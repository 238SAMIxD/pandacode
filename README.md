# PandaCode

A small, native desktop workspace for coding agents. PandaCode runs the coding
CLIs you already use — **Claude Code, Codex, Kimi Code, OpenCode, GLM Coding
Plan and Xiaomi MiMo** (through Claude Code), **Antigravity and xAI's Grok
Build** (through ACP) — side by side, with your projects, Git, a terminal and a
browser in one window.

PandaCode is free and open source under the [MIT license](LICENSE). There is no
account, no license key and no telemetry.

Built with Tauri 2, Rust, SQLite and plain TypeScript. It uses the operating
system's webview: no bundled Chromium, resident Node server, React runtime or
embedded editor engine.

## Features

- **Every harness in one place.** Pick the harness, model and reasoning effort
  per task; switch between them from the composer. See [providers](docs/providers.md).
- **Tasks and a task board.** Parallel tasks across projects, a Pending → In
  progress → Review → Completed [board](docs/task-board.md), message queueing
  and steering while an agent runs.
- **Agent teams.** An [architect and up to three workers](docs/architect-workers.md),
  mixing harnesses and models, or named team profiles.
- **Bots.** Put an agent behind Telegram, Slack, Discord, WhatsApp or a local web
  chat; each conversation is an ordinary task. See [bots](docs/bots.md).
- **Local VMs and cloud sandboxes.** Headless macOS/Linux VMs on Apple silicon
  (Tart), and Daytona, Cloudflare and AWS sandboxes that agents can drive.
- **Simulators.** iOS Simulator and Android emulator tools for agents.
- **Deploys.** Start a deploy task for Vercel, Cloudflare or AWS from the header,
  with approval-gated CLI runs.
- **Git and worktrees.** Diffs, staging, commits, per-task [worktrees](docs/worktrees.md),
  and optional [GitHub](docs/github.md) issues and pull requests through `gh`.
- **Review every turn.** Saved [turn changes](docs/turn-changes.md) with
  unified/split diffs, an embedded [browser](docs/browser.md), and file previews.
- **Token saver.** Per-task response-style packs that cut output tokens.
- **Quick overlay.** A global shortcut (default ⌘/Ctrl + Shift + Space) opens a
  launcher for new and running tasks from anywhere.
- **Agent usage.** Account limits and cost estimates for each installed harness
  ([agent usage](docs/agent-usage.md)), and one-click CLI updates
  ([agent updates](docs/agent-updates.md)).
- **Attachments.** Images, PDFs, documents, folders and a built-in mockup
  sketcher ([attachments](docs/attachments.md)).

## Privacy

- **No telemetry, no analytics, no accounts.** PandaCode does not phone home.
- **Your code stays on your machine.** Projects, conversations and settings are
  stored locally in SQLite. Prompts go only to the coding CLI or service you
  pick, under that provider's own terms.
- **It only talks to services you choose.** Provider keys (GLM, MiMo, cloud
  sandboxes, bot channels) live in the system keychain and are sent only to
  that provider.

A few automatic checks send no personal data — just plain requests for public
information:

| What | Where | How often |
| --- | --- | --- |
| Latest versions of installed coding CLIs | `formulae.brew.sh`, `downloads.claude.ai`, `api.github.com`, `cdn.kimi.com` | About every 6 hours |
| Public model price list (for cost estimates) | `raw.githubusercontent.com` | Daily |

## Install

