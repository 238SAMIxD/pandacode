//! Panda Router for teams: `profileId: "auto"` in dispatch_workers and the route_models tool.
//! Routing runs before the team state is locked; named agent teams route only within their roster.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use rusqlite::{params, OptionalExtension};

use super::{active, load, text, Assignment, TeamConfig, TeamSnapshot, WorkerProfile, HARNESSES};
use crate::model_routing::{self, Job};
use crate::panda_router::{Mode, PoolModel, Route, Routed, TaskContext};
use crate::{storage, AppState, Result};

pub(super) const AUTO: &str = "auto";
const MAX_TASK_TEXT: usize = 8192;

#[derive(Clone, Debug)]
pub(crate) struct AutoRoute {
    /// The policy's choice.
    pick: Option<Routed>,
    /// Try in order, escalating on failure; a fresh Cheap or Balanced assignment opens on its first rung.
    ladder: Vec<Routed>,
    mode: Mode,
    decided_by: String,
    /// Models that failed this assignment before (escalation input).
    failed: Vec<PoolModel>,
    difficulty: u8,
    category: String,
    profiler: &'static str,
}
/// Assignment key -> route, or why there is none.
pub(crate) type AutoRoutes = HashMap<String, std::result::Result<AutoRoute, &'static str>>;

/// Failed attempts at one assignment after which `auto` stops escalating: the first try plus two retries.
pub(super) const MAX_ATTEMPTS: usize = 3;

/// The models `auto` may pick: a named team's own models, else every installed model
/// (`catalog`), else the roster.
pub(super) fn pool(config: &TeamConfig) -> Vec<PoolModel> {
    let source = if config.roster_only || config.catalog.is_empty() { &config.workers } else { &config.catalog };
    model_routing::pool_from(source.iter().map(|p| (p.provider.as_str(), p.model.as_str(), p.name.as_str())))
}

/// One sentence for the lead's team rules; empty while routing is off or nothing is rated.
pub(super) fn prompt_note(config: &TeamConfig, enabled: bool) -> String {
    if !enabled {
        return String::new();
    }
    let n = model_routing::rated_count(&pool(config));
    if n == 0 {
        return String::new();
    }
    let scope = if config.roster_only { format!("this team's {n} rated models") } else { format!("{n} rated models") };
    let start = if model_routing::mode() == Mode::Quality { "starting on the strongest fit" } else { "starting on the cheapest model likely to pass" };
    format!(" profileId \"auto\" lets Panda Router pick each assignment's model from {scope}, {start}; route_models shows picks and ladders first. Verify each routed result (tests, typecheck or a review); if it fails, dispatch a replacement with replaces set to that worker and profileId \"auto\", at most 2 retries, then report the failure to the user. An explicit model request from the user still wins.")
}

/// Failed worker ID -> the models that failed its assignment, oldest first, for `replaces`.
pub(crate) type Chains = HashMap<String, Vec<PoolModel>>;

/// Whether a worker can be replaced: it failed, or it completed and the lead found the result wrong
/// (tests, typecheck, review). A stopped or unfinished worker is no verdict on its model.
pub(super) fn replaceable(status: &str) -> bool {
    matches!(status, "failed" | "completed")
}

