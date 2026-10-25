//! Headless bot configuration (docs/headless.md): `pandacode serve --import-bots bots.json`
//! applies one declarative file through the same constructors the Settings UI uses, so a
//! server needs no window to set up bots; `--export-bots` writes the secret-free shape
//! back. Applying is pure (Store in, report out) — only starting the added channels needs
//! the AppHandle, which is the caller's job in the serve process.

use crate::bots::{self, channels, guard, schedule};
use crate::storage::Store;
use serde_json::{json, Value};
use std::path::Path;

/// A channel the import added; the serve wiring starts it live.
pub(crate) struct AddedChannel {
    pub id: String,
}

pub(crate) struct Report {
    pub lines: Vec<String>,
    pub added_channels: Vec<AddedChannel>,
    pub failed: usize,
}

/// Applies the import document. Bots are matched by exact name (existing = profile update,
/// missing = created with their own workspace folder); channels match on kind+label,
/// schedules on title (or prompt for untitled ones), rules on pattern+decision — so
/// re-applying the same file converges instead of duplicating. A bot that fails is
/// reported and skipped; the rest still import.
pub(crate) fn apply(store: &Store, root: &Path, doc: &Value, now: i64) -> Report {
    let mut report = Report { lines: Vec::new(), added_channels: Vec::new(), failed: 0 };
    let Some(entries) = doc.get("bots").and_then(Value::as_array) else {
        report.failed += 1;
        report.lines.push("The import file needs a \"bots\" array.".into());
        return report;
    };
    for entry in entries {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("").to_owned();
        match apply_bot(store, root, entry, &mut report.added_channels, now) {
            Ok(lines) => report.lines.extend(lines),
            Err(error) => {
                report.failed += 1;
                report.lines.push(format!("bot \"{name}\": {error}"));
            }
        }
    }
    report
}

fn apply_bot(store: &Store, root: &Path, entry: &Value, added: &mut Vec<AddedChannel>, now: i64) -> crate::Result<Vec<String>> {
    let input: bots::BotInput =
        serde_json::from_value(entry.clone()).map_err(|error| format!("unreadable bot entry: {error}"))?;
    if input.name.trim().is_empty() {
        return Err("Every bot needs a name.".into());
    }
    let existing = bots::list(store)?.into_iter().find(|bot| bot.name == input.name);
    let (name, mut lines) = match &existing {
        Some(bot) => {
            bots::update(store, &bot.id, &input)?;
            (bot.id.clone(), vec![format!("\"{}\" updated", bot.name)])
        }
        None => {
            let bot = bots::create(store, &input, root)?;
            (bot.id.clone(), vec![format!("\"{}\" imported", bot.name)])
        }
    };
    if entry.get("skills").is_some() || entry.get("mcp").is_some() {
        let skills = string_list(entry.get("skills"))?;
        let mcp = string_list(entry.get("mcp"))?;
        bots::set_capabilities(store, &name, &skills, &mcp)?;
        lines.push(format!("  capabilities: {} skill(s), {} MCP server(s)", skills.len(), mcp.len()));
    }
    if let Some(entries) = entry.get("channels").and_then(Value::as_array) {
        for channel_entry in entries {
            let mut input: channels::ChannelInput = serde_json::from_value(channel_entry.clone())
                .map_err(|error| format!("unreadable channel entry: {error}"))?;
            for (name, value) in input.secrets.iter_mut() {
                *value = resolve_secret(&input.kind, name, value, &|variable| std::env::var(variable).ok())?;
            }
            let label = input.label.trim().chars().take(60).collect::<String>();
            if channels::list(store, &name)?.iter().any(|channel| channel.kind == input.kind && channel.label == label) {
                lines.push(format!("  channel {} \"{label}\" already configured", input.kind));
                continue;
            }
            let channel = channels::add(store, &name, &input)?;
            added.push(AddedChannel { id: channel.id.clone() });
            lines.push(format!("  channel {} \"{label}\" added", channel.kind));
        }
    }
    if let Some(entries) = entry.get("schedules").and_then(Value::as_array) {
        for schedule_entry in entries {
            let input: schedule::ScheduleInput = serde_json::from_value(schedule_entry.clone())
                .map_err(|error| format!("unreadable schedule entry: {error}"))?;
            let title = input.title.trim().chars().take(120).collect::<String>();
            let exists = schedule::list(store, &name)?.iter().any(|saved| {
                if title.is_empty() {
                    saved.prompt == input.prompt.trim() && saved.kind == input.kind
                } else {
                    saved.title == title
                }
            });
            if exists {
                lines.push(format!("  schedule \"{}\" already configured", if title.is_empty() { &input.prompt } else { &title }));
                continue;
            }
            let created = schedule::create(store, &name, &input, "user", now)?;
            lines.push(format!("  schedule \"{}\" added", created.title));
        }
    }
    if let Some(entries) = entry.get("rules").and_then(Value::as_array) {
        for rule_entry in entries {
            let pattern = rule_entry.get("pattern").and_then(Value::as_str).ok_or("Every rule needs a pattern.")?;
            let decision = rule_entry.get("decision").and_then(Value::as_str).ok_or("Every rule needs a decision (allow, ask or deny).")?;
            if guard::rules(store, &name)?.iter().any(|rule| rule.pattern == pattern.trim() && rule.decision == decision) {
                lines.push(format!("  rule \"{pattern}\" already configured"));
                continue;
            }
            guard::add_rule(store, &name, pattern, decision)?;
            lines.push(format!("  rule \"{pattern}\" added"));
        }
    }
    Ok(lines)
}

