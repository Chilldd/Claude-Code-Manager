use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;
use sysinfo::ProcessesToUpdate;
use tauri::{Emitter, WebviewWindow};

// ── Event payloads ──

#[derive(Debug, Clone, Serialize)]
pub struct PtyOutputPayload {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyExitPayload {
    pub session_id: String,
    pub code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyTitlePayload {
    pub session_id: String,
    pub title: String,
}

/// Emitted when a PTY session is created (with detected root PIDs)
#[derive(Debug, Clone, Serialize)]
pub struct SessionCreatedPayload {
    pub session_id: String,
    pub workspace_id: String,
    pub root_pids: Vec<u32>,
}

/// Emitted when a PTY session is killed
#[derive(Debug, Clone, Serialize)]
pub struct SessionKilledPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
}

// ── OSC title parser ──

fn parse_osc_title(data: &[u8]) -> Option<(String, usize)> {
    let mut pos = 0;
    while pos + 3 < data.len() {
        if data[pos] == 0x1b && data[pos + 1] == b']' {
            let cmd = data[pos + 2];
            if (cmd == b'0' || cmd == b'2') && data[pos + 3] == b';' {
                let title_start = pos + 4;
                for i in title_start..data.len() {
                    if data[i] == 0x07 {
                        let title = String::from_utf8_lossy(&data[title_start..i]).to_string();
                        return Some((title, i + 1));
                    }
                    if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'\\' {
                        let title = String::from_utf8_lossy(&data[title_start..i]).to_string();
                        return Some((title, i + 2));
                    }
                }
                let title = String::from_utf8_lossy(&data[title_start..]).to_string();
                if !title.is_empty() {
                    return Some((title, data.len()));
                }
                return None;
            }
            pos += 3;
        } else {
            pos += 1;
        }
    }
    None
}

// ── Per-session state (pure PTY, no sysinfo) ──

struct PtySession {
    id: String,
    workspace_id: String,
    child: Option<Box<dyn ChildKiller + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
}

// ── Session manager ──

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Create a new PTY session.
    /// Returns (session_id, root_pids) — root PIDs captured at spawn time.
    pub fn create(
        &mut self,
        window: &WebviewWindow,
        workspace_id: &str,
        _session_name: &str,
        command: &str,
        args: &str,
        cwd: &str,
        env: HashMap<String, String>,
    ) -> Result<(String, Vec<u32>), String> {
        let session_id = uuid::Uuid::new_v4().to_string();

        let args: Vec<&str> = args.split_whitespace().filter(|a| !a.is_empty()).collect();

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 48,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY open: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("PTY reader: {}", e))?;

        let writer = pair
            .master
            .try_clone_writer()
            .map_err(|e| format!("PTY writer: {}", e))?;

        let mut cmd_builder = CommandBuilder::new(command);
        for a in &args {
            cmd_builder.arg(a);
        }
        cmd_builder.cwd(cwd);

        for (key, value) in &env {
            cmd_builder.env(key, value);
        }

        // Emit starting message
        let _ = window.emit(
            "pty-output",
            PtyOutputPayload {
                session_id: session_id.clone(),
                data: format!(
                    "\r\n[Starting: {} {} in {}]\r\n\r\n",
                    command,
                    args.join(" "),
                    cwd
                ),
            },
        );

        let child = pair.slave.spawn_command(cmd_builder).map_err(|e| {
            let msg = format!("PTY spawn: {}", e);
            let _ = window.emit(
                "pty-output",
                PtyOutputPayload {
                    session_id: session_id.clone(),
                    data: format!("\r\n[{}]\r\n", msg),
                },
            );
            msg
        })?;

        // Detect root PIDs spawned by this process
        let root_pids = detect_our_child_pids();

        let session = PtySession {
            id: session_id.clone(),
            workspace_id: workspace_id.to_string(),
            child: Some(child),
            writer: Some(writer),
            master: Some(pair.master),
        };
        self.sessions.insert(session_id.clone(), session);

