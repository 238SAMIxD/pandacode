//! Answers requests from the account's other computers, only while
//! "Allow remote control" is on,
//! and pushes the agent events of the tasks they mirror. Remote prompts run under the
//! same approval policy as local ones.
use super::{remote, socket, start, Subscriber};
use crate::{message_queue, providers::AgentEvent, AppState, Result};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub(crate) const METHODS: [&str; 23] = ["subscribe", "tasks.list", "projects.icons", "providers.list", "providers.models", "task.start", "task.messages", "task.send", "task.stop", "task.steer", "task.configure", "approval.respond", "input.respond", "task.pull", "task.pullDiff", "task.pullMerge", "task.pullDetect", "task.changes", "task.diff", "bots.list", "bot.thread", "bot.message", "bot.pause"];
pub(crate) const OFF: &str = "Remote control is off on this computer";
pub(crate) const MAX_TEXT: usize = 100 * 1024;
const SUBSCRIPTION: Duration = Duration::from_secs(10 * 60);
/// Events wait this long, so one frame carries everything a subscriber missed meanwhile.
const FLUSH: Duration = Duration::from_millis(100);
pub(crate) const MAX_IDS: usize = 500;
const TASKS_DEFAULT: usize = 200;
const TASKS_MAX: usize = 500;
const MESSAGE_PAGE_DEFAULT: i64 = 100;
const WINDOW_MS: i64 = 60_000;
const MAX_SEEN: usize = 20_000;
/// A reply's or event frame's JSON budget: sealing adds a third (base64) plus a small
/// envelope, so this stays under the relay's 256 KB frame.
pub(crate) const PAGE_BUDGET: usize = 180 * 1024;
const MAX_PROJECT_ICON_IDS: usize = 50;
const MAX_PROJECT_ICON_BYTES: usize = 64 * 1024;
const MAX_BOT_AVATAR_BYTES: usize = 32 * 1024;
const SUBAGENT_SNAPSHOT_BUDGET: usize = 40 * 1024;
const MAX_SUBAGENT_SNAPSHOT: usize = 64;
const DIFF_BUDGET: usize = 120 * 1024;
const MAX_PATH: usize = 4096;
/// A single message or event larger than this is cut, with [`CUT`] marking the cut.
const MAX_MESSAGE: usize = 120 * 1024;
/// Messages read per legacy `afterId` `task.messages` page before the budget trims it.
const PAGE_ROWS: i64 = 400;
/// Buffered events per subscriber; a viewer that falls this far behind resyncs at run end.
const MAX_BUFFER: usize = 4096;
const CUT: &str = "\n…[cut on the host to fit a remote page]";
/// Harness ids `providers.models` accepts (the same list `storage` allows).
pub(crate) const PROVIDERS: [&str; 16] = ["claude", "codex", "kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "github-copilot", "muse"];

/// Hosting must be on. The socket already limits frames to devices in presence.
pub(crate) fn gate(host_enabled: bool) -> Result<()> {
    if !host_enabled {
        return Err(OFF.into());
    }
    Ok(())
}

/// Request nonces seen in the last minute. Requests outside ±60 s or seen before are refused.
#[derive(Default)]
pub(crate) struct Replay {
    seen: HashMap<String, i64>,
}

impl Replay {
    pub(crate) fn check(&mut self, ts: Option<i64>, nonce: Option<&str>, now_ms: i64) -> Result<()> {
        const REFUSED: &str = "This request expired or was already received. Check that both computers' clocks are right.";
        let (Some(ts), Some(nonce)) = (ts, nonce) else { return Err(REFUSED.into()) };
        if !(16..=64).contains(&nonce.len()) || !nonce.chars().all(|c| c.is_ascii_graphic()) || (now_ms - ts).abs() > WINDOW_MS {
            return Err(REFUSED.into());
        }
        // An accepted nonce only needs remembering while its ts is still inside the window.
        self.seen.retain(|_, seen| *seen >= now_ms - WINDOW_MS);
        if self.seen.contains_key(nonce) {
            return Err(REFUSED.into());
        }
        if self.seen.len() >= MAX_SEEN {
            return Err("This computer is busy. Try again in a moment.".into());
        }
        self.seen.insert(nonce.to_owned(), ts);
        Ok(())
    }
}

/// Ids are UUIDs or provider request ids: short, printable, no spaces.
pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 200 || !id.chars().all(|c| c.is_ascii_graphic()) {
        return Err("Invalid id.".into());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) enum Call {
    Subscribe { session_ids: Vec<String> },
    TasksList { limit: usize },
    ProjectIcons { project_ids: Vec<String> },
    Providers { force: bool },
    Models { provider: String, force: bool },
    Start(start::Start),
    Messages { session_id: String, page: MessagePaging },
    Send { session_id: String, text: String },
    Stop { session_id: String },
    Steer { session_id: String, text: String },
    Configure { session_id: String, model: Option<(String, String)>, effort: Option<Option<String>>, mode: Option<String> },
    Approve { session_id: String, request_id: String, approve: bool },
    Answer { session_id: String, request_id: String, response: Value },
    Pull { session_id: String },
    PullDiff { session_id: String, path: Option<String> },
    PullMerge { session_id: String, method: String },
    PullDetect { session_id: String },
    Changes { session_id: String },
    Diff { session_id: String, path: Option<String>, staged: bool },
    BotsList,
    BotThread { bot_id: String },
    BotMessage { bot_id: String, text: String },
    BotPause { bot_id: String, paused: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MessagePaging {
    After { after_id: i64, limit: i64 },
    Tail { limit: i64 },
    Before { before_id: i64, limit: i64 },
}

pub(crate) fn id_param(params: &Value, key: &str) -> Result<String> {
    let id = params[key].as_str().ok_or_else(|| format!("Missing {key}."))?;
    valid_id(id).map_err(|_| format!("Invalid {key}."))?;
    Ok(id.to_owned())
}

pub(crate) fn text_param(params: &Value, key: &str) -> Result<String> {
    let text = params[key].as_str().map(str::trim).unwrap_or_default();
    if text.is_empty() || text.len() > MAX_TEXT {
        return Err("Send between 1 byte and 100 KB of text.".into());
    }
    Ok(text.to_owned())
}

/// A short printable setting (provider, model, mode, effort), or None when absent.
pub(crate) fn name_param(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(value) => {
            let text = value.as_str().filter(|text| !text.is_empty() && text.len() <= 200 && text.chars().all(|c| c.is_ascii_graphic())).ok_or_else(|| format!("Invalid {key}."))?;
            Ok(Some(text.to_owned()))
        }
    }
}

fn force_param(params: &Value) -> Result<bool> {
    match params.get("force").filter(|v| !v.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| "Invalid force.".into()),
    }
}

fn task_limit(params: &Value) -> Result<usize> {
    match params.get("limit").filter(|value| !value.is_null()) {
        None => Ok(TASKS_DEFAULT),
        Some(value) => value
            .as_u64()
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| *limit <= TASKS_MAX)
            .ok_or_else(|| format!("Limit must be between 0 and {TASKS_MAX}.")),
    }
}

fn message_paging(params: &Value) -> Result<MessagePaging> {
    let tail = match params.get("tail").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_bool().ok_or("Invalid tail.")?),
    };
    let before_id = match params.get("beforeId").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_i64().filter(|id| *id >= 0).ok_or("Invalid beforeId.")?),
    };
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .and_then(|limit| i64::try_from(limit).ok())
                .filter(|limit| (1..=PAGE_ROWS).contains(limit))
                .ok_or_else(|| format!("Limit must be between 1 and {PAGE_ROWS}."))?,
        ),
    };
    if tail == Some(true) && before_id.is_some() {
        return Err("Use tail or beforeId, not both.".into());
    }
    if params.get("afterId").is_some() && (tail == Some(true) || before_id.is_some()) {
        return Err("Use afterId or newest-first paging, not both.".into());
    }
    Ok(if tail == Some(true) {
        MessagePaging::Tail { limit: limit.unwrap_or(MESSAGE_PAGE_DEFAULT) }
    } else if let Some(before_id) = before_id {
        MessagePaging::Before { before_id, limit: limit.unwrap_or(MESSAGE_PAGE_DEFAULT) }
    } else {
        MessagePaging::After {
            after_id: params["afterId"].as_i64().unwrap_or(0).max(0),
            limit: limit.unwrap_or(PAGE_ROWS),
        }
    })
}

fn path_param(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => {
            let path = value.as_str().filter(|path| !path.is_empty() && path.len() <= MAX_PATH && !path.contains('\0')).ok_or_else(|| format!("Invalid {key}."))?;
            if !Path::new(path).components().all(|part| match part {
                Component::Normal(name) => name != ".git",
                Component::CurDir => true,
                _ => false,
            }) {
                return Err(format!("Invalid {key}."));
            }
            Ok(Some(path.to_owned()))
        }
    }
}

fn staged_param(params: &Value) -> Result<bool> {
    match params.get("staged").filter(|value| !value.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| "Invalid staged.".into()),
    }
}

fn project_icon_ids(params: &Value) -> Result<Vec<String>> {
    let ids = params.get("projectIds").and_then(Value::as_array).ok_or("Missing projectIds.")?;
    if ids.is_empty() || ids.len() > MAX_PROJECT_ICON_IDS {
        return Err(format!("Request 1 to {MAX_PROJECT_ICON_IDS} project icons at a time."));
    }
    ids.iter()
        .map(|id| id.as_str().filter(|id| valid_id(id).is_ok()).map(str::to_owned).ok_or_else(|| "Invalid projectIds.".to_owned()))
        .collect()
}

