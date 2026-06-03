use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::log::debug_log;

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

// ── Helpers ──

/// Get the user's home directory.
/// Shared by workspace CRUD and the import module.
pub(crate) fn home_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        PathBuf::from(
            std::env::var("USERPROFILE")
                .unwrap_or_else(|_| ".".to_string()),
        )
    } else {
        PathBuf::from(
            std::env::var("HOME")
                .unwrap_or_else(|_| ".".to_string()),
        )
    }
}

fn data_dir() -> PathBuf {
    let mut path = home_dir();
    path.push(".ccmanager");
    if let Err(e) = fs::create_dir_all(&path) {
        let msg = format!("Failed to create data dir {:?}: {}", path, e);
        eprintln!("[workspace] {}", msg);
        debug_log(format!("[workspace] {}", msg));
    }
    path
}

fn workspaces_path() -> PathBuf {
    let mut path = data_dir();
    path.push("workspaces.json");
    path
}

// ── Persistence ──

pub fn load_all() -> Vec<Workspace> {
    let path = workspaces_path();
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to read {:?}: {}", path, e);
            eprintln!("[workspace] {}", msg);
            debug_log(format!("[workspace] {}", msg));
            return vec![];
        }
    };

    match serde_json::from_str(&content) {
        Ok(workspaces) => workspaces,
        Err(e) => {
            // ── Backup corrupted file before resetting ──
            debug_log(format!("[workspace] Corrupted workspaces.json ({}). Backing up.", e));
            eprintln!(
                "[workspace] Corrupted workspaces.json ({}). Backing up and resetting.",
                e
            );
            let backup = path.with_extension("json.bak");
            if let Err(be) = fs::copy(&path, &backup) {
                let msg = format!("Failed to backup corrupted file: {}", be);
                eprintln!("[workspace] {}", msg);
                debug_log(format!("[workspace] {}", msg));
            } else {
                eprintln!("[workspace] Backup saved to {:?}", backup);
            }
            vec![]
        }
    }
}

pub fn save_all(workspaces: &[Workspace]) {
    let path = workspaces_path();
    match serde_json::to_string_pretty(workspaces) {
        Ok(content) => {
            if let Err(e) = fs::write(&path, &content) {
                let msg = format!("Failed to write {:?}: {}", path, e);
                eprintln!("[workspace] {}", msg);
                debug_log(format!("[workspace] {}", msg));
            }
        }
        Err(e) => {
            let msg = format!("Failed to serialize workspaces: {}", e);
            eprintln!("[workspace] {}", msg);
            debug_log(format!("[workspace] {}", msg));
        }
    }
}

// ── CRUD operations ──

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

pub fn reorder_workspaces(ids: Vec<String>) -> Vec<Workspace> {
    let all = load_all();
    let mut ordered: Vec<Workspace> = ids
        .iter()
        .filter_map(|id| all.iter().find(|w| w.id == *id).cloned())
        .collect();
    // Append any workspaces not in the supplied ids (shouldn't happen, but be safe)
    for w in &all {
        if !ordered.iter().any(|o| o.id == w.id) {
            ordered.push(w.clone());
        }
    }
    save_all(&ordered);
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    static TEST_DIR: OnceLock<PathBuf> = OnceLock::new();

    fn setup() {
        let dir = std::env::temp_dir().join("ccmanager-test-workspace");
        let _ = fs::create_dir_all(&dir);
        TEST_DIR.set(dir.clone()).ok();
    }

    #[test]
    fn test_add_and_get() {
        setup();
        let ws = Workspace {
            id: String::new(),
            name: "test".into(),
            dir: "/tmp/test".into(),
            command: "claude".into(),
            args: String::new(),
            auto_prompt: String::new(),
            env: HashMap::new(),
        };
        let list = add_workspace(ws);
        assert!(!list.is_empty());
        assert!(!list[0].id.is_empty());
    }

    #[test]
    fn test_corrupted_json_backup() {
        setup();
        let path = workspaces_path();
        // Write invalid JSON
        fs::write(&path, "not valid json").ok();
        let list = load_all();
        assert!(list.is_empty());
        // Backup should exist
        let backup = path.with_extension("json.bak");
        assert!(backup.exists(), "Backup file should exist after corruption");
    }
}