/// A secret is either its value or `env:NAME`, read from the environment at import
/// (the lookup is a parameter so tests never touch the process environment).
fn resolve_secret(kind: &str, name: &str, value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> crate::Result<String> {
    let Some(variable) = value.strip_prefix("env:") else {
        return Ok(value.to_owned());
    };
    let resolved = lookup(variable).ok_or_else(|| format!("{kind} channel ({name}): environment variable {variable} is not set"))?;
    if resolved.trim().is_empty() {
        return Err(format!("{kind} channel ({name}): environment variable {variable} is empty"));
    }
    Ok(resolved)
}

fn string_list(value: Option<&Value>) -> crate::Result<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or_else(|| "Capability lists hold strings.".to_string()))
            .collect(),
        Some(_) => Err("Capability lists are arrays of strings.".into()),
    }
}

/// The importable shape of everything configured, minus secrets: channels list the
/// secret *names* under `secretsNeeded`, and web tokens are left out entirely (a
/// re-import mints a fresh one and prints the new link). once-schedules keep their
/// absolute `runAt`; disabled schedules re-import enabled.
pub(crate) fn export(store: &Store) -> crate::Result<Value> {
    let mut bots_json = Vec::new();
    for bot in bots::list(store)? {
        let mut channels_json = Vec::new();
        for channel in channels::list(store, &bot.id)? {
            let mut config = channel.config.clone();
            if let Some(object) = config.as_object_mut() {
                object.remove("verifyToken");
            }
            channels_json.push(json!({
                "kind": channel.kind, "label": channel.label, "config": config,
                "secretsNeeded": channel.secrets,
            }));
        }
        let schedules_json = schedule::list(store, &bot.id)?
            .iter()
            .map(|saved| {
                json!({
                    "title": saved.title, "prompt": saved.prompt, "kind": saved.kind,
                    "intervalMinutes": saved.interval_minutes, "timeOfDay": saved.time_of_day,
                    "runAt": (saved.kind == "once").then_some(saved.next_run_at).flatten(),
                })
            })
            .collect::<Vec<_>>();
        let rules_json = guard::rules(store, &bot.id)?
            .iter()
            .map(|rule| json!({"pattern": rule.pattern, "decision": rule.decision}))
            .collect::<Vec<_>>();
        bots_json.push(json!({
            "name": bot.name, "role": bot.role, "instructions": bot.instructions,
            "goals": bot.goals, "soul": bot.soul, "provider": bot.provider, "model": bot.model,
            "mode": bot.mode, "heartbeatMinutes": bot.heartbeat_minutes,
            "skills": bot.skills, "mcp": bot.mcp,
            "channels": channels_json, "schedules": schedules_json, "rules": rules_json,
        }));
    }
    Ok(json!({ "bots": bots_json }))
}