fn configure(params: &Value) -> Result<Call> {
    let model = match (name_param(params, "provider")?, name_param(params, "model")?) {
        (Some(provider), Some(model)) => Some((provider, model)),
        (None, None) => None,
        _ => return Err("Send a provider with the model.".into()),
    };
    let effort = params.get("effort").map(|_| name_param(params, "effort")).transpose()?;
    Ok(Call::Configure { session_id: id_param(params, "sessionId")?, model, effort, mode: name_param(params, "mode")? })
}

/// Validates a request. Everything is refused while hosting is off.
pub(crate) fn parse(host_enabled: bool, method: &str, params: &Value) -> Result<Call> {
    if !host_enabled {
        return Err(OFF.into());
    }
    Ok(match method {
        "subscribe" => {
            let ids = params["sessionIds"].as_array().ok_or("Missing sessionIds.")?;
            if ids.len() > MAX_IDS {
                return Err(format!("Mirror up to {MAX_IDS} tasks per computer."));
            }
            let session_ids = ids.iter().map(|id| id.as_str().filter(|id| valid_id(id).is_ok()).map(str::to_owned).ok_or("Invalid sessionIds.")).collect::<std::result::Result<_, _>>()?;
            Call::Subscribe { session_ids }
        }
        "tasks.list" => Call::TasksList { limit: task_limit(params)? },
        "projects.icons" => Call::ProjectIcons { project_ids: project_icon_ids(params)? },
        "providers.list" => Call::Providers { force: force_param(params)? },
        "providers.models" => {
            let provider = name_param(params, "provider")?.ok_or("Missing provider.")?;
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err("Unknown provider.".into());
            }
            Call::Models { provider, force: force_param(params)? }
        }
        "task.start" => Call::Start(start::parse(params)?),
        "task.messages" => Call::Messages { session_id: id_param(params, "sessionId")?, page: message_paging(params)? },
        "task.send" => Call::Send { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")? },
        "task.stop" => Call::Stop { session_id: id_param(params, "sessionId")? },
        "task.steer" => Call::Steer { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")? },
        "task.configure" => configure(params)?,
        "approval.respond" => Call::Approve { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, approve: params["approve"].as_bool().ok_or("Missing approve.")? },
        "input.respond" => Call::Answer { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, response: params.get("response").cloned().ok_or("Missing response.")? },
        "task.pull" => Call::Pull { session_id: id_param(params, "sessionId")? },
        "task.pullDiff" => Call::PullDiff { session_id: id_param(params, "sessionId")?, path: path_param(params, "path")? },
        "task.pullMerge" => {
            let method = name_param(params, "method")?.ok_or("Missing method.")?;
            crate::github_pull::merge_flag(&method)?;
            Call::PullMerge { session_id: id_param(params, "sessionId")?, method }
        }
        "task.pullDetect" => Call::PullDetect { session_id: id_param(params, "sessionId")? },
        "task.changes" => Call::Changes { session_id: id_param(params, "sessionId")? },
        "task.diff" => Call::Diff { session_id: id_param(params, "sessionId")?, path: path_param(params, "path")?, staged: staged_param(params)? },
        "bots.list" => Call::BotsList,
        "bot.thread" => Call::BotThread { bot_id: id_param(params, "botId")? },
        "bot.message" => Call::BotMessage { bot_id: id_param(params, "botId")?, text: text_param(params, "text")? },
        "bot.pause" => Call::BotPause { bot_id: id_param(params, "botId")?, paused: params.get("paused").and_then(Value::as_bool).ok_or("Missing paused.")? },
        _ => return Err("Unknown method.".into()),
    })
}

/// The response to one request frame, or None when it has no usable id.
pub(crate) async fn handle(app: &tauri::AppHandle, from: &str, message: &Value) -> Option<Value> {
    let id = message["id"].as_str().filter(|id| valid_id(id).is_ok())?;
    let admitted = {
        let state = remote(app);
        let mut inner = state.lock();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let enabled = inner.settings.host_enabled;
        gate(enabled).and_then(|_| inner.replay.check(message["ts"].as_i64(), message["nonce"].as_str(), now_ms)).map(|_| enabled)
    };
    let result = match admitted.and_then(|enabled| parse(enabled, message["method"].as_str().unwrap_or_default(), &message["params"])) {
        Ok(call) => run(app, from, call).await,
        Err(error) => Err(error),
    };
    Some(match result {
        Ok(result) => json!({"type": "res", "id": id, "ok": true, "result": result}),
        Err(error) => json!({"type": "res", "id": id, "ok": false, "error": error}),
    })
}

/// The task must exist here; a mirror never forwards a second hop.
fn local_task(state: &AppState, session_id: &str) -> Result<()> {
    let _task = local_session(state, session_id)?;
    Ok(())
}

fn local_session(state: &AppState, session_id: &str) -> Result<crate::storage::Session> {
    let task = state.store.lock().map_err(|e| e.to_string())?.session(session_id)?;
    if task.remote_device.is_some() {
        return Err("That task runs on another computer.".into());
    }
    Ok(task)
}

fn task_root(state: &AppState, session_id: &str) -> Result<PathBuf> {
    let task = local_session(state, session_id)?;
    state.store.lock().map_err(|e| e.to_string())?.workspace_root(&task.project_id, Some(session_id))
}

fn linked_pull(state: &AppState, session_id: &str) -> Result<(PathBuf, i64)> {
    let task = local_session(state, session_id)?;
    let number = task.pull_request.as_ref().map(|link| link.number).ok_or("This task has no linked pull request.")?;
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(&task.project_id, Some(session_id))?;
    Ok((root, number))
}

fn optional_pull(state: &AppState, session_id: &str) -> Result<Option<(PathBuf, i64)>> {
    let task = local_session(state, session_id)?;
    let Some(number) = task.pull_request.map(|link| link.number) else { return Ok(None) };
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(&task.project_id, Some(session_id))?;
    Ok(Some((root, number)))
}

async fn run(app: &tauri::AppHandle, from: &str, call: Call) -> Result<Value> {
    let state = app.state::<AppState>();
    match call {
        Call::Subscribe { session_ids } => {
            let tasks = subscribed_tasks(&state, &session_ids)?;
            let state = remote(app);
            let mut inner = state.lock();
            let subscriber = inner.subscribers.entry(from.to_owned()).or_default();
            // Added to, not replaced: a task started a moment ago may not be in the list yet.
            // An expired (or overgrown) subscription starts over.
            if subscriber.until.is_none_or(|until| until <= Instant::now()) || subscriber.sessions.len() > 4 * MAX_IDS {
                subscriber.sessions.clear();
            }
            subscriber.until = Some(Instant::now() + SUBSCRIPTION);
            subscriber.sessions.extend(session_ids);
            Ok(json!({"tasks": tasks}))
        }
        Call::TasksList { limit } => {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                tasks_list(&state, limit)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Call::ProjectIcons { project_ids } => {
            let handle = app.clone();
            crate::blocking(move || {
                let state = handle.state::<AppState>();
                project_icons(&state, &project_ids)
            })
            .await
        }
        Call::Providers { force } => {
            let mut providers = serde_json::to_value(crate::local_providers(force).await).map_err(|e| e.to_string())?;
            fit_providers(&mut providers);
            Ok(providers)
        }
        Call::Models { provider, force } => {
            let mut models = serde_json::to_value(crate::local_provider_models(&provider, force).await?).map_err(|e| e.to_string())?;
            if let Some(list) = models.as_array_mut() {
                fit_list(list, PAGE_BUDGET);
            }
            Ok(models)
        }
        Call::Start(request) => start::run(app, from, request).await,
        Call::Messages { session_id, page } => {
            local_task(&state, &session_id)?;
            let store = state.store.lock().map_err(|e| e.to_string())?;
            match page {
                MessagePaging::After { after_id, limit } if limit == PAGE_ROWS => messages_page(&store.db, &session_id, after_id),
                page => messages_page_with(&store.db, &session_id, page),
            }
        }
        Call::Send { session_id, text } => {
            local_task(&state, &session_id)?;
            // Like Enter in the composer: a running task queues the message.
            let busy = || state.agents.lock().map(|agents| agents.contains_key(&session_id)).map_err(|e| e.to_string());
            if busy()? {
                let entry = message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, &session_id, &text, &json!([]))?;
                // If the run ended between the check and the add, nothing would deliver the
                // entry: take it back (unless a run end already did) and send it now.
                if busy()? || message_queue::take(&*state.store.lock().map_err(|e| e.to_string())?, &entry.id).is_err() {
                    let _ = app.emit("queue-changed", json!({"sessionId": session_id}));
                    return Ok(json!({"queued": true}));
                }
            }
            crate::send_message(app.clone(), state, session_id, text, None, None).await?;
            let _ = app.emit("sessions-changed", ());
            Ok(json!({"queued": false}))
        }
        Call::Stop { session_id } => {
            local_task(&state, &session_id)?;
            crate::stop_session(app.clone(), state, session_id).await?;
            Ok(json!({}))
        }
        Call::Steer { session_id, text } => {
            local_task(&state, &session_id)?;
            message_queue::steer_task(app.clone(), state, session_id, text).await
        }
        Call::Configure { session_id, model, effort, mode } => {
            local_task(&state, &session_id)?;
            if let Some((provider, _)) = &model {
                start::require_installed(provider).await?;
            }
            if let Some(mode) = mode {
                crate::update_session(app.clone(), state.clone(), session_id.clone(), None, None, None, Some(mode)).await?;
            }
            if let Some((provider, model)) = model {
                crate::configure_session(app.clone(), state.clone(), session_id.clone(), provider, model, None).await?;
            }
            if let Some(effort) = effort {
                crate::set_reasoning_effort(app.clone(), state, session_id, effort).await?;
            }
            let _ = app.emit("sessions-changed", ());
            Ok(json!({}))
        }
        Call::Approve { session_id, request_id, approve } => {
            local_task(&state, &session_id)?;
            crate::respond_approval(app.clone(), state, session_id.clone(), request_id.clone(), approve).await?;
            // Clear the card in this computer's window, as bot approvals do.
            let event = AgentEvent { session_id, kind: "approval_cancelled".into(), text: String::new(), request_id: Some(request_id), data: None, tool: None };
            let _ = app.emit("agent-event", event);
            Ok(json!({}))
        }
        Call::Answer { session_id, request_id, response } => {
            local_task(&state, &session_id)?;
            crate::respond_user_input(app.clone(), state, session_id, request_id, response).await?;
            Ok(json!({}))
        }
        Call::Pull { session_id } => {
            let Some((root, number)) = optional_pull(&state, &session_id)? else { return Ok(json!({"pull": null })) };
            let pull = crate::blocking(move || crate::github_pull::detail(&root, number)).await?;
            let mut pull = serde_json::to_value(pull).map_err(|e| e.to_string())?;
            fit_pull_detail(&mut pull);
            Ok(json!({"pull": pull}))
        }
        Call::PullDiff { session_id, path } => {
            let (root, number) = linked_pull(&state, &session_id)?;
            if let Some(path) = path {
                let patch = crate::blocking(move || {
                    let diff = crate::github_pull::diff(&root, number)?;
                    let (patch, truncated) = pull_file_patch(&diff.patch, &path, diff.truncated);
                    Ok::<_, String>(bounded_diff(patch, truncated))
                }).await?;
                Ok(json!({"patch": patch.0, "truncated": patch.1}))
            } else {
                let files = crate::blocking(move || crate::github_pull::detail(&root, number).map(|detail| detail.files)).await?;
                Ok(fit_pull_files(serde_json::to_value(files).map_err(|e| e.to_string())?))
            }
        }
        Call::PullMerge { session_id, method } => {
            let (root, number) = linked_pull(&state, &session_id)?;
            crate::github_pull::merge_flag(&method)?;
            let store = state.store.clone();
            crate::blocking(move || {
                let link = crate::github_pull::merge(&root, number, &method)?;
                store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&link)).map(|_| ())
            })
            .await?;
            let _ = app.emit("sessions-changed", ());
            Ok(json!({}))
        }
        Call::PullDetect { session_id } => detect_pull(app, &state, &session_id).await,
        Call::Changes { session_id } => {
            let root = task_root(&state, &session_id)?;
            crate::blocking(move || {
                let status = crate::workspace::git_status(&root)?;
                let (ahead, behind) = if status.is_repo { ahead_behind(&root)? } else { (0, 0) };
                Ok(changes_reply(status, ahead, behind))
            })
            .await
        }
        Call::Diff { session_id, path, staged } => {
            let root = task_root(&state, &session_id)?;
            crate::blocking(move || {
                let diff = crate::workspace::git_diff(&root, path, staged)?;
                let underlying_truncated = diff.contains("[Preview truncated at 256 KiB]");
                let (diff, truncated) = bounded_diff(diff, underlying_truncated);
                Ok(json!({"diff": diff, "truncated": truncated}))
            })
            .await
        }
        Call::BotsList => {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                bots_list(&state)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Call::BotThread { bot_id } => {
            let store = state.store.clone();
            let (session_id, created) = tauri::async_runtime::spawn_blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                let bot = crate::bots::get(&store, &bot_id)?;
                crate::bots::thread_session(&store, &bot, crate::bots::DESKTOP, crate::bots::DESKTOP, &format!("{} · You", bot.name))
            })
            .await
            .map_err(|e| e.to_string())??;
            if created {
                let _ = app.emit("sessions-changed", ());
                let _ = app.emit("bots-changed", ());
            }
            Ok(json!({"sessionId": session_id}))
        }
        Call::BotMessage { bot_id, text } => {
            let session_id = crate::bots::bot_message(app.clone(), bot_id, text).await?;
            Ok(json!({"sessionId": session_id}))
        }
        Call::BotPause { bot_id, paused } => {
            if paused {
                crate::bots::gateway::stop_bot(app, &bot_id).await;
            }
            let store = state.store.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::bots::set_paused(&*store.lock().map_err(|e| e.to_string())?, &bot_id, paused).map(|_| ())
            })
            .await
            .map_err(|e| e.to_string())??;
            let _ = app.emit("bots-changed", ());
            Ok(json!({}))
        }
    }
}

