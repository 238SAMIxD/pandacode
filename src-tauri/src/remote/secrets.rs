//! The relay token and the device's X25519 private key, in a 0600 JSON file in the app data
//! dir. Never the keychain: macOS pins each item to the exact build that made it, and without
//! an Apple Team ID every update asked for the login password on every read. On Windows the
//! file inherits the app data dir's ACL, which is per-user by default.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const FILE: &str = "connect-secrets.json";
/// Held with an exclusive advisory lock around read-modify-write, so two app processes cannot interleave.
const LOCK: &str = "connect-secrets.lock";

/// Serializes read-modify-write in this process: sign-in, key creation and token refresh can overlap.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Secrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// The base64 X25519 private key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// What is stored. Missing means none; unreadable or corrupt also reads as none, logged.
/// Writes go through `update`, which refuses to replace a file it could not read.
pub(crate) fn read(dir: &Path) -> Secrets {
    load(dir).unwrap_or_else(|error| {
        eprintln!("{error}");
        Secrets::default()
    })
}

/// Missing means none; any other read or parse failure is an error.
fn load(dir: &Path) -> crate::Result<Secrets> {
    let path = dir.join(FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Secrets::default()),
        Err(error) => return Err(format!("Could not read PandaCode Connect secrets at {}: {error}", path.display())),
    };
    serde_json::from_str(&text).map_err(|error| format!("PandaCode Connect secrets at {} are corrupt: {error}", path.display()))
}

/// Replaces the stored secrets with `change(current)`; an empty result deletes the file.
pub(crate) fn update(dir: &Path, change: impl FnOnce(Secrets) -> Secrets) -> crate::Result<()> {
    let _guard = WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK))
        .and_then(|file| file.lock().map(|_| file))
        .map_err(|e| format!("Could not lock PandaCode Connect secrets: {e}"))?;
    let next = change(load(dir)?);
    let path = dir.join(FILE);
    if next == Secrets::default() {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not remove PandaCode Connect secrets: {error}")),
            _ => Ok(()),
        };
    }
    let text = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    let saved = write_atomic(dir, &path, &text).map_err(|e| format!("Could not save PandaCode Connect secrets: {e}"));
    drop(lock);
    saved
}

pub(crate) fn set_token(dir: &Path, token: &str) -> crate::Result<()> {
    update(dir, |s| Secrets { token: Some(token.to_owned()), ..s })
}

/// Sign-out: drops the token and keeps the device key.
pub(crate) fn remove_token(dir: &Path) -> crate::Result<()> {
    update(dir, |s| Secrets { token: None, ..s })
}

pub(crate) fn set_key(dir: &Path, key: &str) -> crate::Result<()> {
    update(dir, |s| Secrets { key: Some(key.to_owned()), ..s })
}

fn write_atomic(dir: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = dir.join(format!("{FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|_| std::fs::rename(&temp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-connect-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_and_sign_out_keeps_the_key() {
        let dir = temp_dir();
        set_key(&dir, "k").unwrap();
        set_token(&dir, "t").unwrap();
        assert_eq!(read(&dir), Secrets { token: Some("t".into()), key: Some("k".into()) });
        remove_token(&dir).unwrap();
        assert_eq!(read(&dir), Secrets { token: None, key: Some("k".into()) });
        // Removing the last field removes the file.
        update(&dir, |_| Secrets::default()).unwrap();
        assert!(!dir.join(FILE).exists());
        remove_token(&dir).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_reads_as_none_but_is_never_overwritten() {
        let dir = temp_dir();
        assert_eq!(read(&dir), Secrets::default());
        std::fs::write(dir.join(FILE), "{not json").unwrap();
        assert_eq!(read(&dir), Secrets::default());
        assert!(set_token(&dir, "t").unwrap_err().contains("corrupt"));
        assert!(update(&dir, |_| Secrets::default()).is_err());
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_is_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join(FILE);
        std::fs::write(&path, r#"{"token":"old","key":"k"}"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            return; // Running as root: permissions do not stop reads.
        }
        assert!(set_token(&dir, "new").unwrap_err().contains("Could not read"));
        assert!(remove_token(&dir).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"token":"old","key":"k"}"#);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_are_atomic_and_private() {
        let dir = temp_dir();
        set_token(&dir, "t").unwrap();
        set_key(&dir, "k").unwrap();
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from(FILE), std::ffi::OsString::from(LOCK)]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
