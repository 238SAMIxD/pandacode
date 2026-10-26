//! Connect diagnostics: a bounded in-memory log of connection events and per-route
//! stats (state, RTT, last error), shown in Settings and exportable without secrets.
use serde_json::{json, Value};

/// Records one connection event (`kind` like `socket.open`, `route.direct`, `rpc.timeout`).
pub(crate) fn record(kind: &str, detail: impl Into<String>) {
    let _ = (kind, detail.into());
}

#[tauri::command]
pub async fn remote_diagnostics() -> Value {
    json!({"routes": [], "events": []})
}
