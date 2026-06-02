use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(rename = "path")]
    pub dir: String,
    pub command: String,
    pub args: String,
    pub auto_prompt: String,
    pub env: HashMap<String, String>,
}

fn data_dir() -> PathBuf {
    let mut path = if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("USERPROFILE")
                .unwrap_or_else(|_| ".".to_string()),
        )
    } else {
        PathBuf::from(
            std::env::var("HOME")
                .unwrap_or_else(|_| ".".to_string()),
        )
    };
    path.push(".ccmanager");
    fs::create_dir_all(&path).ok();
    path
}

fn workspaces_path() -> PathBuf {
    let mut path = data_dir();
    path.push("workspaces.json");
    path
}

pub fn load_all() -> Vec<Workspace> {
    let path = workspaces_path();
    if path.exists() {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    }
}

pub fn save_all(workspaces: &[Workspace]) {
    let path = workspaces_path();
    if let Ok(content) = serde_json::to_string_pretty(workspaces) {
        fs::write(&path, content).ok();
    }
}

// --- Functions (used by main.rs commands) ---

pub fn get_workspaces() -> Vec<Workspace> {
    load_all()
}

pub fn add_workspace(mut ws: Workspace) -> Vec<Workspace> {
    let mut list = load_all();
    ws.id = uuid::Uuid::new_v4().to_string();
    list.push(ws);
    save_all(&list);
    list
}

pub fn update_workspace(ws: Workspace) -> Vec<Workspace> {
    let mut list = load_all();
    if let Some(existing) = list.iter_mut().find(|w| w.id == ws.id) {
        *existing = ws;
    }
    save_all(&list);
    list
}

pub fn delete_workspace(id: String) -> Vec<Workspace> {
    let mut list = load_all();
    list.retain(|w| w.id != id);
    save_all(&list);
    list
}

// ── Import from Claude Code ──

fn claude_projects_dir() -> PathBuf {
    let home = if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("USERPROFILE")
                .unwrap_or_else(|_| ".".to_string()),
        )
    } else {
        PathBuf::from(
            std::env::var("HOME")
                .unwrap_or_else(|_| ".".to_string()),
        )
    };
    home.join(".claude").join("projects")
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

    // Replace remaining '-' with '\' to reconstruct the backslash-separated path
    let path = format!("{}:\\{}", drive_letter, rest.replace('-', "\\"));
    Some(path)
}

/// Read the `"cwd"` field from the newest `.jsonl` session file in a project directory.
/// We only read the first 32 KB of each file to stay fast.
fn extract_cwd_from_session(project_dir: &Path) -> Option<String> {
    use std::fs;
    use std::io::{BufRead, BufReader};

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
        let file = fs::File::open(entry.path()).ok()?;
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
                Err(_) => break,
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

/// Discover Claude Code projects and return them as `Workspace` candidates.
///
/// Each returned workspace has an empty `id` — the caller should assign one
/// via `add_workspace` if they decide to persist it.
pub fn import_from_claude_code() -> Vec<Workspace> {
    let projects_dir = claude_projects_dir();
    if !projects_dir.is_dir() {
        return vec![];
    }

    let existing_paths: HashSet<String> = load_all()
        .into_iter()
        .map(|w| w.dir.clone())
        .collect();

    let mut result = Vec::new();

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
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

        result.push(Workspace {
            id: String::new(),
            name,
            dir: ws_path,
            command: "claude".to_string(),
            args: String::new(),
            auto_prompt: String::new(),
            env: HashMap::new(),
        });
    }

    result
}
