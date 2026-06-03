//! System metrics engine: background CPU/memory sampling, process tree
//! building, and session state inference.
//!
//! Organized into submodules:
//! - `engine`: sampling loop, MetricsEngine public API
//! - `tree`:  process tree / diff computation (pure functions)
//! - `state`: session state machine (TrackedSession + state inference)

mod engine;
pub(crate) mod state;
pub(crate) mod tree;

pub use engine::MetricsEngine;

use serde::Serialize;

// ── Control channel ──

pub enum MetricsCmd {
    TrackSession {
        session_id: String,
        root_pids: Vec<u32>,
    },
    UntrackSession {
        session_id: String,
    },
}

// ── Event payloads ──

#[derive(Debug, Clone, Serialize)]
pub struct SystemMetricsPayload {
    pub cpu_percent: f32,
    pub memory_total_gb: f32,
    pub memory_used_gb: f32,
    pub memory_percent: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessNode {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub children: Vec<ProcessNode>,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessTreePayload {
    pub session_id: String,
    pub trees: Vec<ProcessNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlatProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub state: String,
    pub parent_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessesDiffPayload {
    pub session_id: String,
    pub added: Vec<FlatProcessInfo>,
    pub removed: Vec<u32>,
    pub updated: Vec<FlatProcessInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatePayload {
    pub session_id: String,
    pub state: String,
}

// ── Excluded processes ──

/// Known infrastructure / non-user processes to exclude from metrics
const EXCLUDED_PROCESSES: &[&str] = &[
    "msedgewebview2.exe",
    "MicrosoftEdgeWebView2.exe",
    "conhost.exe",
    "OpenConsole.exe",
    "RuntimeBroker.exe",
    "ApplicationFrameHost.exe",
];

pub(crate) fn is_excluded(name: &str) -> bool {
    EXCLUDED_PROCESSES
        .iter()
        .any(|&e| name.eq_ignore_ascii_case(e))
}
