# Model routing

In an automatic team the lead can let PandaCode pick each worker's model with
[Panda Router](https://github.com/aicodeking/PandaOrchestrator) (MIT). It runs
inside PandaCode, in Rust: no Python, no server and no extra install (ONNX
Runtime is linked into the app). A route takes about 10–25 ms on the CPU, and
nothing about the task leaves your machine.

## How it works

1. A small ONNX profiler (Ettin-32M, int8) reads the assignment text plus context
   (the repository's top three languages by file count, the files in scope and
   whether tools are required). It outputs a category, a difficulty from 1 to 10,
   the skill levels needed and a few flags.
2. A deterministic matcher scores model cards (per-model skills, price, context
   and latency) by P(success), cost and latency, and picks one under the mode.
3. PandaCode launches the worker with the picked model of its harness.

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
  - *Cheapest that passes* (default): the cheapest model whose P(success) is at
    least the minimum.
  - *Balanced*: the highest utility (success against cost and latency).
  - *Best quality*: the model most likely to succeed.
- **Minimum chance of success**: shown for Cheapest that passes only. Default 80%,
  adjustable from 50 to 95%. Upstream uses 75%; PandaCode raises it because a
  failed worker costs a review round.
- **Profiler**: *Ready*, *Downloading…*, *Not downloaded* or *Failed*, with
  **Download** (or **Retry**). *Keyword heuristic: …* (no button) means the profiler
  cannot run on this system — macOS older than 13.4, or ONNX Runtime failed to start —
  and the heuristic routes for the rest of the session.
- **Route**: describe a task to see the pick and the alternatives, with
  P(success) and estimated cost.

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
  compare picks. It can pass the models that already failed, and the router
  escalates past them.
- Named agent teams route only within their own roster.
- When you name models in your message, the lead uses those.

## Privacy

The profiler files — `model.int8.onnx` (31 MB) and `tokenizer.json` (3.5 MB) — are
downloaded once from `raw.githubusercontent.com`, from a pinned commit
(`f53f30e9712867b353de223460a0b172e7e927b3`) of `aicodeking/PandaOrchestrator`,
and verified by SHA-256 before use. They go to app data. The request carries no
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
  `tokenizers`) and the MIRT matcher over the model cards. CI (macOS job) checks the
  pinned assets: exact tokenizer ids and well-formed profiles and routes. int8 results
  vary slightly by CPU, so numeric parity with the Python reference (1e-4) runs with
  `PANDA_ROUTER_STRICT=1` on the machine that dumped `data/parity.json`; the matcher
  is pinned exactly by the heuristic parity tests.
- `src-tauri/src/model_routing.rs`: settings, the download and the IPC.
- `src-tauri/src/architect/routing.rs`: the team side (`profileId: "auto"`,
  `route_models`, the catalog).
- `src/model-routing.ts`: the settings panel.
