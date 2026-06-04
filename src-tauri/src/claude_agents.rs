//! Claude Agents monitor: periodically polls `claude agents --json` and
//! stores the results keyed by sessionId so they can be matched with
//! active terminal sessions.

use crate::log::debug_log;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// Suppress the console window when spawning `claude` on Windows.
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Agent operational status from `claude agents --json`.
#[derive(Debug, Clone)]
pub enum AgentStatus {
    Idle,
    Busy,
    Waiting,
    Running,
    Unknown(String),
}

impl Serialize for AgentStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Waiting => "waiting",
            Self::Running => "running",
            Self::Unknown(s) => s,
        })
    }
}

impl<'de> Deserialize<'de> for AgentStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "idle" => Self::Idle,
            "busy" => Self::Busy,
            "waiting" => Self::Waiting,
            "running" => Self::Running,
            other => Self::Unknown(other.to_string()),
        })
    }
}

/// One entry from `claude agents --json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeAgentInfo {
    pub pid: u32,
    pub cwd: String,
    pub kind: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub status: AgentStatus,
    #[serde(rename = "waitingFor", default)]
    pub waiting_for: Option<String>,
}

/// Handle to a background monitor that keeps a live snapshot of Claude agents.
///
/// ## Thread safety
/// Internally uses `Arc<Mutex<HashMap>>` so the handle can be shared freely.
pub struct ClaudeAgentMonitor {
    store: Arc<Mutex<HashMap<String, ClaudeAgentInfo>>>,
    /// Maps PID → first-seen session_id.
    /// When a claude process calls `resume` its `claude agents --json` session_id
    /// changes, but the PID stays the same.  We cache the original session_id so
    /// the frontend can keep matching by the stable ID it already knows.
    #[allow(dead_code)]
    pid_cache: Arc<Mutex<HashMap<u32, String>>>,
}

impl ClaudeAgentMonitor {
    /// Spawn a background thread that polls `claude agents --json` every 500ms
    /// and pushes the result to the frontend via `claude-agents-updated` event.
    pub fn spawn(app_handle: tauri::AppHandle) -> Self {
        let store: Arc<Mutex<HashMap<String, ClaudeAgentInfo>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pid_cache: Arc<Mutex<HashMap<u32, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let clone_store = Arc::clone(&store);
        let clone_cache = Arc::clone(&pid_cache);

        std::thread::spawn(move || loop {
            if let Err(e) = refresh_and_emit(&clone_store, &clone_cache, &app_handle) {
                debug_log(format!("[claude_agents] refresh failed: {}", e));
            }
            std::thread::sleep(Duration::from_millis(500));
        });

        Self { store, pid_cache }
    }

    /// Look up agent info by session ID.
    pub fn get(&self, session_id: &str) -> Option<ClaudeAgentInfo> {
        self.store.lock().ok()?.get(session_id).cloned()
    }

    /// Return a snapshot of all known agents.
    #[allow(dead_code)]
    pub fn get_all(&self) -> HashMap<String, ClaudeAgentInfo> {
        self.store.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Run `claude agents --json`, update store, and emit event to frontend.
fn refresh_and_emit(
    store: &Mutex<HashMap<String, ClaudeAgentInfo>>,
    pid_cache: &Mutex<HashMap<u32, String>>,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new("claude");
    cmd.args(["agents", "--json"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().map_err(|e| format!("spawn claude agents: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude agents exited non-zero: {}", stderr));
    }

    let agents: Vec<ClaudeAgentInfo> =
        serde_json::from_slice(&output.stdout).map_err(|e| {
            format!(
                "parse claude agents JSON: {} (stdout: {})",
                e,
                String::from_utf8_lossy(&output.stdout)
            )
        })?;

    // Build agents map keyed by stable (first-seen) session_id.
    // When a claude process calls `resume` its session_id in `claude agents --json`
    // changes but the PID stays the same — pid_cache holds the original session_id
    // so the frontend can keep matching by the ID it already knows.
    let active_pids: Vec<u32> = agents.iter().map(|a| a.pid).collect();
    let mut cache = pid_cache.lock().map_err(|e| format!("pid_cache lock: {}", e))?;

    // Evict stale entries for processes that have exited
    cache.retain(|pid, _| active_pids.contains(pid));

    let agents_map: HashMap<String, ClaudeAgentInfo> = agents
        .into_iter()
        .map(|a| {
            let stable_id = cache
                .entry(a.pid)
                .or_insert_with(|| a.session_id.clone());
            (stable_id.clone(), a)
        })
        .collect();

    // Release pid_cache lock before emitting
    drop(cache);

    // Emit to frontend *before* storing to minimize latency
    app_handle
        .emit("claude-agents-updated", &agents_map)
        .map_err(|e| format!("emit event: {}", e))?;

    // Update shared store
    let mut map = store.lock().map_err(|e| format!("store lock: {}", e))?;
    *map = agents_map;

    Ok(())
}
