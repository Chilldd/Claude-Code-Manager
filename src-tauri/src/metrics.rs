use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter;

// ── Control channel ──

pub enum MetricsCmd {
    TrackSession {
        session_id: String,
        root_pids: Vec<u32>,
    },
    UntrackSession {
        session_id: String,
    },
    #[allow(dead_code)]
    Shutdown,
}

// ── Event payloads (emitted to frontend) ──

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

// ── Tracked session state ──

struct TrackedSession {
    root_pids: Vec<u32>,
    last_proc_map: HashMap<u32, FlatProcessInfo>,
    state: String,
    idle_ticks: u32,
    last_cpu_sum: f32,
}

impl TrackedSession {
    fn new(root_pids: Vec<u32>) -> Self {
        Self {
            root_pids,
            last_proc_map: HashMap::new(),
            state: "created".to_string(),
            idle_ticks: 0,
            last_cpu_sum: 0.0,
        }
    }
}

// ── MetricsEngine: background sampling + event emitter ──

pub struct MetricsEngine {
    cmd_tx: mpsc::Sender<MetricsCmd>,
}

impl MetricsEngine {
    pub fn spawn(app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut inner = MetricsEngineInner::new(app_handle, rx);
            inner.run();
        });
        Self { cmd_tx: tx }
    }

    pub fn send(&self, cmd: MetricsCmd) {
        let _ = self.cmd_tx.send(cmd);
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
            while let Ok(cmd) = self.rx.try_recv() {
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
                        self.session_pid_map.insert(session_id.clone(), new_pids.clone());

                        let _ = self.app_handle.emit(
                            "session-state-changed",
                            SessionStatePayload {
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

                        let _ = self.app_handle.emit(
                            "process-tree-updated",
                            ProcessTreePayload {
                                session_id: session_id.clone(),
                                trees: vec![],
                            },
                        );
                        let _ = self.app_handle.emit(
                            "session-state-changed",
                            SessionStatePayload {
                                session_id: session_id.clone(),
                                state: "exited".to_string(),
                            },
                        );
                        self.sessions.remove(&session_id);
                    }
                    MetricsCmd::Shutdown => return,
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
            let _ = self.app_handle.emit("system-metrics-updated", &sys_payload);
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

            // ── Slow layer (every 10 ticks): re-emit metrics ──
            if self.tick % 10 == 0 {
                if let Some(ref m) = self.last_system_metrics {
                    let _ = self.app_handle.emit("system-metrics-updated", m);
                }
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

// ── Standalone helpers (no &self needed — avoids borrow conflicts) ──

/// Known infrastructure / non-user processes to exclude from metrics
const EXCLUDED_PROCESSES: &[&str] = &[
    "msedgewebview2.exe",
    "MicrosoftEdgeWebView2.exe",
    "conhost.exe",
    "OpenConsole.exe",
    "RuntimeBroker.exe",
    "ApplicationFrameHost.exe",
];

fn is_excluded(name: &str) -> bool {
    EXCLUDED_PROCESSES
        .iter()
        .any(|&e| name.eq_ignore_ascii_case(e))
}

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
            // Skip infrastructure / non-user processes
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

    // Infer session state
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
fn collect_descendants(sys: &System, root_pids: &[u32]) -> Vec<u32> {
    let mut all: Vec<u32> = root_pids.to_vec();
    let mut queue: Vec<u32> = root_pids.to_vec();

    while let Some(pid) = queue.pop() {
        let children: Vec<u32> = sys
            .processes()
            .iter()
            .filter(|(_, p)| {
                p.parent().map(|pp| pp.as_u32()) == Some(pid) && pid != p.pid().as_u32()
            })
            .map(|(pid, _)| pid.as_u32())
            .collect();
        for c in children {
            if !all.contains(&c) {
                all.push(c);
                queue.push(c);
            }
        }
    }
    all
}

fn build_process_trees(
    root_pids: &[u32],
    proc_map: &HashMap<u32, FlatProcessInfo>,
) -> Vec<ProcessNode> {
    // For each root PID, skip excluded processes and find the first
    // non-excluded descendants as the visible roots
    let mut roots = Vec::new();
    for &pid in root_pids {
        if let Some(info) = proc_map.get(&pid) {
            if !is_excluded(&info.name) {
                roots.push(pid);
            } else {
                let children = find_non_excluded_children(pid, proc_map);
                roots.extend(children);
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots.iter().filter_map(|pid| build_tree(*pid, proc_map)).collect()
}

fn find_non_excluded_children(
    pid: u32,
    proc_map: &HashMap<u32, FlatProcessInfo>,
) -> Vec<u32> {
    let mut result = Vec::new();
    let children: Vec<u32> = proc_map
        .values()
        .filter(|p| p.parent_pid == Some(pid) && p.pid != pid)
        .map(|p| p.pid)
        .collect();
    for child_pid in children {
        if let Some(info) = proc_map.get(&child_pid) {
            if is_excluded(&info.name) {
                result.extend(find_non_excluded_children(child_pid, proc_map));
            } else {
                result.push(child_pid);
            }
        }
    }
    result
}

fn build_tree(
    pid: u32,
    proc_map: &HashMap<u32, FlatProcessInfo>,
) -> Option<ProcessNode> {
    let info = proc_map.get(&pid)?;
    if is_excluded(&info.name) {
        return None;
    }

    // Build children: skip excluded ones, graft their non-excluded children up
    let children: Vec<ProcessNode> = proc_map
        .values()
        .filter(|p| p.parent_pid == Some(pid) && p.pid != pid)
        .filter_map(|p| {
            if is_excluded(&p.name) {
                let gc = find_non_excluded_children(p.pid, proc_map);
                Some(gc.iter().filter_map(|&gpid| build_tree(gpid, proc_map)).collect::<Vec<_>>())
            } else {
                build_tree(p.pid, proc_map).map(|n| vec![n])
            }
        })
        .flatten()
        .collect();

    Some(ProcessNode {
        pid,
        parent_pid: info.parent_pid,
        children,
        name: info.name.clone(),
        cpu_percent: info.cpu_percent,
        memory_bytes: info.memory_bytes,
        state: info.state.clone(),
    })
}

fn infer_session_state(
    session: &mut TrackedSession,
    proc_map: &HashMap<u32, FlatProcessInfo>,
) -> String {
    if proc_map.is_empty() {
        return "exited".to_string();
    }

    let cpu_sum: f32 = proc_map.values().map(|p| p.cpu_percent).sum();

    if cpu_sum < 0.5 {
        let _mem_total: u64 = proc_map.values().map(|p| p.memory_bytes).sum();
        session.idle_ticks += 1;
        session.last_cpu_sum = cpu_sum;

        // Debounce: require 3 consecutive ticks (~6s) below CPU threshold
        // before declaring idle. Prevents flickering when CPU hovers around 0.5%.
        if session.idle_ticks < 3 {
            return session.state.clone();
        }

        if session.idle_ticks >= 6 {
            return "zombie".to_string();
        }
        return "idle".to_string();
    }

    session.idle_ticks = 0;
    session.last_cpu_sum = cpu_sum;

    if cpu_sum > 50.0 {
        return "busy".to_string();
    }
    "running".to_string()
}
