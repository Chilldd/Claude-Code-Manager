//! Application configuration (`~/.ccmanager/ccmanager.json`).
//!
//! Read at startup; not written back by the app (users edit the file manually).

use crate::log::debug_log;
use crate::workspace::home_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Top-level application configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ccconfig {
    #[serde(default)]
    pub notification: NotificationConfig,
    #[serde(default)]
    pub log: LogConfig,
}

/// Notification preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    /// Notify when a task completes (busy → idle). Default: false.
    #[serde(default)]
    pub task_complete: bool,
    /// Notify when claude needs permission. Default: true.
    #[serde(default = "default_true")]
    pub permission_prompt: bool,
}

/// Logging preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    /// Minimum log level: "error", "warn", "info", "debug", "trace". Default: "debug".
    #[serde(default = "default_log_level")]
    pub level: String,
    /// Directory path for log output. Default: `~/.ccmanager/`.
    #[serde(default = "default_log_path")]
    pub path: String,
}

fn default_log_level() -> String {
    "debug".to_string()
}

fn default_log_path() -> String {
    let mut p = home_dir();
    p.push(".ccmanager");
    p.push("logs");
    p.to_string_lossy().to_string()
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            path: default_log_path(),
        }
    }
}

const fn default_true() -> bool {
    true
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            task_complete: false,
            permission_prompt: default_true(),
        }
    }
}

impl Default for Ccconfig {
    fn default() -> Self {
        Self {
            notification: NotificationConfig {
                task_complete: false,
                permission_prompt: true,
            },
            log: LogConfig::default(),
        }
    }
}

fn config_path() -> PathBuf {
    let mut path = home_dir();
    path.push(".ccmanager");
    path.push("ccmanager.json");
    path
}

/// Ensure the config directory exists.
pub fn ensure_dir() {
    let path = config_path();
    let dir = path.parent().unwrap();
    let _ = std::fs::create_dir_all(dir);
}

/// Load config from disk, returning defaults if the file doesn't exist or is corrupt.
/// When the file is missing, it is created with defaults so users can find and edit it.
pub fn load() -> Ccconfig {
    let path = config_path();
    if !path.exists() {
        debug_log(format!("[config] {} not found, creating with defaults", path.display()));
        let cfg = Ccconfig::default();
        ensure_dir();
        if let Ok(json) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(&path, json);
        }
        return cfg;
    }

    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            // Strip UTF-8 BOM if present (PowerShell Set-Content writes it)
            let raw = raw.trim_start_matches('\u{feff}');
            match serde_json::from_str::<Ccconfig>(raw) {
                Ok(cfg) => {
                    debug_log(format!("[config] loaded from {}", path.display()));
                    cfg
                }
                Err(e) => {
                    let backup = path.with_extension("json.bak");
                    let _ = std::fs::copy(&path, &backup);
                    debug_log(format!(
                        "[config] parse error {} — backed up to {}, using defaults",
                        e,
                        backup.display()
                    ));
                    Ccconfig::default()
                }
            }
        }
        Err(e) => {
            debug_log(format!("[config] read error {} — using defaults", e));
            Ccconfig::default()
        }
    }
}