async fn detect_pull(app: &tauri::AppHandle, state: &AppState, session_id: &str) -> Result<Value> {
    local_task(state, session_id)?;
    let (root, turn, started, existing_number) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(session_id)?;
        if task.pull_request.as_ref().is_some_and(|link| ["open", "draft"].contains(&link.state.as_str())) {
            return Ok(json!({"pull": null}));
        }
        let mut turn = Vec::new();
        let mut started = 0;
        for message in store.messages(session_id, None)? {
            if message.role == "user" {
                started = message.created_at;
                break;
            }
            turn.push(message.content);
        }
        if !turn.iter().any(|text| text.contains("/pull/")) {
            return Ok(json!({"pull": null}));
        }
        (
            store.workspace_root(&task.project_id, Some(session_id))?,
            turn,
            started,
            task.pull_request.map(|link| link.number),
        )
    };
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    let pull = crate::blocking(move || {
        let repo = match crate::github::repository(&root) {
            Ok(repo) => repo,
            Err(error) if error.is_empty() => return Ok(None),
            Err(error) => return Err(error),
        };
        let branch = crate::workspace::git_status(&root).map(|status| status.branch).unwrap_or_default();
        let Some(link) = crate::github_pull::detect(&root, &repo, &turn, &branch, started)? else { return Ok(None) };
        if existing_number == Some(link.number) {
            return Ok(None);
        }
        let mut pull = serde_json::to_value(crate::github_pull::detail(&root, link.number)?).map_err(|e| e.to_string())?;
        fit_pull_detail(&mut pull);
        let store = store.lock().map_err(|e| e.to_string())?;
        if store.session(&session_id)?.pull_request.is_some_and(|current| current.number == link.number) {
            return Ok(None);
        }
        store.set_task_link(&session_id, "pull", Some(&link))?;
        Ok(Some(pull))
    })
    .await?;
    if pull.is_some() {
        let _ = app.emit("sessions-changed", ());
    }
    Ok(json!({"pull": pull}))
}

fn bots_list(state: &AppState) -> Result<Value> {
    let active: HashSet<String> = state.agents.lock().map_err(|e| e.to_string())?.keys().cloned().collect();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let active_projects: HashSet<String> = store
        .sessions()?
        .into_iter()
        .filter(|task| active.contains(&task.id))
        .map(|task| task.project_id)
        .collect();
    let mut items = Vec::new();
    for bot in crate::bots::list(&store)? {
        let desktop_session: Option<String> = store
            .db
            .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2", rusqlite::params![bot.id, crate::bots::DESKTOP], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let avatar = (bot.avatar.len() <= MAX_BOT_AVATAR_BYTES).then_some(bot.avatar);
        let state = if bot.paused { "paused" } else if active_projects.contains(&bot.project_id) { "working" } else { "ready" };
        items.push(json!({
            "id": bot.id,
            "name": bot.name,
            "avatar": avatar,
            "state": state,
            "paused": bot.paused,
            "desktopSession": desktop_session,
            "projectId": bot.project_id,
        }));
    }
    fit_list(&mut items, PAGE_BUDGET.saturating_sub(json!({"bots": []}).to_string().len()));
    Ok(json!({"bots": items}))
}

fn ahead_behind(root: &Path) -> Result<(usize, usize)> {
    let mut command = Command::new("git");
    command.args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).current_dir(root);
    let output = crate::workspace::run_process(command, "Git", 8192, Duration::from_secs(10))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr.bytes).to_ascii_lowercase();
        if error.contains("upstream") || error.contains("unknown revision") || error.contains("ambiguous argument") {
            return Ok((0, 0));
        }
        return match crate::workspace::checked(output) {
            Err(error) => Err(error),
            Ok(_) => Err("Git operation failed".into()),
        };
    }
    let capture = crate::workspace::checked(output)?;
    let counts = std::str::from_utf8(&capture.bytes).map_err(|_| "Git returned invalid ahead/behind counts")?;
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|value| value.parse::<usize>().ok()).ok_or("Git returned invalid ahead/behind counts")?;
    let behind = parts.next().and_then(|value| value.parse::<usize>().ok()).ok_or("Git returned invalid ahead/behind counts")?;
    if parts.next().is_some() {
        return Err("Git returned invalid ahead/behind counts".into());
    }
    Ok((ahead, behind))
}

fn changes_reply(status: crate::workspace::GitStatus, ahead: usize, behind: usize) -> Value {
    let mut files: Vec<Value> = status
        .files
        .into_iter()
        .map(|file| {
            let staged = file.index != " " && file.index != "?";
            let status = if file.index == "?" { "??".to_owned() } else if file.index == " " { file.working } else if file.working == " " { file.index } else { format!("{}{}", file.index, file.working) };
            json!({"path": file.path, "status": status, "staged": staged})
        })
        .collect();
    fit_list(&mut files, PAGE_BUDGET.saturating_sub(json!({"branch": status.branch, "ahead": ahead, "behind": behind, "files": []}).to_string().len()));
    let mut reply = json!({"branch": status.branch, "ahead": ahead, "behind": behind, "files": files});
    shrink(&mut reply, PAGE_BUDGET);
    reply
}

fn bounded_diff(mut diff: String, truncated: bool) -> (String, bool) {
    const MARKER: &str = "\n…[cut on the host to fit a remote diff]";
    if diff.len() <= DIFF_BUDGET && !truncated {
        return (diff, false);
    }
    let end = (DIFF_BUDGET - MARKER.len()).min(diff.len());
    diff.truncate(head(&diff, end).len());
    diff.push_str(MARKER);
    (diff, true)
}

