use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// Append a timestamped message to `%TEMP%\ccm-debug.log`.
/// Visible across webview refreshes and process restarts (appends, not overwrites).
pub fn debug_log(msg: impl std::fmt::Display) {
    let path = std::env::temp_dir().join("ccm-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "[{}] {}", chrono_now(), msg);
    }
}

fn chrono_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let millis = d.as_millis() % 1000;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, millis)
}
