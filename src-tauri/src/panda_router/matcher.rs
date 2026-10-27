//! Deterministic matcher: MIRT P(success) (upstream `matcher/core.py`) and the routing policy (`matcher/policy.py`).

use std::cmp::Ordering;
use std::f64::consts::{PI, SQRT_2};

use super::cards::Card;
use super::profile::{TaskProfile, FLAG_NEEDS_TOOLS, FLAG_NEEDS_VISION, N_DIFFICULTY};
use super::Mode;

const LAMBDA: f64 = 0.5;
const FLOOR: f64 = 0.55;
const W_QUALITY: f64 = 1.0;
const W_COST: f64 = 0.3;
const W_LATENCY: f64 = 0.1;
const CONTEXT_MARGIN: f64 = 1.2;
const INPUT_OVERHEAD_TOKENS: usize = 500;
pub(super) const DEFAULT_CARD: &str = "claude-opus-5.5";
const REASONING: usize = 2;

/// Non-negative half of numpy's `hermgauss(20)`; the rule is symmetric.
const GH_X: [f64; 10] = [
    0.24534070830090127, 0.7374737285453944, 1.234076215395323, 1.7385377121165861, 2.2549740020892752,
    2.7888060584281305, 3.3478545673832163, 3.944764040115625, 4.603682449550744, 5.387480890011233,
];
const GH_W: [f64; 10] = [
    0.4622436696006101, 0.28667550536283415, 0.1090172060200233, 0.024810520887463643, 0.0032437733422378623,
    0.00022833863601635365, 7.80255647853206e-06, 1.0860693707692782e-07, 4.3993409922731747e-10,
    2.2293936455341447e-13,
];

/// Task-side quantities shared by every card.
pub(super) struct Demand {
    exp: [f64; 10],
    w: [f64; 10],
}

impl Demand {
    pub fn new(profile: &TaskProfile) -> Self {
        let exp: [f64; 10] =
            std::array::from_fn(|k| profile.skills[k].iter().enumerate().map(|(lvl, p)| lvl as f64 * p).sum());
        let total: f64 = exp.iter().sum();
        let w = if total < 1e-6 {
            std::array::from_fn(|k| if k == REASONING { 1.0 } else { 0.0 })
        } else {
            exp.map(|e| e / total)
        };
        Self { exp, w }
    }

    /// Mean and sd of the effective ability z (linear + hinge, moment-matched per axis).
    fn moments(&self, card: &Card) -> (f64, f64) {
        let (mut mu, mut var) = (0.0, 0.0);
        for k in 0..10 {
            let m = self.exp[k] - card.theta[k];
            let s = card.se[k].max(1e-9);
            let t = m / s;
            let cdf = 0.5 * libm::erfc(-t / SQRT_2);
            let pdf = (-0.5 * t * t).exp() / (2.0 * PI).sqrt();
            let eh = m * cdf + s * pdf;
            let var_h = ((m * m + s * s) * cdf + m * s * pdf - eh * eh).max(0.0);
            mu += (card.theta[k] - LAMBDA * eh) * self.w[k];
            var += (s * s + LAMBDA * LAMBDA * var_h + 2.0 * LAMBDA * s * s * cdf) * self.w[k] * self.w[k];
        }
        (mu, var.sqrt())
    }

    /// P(success | b = level) for levels 1..10, integrated over z ~ N(mu, sd) by Gauss-Hermite.
    fn p_by_level(&self, card: &Card) -> ([f64; N_DIFFICULTY], f64) {
        let (mu, sd) = self.moments(card);
        let sigmoid = |x: f64| 0.5 * (1.0 + (0.5 * x).tanh());
        let mut out = [0.0; N_DIFFICULTY];
        for (l, o) in out.iter_mut().enumerate() {
            let level = (l + 1) as f64;
            for (x, w) in GH_X.iter().zip(GH_W) {
                let (z, p) = (SQRT_2 * x, w / PI.sqrt());
                *o += p * (sigmoid(card.a * (mu - sd * z - level)) + sigmoid(card.a * (mu + sd * z - level)));
            }
        }
        (out, mu)
    }

    /// Bayes: post(b) ∝ prior(b) · P(fail | b) for a model that failed.
    pub fn after_failure(&self, prior: &[f64; N_DIFFICULTY], failed: &Card) -> [f64; N_DIFFICULTY] {
        let (p, _) = self.p_by_level(failed);
        let post: [f64; N_DIFFICULTY] = std::array::from_fn(|l| prior[l] * (1.0 - p[l]));
        let s: f64 = post.iter().sum();
        if s > 1e-12 { post.map(|x| x / s) } else { *prior }
    }
}

pub(super) fn normalized(d: &[f64; N_DIFFICULTY]) -> [f64; N_DIFFICULTY] {
    let s: f64 = d.iter().sum();
    d.map(|x| x / s)
}

pub(super) struct Scored {
    pub p: f64,
    pub cost: f64,
    pub latency: f64,
}

