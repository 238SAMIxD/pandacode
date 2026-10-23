//! Menu bar item: running tasks, finished tasks not yet viewed, and plan usage.
//! Usage is checked only when the user opens the menu or picks Refresh usage.

use crate::{agent_usage::Usage, storage::Session, AppState};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

const ID: &str = "pandacode";
const SECTION_LIMIT: usize = 10;
/// Finished since last viewed; in memory only, so a restart starts clean.
static UNSEEN: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static USAGE: Mutex<BTreeMap<String, Usage>> = Mutex::new(BTreeMap::new());

pub(crate) fn setup(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))?)
        .icon_as_template(true)
        .tooltip("PandaCode")
        .menu(&menu(app, &[])?)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button_state: MouseButtonState::Down, .. } = event {
                refresh_usage(tray.app_handle(), false);
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}

/// Rebuilds the menu off the caller's thread, so callers may hold any lock.
pub(crate) fn refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || rebuild(&app));
}

pub(crate) fn finished(app: &AppHandle, session_id: &str, stopped: bool) {
    if !stopped {
        UNSEEN.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.into());
    }
    refresh(app);
}

#[tauri::command]
pub(crate) fn tray_seen(app: AppHandle, session_id: String) {
    if UNSEEN.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id) {
        refresh(&app);
    }
}

fn rebuild(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let sessions = match crate::listed_sessions(&app.state::<AppState>()) {
        Ok(sessions) => sessions,
        Err(error) => return eprintln!("Menu bar item could not list tasks: {error}"),
    };
    let running = sessions.iter().filter(|s| s.status == "running").count();
    let _ = tray.set_title((running > 0).then(|| running.to_string()));
    match menu(app, &sessions) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => eprintln!("Menu bar item could not be rebuilt: {error}"),
    }
}

fn menu(app: &AppHandle, sessions: &[Session]) -> tauri::Result<Menu<Wry>> {
    let projects: HashMap<String, String> = app
        .state::<AppState>()
        .store
        .lock()
        .ok()
        .and_then(|store| store.projects().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id, p.name))
        .collect();
    let unseen = UNSEEN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let live = sessions.iter().filter(|s| !s.archived);
    let running: Vec<_> = live.clone().filter(|s| s.status == "running").collect();
    let waiting: Vec<_> = live.clone().filter(|s| s.status == "waiting").collect();
    let done: Vec<_> = live
        .filter(|s| unseen.contains(&s.id) && !matches!(s.status.as_str(), "running" | "waiting"))
        .collect();
    let menu = Menu::new(app)?;
    for (title, rows) in [("Running", running), ("Needs you", waiting), ("Finished, not viewed", done)] {
        if rows.is_empty() {
            continue;
        }
        menu.append(&disabled(app, &format!("{title} ({})", rows.len()))?)?;
        for task in rows.into_iter().take(SECTION_LIMIT) {
            let project = projects.get(&task.project_id).map_or("", String::as_str);
            let label = task_label(&task.title, project, &task.provider);
            menu.append(&MenuItem::with_id(app, format!("open:{}", task.id), label, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let usage = USAGE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if !usage.is_empty() {
        menu.append(&disabled(app, "Plan usage")?)?;
        for line in usage.values().map(usage_line) {
            menu.append(&disabled(app, &line)?)?;
        }
    }
    menu.append(&MenuItem::with_id(app, "refresh-usage", "Refresh usage", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Open PandaCode", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit PandaCode", true, None::<&str>)?)?;
    Ok(menu)
}

fn disabled(app: &AppHandle, label: &str) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::new(app, label, false, None::<&str>)
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "show" => show(app),
        "quit" => app.exit(0),
        "refresh-usage" => refresh_usage(app, true),
        id => {
            if let Some(session_id) = id.strip_prefix("open:") {
                UNSEEN.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
                show(app);
                let _ = app.emit_to("main", "tray-open-session", session_id);
                refresh(app);
            }
        }
    }
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Claude and Codex, plus every agent a task has used. Each result rebuilds the menu.
fn refresh_usage(app: &AppHandle, refresh_now: bool) {
    let mut providers: BTreeSet<String> = ["claude", "codex"].map(String::from).into();
    if let Ok(store) = app.state::<AppState>().store.lock() {
        if let Ok(mut statement) = store.db.prepare("SELECT DISTINCT provider FROM sessions") {
            if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                providers.extend(rows.flatten());
            }
        }
    }
    for provider in providers {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(usage) = crate::agent_usage::query_usage(provider.clone(), refresh_now).await else {
                return;
            };
            let mut all = USAGE.lock().unwrap_or_else(|e| e.into_inner());
            if usage.windows.is_empty() {
                all.remove(&provider);
            } else {
                all.insert(provider, usage);
            }
            drop(all);
            refresh(&app);
        });
    }
}

fn provider_name(id: &str) -> &str {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        "kimi" => "Kimi",
        "glm" => "GLM",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        other => other,
    }
}

fn task_label(title: &str, project: &str, provider: &str) -> String {
    let title = if title.chars().count() > 48 {
        format!("{}…", title.chars().take(47).collect::<String>())
    } else {
        title.to_owned()
    };
    let provider = provider_name(provider);
    if project.is_empty() {
        format!("{title} — {provider}")
    } else {
        format!("{title} — {project} · {provider}")
    }
}

fn usage_line(usage: &Usage) -> String {
    let name = provider_name(&usage.provider);
    let head = usage.plan.as_ref().map_or_else(|| name.to_owned(), |plan| format!("{name} · {plan}"));
    let windows: Vec<String> = usage
        .windows
        .iter()
        .map(|w| format!("{} {}%", w.label, w.used_percent.round()))
        .collect();
    let stale = if usage.stale { " (stale)" } else { "" };
    format!("{head} — {}{stale}", windows.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_usage::UsageWindow;

    #[test]
    fn usage_line_rounds_and_marks_stale() {
        let mut usage = Usage::empty("claude", "ok", "");
        usage.plan = Some("Max".into());
        usage.windows = vec![UsageWindow::new("5h", 41.6, None), UsageWindow::new("Weekly", 18.2, None)];
        assert_eq!(usage_line(&usage), "Claude · Max — 5h 42% · Weekly 18%");
        usage.plan = None;
        usage.stale = true;
        assert_eq!(usage_line(&usage), "Claude — 5h 42% · Weekly 18% (stale)");
    }

    #[test]
    fn task_label_shortens_long_titles() {
        assert_eq!(task_label("Fix login", "web", "codex"), "Fix login — web · Codex");
        assert_eq!(task_label("Fix login", "", "grok"), "Fix login — grok");
        let long = task_label(&"x".repeat(80), "web", "claude");
        assert!(long.starts_with(&format!("{}…", "x".repeat(47))));
    }
}
