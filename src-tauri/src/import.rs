use crate::{log::debug_log, workspace};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// ── Discovery ──

fn claude_projects_dir() -> PathBuf {
    let mut home = workspace::home_dir();
    home.push(".claude");
    home.push("projects");
    home
}

/// Discover Claude Code projects and return them as `Workspace` candidates.
///
/// Each returned workspace has an empty `id` — the caller should assign one
/// via `workspace::add_workspace` if they decide to persist it.
pub fn import_from_claude_code() -> Vec<workspace::Workspace> {
    let projects_dir = claude_projects_dir();
    if !projects_dir.is_dir() {
        return vec![];
    }

    let existing_paths: HashSet<String> = workspace::load_all()
        .into_iter()
        .map(|w| w.dir.clone())
        .collect();

    let mut result = Vec::new();

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(e) => {
            let msg = format!("Failed to read {:?}: {}", projects_dir, e);
            eprintln!("[import] {}", msg);
            debug_log(format!("[import] {}", msg));
            return vec![];
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let folder_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };

        let ws_path = match extract_project_path(&path, &folder_name) {
            Some(p) => p,
            None => continue,
        };

        // Skip if already in our workspace list
        if existing_paths.contains(&ws_path) {
            continue;
        }

        let name = Path::new(&ws_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| folder_name.clone());

        result.push(workspace::Workspace {
            id: String::new(),
            name,
            dir: ws_path,
            command: "claude".to_string(),
            args: String::new(),
            auto_prompt: String::new(),
            env: std::collections::HashMap::new(),
        });
    }

    result
}

/// Extract the workspace path from a Claude Code project folder.
///
/// Strategy:
/// 1. Try to decode the folder name back to a path (quick, no I/O).
/// 2. If the decoded path doesn't exist on disk, fall back to reading
///    the newest `.jsonl` session file to get the `"cwd"` field (reliable).
fn extract_project_path(project_dir: &Path, folder_name: &str) -> Option<String> {
    // Method 1: decode the folder name
    if let Some(p) = decode_folder_name(folder_name) {
        if Path::new(&p).is_dir() {
            return Some(p);
        }
    }

    // Method 2: read cwd from session JSONL files
    extract_cwd_from_session(project_dir)
}

/// Decode a Claude Code project folder name back into a filesystem path.
///
/// Claude Code encodes full paths by replacing each `:` with `-` and each
/// `\` with `-`. For example:
///   `D:\WorkSpace\YuG\agent\yug-cc-manager`
/// becomes:
///   `D--WorkSpace-YuG-agent-yug-cc-manager`
///
/// This is lossy for paths whose directory/file names contain dashes, but
/// works correctly as a first pass. The fallback reads `cwd` from session
/// files when the decoded path doesn't exist.
fn decode_folder_name(name: &str) -> Option<String> {
    if name.len() < 2 {
        return None;
    }

    let drive_letter = &name[..1];
    let rest = name[1..].strip_prefix('-')?; // skip the '-' that replaced ':'

    // Replace remaining '-' with '\' to reconstruct the backslash-separated path.
    // Note: rest already includes the leading '\' (from the first '\' after ':').
    let path = format!("{}:{}", drive_letter, rest.replace('-', "\\"));
    Some(path)
}

/// Read the `"cwd"` field from the newest `.jsonl` session file in a project directory.
/// We only read the first 32 KB of each file to stay fast.
fn extract_cwd_from_session(project_dir: &Path) -> Option<String> {
    // Collect .jsonl files sorted newest-first
    let mut session_files: Vec<_> = fs::read_dir(project_dir).ok()?
        .flatten()
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
        .collect();

    session_files.sort_by(|a, b| {
        b.metadata()
            .and_then(|m| m.modified())
            .ok()
            .cmp(&a.metadata().and_then(|m| m.modified()).ok())
    });

    let marker = r#""cwd":""#;

    for entry in &session_files {
        let file = match fs::File::open(entry.path()) {
            Ok(f) => f,
            Err(e) => {
                let msg = format!("Failed to open {:?}: {}", entry.path(), e);
                eprintln!("[import] {}", msg);
                debug_log(format!("[import] {}", msg));
                continue;
            }
        };
        let mut reader = BufReader::with_capacity(32_768, file);

        // Only read the first 32 KB — the cwd is always in the first user message
        let mut buf = String::new();
        let mut total = 0usize;
        loop {
            let line = reader.read_line(&mut buf);
            match line {
                Ok(0) => break, // EOF
                Ok(n) => {
                    total += n;
                    if total > 32_768 {
                        break;
                    }
                }
                Err(e) => {
                    let msg = format!("Read error on {:?}: {}", entry.path(), e);
                    eprintln!("[import] {}", msg);
                    debug_log(format!("[import] {}", msg));
                    break;
                }
            }
        }

        if let Some(cwd) = extract_cwd_from_raw(&buf, marker) {
            if Path::new(&cwd).is_dir() {
                return Some(cwd);
            }
        }
    }

    None
}