pub(super) struct Decision {
    pub scored: Vec<Scored>,
    pub chosen: Option<usize>,
    /// Candidates, chosen first, then by P(success) descending.
    pub order: Vec<usize>,
}

fn cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// `pool` is the de-duplicated list of cards; `failed[i]` excludes pool entry i.
pub(super) fn decide(
    profile: &TaskProfile,
    difficulty: &[f64; N_DIFFICULTY],
    pool: &[&Card],
    failed: &[bool],
    text_chars: usize,
    mode: Mode,
    min_p: f64,
) -> Decision {
    let demand = Demand::new(profile);
    let diff = normalized(difficulty);
    let in_tok = (text_chars / 4 + INPUT_OVERHEAD_TOKENS) as f64;
    let out_tok = 10f64.powf(profile.out_p50);
    let mut quality = Vec::with_capacity(pool.len());
    let scored: Vec<Scored> = pool
        .iter()
        .map(|card| {
            let (by_level, mu) = demand.p_by_level(card);
            quality.push((mu / 10.0).clamp(0.0, 1.0));
            Scored {
                p: by_level.iter().zip(diff).map(|(p, d)| p * d).sum::<f64>().clamp(0.0, 1.0),
                cost: (in_tok * card.cost_in + out_tok * card.cost_out) / 1e6,
                latency: card.ttft_ms + out_tok / card.tps * 1000.0,
            }
        })
        .collect();

    // Hard filters.
    let needs_tools = profile.flags[FLAG_NEEDS_TOOLS] > 0.5;
    let needs_vision = profile.flags[FLAG_NEEDS_VISION] > 0.5;
    let mut cand: Vec<usize> = (0..pool.len())
        .filter(|&i| {
            let c = pool[i];
            !failed[i] && (c.tools || !needs_tools) && (c.vision || !needs_vision) && in_tok * CONTEXT_MARGIN <= c.context
        })
        .collect();

    // Newer version wins when it costs no more for this task.
    let newer = |old: &str| cand.iter().rev().copied().find(|&j| pool[j].supersedes.iter().any(|s| s == old));
    let superseded: Vec<usize> = cand
        .iter()
        .copied()
        .filter(|&i| newer(&pool[i].id).is_some_and(|j| scored[j].cost <= scored[i].cost + 1e-12))
        .collect();
    cand.retain(|i| !superseded.contains(i));

    let max_of = |f: &dyn Fn(&Scored) -> f64| cand.iter().map(|&i| f(&scored[i])).fold(0.0, f64::max);
    let (max_cost, max_lat) = (max_of(&|s| s.cost), max_of(&|s| s.latency));
    let norm = |x: f64, m: f64| if m > 0.0 { x / m } else { 0.0 };
    let util = |i: usize| {
        let s = &scored[i];
        W_QUALITY * quality[i] * s.p - W_COST * norm(s.cost, max_cost) - W_LATENCY * norm(s.latency, max_lat)
    };
    let cts = |i: usize| scored[i].cost / scored[i].p.max(1e-6);
    let p = |i: usize| scored[i].p;
    // max by (p, -cost, -i)
    let best_p = |set: &[usize]| {
        set.iter().copied().max_by(|&a, &b| cmp(p(a), p(b)).then(cmp(scored[b].cost, scored[a].cost)).then(b.cmp(&a)))
    };

    let chosen = if cand.is_empty() {
        None
    } else {
        let eligible: Vec<usize> = cand.iter().copied().filter(|&i| p(i) >= FLOOR).collect();
        if eligible.is_empty() {
            cand.iter().copied().find(|&i| pool[i].id == DEFAULT_CARD).or_else(|| {
                cand.iter().copied().max_by(|&a, &b| cmp(p(a), p(b)).then(b.cmp(&a)))
            })
        } else {
            match mode {
                Mode::Cheapest => {
                    let above: Vec<usize> = eligible.iter().copied().filter(|&i| p(i) >= min_p).collect();
                    if above.is_empty() {
                        best_p(&eligible)
                    } else {
                        above.into_iter().min_by(|&a, &b| {
                            cmp(cts(a), cts(b))
                                .then(cmp(scored[a].cost, scored[b].cost))
                                .then(cmp(scored[a].latency, scored[b].latency))
                                .then(cmp(p(b), p(a)))
                                .then(a.cmp(&b))
                        })
                    }
                }
                Mode::Balanced => eligible.into_iter().max_by(|&a, &b| cmp(util(a), util(b)).then(b.cmp(&a))),
                Mode::Quality => best_p(&eligible),
            }
        }
    };

    let mut order = cand;
    order.sort_by(|&a, &b| cmp(p(b), p(a)).then(cmp(scored[a].cost, scored[b].cost)).then(a.cmp(&b)));
    if let Some(c) = chosen {
        order.retain(|&i| i != c);
        order.insert(0, c);
    }
    Decision { scored, chosen, order }
}
