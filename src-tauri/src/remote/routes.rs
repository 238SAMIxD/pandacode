//! Routes to a device besides the relay: a direct end-to-end encrypted socket on the
//! local network (or Tailscale), raced against the relay. Filled in by the routes work.
use crate::Result;

/// Drops the current sockets' backoff and reconnects every route now.
#[tauri::command]
pub async fn remote_reconnect(app: tauri::AppHandle) -> Result<()> {
    let _ = app;
    Ok(())
}
