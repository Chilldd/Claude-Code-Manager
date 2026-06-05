use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;

/// On Windows, npm-installed tools like `claude` are `.cmd` shims that
/// `CreateProcessW` cannot execute directly.  If the command has no
/// executable extension, run it via `cmd /c`.
fn resolve_command(cmd: &str, args: &[String]) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let lower = cmd.to_lowercase();
        let has_ext = lower.ends_with(".exe")
            || lower.ends_with(".cmd")
            || lower.ends_with(".bat")
            || lower.ends_with(".com");
        if !has_ext {
            let mut cmd_args = vec!["/c".to_string(), cmd.to_string()];
            cmd_args.extend_from_slice(args);
            return ("cmd.exe".to_string(), cmd_args);
        }
    }
    // Non-Windows or already an executable — use as-is
    (cmd.to_string(), args.to_vec())
}
use sysinfo::ProcessesToUpdate;
use tauri::{Emitter, WebviewWindow};

use crate::log::debug_log;

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

/// Emitted when a PTY session is created
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

/// Parse a command-line string into arguments, respecting shell quoting rules.
///
/// This handles single quotes, double quotes, and escaped characters.
#[cfg(not(test))]
fn parse_args(input: &str) -> Vec<String> {
    match shell_words::split(input) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("[pty] Failed to parse args {:?}: {}. Falling back to whitespace split.", input, e);
            input.split_whitespace().map(|s| s.to_string()).collect()
        }
    }
}

// test-only stub to avoid depending on shell-words in tests
#[cfg(test)]
fn parse_args(input: &str) -> Vec<String> {
    input.split_whitespace().map(|s| s.to_string()).collect()
}

// ── Per-session state ──

struct PtySession {
    id: String,
    workspace_id: String,
    name: String,
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
    /// Returns `(session_id, root_pids)` — root PIDs captured at spawn time.
    pub fn create(
        &mut self,
        window: &WebviewWindow,
        session_id: &str,
        workspace_id: &str,
        session_name: &str,
        command: &str,
        args: &str,
        cwd: &str,
        env: HashMap<String, String>,
        inject_session_id: bool,
        cols: u16,
        rows: u16,
    ) -> Result<(String, Vec<u32>), String> {
        let mut args = parse_args(args);

        // Inject --session-id so the spawned process can identify itself.
        if inject_session_id {
            args.push("--session-id".to_string());
            args.push(session_id.to_string());
        }

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: if rows > 0 { rows } else { 48 },
                cols: if cols > 0 { cols } else { 120 },
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

        let (resolved_cmd, resolved_args) = resolve_command(command, &args);
        let mut cmd_builder = CommandBuilder::new(&resolved_cmd);
        for a in &resolved_args {
            cmd_builder.arg(a);
        }
        cmd_builder.cwd(cwd);

        eprintln!("[pty] create: cmd={}, resolved_cmd={}, args={:?}, cwd={}", command, resolved_cmd, resolved_args, cwd);

        for (key, value) in &env {
            cmd_builder.env(key, value);
        }

        // Emit starting message
        let _ = window.emit(
            "pty-output",
            PtyOutputPayload {
                session_id: session_id.to_string(),
                data: format!(
                    "\r\n[Starting: {} {} in {}]\r\n\r\n",
                    command,
                    args.join(" "),
                    cwd
                ),
            },
        );

        eprintln!("[pty] spawning command...");
        let child = pair.slave.spawn_command(cmd_builder).map_err(|e| {
            let msg = format!("PTY spawn: {}", e);
            eprintln!("[pty] spawn FAILED: {}", msg);
            let _ = window.emit(
                "pty-output",
                PtyOutputPayload {
                    session_id: session_id.to_string(),
                    data: format!("\r\n[{}]\r\n", msg),
                },
            );
            msg
        })?;

        // Detect root PIDs spawned by this process
        let root_pids = detect_our_child_pids();

        let session = PtySession {
            id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            name: session_name.to_string(),
            child: Some(child),
            writer: Some(writer),
            master: Some(pair.master),
        };
        self.sessions.insert(session_id.to_string(), session);

        // Reader thread — emits PTY events scoped by session_id
        let win = window.clone();
        let sid = session_id.to_string();
        eprintln!("[pty] reader thread spawning for {}", sid);
        thread::spawn(move || {
            eprintln!("[pty] reader thread STARTED for {}", sid);
            let mut buf = vec![0u8; 65536];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        debug_log(format!("[pty] reader EOF session={}", sid));
                        eprintln!("[pty] reader EOF for {}", sid);
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
                        debug_log(format!("[pty] reader error session={}: {}", sid, e));
                        eprintln!("[pty] reader error for {}: {}", sid, e);
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

        Ok((session_id.to_string(), root_pids))
    }

    pub fn write(&mut self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.sessions.get_mut(session_id).ok_or_else(|| {
            let msg = format!("Session not found: {}", session_id);
            debug_log(format!("[pty] write: {}", msg));
            msg
        })?;
        let writer = session.writer.as_mut().ok_or("No active PTY")?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| {
                let msg = format!("PTY write: {}", e);
                debug_log(format!("[pty] write error: {}", msg));
                msg
            })
    }

    pub fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.sessions.get(session_id).ok_or_else(|| {
            let msg = format!("Session not found: {}", session_id);
            debug_log(format!("[pty] resize: {}", msg));
            msg
        })?;
        if let Some(master) = &session.master {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| {
                    let msg = format!("PTY resize({}x{}): {}", cols, rows, e);
                    debug_log(format!("[pty] resize error: {}", msg));
                    msg
                })
        } else {
            Ok(())
        }
    }

    /// Kill a specific session. Returns `true` if a session was found.
    pub fn kill(&mut self, session_id: &str) -> bool {
        if let Some(mut session) = self.sessions.remove(session_id) {
            debug_log(format!("[pty] kill session={}", session_id));
            if let Some(mut child) = session.child.take() {
                let _ = child.kill();
            }
            session.writer.take();
            session.master.take();
            true
        } else {
            debug_log(format!("[pty] kill: session not found {}", session_id));
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
                name: s.name.clone(),
            })
            .collect()
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_osc_title_bel() {
        let data = b"hello\x1b]0;my title\x07world";
        let (title, end) = parse_osc_title(data).unwrap();
        assert_eq!(title, "my title");
        assert_eq!(&data[end..], b"world");
    }

    #[test]
    fn test_parse_osc_title_st() {
        let data = b"hello\x1b]2;tab title\x1b\\world";
        let (title, end) = parse_osc_title(data).unwrap();
        assert_eq!(title, "tab title");
        assert_eq!(&data[end..], b"world");
    }
}