/// Reads and applies the import file inside the serve process, starts the added channels
/// live, prints web chat links. Exits non-zero on any failure, after the per-bot report
/// (systemd shows it); what imported before the failure stays, so fixing the file and
/// restarting converges.
pub(crate) fn run_import(app: &tauri::AppHandle, path: &Path) {
    use tauri::Manager;
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("Could not read the bot import file {}: {error}", path.display());
            std::process::exit(1)
        }
    };
    let doc: Value = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(error) => {
            eprintln!("The bot import file is not valid JSON: {error}");
            std::process::exit(1)
        }
    };
    let state = app.state::<crate::AppState>();
    let report = {
        let Ok(store) = state.store.lock() else {
            eprintln!("Could not open the task store for the bot import.");
            std::process::exit(1)
        };
        apply(&store, &bots::workspace_root(), &doc, crate::storage::now())
    };
    for line in &report.lines {
        println!("{line}");
    }
    if report.failed > 0 {
        eprintln!("The bot import had errors; fix the file and restart — what imported stays.");
        std::process::exit(1)
    }
    let mut links = Vec::new();
    for added in &report.added_channels {
        let channel = {
            let Ok(store) = state.store.lock() else { continue };
            match channels::get(&store, &added.id) {
                Ok(channel) => channel,
                Err(_) => continue,
            }
        };
        channels::start(app, channel.clone());
        if channel.kind == "web" {
            let port = channels::http::ensure_server(app.clone());
            let token = {
                let Ok(store) = state.store.lock() else { continue };
                channels::web_token(&store, &channel.id)
            };
            if let Some(token) = token {
                links.push(format!("http://127.0.0.1:{port}/chat/{}#{token}", channel.id));
            }
        }
    }
    for link in links {
        println!("Web chat: {link}");
    }
}

