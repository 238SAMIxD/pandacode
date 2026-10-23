//! Reads GitHub Copilot CLI's documented local session event logs. Cloud
//! discovery is handled separately through the supported Copilot SDK API.
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub(crate) struct CloudSession {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub created_at: i64,
    pub is_remote: bool,
    pub events: Vec<Value>,
    pub transcript_error: Option<String>,
}

pub(crate) const MAX_ENTRIES: usize = 1000;
const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_LINE: usize = 1024 * 1024;
const MAX_TEXT: usize = 64 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Summary {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub messages: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: Option<String>,
}

pub(crate) type Entry = (&'static str, String, i64);

pub(crate) fn home() -> PathBuf {
    home_from(
        std::env::var_os("COPILOT_HOME"),
        crate::agent_usage_providers::home(),
    )
}

fn home_from(copilot_home: Option<std::ffi::OsString>, user_home: Option<PathBuf>) -> PathBuf {
    copilot_home
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            user_home
                .unwrap_or_else(std::env::temp_dir)
                .join(".copilot")
        })
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn event_type(event: &Value) -> &str {
    event["type"]
        .as_str()
        .or_else(|| event["eventType"].as_str())
        .unwrap_or_default()
}

fn time_ms(event: &Value) -> Option<i64> {
    let timestamp = event["timestamp"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn bounded(text: &str) -> String {
    let text = text.trim();
    if text.len() <= MAX_TEXT {
        return text.to_owned();
    }
    let mut end = MAX_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[Truncated during import]", &text[..end])
}

fn text_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then(|| bounded(&text))
}

fn message_text(event: &Value) -> Option<String> {
    let data = &event["data"];
    let value = data.get("message").or_else(|| data.get("content"))?;
    text_value(value)
}

fn find_folder(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => {
            for (key, item) in object {
                if matches!(
                    key.as_str(),
                    "cwd" | "workingDirectory" | "working_directory" | "workspacePath"
                ) {
                    if let Some(path) = item.as_str().filter(|path| !path.trim().is_empty()) {
                        return Some(path.to_owned());
                    }
                }
            }
            object.values().find_map(find_folder)
        }
        Value::Array(values) => values.iter().find_map(find_folder),
        _ => None,
    }
}

fn title_of(event: &Value) -> Option<String> {
    let data = &event["data"];
    [data.get("title"), data.get("summary"), data.get("name")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(|text| text.chars().take(160).collect())
}

/// Read valid JSONL records only. Oversized files are rejected before allocating
/// their contents; oversized individual lines are skipped like malformed records.
pub(crate) fn read_events(path: &Path) -> Result<Vec<Value>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Copilot session data is unavailable.".to_owned())?;
    if !metadata.file_type().is_file() {
        return Err("Copilot session data is unavailable.".into());
    }
    if metadata.len() > MAX_FILE {
        return Err("This Copilot session exceeds the 32 MiB import limit.".into());
    }
    let file =
        std::fs::File::open(path).map_err(|_| "Copilot session data is unavailable.".to_owned())?;
    let mut events = Vec::new();
    for line in BufReader::with_capacity(64 * 1024, file)
        .split(b'\n')
        .map_while(Result::ok)
    {
        if line.len() > MAX_LINE {
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(&line) {
            if event.is_object() {
                events.push(event);
            }
        }
    }
    Ok(events)
}

pub(crate) fn summarize(id: &str, events: &[Value]) -> Option<Summary> {
    if !valid_id(id) {
        return None;
    }
    let mut summary = Summary {
        id: id.to_owned(),
        ..Summary::default()
    };
    let mut first_prompt = None;
    for event in events {
        match event_type(event) {
            "session.start" | "session.title" | "session.info" => {
                if summary.title.is_empty() {
                    summary.title = title_of(event).unwrap_or_default();
                }
                if summary.folder.is_empty() {
                    summary.folder = find_folder(&event["data"]).unwrap_or_default();
                }
                if summary.model.is_none() {
                    summary.model = event["data"]["model"].as_str().map(str::to_owned);
                }
            }
            "user.message" | "assistant.message"
                if event["agentId"].is_null() && event["ephemeral"] != true =>
            {
                if let Some(text) = message_text(event) {
                    summary.messages += 1;
                    if event_type(event) == "user.message" && first_prompt.is_none() {
                        first_prompt = text
                            .lines()
                            .next()
                            .map(|line| line.chars().take(160).collect::<String>());
                    }
                    if let Some(at) = time_ms(event) {
                        summary.created_at = if summary.created_at == 0 {
                            at
                        } else {
                            summary.created_at.min(at)
                        };
                        summary.updated_at = summary.updated_at.max(at);
                    }
                }
            }
            _ => {}
        }
    }
    if summary.messages == 0 {
        return None;
    }
    if summary.title.is_empty() {
        summary.title = first_prompt
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "Untitled Copilot conversation".into());
    }
    Some(summary)
}