        // Reader thread — emits PTY events scoped by session_id
        let win = window.clone();
        let sid = session_id.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; 65536];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = win.emit(
                            "pty-output",
                            PtyOutputPayload {
                                session_id: sid.clone(),
                                data: "\r\n[Process exited]\r\n".to_string(),
                            },
                        );
                        let _ = win.emit(
                            "pty-exit",
                            PtyExitPayload {
                                session_id: sid.clone(),
                                code: 0,
                            },
                        );
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let trimmed = data.trim_end_matches('\0').to_string();

                        if let Some((title, _)) = parse_osc_title(&buf[..n]) {
                            let _ = win.emit(
                                "pty-title",
                                PtyTitlePayload {
                                    session_id: sid.clone(),
                                    title,
                                },
                            );
                        }

                        if !trimmed.is_empty() {
                            let _ = win.emit(
                                "pty-output",
                                PtyOutputPayload {
                                    session_id: sid.clone(),
                                    data: trimmed,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        let msg = format!("\r\n[PTY error: {}]\r\n", e);
                        let _ = win.emit(
                            "pty-output",
                            PtyOutputPayload {
                                session_id: sid.clone(),
                                data: msg,
                            },
                        );
                        let _ = win.emit(
                            "pty-exit",
                            PtyExitPayload {
                                session_id: sid.clone(),
                                code: -1,
                            },
                        );
                        break;
                    }
                }
            }
        });

        Ok((session_id, root_pids))
    }

    pub fn write(&mut self, session_id: &str, data: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            if let Some(writer) = &mut session.writer {
                writer
                    .write_all(data.as_bytes())
                    .map_err(|e| format!("PTY write: {}", e))?;
                writer
                    .flush()
                    .map_err(|e| format!("PTY flush: {}", e))?;
                Ok(())
            } else {
                Err("No active PTY".to_string())
            }
        } else {
            Err("Session not found".to_string())
        }
    }

    pub fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(session) = self.sessions.get(session_id) {
            if let Some(master) = &session.master {
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| format!("PTY resize: {}", e))
            } else {
                Ok(())
            }
        } else {
            Err("Session not found".to_string())
        }
    }

    /// Kill a specific session. Returns the session_id if found.
    pub fn kill(&mut self, session_id: &str) -> bool {
        if let Some(mut session) = self.sessions.remove(session_id) {
            if let Some(mut child) = session.child.take() {
                let _ = child.kill();
            }
            session.writer.take();
            session.master.take();
            true
        } else {
            false
        }
    }

    pub fn is_active(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn list_active(&self) -> Vec<SessionInfo> {
        self.sessions
            .values()
            .map(|s| SessionInfo {
                id: s.id.clone(),
                workspace_id: s.workspace_id.clone(),
                name: String::new(),
            })
            .collect()
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in &ids {
            self.kill(&id);
        }
    }

    #[allow(dead_code)]
    pub fn kill_workspace(&mut self, workspace_id: &str) {
        let ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.workspace_id == workspace_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in &ids {
            self.kill(&id);
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Snapshot child PIDs of our process right now.
/// Used at spawn time to detect what was just launched.
/// This is the only place we touch sysinfo in the PTY layer — a one-shot probe.
pub fn detect_our_child_pids() -> Vec<u32> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(ProcessesToUpdate::All);
    let our_pid = std::process::id();
    let mut all: Vec<u32> = Vec::new();

    // Direct children
    let direct: Vec<u32> = sys
        .processes()
        .iter()
        .filter(|(_, p)| p.parent().map(|pp| pp.as_u32()) == Some(our_pid))
        .map(|(pid, _)| pid.as_u32())
        .collect();
    all.extend(&direct);

    // Grandchildren (children of direct children — captures conhost → user_command on Windows)
    for &child_pid in &direct {
        let gc: Vec<u32> = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.parent().map(|pp| pp.as_u32()) == Some(child_pid))
            .map(|(pid, _)| pid.as_u32())
            .collect();
        all.extend(gc);
    }

    all
}
