# Model routing

In an automatic team the lead can let PandaCode pick each worker's model with
[Panda Router](https://github.com/aicodeking/PandaOrchestrator) v4 (MIT). It runs
inside PandaCode, in Rust: no Python, no server and no extra install (ONNX
Runtime is linked into the app). A route takes about 10–25 ms on the CPU, and
nothing about the task leaves your machine.

## How it works

1. A small ONNX profiler (Ettin-32M, int8) reads the assignment text plus context
   (the repository's top three languages by file count, the files in scope and
   whether tools are required). It outputs a category, a difficulty from 1 to 10,
   the skill levels needed and a few flags.
2. A deterministic matcher scores model cards (per-model skills, price, context
   and latency), and a small learned success head calibrates each P(success) with
   a lower confidence bound. The policy picks one under the mode and also returns an
   **escalation ladder**: the models to try in order if a pick fails.
3. PandaCode launches the worker on the ladder's first rung, the cheapest model
   that is safe to try (Balanced; Cheap uses the first rung whose lower bound clears
   the minimum chance of success; Best, or no such rung, launches the policy's pick). The
   dispatch note says so, for example `routed: Haiku · claude (ladder 1/3, opener;
   policy pick Opus; …)`.
4. The lead checks each routed result with tests, a typecheck or a review. When a
   worker fails, or completes with a result that fails that check, the lead can
   dispatch a replacement with `replaces: <worker ID>` (and optionally
   `replaceReason`, the check it failed) and `profileId: "auto"`. The router treats every model
   that failed that assignment (the whole chain of replaced workers) as evidence the
   task is harder, excludes them, and never steps down: the next rung of the ladder
   at least as strong as the strongest failed model, else a stronger model, else the
   strongest left. The dispatch note names the step (`escalation_ladder`,
   `escalation:stronger` or `escalation:strongest_left`) and the models it passed.
5. An assignment gets at most 2 retries: once three attempts have failed, any
   replacement is refused and the lead reports the failure to you instead.

Model names are matched to cards by exact map, then card id or model string,
loose spelling, vendor prefix, and last a digit-guarded fuzzy match (cutoff 0.75),
as upstream. A model without a card is unrated and never picked automatically.

Dispatch and `route_models` never wait for the download. Until the profiler is
ready they route with a keyword heuristic, which is clearly weaker, and the result
says so. Only Settings' **Route** button may wait briefly.

## Settings

Settings → Agents → Model routing:

- **Pick worker models with Panda Router**: the off switch.
- **Mode**
  - *Cheap*: the lowest expected cost whose P(success) lower bound is at least the
    minimum; when none is, the best that is left (`:relaxed`). A failure escalates.
  - *Balanced* (default): the highest utility (success against cost and latency).
  - *Best*: the model most likely to succeed.
- **Minimum chance of success**: shown for Cheap only. Default 50%, adjustable from
  30 to 90%, compared with the lower bound of P. A saved 0.8 (the old default)
  becomes 0.5; any other saved value is kept.
- **Profiler**: *Ready*, *Downloading…*, *Not downloaded* or *Failed*, with
  **Download** (or **Retry**). *Keyword heuristic: …* (no button) means the profiler
  cannot run on this system — macOS older than 13.4, or ONNX Runtime failed to start —
  and the heuristic routes for the rest of the session.
- **Route**: describe a task to see the pick and the alternatives, with
  P(success) and estimated cost.

The prompt box's **Team** button (`showTeamMenu` in `src/main.ts`) offers *No team*,
*Cheap team*, *Balanced team* and *Best team* while routing is on (and *Team*, where the
lead picks models, while it is off). Each routed kind sets the same global mode with
`model_routing_configure` and turns on an automatic team (`setTeam`). It is one global
mode, not a per-task one: switching kinds changes it everywhere, so a running automatic
team's label and its next routed dispatch follow it.

While routing is off, `profileId: "auto"` is not refused: the worker gets the
lead's own model (in a named team without the lead's model, the team's first
model) and the dispatch note says "not routed (routing is off)". `route_models`
and **Route** return a "routing is off" error.

## In teams

- In an automatic team, the lead sets `profileId: "auto"` on an assignment in
  `dispatch_workers`. PandaCode routes it over the team's `catalog`: every model
  of every installed harness, up to 1000, ordered round-robin across harnesses. It
  is not limited by the 24-entry roster, and it is rebuilt each time a team turns
  on. The lead prompt names the number of rated models.
- Before dispatching, the lead can call `route_models` with several tasks to
  compare picks: each answer has the pick, why (`decidedBy`), alternatives and the
  first four rungs of the ladder. It can pass the models that already failed, oldest
  first, and the router escalates past them.
- A replacement dispatched with `replaces` marks the old worker abandoned
  ("Replaced by worker …: <reason>"), so finishing does not wait on it. Failed workers
  and completed ones whose result failed the lead's check can be replaced, each once;
  stopped or unfinished workers cannot (a stop is no verdict on the model).
- The lead prompt (only while routing is on) says this in one sentence: `auto` starts
  on the cheapest safe model; verify each routed result; on failure dispatch a
  replacement with `replaces` and `auto`, at most 2 retries, then report.
- Named agent teams route only within their own roster.
- When you name models in your message, the lead uses those.

## Privacy

The profiler files — `model.int8.onnx` (31 MB) and `tokenizer.json` (3.5 MB) — are
downloaded once from `raw.githubusercontent.com`, from a pinned commit
(`83e408c794ef1d09b6d13b6ad8734e984f552402`) of `aicodeking/PandaOrchestrator`,
and verified by SHA-256 before use. They go to `panda-router/v4` in app data; the
v2 files of earlier releases are deleted once v4 loads. The request carries no
content from your work. It happens only while routing is enabled and only when a team needs it (turning a team
on, or a team's first routed dispatch) or when you click **Download** or **Route** in
Settings, never at launch. After a failed attempt it waits 10 minutes before trying again
(**Retry** works any time). On macOS older than 13.4 it never happens: the bundled ONNX
Runtime needs 13.4, so routing keeps the keyword heuristic there. Builds for Intel Macs
and x86_64 Linux have no ONNX profiler at all (no compatible prebuilt ONNX Runtime;
`panda_onnx` in `src-tauri/build.rs`), so they also route with the heuristic and never
download it. Routing itself makes no
network request.

## Limits

- Model cards are estimates, not measurements. See the upstream
  [cards README](https://github.com/aicodeking/PandaOrchestrator/blob/main/cards/README.md)
  for how each number was set.
- The router picks a model; it does not know your account's access. A model must
  still be supported by its harness and your account.

## Where the code lives

- `src-tauri/src/panda_router.rs` and `panda_router/`: the ONNX profiler (`ort`,
  `tokenizers`), the MIRT matcher over the model cards, the success head and the v4
  policy with its escalation ladder. CI (macOS job) checks the
  pinned assets: exact tokenizer ids and well-formed profiles and routes. int8 results
  vary slightly by CPU, so numeric parity with the Python reference (1e-4) runs with
  `PANDA_ROUTER_STRICT=1` on the machine that dumped `data/parity.json`; the matcher
  is pinned exactly by the heuristic parity tests.
- `src-tauri/src/model_routing.rs`: settings, the download and the IPC.
- `src-tauri/src/architect/routing.rs`: the team side (`profileId: "auto"`,
  `replaces` and its failure chain, `route_models`, the catalog).
- Live check with the real profiler: `PANDA_ROUTER_ASSETS=<dir>
  cargo test --lib live_team_routing -- --ignored --nocapture` prints each pick, its
  ladder and two escalation steps (`PANDA_ROUTER_MODE=cheapest|quality`).
- `src/model-routing.ts`: the settings panel.