/// The models that failed worker `id`'s assignment if it is replaced, oldest first: each worker its
/// dispatch `replaced` (recursively, from the saved requests), then its own. None unless `replaceable`.
pub(super) fn failed_chain(store: &storage::Store, team: &TeamSnapshot, id: &str) -> Result<Option<Vec<PoolModel>>> {
    if !team.workers.iter().any(|w| w.id == id && replaceable(&w.status)) {
        return Ok(None);
    }
    let pool = pool(&team.config);
    let mut chain = Vec::new();
    let mut next = team.workers.iter().find(|w| w.id == id);
    // Bounded by the team's size, so a malformed record cannot loop.
    while let Some(w) = next.filter(|_| chain.len() < team.workers.len()) {
        let name = pool.iter().find(|m| m.provider == w.provider && m.model == w.model).map_or_else(|| w.model.clone(), |m| m.name.clone());
        chain.push(PoolModel { provider: w.provider.clone(), model: w.model.clone(), name });
        let request: Option<String> = store
            .db
            .query_row("SELECT content FROM architect_requests WHERE parent_session_id=?1 AND worker_id=?2 AND kind='dispatch'", params![team.session_id, w.id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let replaced = request.and_then(|c| serde_json::from_str::<Value>(&c).ok()).and_then(|v| v["replaces"].as_str().map(String::from));
        next = replaced.and_then(|r| team.workers.iter().find(|x| x.id == r));
    }
    chain.reverse();
    Ok(Some(chain))
}

/// `failed_chain` for the workers this dispatch replaces (its `replaces` IDs), not the whole team.
pub(super) fn chains(store: &storage::Store, team: &TeamSnapshot, args: &Value) -> Result<Chains> {
    let mut chains = Chains::new();
    for id in args["assignments"].as_array().into_iter().flatten().filter_map(|a| a["replaces"].as_str()) {
        if let Some(chain) = failed_chain(store, team, id)? {
            chains.insert(id.to_string(), chain);
        }
    }
    Ok(chains)
}

/// The team's config, its checkout's main languages (cached per checkout) and failed workers' chains, for routing.
pub(super) async fn team_context(app: &tauri::AppHandle, sid: &str, generation: u64, args: &Value) -> Result<(TeamConfig, Vec<String>, Chains)> {
    let (config, root, chains) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let team = load(&store, sid)?.ok_or("Team unavailable.")?;
        if !active(&team.status) || team.generation != generation {
            return Err("Team is no longer active.".into());
        }
        let lead = store.session(sid)?;
        let chains = chains(&store, &team, args)?;
        (team.config, store.workspace_root(&lead.project_id, Some(sid)).ok(), chains)
    };
    let langs = match root {
        Some(root) => tokio::task::spawn_blocking(move || model_routing::repo_languages(&root)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    Ok((config, langs, chains))
}

/// Worker assignments run as tool-using coding agents in the team's checkout.
fn job(text: &str, files: usize, langs: &[String], failed: Vec<PoolModel>) -> Job {
    let text: String = text.chars().take(MAX_TASK_TEXT).collect();
    let files_in_scope = (files > 0).then(|| files.min(u32::MAX as usize) as u32);
    Job { text, ctx: TaskContext { files_in_scope, repo_languages: langs.to_vec(), requires_tools: true }, failed }
}

/// Whether a dispatch asks for any routed worker, so plain dispatches skip the routing context.
pub(super) fn has_auto(args: &Value) -> bool {
    args["assignments"].as_array().is_some_and(|a| a.iter().any(|a| a["profileId"] == AUTO))
}

/// Keys and jobs for this dispatch's `profileId: "auto"` assignments; one that `replaces` a failed
/// worker escalates past every model that failed that assignment.
pub(super) fn auto_jobs(args: &Value, langs: &[String], chains: &Chains) -> (Vec<String>, Vec<Job>) {
    args["assignments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["profileId"] == AUTO)
        .filter_map(|a| {
            let files = a["files"].as_array().map_or(0, Vec::len);
            let failed = a["replaces"].as_str().and_then(|id| chains.get(id)).cloned().unwrap_or_default();
            Some((a["key"].as_str()?.to_string(), job(a["prompt"].as_str()?, files, langs, failed)))
        })
        .unzip()
}

pub(super) fn auto_from(keys: Vec<String>, routes: Option<std::result::Result<Vec<Route>, String>>, mode: Mode) -> AutoRoutes {
    match routes {
        Some(Ok(routes)) => keys
            .into_iter()
            .zip(routes)
            .map(|(key, r)| {
                let route = AutoRoute { pick: r.pick, ladder: r.ladder, mode, decided_by: r.decided_by, failed: r.failed, difficulty: r.difficulty, category: r.category, profiler: r.profiler };
                (key, Ok(route))
            })
            .collect(),
        Some(Err(error)) => {
            eprintln!("Model routing failed: {error}");
            keys.into_iter().map(|key| (key, Err("routing failed"))).collect()
        }
        None => keys.into_iter().map(|key| (key, Err("routing is off"))).collect(),
    }
}

pub(super) async fn auto_routes(config: &TeamConfig, langs: &[String], chains: &Chains, args: &Value) -> AutoRoutes {
    let (keys, jobs) = auto_jobs(args, langs, chains);
    if keys.is_empty() {
        return AutoRoutes::default();
    }
    // One mode for routing and staffing, even if Settings changes it meanwhile.
    let mode = model_routing::mode();
    auto_from(keys, model_routing::route_jobs(pool(config), jobs, Some(mode)).await, mode)
}

fn effort(provider: &str, effort: Option<&String>) -> Option<String> {
    effort.filter(|e| crate::providers::validate_reasoning_effort(provider, Some(e)).is_ok()).cloned()
}

fn money(usd: f64) -> String {
    if usd < 0.01 { format!("${usd:.4}") } else { format!("${usd:.2}") }
}

/// Staffs a `profileId: "auto"` assignment, or the lead's own model when unrouted (a configured or named
/// team without the lead's model uses its first entry), and says which in one line. A fresh assignment
/// in Cheap or Balanced mode opens on the ladder's first (cheapest safe) rung and escalates from there;
/// Best mode and escalations take the policy's pick.
pub(super) fn staff(config: &TeamConfig, lead: &storage::Session, assignment: &Assignment, routes: &AutoRoutes) -> Result<(WorkerProfile, String)> {
    if assignment.provider.is_some() || assignment.model.is_some() {
        return Err("Use either profileId or provider and model, not both.".into());
    }
    let wanted = assignment.reasoning_effort.as_ref();
    let route = routes.get(&assignment.key).cloned().unwrap_or(Err("routing is off"));
    let reason = match route {
        Ok(AutoRoute { pick: Some(policy), ladder, mode, decided_by, failed, difficulty, category, profiler }) => {
            // Cheap keeps its contract: the opener must clear the minimum lower bound, else the policy pick.
            let opener = match mode {
                _ if !failed.is_empty() => None,
                Mode::Quality => None,
                Mode::Cheapest => ladder.iter().find(|m| m.p_success_lower >= model_routing::min_p()),
                _ => ladder.first(),
            };
            let pick = opener.cloned().unwrap_or_else(|| policy.clone());
            let roster = config.workers.iter().find(|p| p.provider == pick.provider && p.model == pick.model);
            if config.roster_only && roster.is_none() {
                return Err("Panda Router picked a model outside this team.".into());
            }
            let reasoning_effort = effort(&pick.provider, wanted).or_else(|| roster.and_then(|p| p.reasoning_effort.clone()));
            let label = if pick.name.contains('·') { pick.name.clone() } else { format!("{} · {}", pick.name, pick.provider) };
            // The keyword heuristic stands in while the profiler downloads; say so.
            let rough = if profiler == "heuristic" { ", heuristic" } else { "" };
            // The rung the opener sits on (Cheap may skip rungs below min P).
            let rung = opener.and_then(|o| ladder.iter().position(|m| m.card_id == o.card_id)).map_or(1, |i| i + 1);
            let step = match opener {
                Some(first) if first.card_id != policy.card_id => format!("ladder {rung}/{}, opener; policy pick {}; ", ladder.len(), policy.name),
                Some(_) => format!("ladder {rung}/{}, opener; ", ladder.len()),
                None => String::new(),
            };
            let mut note = format!("routed: {label} ({step}P {:.2}, ~{}, difficulty {difficulty} {category}{rough})", pick.p_success, money(pick.est_cost_usd));
            if decided_by.starts_with("escalation") {
                let past: Vec<_> = failed.iter().map(|m| format!("{} · {}", m.name, m.provider)).collect();
                note.push_str(&format!(", {decided_by} past {}", past.join(", ")));
            }
            let profile = WorkerProfile {
                id: roster.map_or_else(|| AUTO.to_string(), |p| p.id.clone()),
                name: roster.map_or(pick.name, |p| p.name.clone()),
                provider: pick.provider,
                model: pick.model,
                reasoning_effort,
            };
            return Ok((profile, note));
        }
        Ok(_) => "no rated model fits",
        Err(reason) => reason,
    };
    let profile = if config.auto && !config.roster_only {
        WorkerProfile {
            id: AUTO.into(),
            name: lead.model.clone(),
            provider: lead.provider.clone(),
            model: lead.model.clone(),
            reasoning_effort: effort(&lead.provider, wanted).or_else(|| lead.reasoning_effort.clone()),
        }
    } else {
        let entry = config
            .workers
            .iter()
            .find(|p| p.provider == lead.provider && p.model == lead.model)
            .or(config.workers.first())
            .ok_or("This team has no models.")?;
        WorkerProfile { reasoning_effort: effort(&entry.provider, wanted).or_else(|| entry.reasoning_effort.clone()), ..entry.clone() }
    };
    let note = format!("not routed ({reason}), using {} · {}", profile.name, profile.provider);
    Ok((profile, note))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteArgs {
    tasks: Vec<RouteTask>,
    #[serde(default)]
    mode: Option<Mode>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteTask {
    text: String,
    #[serde(default)]
    files: Option<u32>,
    #[serde(default)]
    failed: Vec<FailedModel>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailedModel {
    provider: String,
    model: String,
}

/// The pool, jobs and mode of a route_models call.
pub(super) fn route_request(config: &TeamConfig, langs: &[String], args: Value) -> Result<(Vec<PoolModel>, Vec<Job>, Option<Mode>)> {
    let args: RouteArgs = serde_json::from_value(args).map_err(|e| format!("Invalid route_models arguments: {e}"))?;
    if args.tasks.is_empty() || args.tasks.len() > 12 {
        return Err("Route 1–12 tasks per call.".into());
    }
    let pool = pool(config);
    let mut jobs = Vec::new();
    for task in args.tasks {
        text(&task.text, MAX_TASK_TEXT, "Task text")?;
        if task.failed.len() > 12 || task.failed.iter().any(|f| !HARNESSES.contains(&f.provider.as_str()) || f.model.len() > 200) {
            return Err("List at most 12 failed models, each with a known harness.".into());
        }
        let failed = task
            .failed
            .into_iter()
            .map(|f| {
                let name = pool.iter().find(|m| m.provider == f.provider && m.model == f.model).map_or_else(|| f.model.clone(), |m| m.name.clone());
                PoolModel { provider: f.provider, model: f.model, name }
            })
            .collect();
        jobs.push(job(&task.text, task.files.unwrap_or(0) as usize, langs, failed));
    }
    Ok((pool, jobs, args.mode))
}

/// Compact route_models output: pick and why, up to 3 alternatives, the first 4 rungs of the
/// escalation ladder, difficulty, category, unrated count, and which profiler ran ("heuristic" while
/// the ONNX profiler downloads).
pub(super) fn route_summary(config: &TeamConfig, routes: &[Route]) -> Value {
    let model = |m: &Routed| {
        let mut entry = json!({"provider":m.provider,"model":m.model,"name":m.name,"pSuccess":(m.p_success * 100.0).round() / 100.0,"estCostUsd":(m.est_cost_usd * 10000.0).round() / 10000.0});
        if let Some(p) = config.workers.iter().find(|p| p.provider == m.provider && p.model == m.model) {
            entry["profileId"] = json!(p.id);
        }
        entry
    };
    let tasks: Vec<Value> = routes
        .iter()
        .map(|r| {
            let picked = r.pick.as_ref().map(|p| p.card_id.as_str());
            let alternatives: Vec<Value> = r.ranking.iter().filter(|m| Some(m.card_id.as_str()) != picked).take(3).map(model).collect();
            let ladder: Vec<Value> = r.ladder.iter().take(4).map(model).collect();
            json!({"pick":r.pick.as_ref().map(model),"decidedBy":r.decided_by,"alternatives":alternatives,"ladder":ladder,"difficulty":r.difficulty,"category":r.category,"unrated":r.unrated.len()})
        })
        .collect();
    json!({"tasks": tasks, "profiler": routes.first().map_or("heuristic", |r| r.profiler)})
}

pub(super) async fn route_models(config: &TeamConfig, langs: &[String], args: Value) -> Result<Value> {
    let (pool, jobs, mode) = route_request(config, langs, args)?;
    let routes = model_routing::route_jobs(pool, jobs, mode)
        .await
        .ok_or_else(|| format!("{} Choose models yourself.", model_routing::OFF))??;
    Ok(route_summary(config, &routes))
}