fn unquote_git_path(path: &str) -> Option<String> {
    if !path.starts_with('"') {
        return Some(path.to_owned());
    }
    let bytes = path.as_bytes();
    let (mut index, mut decoded) = (1, Vec::new());
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return String::from_utf8(decoded).ok(),
            b'\\' => {
                index += 1;
                let escape = *bytes.get(index)?;
                match escape {
                    b'"' | b'\\' => decoded.push(escape),
                    b'a' => decoded.push(7),
                    b'b' => decoded.push(8),
                    b't' => decoded.push(b'\t'),
                    b'n' => decoded.push(b'\n'),
                    b'v' => decoded.push(11),
                    b'f' => decoded.push(12),
                    b'r' => decoded.push(b'\r'),
                    b'0'..=b'7' => {
                        let mut value = (escape - b'0') as u16;
                        for _ in 0..2 {
                            if bytes.get(index + 1).is_some_and(|byte| (b'0'..=b'7').contains(byte)) {
                                index += 1;
                                value = value * 8 + (bytes[index] - b'0') as u16;
                            } else {
                                break;
                            }
                        }
                        decoded.push(u8::try_from(value).ok()?);
                    }
                    _ => return None,
                }
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    None
}

fn path_from_diff_header(line: &str) -> Option<String> {
    let line = line.strip_prefix("--- ").or_else(|| line.strip_prefix("+++ "))?;
    let path = line.split('\t').next()?;
    let decoded = unquote_git_path(path)?;
    decoded.strip_prefix("a/").or_else(|| decoded.strip_prefix("b/")).map(str::to_owned)
}

fn pull_file_patch(diff: &str, path: &str, source_truncated: bool) -> (String, bool) {
    let starts: Vec<usize> = diff
        .match_indices("diff --git ")
        .filter_map(|(index, _)| (index == 0 || diff.as_bytes().get(index - 1) == Some(&b'\n')).then_some(index))
        .collect();
    for (position, start) in starts.iter().copied().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(diff.len());
        let section = &diff[start..end];
        let header = section.lines().take_while(|line| !line.starts_with("@@") && *line != "GIT binary patch");
        let matches_headers = header
            .clone()
            .filter_map(path_from_diff_header)
            .any(|candidate| candidate == path)
            || header
                .clone()
                .filter_map(|line| line.strip_prefix("rename from ").or_else(|| line.strip_prefix("rename to ")))
                .filter_map(unquote_git_path)
                .any(|candidate| candidate == path)
            || header.filter_map(|line| line.strip_prefix("Binary files ")).any(|paths| {
                paths
                    .strip_suffix(" differ")
                    .and_then(|paths| paths.split_once(" and "))
                    .is_some_and(|(left, right)| {
                        [left, right].into_iter().filter_map(unquote_git_path).filter_map(|file| file.strip_prefix("a/").or_else(|| file.strip_prefix("b/")).map(str::to_owned)).any(|file| file == path)
                    })
            });
        let matches = matches_headers;
        if matches {
            return (section.to_owned(), source_truncated && end == diff.len());
        }
    }
    (String::new(), source_truncated)
}

fn fit_pull_files(mut files: Value) -> Value {
    let Some(list) = files.as_array_mut() else { return json!({"files": [], "truncated": false}) };
    let count = list.len();
    fit_list(list, PAGE_BUDGET.saturating_sub(json!({"files": [], "truncated": true}).to_string().len()));
    let truncated = list.len() < count;
    json!({"files": files, "truncated": truncated})
}

fn fit_pull_detail(pull: &mut Value) {
    let budget = PAGE_BUDGET.saturating_sub(16);
    let mut truncated = pull["bodyTruncated"].as_bool().unwrap_or(false);
    pull["truncated"] = json!(truncated);
    const ARRAYS: [&str; 5] = ["timeline", "files", "commits", "checks", "labels"];
    while pull.to_string().len() > budget {
        let largest = ARRAYS
            .iter()
            .filter_map(|key| pull.get(*key).and_then(Value::as_array).filter(|items| !items.is_empty()).map(|items| (*key, json!(items).to_string().len())))
            .max_by_key(|(_, size)| *size);
        let body_len = pull["body"].as_str().map(str::len).unwrap_or_default();
        if let Some((key, _)) = largest.filter(|(_, size)| *size >= body_len || body_len <= 2 * CUT.len()) {
            if let Some(items) = pull.get_mut(key).and_then(Value::as_array_mut) {
                let budget = json!(items).to_string().len() / 2;
                fit_list(items, budget);
            }
            truncated = true;
        } else if body_len > 2 * CUT.len() {
            let size = pull.to_string().len();
            let target = body_len.saturating_sub(size.saturating_sub(budget)).saturating_sub(CUT.len());
            let text = pull["body"].as_str().unwrap_or_default();
            pull["body"] = json!(format!("{}{}", head(text, target), CUT));
            pull["bodyTruncated"] = json!(true);
            truncated = true;
        } else if let Some((key, _)) = largest {
            if let Some(items) = pull.get_mut(key).and_then(Value::as_array_mut) {
                let budget = json!(items).to_string().len() / 2;
                fit_list(items, budget);
            }
            truncated = true;
        } else {
            shrink(pull, budget);
            truncated = true;
            break;
        }
        pull["truncated"] = json!(truncated);
    }
    pull["truncated"] = json!(truncated);
}

#[derive(Clone, Copy)]
struct LiveTiming {
    last_event_at: i64,
    run_started_at: Option<i64>,
}

struct LiveRun {
    timing: LiveTiming,
    subagents: Vec<Value>,
    subagents_truncated: bool,
}

fn add_live_timing(task: &mut Value, timing: Option<LiveTiming>) {
    let Some(timing) = timing else { return };
    task["lastEventAt"] = json!(timing.last_event_at);
    if let Some(started_at) = timing.run_started_at {
        task["runStartedAt"] = json!(started_at);
    }
}

/// Fits desktop-shaped child snapshots into a small slice of the response budget.
fn bounded_subagents(activities: &[crate::providers::SubagentActivity], budget: usize) -> Result<(Vec<Value>, bool)> {
    let mut items = Vec::new();
    let mut truncated = activities.len() > MAX_SUBAGENT_SNAPSHOT;
    for activity in activities.iter().take(MAX_SUBAGENT_SNAPSHOT) {
        let mut item = serde_json::to_value(activity).map_err(|error| error.to_string())?;
        let original_size = item.to_string().len();
        let current_size = json!(&items).to_string().len();
        let separator = usize::from(!items.is_empty());
        let remaining = budget.saturating_sub(current_size.saturating_add(separator));
        shrink(&mut item, remaining);
        let item_size = item.to_string().len();
        if item_size > remaining {
            truncated = true;
            break;
        }
        truncated |= item_size < original_size;
        items.push(item);
    }
    truncated |= items.len() < activities.len();
    Ok((items, truncated))
}

fn live_run(agent: &crate::RunningAgent) -> Result<LiveRun> {
    let activities = agent
        .subagents
        .lock()
        .map_err(|error| error.to_string())?
        .merge_history(Vec::new());
    let (subagents, subagents_truncated) = bounded_subagents(&activities, SUBAGENT_SNAPSHOT_BUDGET)?;
    Ok(LiveRun {
        timing: LiveTiming {
            last_event_at: agent.last_event.load(Ordering::SeqCst),
            run_started_at: None,
        },
        subagents,
        subagents_truncated,
    })
}

/// Returns local tasks and their projects for a viewer's task picker. Store::sessions
/// already omits drafts and architect workers; mirrors are filtered and bot workspaces tagged here.
fn tasks_list(state: &AppState, limit: usize) -> Result<Value> {
    let (last_event_by_session, pending_by_session) = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let mut last_event = HashMap::new();
        let mut pending = HashMap::new();
        for (session_id, agent) in agents.iter() {
            last_event.insert(session_id.clone(), agent.last_event.load(Ordering::SeqCst));
            let requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
            let items = pending_items(&requests);
            if !items.is_empty() {
                pending.insert(session_id.clone(), items);
            }
        }
        (last_event, pending)
    };
    let (sessions, project_rows, bots_by_project) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bots = crate::bots::list(&store)?.into_iter().map(|bot| (bot.project_id, (bot.id, bot.name))).collect::<HashMap<_, _>>();
        (store.sessions()?, store.projects()?, bots)
    };
    let bot_projects: HashSet<String> = bots_by_project.keys().cloned().collect();

    let project_chats: HashSet<String> = project_rows
        .iter()
        .filter(|project| !bot_projects.contains(&project.id) && crate::chats::is_chat_folder(Path::new(&project.path)))
        .map(|project| project.id.clone())
        .collect();
    let projects: Vec<Value> = project_rows
        .into_iter()
        .filter(|project| !bot_projects.contains(&project.id))
        .map(|project| {
            let repo = crate::github_hub::project_repo(Path::new(&project.path));
            json!({"id": project.id, "name": project.name, "repo": repo})
        })
        .collect();
    let project_names: HashMap<String, String> = projects
        .iter()
        .filter_map(|project| Some((project["id"].as_str()?.to_owned(), project["name"].as_str()?.to_owned())))
        .collect();
    let mut sessions: Vec<_> = sessions
        .into_iter()
        .filter(|task| task.remote_device.is_none() && (project_names.contains_key(&task.project_id) || bot_projects.contains(&task.project_id)))
        .collect();
    sessions.sort_by(|a, b| activity_at(b).cmp(&activity_at(a)).then_with(|| a.id.cmp(&b.id)));
    let tasks: Vec<Value> = sessions
        .into_iter()
        .take(limit)
        .map(|task| {
            let status = if matches!(task.status.as_str(), "running" | "waiting") && !last_event_by_session.contains_key(&task.id) { "interrupted" } else { task.status.as_str() };
            let project_name = project_names.get(&task.project_id).or_else(|| bots_by_project.get(&task.project_id).map(|(_, name)| name)).cloned().unwrap_or_default();
            let run_started_at = task.last_prompt_at;
            let mut item = json!({
                "sessionId": task.id,
                "title": task.title,
                "status": status,
                "projectId": task.project_id,
                "projectName": project_name,
                "provider": task.provider,
                "model": task.model,
                "effort": task.reasoning_effort,
                "mode": task.mode,
                "pinned": task.pinned,
                "updatedAt": task.updated_at,
                "lastPromptAt": task.last_prompt_at,
                "pending": pending_by_session.get(&task.id).cloned().unwrap_or_default(),
            });
            if let Some(&last_event_at) = last_event_by_session.get(&task.id) {
                add_live_timing(&mut item, Some(LiveTiming { last_event_at, run_started_at }));
            }
            if let Some((bot_id, bot_name)) = bots_by_project.get(&task.project_id) {
                item["botId"] = json!(bot_id);
                item["botName"] = json!(bot_name);
            }
            if let Some(branch) = task.worktree_branch {
                item["branch"] = json!(branch);
            }
            if project_chats.contains(&task.project_id) {
                item["chat"] = json!(true);
            }
            item
        })
        .collect();
    Ok(fit_task_lists(tasks, projects))
}

