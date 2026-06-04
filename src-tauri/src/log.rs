use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolved log configuration. Protected by Mutex so `init()` can override
/// even if `debug_log()` was already called before init.
static LOG_STATE: Mutex<Option<LogState>> = Mutex::new(None);

#[derive(Clone)]
struct LogState {
    path: PathBuf,
    /// Minimum level to output: 0=error, 1=warn, 2=info, 3=debug.
    level: u8,
}

impl Default for LogState {
    fn default() -> Self {
        Self {
            path: std::env::temp_dir().join("ccm-debug.log"),
            level: 3,
        }
    }
}

fn level_value(s: &str) -> u8 {
    match s.trim().to_lowercase().as_str() {
        "error" => 0,
        "warn" | "warning" => 1,
        "info" => 2,
        "debug" => 3,
        "trace" => 4,
        _ => 3,
    }
}

/// Initialize logging from config. Call once at startup, after config is loaded.
pub fn init(level: &str, dir: &str) {
    let path = PathBuf::from(dir);
    let log_file = if path.extension().is_some() && path.file_name().is_some() {
        path
    } else {
        path.join("ccm-debug.log")
    };

    if let Some(parent) = log_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    *LOG_STATE.lock().unwrap() = Some(LogState {
        path: log_file,
        level: level_value(level),
    });
}

fn get_state() -> LogState {
    LOG_STATE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default()
}

fn write_log(msg: &str) {
    let s = get_state();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&s.path)
    {
        let _ = writeln!(f, "[{}] {}", chrono_now(), msg);
    }
}

/// Write a debug-level message to the log file.
/// Filtered out when configured level is below "debug".
pub fn debug_log(msg: impl std::fmt::Display) {
    let s = get_state();
    if s.level < 3 {
        return;
    }
    drop(s);
    write_log(&msg.to_string());
}

/// Write an info-level message to the log file.
/// Filtered out when configured level is below "info".
pub fn info_log(msg: impl std::fmt::Display) {
    let s = get_state();
    if s.level < 2 {
        return;
    }
    drop(s);
    write_log(&msg.to_string());
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
