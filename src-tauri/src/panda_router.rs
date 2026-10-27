//! Panda Router: picks the model for a task, in process. A native port of PandaOrchestrator
//! (github.com/aicodeking/PandaOrchestrator @ f53f30e): an int8 ONNX task profiler (or a keyword heuristic
//! when the model files are not installed) and a deterministic card matcher. Nothing here touches the
//! network; `model_routing` downloads the profiler and owns the process-wide router.

mod cards;
mod heuristic;
mod matcher;
mod onnx;
mod profile;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use matcher::Demand;
use onnx::OnnxProfiler;
use profile::{TaskProfile, CATEGORIES};

/// Model files downloaded into the router directory: (file name, sha256 hex).
pub const ASSETS: &[(&str, &str)] = &[
    ("model.int8.onnx", "f88d53898082580340c21724de47cbe2e7900ca90b2962bdeb953b1778a6bffa"),
    ("tokenizer.json", "ca870c678352403d107496dc78899fa666ed0f56fef63e88ae398fafe5d78c45"),
];
pub const ASSET_BASE_URL: &str = "https://raw.githubusercontent.com/aicodeking/PandaOrchestrator/f53f30e9712867b353de223460a0b172e7e927b3/artifacts/panda-router-v2/";

const TOP_K: usize = 5;

/// A PandaCode harness + model id + display name.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolModel {
    pub provider: String,
    pub model: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Upstream `max_utility`.
    #[default]
    Balanced,
    /// Upstream `cheapest_above_threshold`.
    Cheapest,
    /// Upstream `max_quality`.
    Quality,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub mode: Mode,
    pub min_p: f64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { mode: Mode::Cheapest, min_p: 0.8 }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TaskContext {
    pub repo_languages: Vec<String>,
    pub files_in_scope: Option<u32>,
    /// The task runs as a tool-using agent: the profiler sees it and only tool-capable models qualify.
    pub requires_tools: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routed {
    pub provider: String,
    pub model: String,
    pub name: String,
    pub card_id: String,
    pub p_success: f64,
    pub est_cost_usd: f64,
    pub est_latency_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub pick: Option<Routed>,
    /// Best first, at most 5.
    pub ranking: Vec<Routed>,
    /// Pool entries with no card.
    pub unrated: Vec<PoolModel>,
    pub difficulty: u8,
    pub category: String,
    /// "onnx" or "heuristic".
    pub profiler: &'static str,
    pub latency_ms: f64,
}

pub struct Router {
    onnx: Option<OnnxProfiler>,
}

/// Maps a PandaCode model to a card id: the harness table, then upstream alias matching, then (for
/// `default`) the display name. Ambiguous or unknown -> None.
pub fn resolve_card(provider: &str, model: &str, name: &str) -> Option<&'static str> {
    let catalog = cards::catalog().ok()?;
    catalog.resolve(provider, model, name).map(|i| catalog.cards[i].id.as_str())
}

impl Router {
    /// Loads the ONNX profiler from `dir` (model.int8.onnx + tokenizer.json, checked against `ASSETS`).
    pub fn load(dir: &Path) -> Result<Router, String> {
        cards::catalog()?;
        Ok(Router { onnx: Some(OnnxProfiler::load(dir)?) })
    }

    /// Keyword profiler; works without model files but routes less well.
    pub fn heuristic() -> Router {
        Router { onnx: None }
    }

    pub fn is_onnx(&self) -> bool {
        self.onnx.is_some()
    }

    fn profiler_name(&self) -> &'static str {
        if self.is_onnx() { "onnx" } else { "heuristic" }
    }

    fn profile(&self, text: &str, ctx: &TaskContext) -> Result<TaskProfile, String> {
        match &self.onnx {
            Some(onnx) => Ok(onnx.profile_batch(&[profile::format_input(text, ctx)])?.remove(0)),
            None => Ok(heuristic::profile(text, ctx)),
        }
    }

    pub fn route(
        &self,
        text: &str,
        ctx: &TaskContext,
        pool: &[PoolModel],
        prefs: &Preferences,
        failed: &[PoolModel],
    ) -> Result<Route, String> {
        let start = Instant::now();
        let mut profile = self.profile(text, ctx)?;
        // Upstream: needs_tools = max(flag, 1 if requires_tools) > 0.5.
        if ctx.requires_tools {
            profile.flags[profile::FLAG_NEEDS_TOOLS] = 1.0;
        }
        self.match_profile(&profile, text, pool, prefs, failed, start)
    }

    fn match_profile(
        &self,
        profile: &TaskProfile,
        text: &str,
        pool: &[PoolModel],
        prefs: &Preferences,
        failed: &[PoolModel],
        start: Instant,
    ) -> Result<Route, String> {
        let catalog = cards::catalog()?;
        let resolve = |m: &PoolModel| catalog.resolve(&m.provider, &m.model, &m.name);

        // Resolve the pool; the first entry for a card wins.
        let mut rated: Vec<(&PoolModel, usize)> = Vec::new();
        let mut unrated = Vec::new();
        for m in pool {
            match resolve(m) {
                Some(card) if rated.iter().all(|(_, c)| *c != card) => rated.push((m, card)),
                Some(_) => {}
                None => unrated.push(m.clone()),
            }
        }

        // Escalation: each failure is evidence the task is harder than that model's ability.
        let failed_cards: Vec<usize> = failed.iter().filter_map(resolve).collect();
        let demand = Demand::new(profile);
        let mut difficulty = matcher::normalized(&profile.difficulty);
        for &card in &failed_cards {
            difficulty = demand.after_failure(&difficulty, &catalog.cards[card]);
        }
        let excluded: Vec<bool> =
            rated.iter().map(|(m, card)| failed_cards.contains(card) || failed.contains(m)).collect();

        let cards: Vec<&cards::Card> = rated.iter().map(|(_, c)| &catalog.cards[*c]).collect();
        let decision = matcher::decide(
            profile,
            &difficulty,
            &cards,
            &excluded,
            text.chars().count(),
            prefs.mode,
            prefs.min_p,
        );
        let routed = |i: usize| {
            let (m, card) = rated[i];
            let s = &decision.scored[i];
            Routed {
                provider: m.provider.clone(),
                model: m.model.clone(),
                name: m.name.clone(),
                card_id: catalog.cards[card].id.clone(),
                p_success: s.p,
                est_cost_usd: s.cost,
                est_latency_ms: s.latency,
            }
        };
        let level = difficulty
            .iter()
            .enumerate()
            .fold(0, |best, (i, p)| if *p > difficulty[best] { i } else { best });
        Ok(Route {
            pick: decision.chosen.map(routed),
            ranking: decision.order.iter().take(TOP_K).map(|&i| routed(i)).collect(),
            unrated,
            difficulty: level as u8 + 1,
            category: CATEGORIES[profile.top_category()].to_string(),
            profiler: self.profiler_name(),
            latency_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}