/// Resolves only registered non-bot projects, keeping filesystem icon reads off the async runtime.
fn project_icons(state: &AppState, ids: &[String]) -> Result<Value> {
    let project_paths = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bot_projects: HashSet<String> = crate::bots::project_ids(&store)?.into_iter().collect();
        store
            .projects()?
            .into_iter()
            .filter(|project| !bot_projects.contains(&project.id))
            .map(|project| (project.id, std::path::PathBuf::from(project.path)))
            .collect::<HashMap<_, _>>()
    };
    let entries = ids.iter().filter_map(|id| {
        project_paths.get(id).map(|path| (id.clone(), crate::project_icon::find(path)))
    });
    Ok(fit_project_icons(entries))
}

fn activity_at(task: &crate::storage::Session) -> i64 {
    task.last_response_at.into_iter().chain(task.last_prompt_at).max().unwrap_or(task.created_at)
}

/// Fits both arrays, including their object envelope, under the relay's reply budget.
fn fit_task_lists(mut tasks: Vec<Value>, mut projects: Vec<Value>) -> Value {
    fit_list(&mut projects, PAGE_BUDGET);
    let task_budget = PAGE_BUDGET.saturating_sub(json!(projects).to_string().len() + 32);
    fit_list(&mut tasks, task_budget);
    while json!({"tasks": &tasks, "projects": &projects}).to_string().len() > PAGE_BUDGET {
        if tasks.pop().is_none() && projects.pop().is_none() {
            break;
        }
    }
    json!({"tasks": tasks, "projects": projects})
}

/// Keeps the result envelope under the frame budget; known projects without a usable icon stay null.
fn fit_project_icons(icons: impl IntoIterator<Item = (String, Option<String>)>) -> Value {
    let mut result = serde_json::Map::new();
    for (id, icon) in icons {
        if result.contains_key(&id) {
            continue;
        }
        let icon = icon.filter(|icon| icon.len() <= MAX_PROJECT_ICON_BYTES).map(Value::String).unwrap_or(Value::Null);
        result.insert(id.clone(), icon);
        if json!({"icons": &result}).to_string().len() > PAGE_BUDGET {
            result.remove(&id);
            break;
        }
    }
    json!({"icons": result})
}

/// Each subscribed task that exists here: its status as this window shows it, its newest
/// message id (so the viewer pulls what it missed) and its title.
fn subscribed_tasks(state: &AppState, ids: &[String]) -> Result<Vec<Value>> {
    let (active_runs, pending_by_session) = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let mut active_runs = HashMap::new();
        let mut pending = HashMap::new();
        for id in ids {
            if let Some(agent) = agents.get(id) {
                active_runs.insert(id.clone(), live_run(agent)?);
                let requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
                pending.insert(id.clone(), pending_items(&requests));
            }
        }
        (active_runs, pending)
    };
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut tasks = Vec::new();
    for id in ids {
        let row: Option<(String, String, i64, Option<i64>)> = store
            .db
            .query_row("SELECT status,title,(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1),last_prompt_at FROM sessions WHERE id=?1 AND remote_device IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((status, title, last_id, last_prompt_at)) = row else { continue };
        // Only a registered agent is really running; a stale row reads as interrupted.
        let status = if active_runs.contains_key(id) || !matches!(status.as_str(), "running" | "waiting") { status } else { "interrupted".into() };
        let pending = pending_by_session.get(id).cloned().unwrap_or_default();
        let mut task = json!({"sessionId": id, "status": status, "lastId": last_id, "title": title, "pending": pending});
        if let Some(run) = active_runs.get(id) {
            add_live_timing(
                &mut task,
                Some(LiveTiming { run_started_at: last_prompt_at, ..run.timing }),
            );
            task["subagents"] = json!(run.subagents);
            if run.subagents_truncated {
                task["subagentsTruncated"] = json!(true);
            }
        }
        tasks.push(task);
    }
    fit_list(&mut tasks, PAGE_BUDGET.saturating_sub(json!({"tasks": []}).to_string().len()));
    Ok(tasks)
}

/// Clones the currently answerable events into a small JSON shape for late subscribers.
fn pending_items(requests: &HashMap<String, AgentEvent>) -> Vec<Value> {
    let mut items: Vec<Value> = requests
        .values()
        .map(|event| {
            let mut item = json!({
                "kind": event.kind,
                "requestId": event.request_id,
                "text": event.text,
                "data": event.data,
            });
            if let Some(tool) = &event.tool {
                item["tool"] = json!(tool);
            }
            shrink(&mut item, MAX_MESSAGE.saturating_sub(1024));
            item
        })
        .collect();
    items.sort_by(|a, b| a["requestId"].as_str().cmp(&b["requestId"].as_str()));
    fit_list(&mut items, MAX_MESSAGE);
    items
}

fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"id": row.get::<_, i64>(0)?, "role": row.get::<_, String>(1)?, "content": row.get::<_, String>(2)?, "createdAt": row.get::<_, i64>(3)?, "turnDurationMs": row.get::<_, Option<i64>>(4)?}))
}

