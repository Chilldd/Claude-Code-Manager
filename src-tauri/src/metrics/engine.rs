use super::state::{infer_session_state, TrackedSession};
use super::tree::{build_process_trees, collect_descendants};
use super::{
    is_excluded, FlatProcessInfo, MetricsCmd, ProcessTreePayload, ProcessesDiffPayload,
    SessionStatePayload, SystemMetricsPayload,
};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter;

/// Handle used to send commands to the background metrics thread.
pub struct MetricsEngine {
    cmd_tx: mpsc::Sender<MetricsCmd>,
}

impl MetricsEngine {
    /// Spawn a background thread that samples system metrics every ~1 s and
    /// emits Tauri events for every tracked session.
    pub fn spawn(app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut inner = MetricsEngineInner::new(app_handle, rx);
            inner.run();
        });
        Self { cmd_tx: tx }
    }

    /// Send a command to the background thread (TrackSession / UntrackSession).
    pub fn send(&self, cmd: MetricsCmd) {
        if let Err(e) = self.cmd_tx.send(cmd) {
            eprintln!("[metrics] Failed to send command: {}", e);
        }
    }
}

impl Drop for MetricsEngine {
    fn drop(&mut self) {
        // Dropping cmd_tx causes the receiver to get `Disconnected`,
        // which makes the run loop exit naturally.
    }
}

struct MetricsEngineInner {
    sys: System,
    sessions: HashMap<String, TrackedSession>,
    /// All PIDs currently tracked across ALL sessions (for dedup)
    global_pid_set: HashSet<u32>,
    /// Which PIDs each session actually claimed (after dedup)
    session_pid_map: HashMap<String, Vec<u32>>,
    rx: mpsc::Receiver<MetricsCmd>,
    app_handle: tauri::AppHandle,
    tick: u64,
    last_system_metrics: Option<SystemMetricsPayload>,
}

