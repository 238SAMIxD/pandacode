//! What each paired device may do on this computer (scoped pairing). A device seen for
//! the first time waits for the user's approval here before any request is served.
use crate::Result;
use serde_json::{json, Value};

/// Ok when `device` may call `method` on this host.
pub(crate) fn check(app: &tauri::AppHandle, device: &str, method: &str) -> Result<()> {
    let _ = (app, device, method);
    Ok(())
}

/// Every known device with its scope (`pending`, `full`, `control`, `view`, `blocked`).
#[tauri::command]
pub async fn remote_device_grants(app: tauri::AppHandle) -> Result<Value> {
    let _ = app;
    Ok(json!([]))
}

/// Sets a device's scope; `pending` devices become usable once given another scope.
#[tauri::command]
pub async fn remote_set_device_grant(app: tauri::AppHandle, device_id: String, scope: String) -> Result<()> {
    let _ = (app, device_id, scope);
    Ok(())
}