/// Writes the export document to `path` (pretty-printed, newline-terminated).
pub(crate) fn run_export(app: &tauri::AppHandle, path: &Path) -> crate::Result<()> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let doc = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        export(&store)?
    };
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("Could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pandacode-bot-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A per-test variable name that is never set: reading a missing variable is safe
    /// in parallel tests; writing the environment is not.
    fn token_doc(var: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"bots": [{{
                "name": "build-bot", "role": "builder", "instructions": "Build things.",
                "goals": "Ship it", "provider": "claude", "model": "sonnet", "mode": "auto",
                "heartbeatMinutes": 30, "skills": ["skill-a"], "mcp": ["server-a"],
                "channels": [
                    {{"kind": "telegram", "label": "main", "config": {{}}, "secrets": {{"token": "{var}"}}}},
                    {{"kind": "web"}}
                ],
                "schedules": [{{"title": "Standup", "prompt": "What is next?", "kind": "daily", "timeOfDay": "09:00"}}],
                "rules": [{{"pattern": "npm test*", "decision": "allow"}}]
            }}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn import_creates_bot_channel_secrets_schedule_and_rule() {
        let store = store();
        let root = root();
        let report = apply(&store, &root, &token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"), 1_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert_eq!(report.added_channels.len(), 2);
        let list = bots::list(&store).unwrap();
        assert_eq!(list.len(), 1);
        let bot = &list[0];
        assert_eq!((bot.provider.as_str(), bot.mode.as_str(), bot.heartbeat_minutes), ("claude", "auto", 30));
        assert_eq!(bot.skills, vec!["skill-a".to_owned()]);
        assert_eq!(bot.goals, "Ship it");
        // The telegram channel saved the token under the file backend's key.
        let channel = channels::list(&store, &bot.id).unwrap().into_iter().find(|c| c.kind == "telegram").unwrap();
        assert_eq!(channel.secrets, vec!["token".to_owned()]);
        assert_eq!(secret_store::get("app.pandacode.bots", &format!("{}:token", channel.id)).as_deref(), Some("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"));
        // The web channel minted a link token.
        let web = channels::list(&store, &bot.id).unwrap().into_iter().find(|c| c.kind == "web").unwrap();
        let token = channels::web_token(&store, &web.id).unwrap();
        assert_eq!(token.len(), 64);
        // The schedule got a computed next run and the rule stored its decision.
        let schedules = schedule::list(&store, &bot.id).unwrap();
        assert_eq!(schedules.len(), 1);
        assert!(schedules[0].next_run_at.is_some());
        assert_eq!(schedules[0].created_by, "user");
        assert_eq!(guard::rules(&store, &bot.id).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reapplying_the_same_file_converges() {
        let store = store();
        let root = root();
        let doc = token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa");
        apply(&store, &root, &doc, 1_000_000);
        let report = apply(&store, &root, &doc, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert_eq!(report.added_channels.len(), 0, "channels are matched, not re-added");
        let bots = bots::list(&store).unwrap();
        assert_eq!(bots.len(), 1);
        assert_eq!(channels::list(&store, &bots[0].id).unwrap().len(), 2);
        assert_eq!(schedule::list(&store, &bots[0].id).unwrap().len(), 1);
        assert_eq!(guard::rules(&store, &bots[0].id).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_failing_bot_does_not_block_the_others() {
        let store = store();
        let root = root();
        let doc: Value = serde_json::from_str(
            r#"{"bots": [
                {"name": "good", "provider": "claude", "model": "sonnet", "mode": "auto"},
                {"name": "bad", "provider": "nope", "model": "x", "mode": "auto"}
            ]}"#,
        )
        .unwrap();
        let report = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(report.failed, 1);
        assert!(report.lines.iter().any(|line| line.contains("bad")));
        let bots = bots::list(&store).unwrap();
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].name, "good");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_is_config_only_and_secret_free() {
        let store = store();
        let root = root();
        apply(&store, &root, &token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"), 1_000_000);
        let exported = export(&store).unwrap();
        let text = serde_json::to_string(&exported).unwrap();
        assert!(!text.contains("AAtesttokenvalue"), "secret values never export");
        assert!(!text.to_lowercase().contains("webtoken"), "web tokens never export");
        let bot = &exported["bots"][0];
        assert_eq!(bot["name"], "build-bot");
        assert_eq!(bot["channels"][0]["secretsNeeded"], serde_json::json!(["token"]));
        assert_eq!(bot["rules"][0]["decision"], "allow");
        // An export re-imports cleanly on the same server: the profile updates and the
        // existing channels match by kind+label, so no secret is needed again. (On a
        // fresh server the missing secret is the named per-bot error instead.)
        let report = apply(&store, &root, &exported, 3_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert!(report.lines.iter().any(|line| line.contains("already configured")));
        assert_eq!(bots::list(&store).unwrap().len(), 1);
        assert_eq!(channels::list(&store, &bots::list(&store).unwrap()[0].id).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_env_and_malformed_entries_report_per_bot() {
        let store = store();
        let root = root();
        let var = format!("TEST_TOKEN_{}", uuid::Uuid::new_v4().simple().to_string());
        let doc: Value = serde_json::from_str(&format!(
            r#"{{"bots": [
                {{"name": "tg", "provider": "claude", "model": "sonnet", "mode": "auto",
                 "channels": [{{"kind": "telegram", "secrets": {{"token": "env:{var}"}}}}]}},
                {{"name": 42}}
            ]}}"#
        ))
        .unwrap();
        let report = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(report.failed, 2);
        assert!(report.lines.iter().any(|line| line.contains(&var)));
        assert!(report.lines.iter().any(|line| line.contains("unreadable bot entry")));
        // Not a document: no bots array.
        let report = apply(&store, &root, &serde_json::json!({"nope": true}), 1_000_000);
        assert_eq!(report.failed, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn secrets_resolve_from_the_environment_or_pass_through() {
        let lookup = |name: &str| Some(format!("value-for-{name}"));
        assert_eq!(resolve_secret("telegram", "token", "plain", &lookup).unwrap(), "plain");
        assert_eq!(resolve_secret("telegram", "token", "env:TOKEN", &lookup).unwrap(), "value-for-TOKEN");
        assert!(resolve_secret("telegram", "token", "env:MISSING", &|_| None).unwrap_err().contains("MISSING"));
        assert!(resolve_secret("telegram", "token", "env:EMPTY", &|_| Some("  ".into())).unwrap_err().contains("EMPTY"));
    }
}