fn message_exists(db: &rusqlite::Connection, session_id: &str, id: i64, older: bool) -> Result<bool> {
    let comparison = if older { "<" } else { ">" };
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id{comparison}?2)"),
        rusqlite::params![session_id, id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Legacy `afterId` page entrypoint used by mirror copies and tests.
pub(crate) fn messages_page(db: &rusqlite::Connection, session_id: &str, after_id: i64) -> Result<Value> {
    messages_page_with(db, session_id, MessagePaging::After { after_id, limit: PAGE_ROWS })
}

/// Reads a message page oldest first, cutting individual messages and the page to fit one frame.
/// `hasMore` means newer rows follow the page; `hasOlder` means older rows precede its first id.
pub(crate) fn messages_page_with(db: &rusqlite::Connection, session_id: &str, page: MessagePaging) -> Result<Value> {
    let title: String = db.query_row("SELECT title FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.ok_or("Conversation not found.")?;
    let last_id: Option<i64> = db
        .query_row("SELECT MAX(id) FROM messages WHERE session_id=?1", [session_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let newest_first = matches!(page, MessagePaging::Tail { .. } | MessagePaging::Before { .. });
    let mut statement = match page {
        MessagePaging::After { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 AND id>?2 ORDER BY id LIMIT ?3"),
        MessagePaging::Tail { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 ORDER BY id DESC LIMIT ?2"),
        MessagePaging::Before { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 AND id<?2 ORDER BY id DESC LIMIT ?3"),
    }
    .map_err(|e| e.to_string())?;
    let mapped = match page {
        MessagePaging::After { after_id, limit } => statement.query_map(rusqlite::params![session_id, after_id, limit], message_row),
        MessagePaging::Tail { limit } => statement.query_map(rusqlite::params![session_id, limit], message_row),
        MessagePaging::Before { before_id, limit } => statement.query_map(rusqlite::params![session_id, before_id, limit], message_row),
    }
    .map_err(|e| e.to_string())?;
    let rows: Vec<Value> = mapped.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    let fetched = rows.len();
    let mut room = PAGE_BUDGET.saturating_sub(json!({"messages": [], "hasMore": false, "hasOlder": false, "title": &title, "lastId": last_id}).to_string().len());
    let mut kept = Vec::new();
    for mut message in rows {
        if message.to_string().len() > MAX_MESSAGE {
            cut(&mut message);
        }
        let size = message.to_string().len() + 1;
        // The first message always fits: once cut it is under the budget.
        if size > room && !kept.is_empty() {
            break;
        }
        room = room.saturating_sub(size);
        kept.push(message);
    }
    if newest_first {
        kept.reverse();
    }
    let first_id = kept.first().and_then(|message| message["id"].as_i64());
    let last_page_id = kept.last().and_then(|message| message["id"].as_i64());
    let has_older = match first_id {
        Some(id) => message_exists(db, session_id, id, true)?,
        None => false,
    };
    let has_more = match page {
        MessagePaging::After { limit, .. } => kept.len() < fetched || fetched as i64 == limit,
        MessagePaging::Tail { .. } => false,
        MessagePaging::Before { .. } => match last_page_id {
            Some(id) => message_exists(db, session_id, id, false)?,
            None => false,
        },
    };
    Ok(json!({"messages": kept, "hasMore": has_more, "hasOlder": has_older, "title": title, "lastId": last_id}))
}

/// Drops the tail of a list until its JSON fits `budget`.
pub(crate) fn fit_list(list: &mut Vec<Value>, budget: usize) {
    let mut size = 2;
    let keep = list.iter().take_while(|item| {
        size += item.to_string().len() + 1;
        size <= budget
    }).count();
    list.truncate(keep);
}

/// Trims the longest model lists until the provider list fits one reply.
pub(crate) fn fit_providers(providers: &mut Value) {
    while providers.to_string().len() > PAGE_BUDGET {
        let Some(models) = providers.as_array_mut().and_then(|list| list.iter_mut().filter_map(|p| p["models"].as_array_mut()).max_by_key(|models| models.len())).filter(|models| !models.is_empty()) else { return };
        let keep = models.len() / 2;
        models.truncate(keep);
    }
}

/// Appends an event to a subscriber's buffer, joining consecutive text deltas.
pub(crate) fn push_event(events: &mut Vec<Value>, event: Value) {
    if event["kind"] == "text" {
        if let Some(last) = events.last_mut().filter(|last| last["kind"] == "text" && last["sessionId"] == event["sessionId"] && last["data"] == event["data"] && last["requestId"] == event["requestId"]) {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or_default(), event["text"].as_str().unwrap_or_default());
            last["text"] = json!(joined);
            return;
        }
    }
    if events.len() < MAX_BUFFER {
        events.push(event);
    }
}

/// Events grouped into frames that each fit the budget; an oversized event is cut.
pub(crate) fn frames(events: Vec<Value>) -> Vec<Vec<Value>> {
    let mut frames = Vec::new();
    let (mut frame, mut size) = (Vec::new(), 0);
    for mut event in events {
        if event.to_string().len() > MAX_MESSAGE {
            shrink(&mut event, MAX_MESSAGE);
        }
        let length = event.to_string().len() + 1;
        if size + length > PAGE_BUDGET && !frame.is_empty() {
            frames.push(std::mem::take(&mut frame));
            size = 0;
        }
        size += length;
        frame.push(event);
    }
    if !frame.is_empty() {
        frames.push(frame);
    }
    frames
}

/// Adds a task to a device's subscription, starting one if it has none.
pub(crate) fn follow(app: &tauri::AppHandle, device: &str, session_id: &str) {
    let state = remote(app);
    let mut inner = state.lock();
    let subscriber = inner.subscribers.entry(device.to_owned()).or_default();
    if subscriber.until.is_none_or(|until| until <= Instant::now()) {
        subscriber.until = Some(Instant::now() + SUBSCRIPTION);
    }
    subscriber.sessions.insert(session_id.to_owned());
}

/// Drops expired subscribers and devices no longer in presence; true if any remain.
fn prune_subscribers(inner: &mut super::Inner, now: Instant) -> bool {
    let super::Inner { subscribers, devices, .. } = inner;
    subscribers.retain(|id, subscriber| subscriber.until.is_some_and(|until| until > now) && devices.iter().any(|d| &d.id == id));
    !subscribers.is_empty()
}

/// Queues an event for every device mirroring its task. Called on the agent-event hot
/// path: nothing is cloned unless someone mirrors this task.
pub(crate) fn agent_event(app: &tauri::AppHandle, event: &AgentEvent) {
    buffer(app, &event.session_id, |subscriber| {
        if let Ok(value) = serde_json::to_value(event) {
            push_event(&mut subscriber.events, value);
        }
    });
}

/// Queues `run.finished` for every device mirroring the task.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool, stopped: bool, text: &str) {
    buffer(app, session_id, |subscriber| subscriber.finished.push(json!({"sessionId": session_id, "successful": successful, "stopped": stopped, "text": text})));
}

fn buffer(app: &tauri::AppHandle, session_id: &str, mut add: impl FnMut(&mut Subscriber)) {
    let Some(state) = app.try_state::<super::Remote>() else { return };
    let schedule = {
        let mut inner = state.lock();
        if !inner.settings.host_enabled || inner.outbox.is_none() || !inner.subscribers.values().any(|s| s.sessions.contains(session_id)) {
            return;
        }
        if !prune_subscribers(&mut inner, Instant::now()) {
            return;
        }
        for subscriber in inner.subscribers.values_mut().filter(|s| s.sessions.contains(session_id)) {
            add(subscriber);
        }
        !std::mem::replace(&mut inner.flushing, true)
    };
    if schedule {
        tauri::async_runtime::spawn(flush(app.clone()));
    }
}

/// Sends each subscriber one `agent.events` frame (more only past the frame budget),
/// then its `run.finished` events, so a run's last deltas always arrive before its end.
async fn flush(app: tauri::AppHandle) {
    tokio::time::sleep(FLUSH).await;
    let batches: Vec<(String, Vec<Value>, Vec<Value>)> = {
        let state = remote(&app);
        let mut inner = state.lock();
        inner.flushing = false;
        let hosting = inner.settings.host_enabled;
        inner.subscribers.iter_mut().filter(|_| hosting).map(|(id, s)| (id.clone(), std::mem::take(&mut s.events), std::mem::take(&mut s.finished))).filter(|(_, events, finished)| !events.is_empty() || !finished.is_empty()).collect()
    };
    for (device, events, finished) in batches {
        for frame in frames(events) {
            let _ = socket::send_to_device(&app, &device, &json!({"type": "event", "name": "agent.events", "data": {"events": frame}}));
        }
        for data in finished {
            let _ = socket::send_to_device(&app, &device, &json!({"type": "event", "name": "run.finished", "data": data}));
        }
    }
}

fn head(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn longest_string(value: &mut Value) -> Option<&mut String> {
    match value {
        Value::String(text) => Some(text),
        Value::Array(items) => items.iter_mut().filter_map(longest_string).max_by_key(|text| text.len()),
        Value::Object(map) => map.values_mut().filter_map(longest_string).max_by_key(|text| text.len()),
        _ => None,
    }
}

/// Halves the longest string in `value`, marking the cut, until it serializes under `max`.
fn shrink(value: &mut Value, max: usize) {
    while value.to_string().len() > max {
        let Some(longest) = longest_string(value).filter(|text| text.len() > 2 * CUT.len()) else { return };
        *longest = format!("{}{CUT}", head(longest, longest.len() / 2));
    }
}

/// Cuts one oversized message. JSON content (tool calls) is cut inside, so it still parses.
fn cut(message: &mut Value) {
    let parsed = message["content"].as_str().and_then(|content| serde_json::from_str::<Value>(content).ok()).filter(Value::is_object);
    if let Some(mut content) = parsed {
        shrink(&mut content, MAX_MESSAGE * 3 / 4);
        message["content"] = json!(content.to_string());
    }
    shrink(message, MAX_MESSAGE);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subagent(id: &str, response: &str) -> crate::providers::SubagentActivity {
        crate::providers::SubagentActivity {
            id: id.into(),
            parent_id: None,
            name: "Reviewer".into(),
            prompt: "Inspect the change".into(),
            status: "running".into(),
            response: response.into(),
            tools: Vec::new(),
            started_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_500,
        }
    }

    #[test]
    fn live_timestamps_are_unix_milliseconds_and_omitted_without_a_run() {
        let mut task = json!({"sessionId": "s1"});
        add_live_timing(&mut task, None);
        assert!(task.get("lastEventAt").is_none());
        assert!(task.get("runStartedAt").is_none());

        add_live_timing(
            &mut task,
            Some(LiveTiming {
                last_event_at: 1_700_000_000_250,
                run_started_at: Some(1_700_000_000_000),
            }),
        );
        assert_eq!(task["lastEventAt"], 1_700_000_000_250_i64);
        assert_eq!(task["runStartedAt"], 1_700_000_000_000_i64);
    }

    #[test]
    fn subagent_snapshots_keep_desktop_shape_and_mark_budget_cuts() {
        let (items, truncated) = bounded_subagents(&[subagent("run:worker", "Reading the source")], 1024).unwrap();
        assert!(!truncated);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "run:worker");
        assert_eq!(items[0]["parentId"], Value::Null);
        assert_eq!(items[0]["name"], "Reviewer");
        assert_eq!(items[0]["prompt"], "Inspect the change");
        assert_eq!(items[0]["status"], "running");
        assert_eq!(items[0]["response"], "Reading the source");
        assert_eq!(items[0]["tools"], json!([]));
        assert_eq!(items[0]["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(items[0]["updatedAt"], 1_700_000_000_500_i64);

        let large = subagent("run:large", &"activity ".repeat(512));
        let (items, truncated) = bounded_subagents(&[large], 512).unwrap();
        assert!(truncated);
        assert_eq!(items.len(), 1);
        assert!(items[0]["response"].as_str().unwrap().ends_with(CUT));
        assert!(json!(items).to_string().len() <= 512);
    }

    #[test]
    fn everything_is_refused_while_hosting_is_off() {
        for method in METHODS {
            assert_eq!(parse(false, method, &json!({"sessionId": "s", "text": "hi", "requestId": "r", "approve": true})), Err(OFF.to_string()));
        }
        assert_eq!(parse(false, "nope", &json!({})), Err(OFF.to_string()));
    }

    #[test]
    fn requests_are_validated() {
        assert_eq!(parse(true, "subscribe", &json!({"sessionIds": ["s1", "s2"]})), Ok(Call::Subscribe { session_ids: vec!["s1".into(), "s2".into()] }));
        assert!(parse(true, "subscribe", &json!({})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": ["a b"]})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": vec!["s"; MAX_IDS + 1]})).is_err());
        assert_eq!(parse(true, "task.send", &json!({"sessionId": "s1", "text": " hi "})), Ok(Call::Send { session_id: "s1".into(), text: "hi".into() }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": 7})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::After { after_id: 7, limit: PAGE_ROWS } }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": -3})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::After { after_id: 0, limit: PAGE_ROWS } }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "effort": null})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: Some(None), mode: None }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "mode": "ask"})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: None, mode: Some("ask".into()) }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "provider": "codex", "model": "gpt"})), Ok(Call::Configure { session_id: "s1".into(), model: Some(("codex".into(), "gpt".into())), effort: None, mode: None }));
        assert!(parse(true, "task.configure", &json!({"sessionId": "s1", "model": "gpt"})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "x".repeat(MAX_TEXT + 1)})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "  "})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "a\nb"})).is_err());
        assert!(parse(true, "task.stop", &json!({})).is_err());
        assert!(parse(true, "approval.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        assert!(parse(true, "input.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        assert_eq!(parse(true, "tasks.list", &json!({})), Ok(Call::TasksList { limit: TASKS_DEFAULT }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": null})), Ok(Call::TasksList { limit: TASKS_DEFAULT }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 500})), Ok(Call::TasksList { limit: 500 }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 1})), Ok(Call::TasksList { limit: 1 }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 0})), Ok(Call::TasksList { limit: 0 }));
        assert!(parse(true, "tasks.list", &json!({"limit": 501})).is_err());
        assert!(parse(true, "tasks.list", &json!({"limit": 1.5})).is_err());
        assert!(parse(true, "tasks.list", &json!({"limit": "20"})).is_err());
        for gone in ["task.get", "shell.exec"] {
            assert!(parse(true, gone, &json!({})).is_err(), "{gone}");
        }
        assert!(valid_id(&"a".repeat(201)).is_err());
    }

    #[test]
    fn task_pull_changes_and_bot_requests_are_validated() {
        for (method, params) in [
            ("task.pull", json!({"sessionId": "s1"})),
            ("task.pullDiff", json!({"sessionId": "s1"})),
            ("task.pullDiff", json!({"sessionId": "s1", "path": "src/main.rs"})),
            ("task.pullMerge", json!({"sessionId": "s1", "method": "squash"})),
            ("task.pullDetect", json!({"sessionId": "s1"})),
            ("task.changes", json!({"sessionId": "s1"})),
            ("task.diff", json!({"sessionId": "s1"})),
            ("task.diff", json!({"sessionId": "s1", "path": "src/main.rs", "staged": true})),
            ("bots.list", json!({})),
            ("bot.thread", json!({"botId": "b1"})),
            ("bot.message", json!({"botId": "b1", "text": "hello"})),
            ("bot.pause", json!({"botId": "b1", "paused": true})),
        ] {
            assert!(parse(true, method, &params).is_ok(), "{method} {params}");
        }

        for (method, params) in [
            ("task.pull", json!({})),
            ("task.pullMerge", json!({"sessionId": "s1", "method": "--admin"})),
            ("task.changes", json!({"sessionId": "bad id"})),
            ("task.diff", json!({"sessionId": "s1", "path": "../secret"})),
            ("task.diff", json!({"sessionId": "s1", "staged": "yes"})),
            ("bot.thread", json!({"botId": "bad id"})),
            ("bot.message", json!({"botId": "b1", "text": "  "})),
            ("bot.pause", json!({"botId": "b1", "paused": "yes"})),
        ] {
            assert!(parse(true, method, &params).is_err(), "{method} {params}");
        }
    }

    #[test]
    fn message_paging_options_are_parsed_and_validated() {
        let tail = parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true})).unwrap();
        assert_eq!(tail, Call::Messages { session_id: "s1".into(), page: MessagePaging::Tail { limit: MESSAGE_PAGE_DEFAULT } });

        let before = parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19, "limit": 25})).unwrap();
        assert_eq!(before, Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: 25 } });
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: MESSAGE_PAGE_DEFAULT } }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 1})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Tail { limit: 1 } }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19, "limit": 400})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: 400 } }));

        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "afterId": 1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 1, "afterId": 2})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "beforeId": 1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 0})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 401})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": "19"})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": -1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": "yes"})).is_err());
    }

    #[test]
    fn pull_diff_and_detail_replies_fit_the_remote_budget() {
        let mut pull = json!({
            "number": 42,
            "title": "A pull request",
            "body": "b".repeat(64 * 1024),
            "bodyTruncated": false,
            "timeline": vec![json!({"body": "c".repeat(16 * 1024)}); 60],
            "files": vec![json!({"path": "src/".to_owned() + &"f".repeat(2048), "additions": 1, "deletions": 0}); 200],
            "commits": [],
            "checks": [],
            "labels": [],
        });
        fit_pull_detail(&mut pull);
        assert_eq!(pull["truncated"], true);
        assert!(pull.to_string().len() <= PAGE_BUDGET);
        assert!(json!({"pull": &pull}).to_string().len() <= PAGE_BUDGET);

        let files = fit_pull_files(json!(vec![json!({"path": "p".repeat(1024), "additions": 3, "deletions": 1}); 300]));
        assert_eq!(files["truncated"], true);
        assert!(files.to_string().len() <= PAGE_BUDGET);

        let mut bots = vec![json!({"avatar": "data:image/png;base64,{}", "id": "bot".repeat(100) }); 12];
        fit_list(&mut bots, PAGE_BUDGET.saturating_sub(json!({"bots": []}).to_string().len()));
        let bots = json!({"bots": bots});
        assert!(bots.to_string().len() <= PAGE_BUDGET);

        let (patch, truncated) = bounded_diff("λ".repeat(DIFF_BUDGET), false);
        assert!(truncated);
        assert!(patch.len() <= DIFF_BUDGET);
        assert!(patch.ends_with("[cut on the host to fit a remote diff]"));

        let source = "diff --git a/first.rs b/first.rs\n--- a/first.rs\n+++ b/first.rs\n@@ -1 +1 @@\n+first\ndiff --git \"a/space name.rs\" \"b/space name.rs\"\n--- \"a/space name.rs\"\n+++ \"b/space name.rs\"\n@@ -1 +1 @@\n+second\n";
        let (selected, truncated) = pull_file_patch(source, "space name.rs", false);
        assert!(selected.contains("+second"));
        assert!(!selected.contains("+first"));
        assert!(!truncated);
        assert_eq!(pull_file_patch(source, "missing.rs", true), (String::new(), true));

        let changes = changes_reply(
            crate::workspace::GitStatus {
                branch: "b".repeat(PAGE_BUDGET),
                files: (0..500).map(|n| crate::workspace::GitFile { path: format!("src/{}-{n}", "f".repeat(512)), index: " ".into(), working: "M".into() }).collect(),
                is_repo: true,
            },
            2,
            1,
        );
        assert!(changes.to_string().len() <= PAGE_BUDGET);
    }

    #[test]
    fn provider_requests_are_validated() {
        assert_eq!(parse(true, "providers.list", &json!({})), Ok(Call::Providers { force: false }));
        assert_eq!(parse(true, "providers.list", &json!({"force": true})), Ok(Call::Providers { force: true }));
        assert!(parse(true, "providers.list", &json!({"force": "yes"})).is_err());
        assert_eq!(parse(true, "providers.models", &json!({"provider": "codex", "force": null})), Ok(Call::Models { provider: "codex".into(), force: false }));
        assert_eq!(parse(true, "providers.models", &json!({"provider": "omp", "force": true})), Ok(Call::Models { provider: "omp".into(), force: true }));
        for bad in [json!({}), json!({"provider": "../bin/sh"}), json!({"provider": "gemini"}), json!({"provider": 3})] {
            assert!(parse(true, "providers.models", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn project_icon_requests_are_validated() {
        assert_eq!(parse(true, "projects.icons", &json!({"projectIds": ["p1", "p2"]})), Ok(Call::ProjectIcons { project_ids: vec!["p1".into(), "p2".into()] }));
        let fifty: Vec<String> = (0..MAX_PROJECT_ICON_IDS).map(|i| format!("p{i}")).collect();
        assert!(parse(true, "projects.icons", &json!({"projectIds": fifty})).is_ok());
        assert!(parse(true, "projects.icons", &json!({})).is_err());
        assert!(parse(true, "projects.icons", &json!({"projectIds": []})).is_err());
        assert!(parse(true, "projects.icons", &json!({"projectIds": vec!["p"; 51]})).is_err());
        for bad in [json!({"projectIds": [""]}), json!({"projectIds": ["bad id"]}), json!({"projectIds": [1]}), json!({"projectIds": "p1"})] {
            assert!(parse(true, "projects.icons", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn project_icons_obey_single_icon_and_reply_budgets() {
        let result = fit_project_icons(vec![
            ("oversized".into(), Some("x".repeat(64 * 1024 + 1))),
            ("empty".into(), None),
            ("first".into(), Some("x".repeat(60 * 1024))),
            ("second".into(), Some("x".repeat(60 * 1024))),
            ("third".into(), Some("x".repeat(60 * 1024))),
            ("after".into(), Some("small".into())),
        ]);
        assert_eq!(result["icons"]["oversized"], Value::Null);
        assert_eq!(result["icons"]["empty"], Value::Null);
        assert!(result["icons"].get("first").is_some());
        assert!(result["icons"].get("second").is_some());
        assert!(result["icons"].get("third").is_none());
        assert!(result["icons"].get("after").is_none());
        assert!(result.to_string().len() <= PAGE_BUDGET);

        let at_limit = fit_project_icons(vec![("at-limit".into(), Some("x".repeat(MAX_PROJECT_ICON_BYTES)))]);
        assert_eq!(at_limit["icons"]["at-limit"].as_str().unwrap().len(), MAX_PROJECT_ICON_BYTES);
    }

    #[test]
    fn provider_lists_are_trimmed_to_one_reply() {
        let model = json!({"id": "m", "name": "x".repeat(1000)});
        let mut list = vec![model.clone(); 400];
        fit_list(&mut list, PAGE_BUDGET);
        assert!(!list.is_empty() && list.len() < 400 && json!(list).to_string().len() <= PAGE_BUDGET);
        let mut small = vec![model.clone(); 3];
        fit_list(&mut small, PAGE_BUDGET);
        assert_eq!(small.len(), 3);
        let mut providers = json!([{"id": "opencode", "models": vec![model.clone(); 400]}, {"id": "claude", "models": [model]}]);
        fit_providers(&mut providers);
        assert!(providers.to_string().len() <= PAGE_BUDGET);
        assert_eq!(providers[1]["models"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn task_and_project_lists_fit_one_reply() {
        let tasks = vec![json!({"title": "t".repeat(1024)}); 110];
        let projects = vec![json!({"name": "p".repeat(900)}); 70];
        let result = fit_task_lists(tasks, projects);
        assert!(result.to_string().len() <= PAGE_BUDGET);
        assert!(!result["tasks"].as_array().unwrap().is_empty());
        assert!(!result["projects"].as_array().unwrap().is_empty());
    }

    #[test]
    fn remote_pending_requests_keep_answer_payloads_within_one_message_budget() {
        let request_id = "run-id:provider-id";
        let requests = HashMap::from([(
            request_id.to_owned(),
            AgentEvent {
                session_id: "task-id".into(),
                kind: "input_request".into(),
                text: "Choose one".into(),
                request_id: Some(request_id.into()),
                data: Some(json!({"question": "x".repeat(MAX_MESSAGE * 2)})),
                tool: None,
            },
        )]);
        let pending = pending_items(&requests);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["kind"], "input_request");
        assert_eq!(pending[0]["requestId"], request_id);
        assert_eq!(pending[0]["text"], "Choose one");
        assert!(pending[0]["data"]["question"].as_str().unwrap().contains("[cut on the host"));
        assert!(pending[0].get("tool").is_none());
        assert!(json!(pending).to_string().len() <= MAX_MESSAGE);
    }

    #[test]
    fn host_gate_only_checks_remote_control() {
        assert_eq!(gate(false), Err(OFF.to_string()));
        assert_eq!(gate(true), Ok(()));
    }

    #[test]
    fn a_present_device_keeps_its_subscription_without_a_pin() {
        let now = Instant::now();
        let mut subscriber = Subscriber::default();
        subscriber.until = Some(now + Duration::from_secs(60));
        let mut inner = super::super::Inner {
            devices: vec![super::super::Device {
                id: "viewer".into(), name: "Phone".into(), platform: "iOS".into(), public_key: "current-key".into(),
                host: false, online: true, last_seen: Value::Null,
            }],
            ..Default::default()
        };
        inner.subscribers.insert("viewer".into(), subscriber);
        assert!(prune_subscribers(&mut inner, now));
        assert!(inner.subscribers.contains_key("viewer"));
    }

    #[test]
    fn replays_and_stale_requests_are_refused() {
        let mut replay = Replay::default();
        let now = 1_000_000_000;
        let nonce = "0123456789abcdef0123";
        assert!(replay.check(Some(now - 1000), Some(nonce), now).is_ok());
        assert!(replay.check(Some(now - 1000), Some(nonce), now + 10).is_err(), "same nonce twice");
        assert!(replay.check(Some(now - 60_001), Some("fresh-nonce-000001"), now).is_err(), "too old");
        assert!(replay.check(Some(now + 60_001), Some("fresh-nonce-000002"), now).is_err(), "too new");
        assert!(replay.check(None, Some("fresh-nonce-000003"), now).is_err());
        assert!(replay.check(Some(now), Some("short"), now).is_err());
        assert!(replay.check(Some(now), None, now).is_err());
        // Seen nonces are pruned once their ts leaves the window.
        assert!(replay.check(Some(now + 61_500), Some("fresh-nonce-000004"), now + 61_500).is_ok());
        assert!(!replay.seen.contains_key(nonce));
    }

    fn event(session: &str, kind: &str, text: &str) -> Value {
        serde_json::to_value(AgentEvent { session_id: session.into(), kind: kind.into(), text: text.into(), request_id: None, data: None, tool: None }).unwrap()
    }

    #[test]
    fn consecutive_text_deltas_are_merged() {
        let mut events = Vec::new();
        for (session, kind, text) in [("a", "text", "Hel"), ("a", "text", "lo"), ("b", "text", "other"), ("a", "text", " there"), ("a", "tool", "ls"), ("a", "text", "!"), ("a", "text", "?")] {
            push_event(&mut events, event(session, kind, text));
        }
        let texts: Vec<(&str, &str)> = events.iter().map(|e| (e["sessionId"].as_str().unwrap(), e["text"].as_str().unwrap())).collect();
        assert_eq!(texts, [("a", "Hello"), ("b", "other"), ("a", " there"), ("a", "ls"), ("a", "!?")]);
        // A delta of another message (its data differs) starts a new event.
        let mut tagged = event("a", "text", "new");
        tagged["data"] = json!({"messageId": "m2"});
        push_event(&mut events, tagged);
        assert_eq!(events.len(), 6);
        // A viewer that falls far behind stops buffering; it catches up at the run end.
        let mut full: Vec<Value> = (0..MAX_BUFFER).map(|i| event("a", "tool", &i.to_string())).collect();
        push_event(&mut full, event("a", "tool", "late"));
        assert_eq!(full.len(), MAX_BUFFER);
    }

    #[test]
    fn events_are_framed_under_the_budget() {
        let events: Vec<Value> = (0..30).map(|i| event("a", "tool", &format!("{i}{}", "o".repeat(20 * 1024)))).chain([event("a", "text", &"é".repeat(300 * 1024))]).collect();
        let framed = frames(events);
        assert!(framed.len() > 1);
        assert_eq!(framed.iter().map(Vec::len).sum::<usize>(), 31, "nothing is dropped");
        let key = [7u8; 32];
        for frame in &framed {
            let body = super::super::crypto::seal(&key, "a", "b", json!({"type": "event", "name": "agent.events", "data": {"events": frame}}).to_string().as_bytes()).unwrap();
            assert!(json!({"to": "b", "body": body}).to_string().len() < 256 * 1024);
        }
        assert!(framed.last().unwrap()[0]["text"].as_str().unwrap().ends_with(CUT));
        assert!(frames(Vec::new()).is_empty());
    }

    #[test]
    fn huge_messages_are_cut_and_tool_json_still_parses() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task'),('t','Other');").unwrap();
        let tool = json!({"status": "completed", "output": "o".repeat(300 * 1024)}).to_string();
        db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','tool',?1,1),('t','user','elsewhere',2),('s','assistant','done',3)", [&tool]).unwrap();
        let page = messages_page_with(&db, "s", MessagePaging::After { after_id: 0, limit: PAGE_ROWS }).unwrap();
        let messages = page["messages"].as_array().unwrap();
        assert_eq!((messages.len(), page["hasMore"].as_bool(), page["title"].as_str()), (2, Some(false), Some("Task")), "only this task's messages");
        assert_eq!(page["lastId"], 3);
        assert_eq!(page["hasOlder"], false);
        assert!(messages[0].to_string().len() <= MAX_MESSAGE);
        let parsed = serde_json::from_str::<Value>(messages[0]["content"].as_str().unwrap()).expect("tool content still parses");
        assert!(parsed["output"].as_str().unwrap().ends_with(CUT) && parsed["status"] == "completed");
        assert_eq!(messages[1]["content"], "done");
        assert!(messages_page_with(&db, "missing", MessagePaging::After { after_id: 0, limit: PAGE_ROWS }).is_err());
    }

    #[test]
    fn message_pages_report_older_rows_last_id_and_empty_threads() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task'),('empty','Empty'); INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user','first',1),('s','assistant','last',2);").unwrap();

        let page = messages_page_with(&db, "s", MessagePaging::After { after_id: 1, limit: PAGE_ROWS }).unwrap();
        assert_eq!(page["messages"][0]["content"], "last");
        assert_eq!(page["hasOlder"], true);
        assert_eq!(page["lastId"], 2);

        let empty = messages_page_with(&db, "empty", MessagePaging::Tail { limit: MESSAGE_PAGE_DEFAULT }).unwrap();
        assert_eq!(empty["messages"], json!([]));
        assert_eq!(empty["hasMore"], false);
        assert_eq!(empty["hasOlder"], false);
        assert_eq!(empty["lastId"], Value::Null);
    }

    #[test]
    fn tail_and_before_pages_return_the_newest_rows_oldest_first() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=5 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user',?1,?2)", rusqlite::params![format!("message-{index}"), index]).unwrap();
        }

        let tail = messages_page_with(&db, "s", MessagePaging::Tail { limit: 2 }).unwrap();
        assert_eq!(tail["messages"].as_array().unwrap().iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [4, 5]);
        assert_eq!(tail["hasOlder"], true);
        assert_eq!(tail["hasMore"], false);
        assert_eq!(tail["lastId"], 5);

        let before = messages_page_with(&db, "s", MessagePaging::Before { before_id: 4, limit: 2 }).unwrap();
        assert_eq!(before["messages"].as_array().unwrap().iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(before["hasOlder"], true);
        assert_eq!(before["hasMore"], true);
        assert_eq!(before["lastId"], 5);
    }

    #[test]
    fn newest_first_pages_keep_the_newest_messages_that_fit_the_budget() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=4 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user',?1,?2)", rusqlite::params!["x".repeat(72 * 1024), index]).unwrap();
        }

        let page = messages_page_with(&db, "s", MessagePaging::Tail { limit: 4 }).unwrap();
        let messages = page["messages"].as_array().unwrap();
        assert_eq!(messages.iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [3, 4]);
        assert!(page.to_string().len() <= PAGE_BUDGET);
        assert_eq!(page["hasOlder"], true);
        assert_eq!(page["lastId"], 4);

        let before = messages_page_with(&db, "s", MessagePaging::Before { before_id: 4, limit: 4 }).unwrap();
        let messages = before["messages"].as_array().unwrap();
        assert_eq!(messages.iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 3]);
        assert!(before.to_string().len() <= PAGE_BUDGET);
        assert_eq!(before["hasOlder"], true);
        assert_eq!(before["hasMore"], true);
    }
}