Download the latest build from
[GitHub Releases](https://github.com/aicodeking/pandacode/releases/latest):

| Platform | File | Requirements |
| --- | --- | --- |
| macOS (Apple silicon) | `PandaCode-macOS-arm64.dmg` | macOS 12+ |
| Windows x64 | `PandaCode-Windows-x64-setup.exe` | Windows 10 1809+ or Windows 11 |
| Linux x64 | `PandaCode-Linux-x86_64.AppImage` | Ubuntu 22.04+ or compatible, X11 or XWayland |

Release builds are not code-signed, so your OS will warn the first time:

- **macOS:** if macOS says it cannot verify PandaCode, open **System Settings →
  Privacy & Security** and click **Open Anyway**.
- **Windows:** if SmartScreen appears, click **More info → Run anyway**.
- **Linux:** `chmod +x PandaCode-Linux-x86_64.AppImage`, then run it. Some
  distributions need FUSE 2 (`libfuse2`), or set `APPIMAGE_EXTRACT_AND_RUN=1`.

Each file has a `.sha256` checksum beside it. New versions are announced on the
Releases page. See [platform support](docs/platform-support.md) for details.

Then install Git and at least one coding CLI and sign in with its normal login.
PandaCode does not include provider plans or usage.

## Build from source

You need Node.js 22, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
git clone https://github.com/aicodeking/pandacode.git
cd pandacode
npm ci
npm run desktop        # same as: npm run tauri dev
```

`npm run dev` serves only the frontend. In a regular browser it runs a labeled,
device-local sample workspace for UI work; files, Git and terminals are
simulated there. `npm run tauri build` makes a local installer, and
`npm run release:build` builds the release asset for your OS (see
[releasing](docs/releasing.md)).

The website lives in [website/](website/): `npm run site:dev` and
`npm run site:build`.

## Use

Open a project folder, then click **New task** or press `⌘/Ctrl N`. A centered
"What should we build in …?" page opens in the last active project with the
message box focused. Choose the harness and model from the searchable picker in
the message box; new tasks remember your last choice. The **+** button attaches
images, documents, folders, project files or a mockup. Open **Changes** to
inspect and stage diffs, or the terminal to run shell commands. Conversations
and provider session IDs persist across restarts; agents start only for active
turns.

In **Files**, click an HTML, SVG, image or PDF to open it in the sidebar browser.
Filenames mentioned in responses become clickable and resolve against the task's
own project or worktree.

The bar above the prompt shows the project, checkout and branch. Its branch chip
is the one place for [worktrees](docs/worktrees.md): an unstarted task moves into
a new worktree in place, a started one spawns a sibling task, and archiving a
clean worktree task offers to remove its checkout and merged branch.

Choose **Board** in the header to manage tasks by status. Choose **Team** in the
composer for an automatic team, or set up an architect and workers. Each turn's
tool calls sit inside a compact **Worked for …** row; final answers, errors and
approval requests stay visible.

**Standard** permissions keep each provider's native checks. Claude's **Accept
edits** allows its editing tools; Codex uses its workspace sandbox with
on-request approvals. **Full access** enables the harness's broadest mode. See
[provider details](docs/providers.md).

Type `/` at the start of a message for the harness's commands and skills
([slash commands](docs/slash-commands.md)).

Keyboard shortcuts: `⌘/Ctrl N` new task, `⌘/Ctrl K` command palette,
`⌘/Ctrl J` terminal, `⌘/Ctrl B` sidebar, `⌘/Ctrl ,` settings, `Enter` send
(queues while an agent runs), `⌘/Ctrl Enter` steer, `Shift Enter` newline,
`⌘/Ctrl +/−/0` text size.

On macOS, if folder access is denied, use **Browse** to select the folder, or
allow PandaCode under **System Settings → Privacy & Security → Files & Folders**.

PandaCode includes [21 anime scenery wallpapers](docs/wallpapers.md), a
different morning, afternoon and night scene for each weekday. **Settings →
Daily wallpapers** turns them off. You can also import VS Code color themes.

The [optional Jev add-on](docs/jev.md) adds work review, project-rule checks and
app testing in isolated Chrome profiles. It is off by default and PandaCode works
fully without it.

## Resource limits

No background directory polling or recursive file watchers. Agents exit after
each turn and resume by provider session ID. Terminal and Markdown code load only
when needed. Terminal history, provider frames, files, diffs and streamed text
all have explicit limits; only the current 100-message page of a conversation is
loaded. **Resource usage** reports native core RSS, active agents, terminals and
database size (core RSS excludes the system webview and provider processes).

## Tests

```sh
npx tsc --noEmit           # typecheck
npm run build && npm test  # unit tests (some read dist/)
npm run test:release       # release script tests
npm run test:rust          # cargo test
npx playwright test        # browser suite (Chrome)
npx playwright test -c playwright.webkit.config.ts   # WebKit
```

Ordinary tests make no paid model calls. Opt-in live tests are `#[ignore]`d;
see [providers](docs/providers.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the pull request process, and [AGENTS.md](AGENTS.md) for code conventions. Please
follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues
privately as described in [SECURITY.md](SECURITY.md). Bugs and ideas go in
[GitHub issues](https://github.com/aicodeking/pandacode/issues).

Architecture notes: [design](docs/design.md), [native IPC](docs/ipc.md),
[research](docs/research.md). Provider protocols live in
`src-tauri/src/providers.rs` behind one normalized event interface; ACP harnesses
share `acp.rs`.

## Data

Data lives in Tauri's per-user application data directory (on macOS,
`~/Library/Application Support/ai.pandacode.desktop/`) in `kingcode.sqlite3`; the
database keeps its legacy internal name. Project source stays in the folders you
open, and removing a project from the app never deletes its files.

## License

[MIT](LICENSE) © 2026 PandaCode contributors. Provider names and logos belong to
their owners and do not imply endorsement ([brand assets](docs/brand-assets.md)).
