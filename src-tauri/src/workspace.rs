use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

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