pub(crate) fn history(events: &[Value]) -> Vec<Entry> {
    let mut entries = std::collections::VecDeque::new();
    let mut last = 0;
    let mut push = |entry: Entry| {
        if entries.len() == MAX_ENTRIES {
            entries.pop_front();
        }
        entries.push_back(entry);
    };
    for event in events {
        if event["agentId"].is_string() || event["ephemeral"] == true {
            continue;
        }
        let at = time_ms(event).unwrap_or(last);
        last = at;
        match event_type(event) {
            "user.message" => {
                if let Some(text) = message_text(event) {
                    push(("user", text, at));
                }
            }
            "assistant.message" => {
                if let Some(text) = message_text(event) {
                    push(("assistant", text, at));
                }
            }
            "tool.execution_start" => {
                if let Some(name) = event["data"]["toolName"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                {
                    push((
                        "tool",
                        format!("Tool: {}", name.chars().take(160).collect::<String>()),
                        at,
                    ));
                }
            }
            _ => {}
        }
    }
    entries.into()
}

pub(crate) fn logs(root: &Path, limit: usize) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(std::time::SystemTime, String, PathBuf)> = Vec::new();
    let session_root = root.join("session-state");
    let Ok(sessions) = std::fs::read_dir(session_root) else {
        return Vec::new();
    };
    for entry in sessions.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) {
            continue;
        }
        let path = entry.path().join("events.jsonl");
        if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_file()) {
            continue;
        }
        let modified = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push((modified, id, path));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found
        .into_iter()
        .take(limit)
        .map(|(_, id, path)| (id, path))
        .collect()
}

pub(crate) async fn cloud_sessions(
    home: &Path,
    program: &Path,
    local_ids: &std::collections::HashSet<String>,
) -> Result<Vec<CloudSession>, String> {
    use github_copilot_sdk::{CliProgram, Client, ClientOptions};

    let options = ClientOptions::new()
        .with_program(CliProgram::Path(program.to_path_buf()))
        .with_base_directory(home.to_path_buf());
    let client = Client::start(options).await.map_err(|_| "Copilot cloud sessions are unavailable. Check that Copilot CLI is installed and signed in.".to_owned())?;
    let metadata = match client.list_sessions(None).await {
        Ok(sessions) => sessions,
        Err(_) => {
            let _ = client.stop().await;
            return Err(
                "This Copilot CLI did not expose cloud sessions. Update Copilot CLI and try again."
                    .into(),
            );
        }
    };
    let mut cloud: Vec<_> = metadata
        .into_iter()
        .filter(|session| !local_ids.contains(session.session_id.as_str()))
        .collect();
    cloud.sort_by_key(|session| {
        std::cmp::Reverse(
            chrono::DateTime::parse_from_rfc3339(&session.modified_time)
                .ok()
                .map(|time| time.timestamp_millis())
                .unwrap_or(0),
        )
    });
    cloud.truncate(50);
    let mut result = Vec::with_capacity(cloud.len());
    for metadata in cloud {
        let id = metadata.session_id.as_str().to_owned();
        if !valid_id(&id) {
            continue;
        }
        let (events, transcript_error) = match client
            .call(
                "session.getMessages",
                Some(serde_json::json!({"sessionId": id})),
            )
            .await
        {
            Ok(value) => {
                let events = value["events"].as_array().cloned().unwrap_or_default();
                if events.len() > 100_000 {
                    (
                        Vec::new(),
                        Some("Copilot returned too many events to import.".into()),
                    )
                } else {
                    (events.into_iter().filter(Value::is_object).collect(), None)
                }
            }
            Err(_) => (
                Vec::new(),
                Some("Copilot did not make this session transcript available.".into()),
            ),
        };
        let updated_at = chrono::DateTime::parse_from_rfc3339(&metadata.modified_time)
            .ok()
            .map(|time| time.timestamp_millis())
            .unwrap_or(0);
        let created_at = chrono::DateTime::parse_from_rfc3339(&metadata.start_time)
            .ok()
            .map(|time| time.timestamp_millis())
            .unwrap_or(updated_at);
        result.push(CloudSession {
            id,
            title: metadata
                .summary
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| "Untitled Copilot conversation".into()),
            updated_at,
            created_at,
            is_remote: metadata.is_remote,
            events,
            transcript_error,
        });
    }
    let _ = client.stop().await;
    Ok(result)
}