/// Parse the raw `"cwd":"..."` value from a JSONL fragment.
fn extract_cwd_from_raw(content: &str, marker: &str) -> Option<String> {
    let pos = content.find(marker)?;
    let start = pos + marker.len();
    let remaining = &content[start..];

    // Find the closing double-quote, respecting escaped backslashes
    let mut end = 0;
    let mut prev_was_escape = false;
    for (i, ch) in remaining.char_indices() {
        match ch {
            '\\' => {
                prev_was_escape = !prev_was_escape;
            }
            '"' if !prev_was_escape => {
                end = i;
                break;
            }
            _ => {
                prev_was_escape = false;
            }
        }
    }

    if end > 0 {
        // JSON escapes the backslashes: `D:\\path` → `D:\path`
        let json_val = &remaining[..end];
        Some(json_val.replace(r"\\", r"\"))
    } else {
        None
    }
}

/// Try to extract a session title from a `.jsonl` conversation file.
/// Claude Code stores the AI-generated title in a JSON line with
/// `"type":"ai-title"` and field `"aiTitle"`.  Read the file in 64 KB chunks
/// (up to 2 chunks ~ 128 KB) to avoid loading large transcripts.
fn extract_session_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(65_536, file);
    let mut buf = String::new();
    let mut total_read = 0usize;
    let marker = r#""type":"ai-title""#;

    // Try up to 2 chunks (≈ 128 KB) — titles are always near the top
    for _ in 0..2 {
        let chunk = reader.by_ref().take(65_536).read_to_string(&mut buf);
        match chunk {
            Ok(0) => break, // EOF
            Ok(n) => {
                total_read += n;
                if let Some(pos) = buf[total_read - n..].find(marker) {
                    let abs_pos = total_read - n + pos;
                    // Line boundaries around the marker
                    let line_start = buf[..abs_pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
                    let line_end = buf[abs_pos..].find('\n').map(|i| abs_pos + i).unwrap_or(buf.len());
                    let json_line = buf[line_start..line_end].trim();
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_line) {
                        if let Some(serde_json::Value::String(s)) = val.get("aiTitle") {
                            let s = s.trim();
                            if !s.is_empty() {
                                return Some(if s.len() > 80 {
                                    format!("{}...", &s[..77])
                                } else {
                                    s.to_string()
                                });
                            }
                        }
                    }
                    return None; // marker found but no valid title
                }
            }
            Err(_) => break,
        }
    }
    None
}

/// Encode a filesystem path to a Claude Code project folder name.
/// `D:\WorkSpace\YuG\agent\yug-cc-manager` → `D--WorkSpace-YuG-agent-yug-cc-manager`
pub fn encode_folder_name(path: &str) -> String {
    path.replace(':', "-").replace('\\', "-")
}

/// Summary of a recent session file
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    /// Session title (from Claude Code conversation metadata)
    pub title: String,
    /// Unix timestamp (milliseconds) of last modification
    pub last_modified: u64,
}

/// Return the most recent session `.jsonl` files for a workspace directory,
/// ordered by modification time (newest first).
pub fn recent_sessions(workspace_dir: &str, max: usize) -> Vec<SessionSummary> {
    let mut dir = claude_projects_dir();
    dir.push(encode_folder_name(workspace_dir));

    if !dir.is_dir() {
        return vec![];
    }

    let mut sessions: Vec<SessionSummary> = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
                .filter_map(|e| {
                    let session_id = e.path().file_stem()?.to_string_lossy().to_string();
                    let meta = e.metadata().ok()?;
                    let last_modified = meta
                        .modified()
                        .ok()?
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .ok()?
                        .as_millis() as u64;

                    // Read first line for session title
                    let title = extract_session_title(&e.path()).unwrap_or_default();

                    Some(SessionSummary {
                        session_id,
                        title,
                        last_modified,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Sort newest first, keep only the most recent `max`
    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    sessions.truncate(max);
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_folder_name() {
        // Simple case without embedded dashes
        assert_eq!(
            decode_folder_name("C--Users-test").as_deref(),
            Some("C:\\Users\\test")
        );
        assert!(decode_folder_name("").is_none());
        assert!(decode_folder_name("X").is_none());
    }

    #[test]
    fn test_decode_folder_name_with_dashes() {
        // NOTE: decode_folder_name is lossy for paths containing dashes
        // because it can't distinguish `-` that replaced `\` from literal `-`.
        // The preferred fallback is extract_cwd_from_session.
        // This test documents the behavior — a path like `D:\WorkSpace\YuG\agent\yug-cc-manager`
        // gets decoded as `D:\WorkSpace\YuG\agent\yug\cc\manager`.
        let result = decode_folder_name("D--WorkSpace-YuG-agent-yug-cc-manager");
        assert!(result.is_some());
        // The decoded path won't exist on disk, so extract_project_path will
        // fall through to extract_cwd_from_session — this is the expected flow.
    }

    #[test]
    fn test_extract_cwd_from_raw() {
        let marker = r#""cwd":""#;
        let input = r#"{"cwd":"C:\\Users\\test\\project","msg":"hello"}"#;
        assert_eq!(
            extract_cwd_from_raw(input, marker).as_deref(),
            Some("C:\\Users\\test\\project")
        );

        // No marker
        assert!(extract_cwd_from_raw("{}", marker).is_none());

        // Empty cwd
        let input2 = r#"{"cwd":""}"#;
        assert!(extract_cwd_from_raw(input2, marker).is_none());
    }

    #[test]
    fn test_extract_cwd_with_backslashes() {
        let marker = r#""cwd":""#;
        // Standard path with escaped backslashes (common case)
        let input = r#"{"cwd":"C:\\Users\\test\\project","msg":"hello"}"#;
        assert_eq!(
            extract_cwd_from_raw(input, marker).as_deref(),
            Some("C:\\Users\\test\\project")
        );

        // Path with a double backslash prefix (UNC path)
        let input2 = r#"{"cwd":"\\\\server\\share\\folder"}"#;
        assert_eq!(
            extract_cwd_from_raw(input2, marker).as_deref(),
            Some("\\\\server\\share\\folder")
        );
    }
}
