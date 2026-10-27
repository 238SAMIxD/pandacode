//! Panda Router for teams: `profileId: "auto"` in dispatch_workers and the route_models tool.
//! Routing runs before the team state is locked; named agent teams route only within their roster.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use super::{active, load, text, Assignment, TeamConfig, WorkerProfile, HARNESSES};
use crate::model_routing::{self, Job};
use crate::panda_router::{Mode, PoolModel, Route, Routed, TaskContext};
use crate::{storage, AppState, Result};

pub(super) const AUTO: &str = "auto";
const MAX_TASK_TEXT: usize = 8192;

#[derive(Clone, Debug)]
pub(crate) struct AutoRoute {
    pick: Option<Routed>,
    difficulty: u8,
    category: String,
    profiler: &'static str,
}
/// Assignment key -> route, or why there is none.
pub(crate) type AutoRoutes = HashMap<String, std::result::Result<AutoRoute, &'static str>>;

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
    format!(" profileId \"auto\" lets Panda Router pick each assignment's model from {scope}; route_models compares picks first. An explicit model request from the user still wins.")
}

/// The team's config and its checkout's main languages (cached per checkout), for routing.
pub(super) async fn team_context(app: &tauri::AppHandle, sid: &str, generation: u64) -> Result<(TeamConfig, Vec<String>)> {
    let (config, root) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let team = load(&store, sid)?.ok_or("Team unavailable.")?;
        if !active(&team.status) || team.generation != generation {
            return Err("Team is no longer active.".into());
        }
        let lead = store.session(sid)?;
        (team.config, store.workspace_root(&lead.project_id, Some(sid)).ok())
    };
    let langs = match root {
        Some(root) => tokio::task::spawn_blocking(move || model_routing::repo_languages(&root)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    Ok((config, langs))
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

/// Keys and jobs for this dispatch's `profileId: "auto"` assignments.
pub(super) fn auto_jobs(args: &Value, langs: &[String]) -> (Vec<String>, Vec<Job>) {
    args["assignments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["profileId"] == AUTO)
        .filter_map(|a| {
            let files = a["files"].as_array().map_or(0, Vec::len);
            Some((a["key"].as_str()?.to_string(), job(a["prompt"].as_str()?, files, langs, vec![])))
        })
        .unzip()
}

pub(super) fn auto_from(keys: Vec<String>, routes: Option<std::result::Result<Vec<Route>, String>>) -> AutoRoutes {
    match routes {
        Some(Ok(routes)) => keys
            .into_iter()
            .zip(routes)
            .map(|(key, r)| (key, Ok(AutoRoute { pick: r.pick, difficulty: r.difficulty, category: r.category, profiler: r.profiler })))
            .collect(),
        Some(Err(error)) => {
            eprintln!("Model routing failed: {error}");
            keys.into_iter().map(|key| (key, Err("routing failed"))).collect()
        }
        None => keys.into_iter().map(|key| (key, Err("routing is off"))).collect(),
    }
}

pub(super) async fn auto_routes(config: &TeamConfig, langs: &[String], args: &Value) -> AutoRoutes {
    let (keys, jobs) = auto_jobs(args, langs);
    if keys.is_empty() {
        return AutoRoutes::default();
    }
    auto_from(keys, model_routing::route_jobs(pool(config), jobs, None).await)
}

fn effort(provider: &str, effort: Option<&String>) -> Option<String> {
    effort.filter(|e| crate::providers::validate_reasoning_effort(provider, Some(e)).is_ok()).cloned()
}

fn money(usd: f64) -> String {
    if usd < 0.01 { format!("${usd:.4}") } else { format!("${usd:.2}") }
}

/// Staffs a `profileId: "auto"` assignment with its routed pick, or the lead's own model (a
/// configured or named team without the lead's model uses its first entry), and says which in one line.
pub(super) fn staff(config: &TeamConfig, lead: &storage::Session, assignment: &Assignment, routes: &AutoRoutes) -> Result<(WorkerProfile, String)> {
    if assignment.provider.is_some() || assignment.model.is_some() {
        return Err("Use either profileId or provider and model, not both.".into());
    }
    let wanted = assignment.reasoning_effort.as_ref();
    let route = routes.get(&assignment.key).cloned().unwrap_or(Err("routing is off"));
    let reason = match route {
        Ok(AutoRoute { pick: Some(pick), difficulty, category, profiler }) => {
            let roster = config.workers.iter().find(|p| p.provider == pick.provider && p.model == pick.model);
            if config.roster_only && roster.is_none() {
                return Err("Panda Router picked a model outside this team.".into());
            }
            let reasoning_effort = effort(&pick.provider, wanted).or_else(|| roster.and_then(|p| p.reasoning_effort.clone()));
            let label = if pick.name.contains('·') { pick.name.clone() } else { format!("{} · {}", pick.name, pick.provider) };
            // The keyword heuristic stands in while the profiler downloads; say so.
            let rough = if profiler == "heuristic" { ", heuristic" } else { "" };
            let note = format!("routed: {label} (P {:.2}, ~{}, difficulty {difficulty} {category}{rough})", pick.p_success, money(pick.est_cost_usd));
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

/// Compact route_models output: pick, up to 3 alternatives, difficulty, category, unrated count, and
/// which profiler ran ("heuristic" while the ONNX profiler downloads).
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
            json!({"pick":r.pick.as_ref().map(model),"alternatives":alternatives,"difficulty":r.difficulty,"category":r.category,"unrated":r.unrated.len()})
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