/// Repository hints are taken only from structured session context.
pub(crate) fn repository(events: &[Value]) -> Option<String> {
    fn parse_repository(text: &str) -> Option<String> {
        let text = text.trim().trim_end_matches('/').trim_end_matches(".git");
        let repo = if text.contains("github.com") || text.starts_with("git@") {
            crate::github_hub::repo_from_remote(text)
        } else if text.split('/').count() == 2 {
            Some(text.to_owned())
        } else {
            None
        };
        repo.filter(|repo| {
            repo.split('/').count() == 2
                && repo.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.')
                })
        })
    }

    fn find(value: &Value) -> Option<String> {
        match value {
            Value::Object(object) => {
                for (key, item) in object {
                    if matches!(
                        key.as_str(),
                        "repository" | "repo" | "repositoryName" | "nameWithOwner" | "fullName"
                    ) {
                        if let Some(text) = item.as_str() {
                            if let Some(repo) = parse_repository(text) {
                                return Some(repo);
                            }
                        } else if let Some(repository) = item.as_object() {
                            let owner = repository.get("owner").and_then(|owner| {
                                owner.as_str().or_else(|| owner["login"].as_str())
                            });
                            let name = repository.get("name").and_then(Value::as_str);
                            if let (Some(owner), Some(name)) = (owner, name) {
                                if let Some(repo) = parse_repository(&format!("{owner}/{name}")) {
                                    return Some(repo);
                                }
                            }
                        }
                    }
                }
                object.values().find_map(find)
            }
            Value::Array(values) => values.iter().find_map(find),
            _ => None,
        }
    }
    events.iter().find_map(|event| find(&event["data"]))
}

pub(crate) fn cloud_source_kind(is_remote: bool) -> &'static str {
    if is_remote {
        "hosted"
    } else {
        "synced"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_events() -> Vec<Value> {
        vec![
            json!({"id":"start","timestamp":"2026-10-20T10:00:00Z","type":"session.start","data":{"title":"Search work","model":"gpt-test","context":{"cwd":"/tmp/copilot-project","gitInfo":{"repository":"acme/search"}}}}),
            json!({"id":"u1","timestamp":"2026-10-20T10:01:00Z","type":"user.message","data":{"content":"Improve exact search."}}),
            json!({"id":"reason","timestamp":"2026-10-20T10:01:01Z","type":"assistant.reasoning","data":{"reasoning":"private reasoning"}}),
            json!({"id":"tool","timestamp":"2026-10-20T10:01:02Z","type":"tool.execution_start","data":{"toolName":"Read","arguments":{"path":"/private/file"}}}),
            json!({"id":"sub","timestamp":"2026-10-20T10:01:03Z","type":"assistant.message","agentId":"agent-1","data":{"message":"subagent text"}}),
            json!({"id":"a1","timestamp":"2026-10-20T10:02:00Z","type":"assistant.message","data":{"message":"Exact matches now rank first."}}),
        ]
    }

    #[test]
    fn local_session_summary_and_history_keep_only_main_thread_text_and_tool_names() {
        let events = sample_events();
        let summary = summarize("copilot-abc_123", &events).unwrap();
        assert_eq!(summary.title, "Search work");
        assert_eq!(summary.folder, "/tmp/copilot-project");
        assert_eq!(summary.messages, 2);
        assert_eq!(summary.model.as_deref(), Some("gpt-test"));
        let history = history(&events);
        assert_eq!(
            history.iter().map(|entry| entry.0).collect::<Vec<_>>(),
            ["user", "tool", "assistant"]
        );
        let transcript = history
            .iter()
            .map(|entry| entry.1.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!transcript.contains("private reasoning"));
        assert!(!transcript.contains("subagent text"));
        assert!(!transcript.contains("/private/file"));
        assert!(transcript.contains("Tool: Read"));
        assert_eq!(repository(&events).as_deref(), Some("acme/search"));
        let nested = vec![
            json!({"type":"session.start","data":{"repository":{"owner":{"login":"acme"},"name":"search"}}}),
        ];
        assert_eq!(repository(&nested).as_deref(), Some("acme/search"));
    }

    #[test]
    fn copilot_home_is_honored_and_cloud_sources_are_distinguished() {
        assert_eq!(
            home_from(
                Some("/tmp/copilot-custom".into()),
                Some(PathBuf::from("/home/test"))
            ),
            PathBuf::from("/tmp/copilot-custom")
        );
        assert_eq!(
            home_from(None, Some(PathBuf::from("/home/test"))),
            PathBuf::from("/home/test/.copilot")
        );
        assert_eq!(cloud_source_kind(false), "synced");
        assert_eq!(cloud_source_kind(true), "hosted");
    }

    #[test]
    fn malformed_lines_are_skipped_and_oversized_files_are_rejected() {
        let dir =
            std::env::temp_dir().join(format!("pandacode-copilot-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        std::fs::write(&path, format!("{{not json}}\n{}\n", json!({"type":"user.message","timestamp":"2026-10-20T10:00:00Z","data":{"content":"hello"}}))).unwrap();
        let events = read_events(&path).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(history(&events)[0].1, "hello");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert!(read_events(&path).unwrap_err().contains("32 MiB"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_ids_cannot_escape_the_session_state_directory() {
        assert!(valid_id("018f2b5e-8a1a-7e81-bf7c-123456789abc"));
        assert!(!valid_id("../events.jsonl"));
        assert!(!valid_id(""));
    }
}