impl MetricsEngineInner {
    fn new(app_handle: tauri::AppHandle, rx: mpsc::Receiver<MetricsCmd>) -> Self {
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All);
        Self {
            sys,
            sessions: HashMap::new(),
            global_pid_set: HashSet::new(),
            session_pid_map: HashMap::new(),
            rx,
            app_handle,
            tick: 0,
            last_system_metrics: None,
        }
    }

    fn run(&mut self) {
        loop {
            // Drain pending commands; exit if sender is dropped
            loop {
                match self.rx.try_recv() {
                    Ok(cmd) => self.handle_cmd(cmd),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return, // MetricsEngine dropped
                }
            }

            self.tick += 1;

            // ── Fast layer (every tick = 1s): system metrics ──
            self.sys.refresh_cpu_all();
            self.sys.refresh_memory();
            let sys_payload = SystemMetricsPayload {
                cpu_percent: self.sys.global_cpu_usage(),
                memory_total_gb: self.sys.total_memory() as f32 / (1024.0 * 1024.0 * 1024.0),
                memory_used_gb: self.sys.used_memory() as f32 / (1024.0 * 1024.0 * 1024.0),
                memory_percent: if self.sys.total_memory() > 0 {
                    self.sys.used_memory() as f32 / self.sys.total_memory() as f32 * 100.0
                } else {
                    0.0
                },
            };
            self.emit("system-metrics-updated", &sys_payload);
            self.last_system_metrics = Some(sys_payload);

            // ── Medium layer (every 2 ticks): process tree + diff ──
            if self.tick % 2 == 0 {
                self.sys.refresh_processes(ProcessesToUpdate::All);
                let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
                for sid in &session_ids {
                    if let Some(session) = self.sessions.get_mut(sid) {
                        refresh_session(&self.sys, &self.app_handle, sid, session);
                    }
                }
            }

            // ── Slow layer (every 10 ticks): re-emit heartbeat metrics ──
            if self.tick % 10 == 0 {
                if let Some(ref m) = self.last_system_metrics {
                    self.emit("system-metrics-updated", m);
                }
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    }

    fn handle_cmd(&mut self, cmd: MetricsCmd) {
        match cmd {
            MetricsCmd::TrackSession {
                session_id,
                root_pids,
            } => {
                // Dedup: only take PIDs not already tracked by other sessions
                let new_pids: Vec<u32> = root_pids
                    .into_iter()
                    .filter(|pid| !self.global_pid_set.contains(pid))
                    .collect();
                for pid in &new_pids {
                    self.global_pid_set.insert(*pid);
                }
                self.session_pid_map
                    .insert(session_id.clone(), new_pids.clone());

                self.emit(
                    "session-state-changed",
                    &SessionStatePayload {
                        session_id: session_id.clone(),
                        state: "created".to_string(),
                    },
                );
                self.sessions
                    .insert(session_id, TrackedSession::new(new_pids));
            }
            MetricsCmd::UntrackSession { session_id } => {
                // Release this session's PIDs from global set
                if let Some(pids) = self.session_pid_map.remove(&session_id) {
                    for pid in pids {
                        self.global_pid_set.remove(&pid);
                    }
                }

                self.emit(
                    "process-tree-updated",
                    &ProcessTreePayload {
                        session_id: session_id.clone(),
                        trees: vec![],
                    },
                );
                self.emit(
                    "session-state-changed",
                    &SessionStatePayload {
                        session_id: session_id.clone(),
                        state: "exited".to_string(),
                    },
                );
                self.sessions.remove(&session_id);
            }
        }
    }

    fn emit<T: serde::Serialize + std::fmt::Debug>(&self, event: &str, payload: &T) {
        if let Err(e) = self.app_handle.emit(event, payload) {
            eprintln!("[metrics] Failed to emit {}: {}", event, e);
        }
    }
}

/// Refresh process info for one tracked session, emitting diff/tree/state events.
fn refresh_session(
    sys: &System,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    session: &mut TrackedSession,
) {
    let all_pids = collect_descendants(sys, &session.root_pids);

    let mut current_map: HashMap<u32, FlatProcessInfo> = HashMap::new();
    for &pid in &all_pids {
        if let Some(proc) = sys.process(sysinfo::Pid::from_u32(pid)) {
            let name = proc.name().to_string_lossy().to_string();
            if is_excluded(&name) {
                continue;
            }
            let info = FlatProcessInfo {
                pid,
                name,
                cpu_percent: proc.cpu_usage(),
                memory_bytes: proc.memory(),
                state: format!("{:?}", proc.status()),
                parent_pid: proc.parent().map(|p| p.as_u32()),
            };
            current_map.insert(pid, info);
        }
    }

    // Compute diff
    let mut added: Vec<FlatProcessInfo> = Vec::new();
    let mut removed: Vec<u32> = Vec::new();
    let mut updated: Vec<FlatProcessInfo> = Vec::new();

    for (&pid, info) in &current_map {
        if !session.last_proc_map.contains_key(&pid) {
            added.push(info.clone());
        } else {
            let old = &session.last_proc_map[&pid];
            if (old.cpu_percent - info.cpu_percent).abs() > 0.5
                || old.memory_bytes != info.memory_bytes
            {
                updated.push(info.clone());
            }
        }
    }

    for pid in session.last_proc_map.keys() {
        if !current_map.contains_key(pid) {
            removed.push(*pid);
        }
    }

    // Emit diff event
    if !added.is_empty() || !removed.is_empty() || !updated.is_empty() {
        let _ = app_handle.emit(
            "processes-diff",
            ProcessesDiffPayload {
                session_id: session_id.to_string(),
                added,
                removed,
                updated,
            },
        );
    }

    // Emit process tree
    let trees = build_process_trees(&session.root_pids, &current_map);
    let _ = app_handle.emit(
        "process-tree-updated",
        ProcessTreePayload {
            session_id: session_id.to_string(),
            trees,
        },
    );

    // Infer and emit session state
    let new_state = infer_session_state(session, &current_map);
    if new_state != session.state {
        let _ = app_handle.emit(
            "session-state-changed",
            SessionStatePayload {
                session_id: session_id.to_string(),
                state: new_state.clone(),
            },
        );
        session.state = new_state;
    }

    session.last_proc_map = current_map;
}
