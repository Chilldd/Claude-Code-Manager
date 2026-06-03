//! Process-tree computation and process-list diff — pure functions, no I/O.
//!
//! These functions operate on snapshots (`HashMap<u32, FlatProcessInfo>`) and
//! return tree structures / diff results. They are testable without sysinfo.

use super::{is_excluded, FlatProcessInfo, ProcessNode};

/// Collect all descendant PIDs for a set of root PIDs, breadth-first.
pub(crate) fn collect_descendants(
    sys: &sysinfo::System,
    root_pids: &[u32],
) -> Vec<u32> {
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

/// Build hierarchical process trees starting from root PIDs.
///
/// Skips excluded infrastructure processes (conhost, etc.) and grafts their
/// non-excluded children up to the visible root level.
pub(crate) fn build_process_trees(
    root_pids: &[u32],
    proc_map: &std::collections::HashMap<u32, FlatProcessInfo>,
) -> Vec<ProcessNode> {
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
    roots
        .iter()
        .filter_map(|pid| build_tree(*pid, proc_map))
        .collect()
}

/// Recursively find non-excluded descendants of a PID, skipping excluded intermediates.
fn find_non_excluded_children(
    pid: u32,
    proc_map: &std::collections::HashMap<u32, FlatProcessInfo>,
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

/// Build a single `ProcessNode` tree (recursive).
fn build_tree(
    pid: u32,
    proc_map: &std::collections::HashMap<u32, FlatProcessInfo>,
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
                Some(
                    gc.iter()
                        .filter_map(|&gpid| build_tree(gpid, proc_map))
                        .collect::<Vec<_>>(),
                )
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_info(pid: u32, name: &str, ppid: Option<u32>, cpu: f32) -> FlatProcessInfo {
        FlatProcessInfo {
            pid,
            name: name.to_string(),
            cpu_percent: cpu,
            memory_bytes: 0,
            state: "Running".into(),
            parent_pid: ppid,
        }
    }

    #[test]
    fn test_build_trees_basic() {
        let mut map = HashMap::new();
        map.insert(100, make_info(100, "bash.exe", None, 1.0));
        map.insert(200, make_info(200, "claude.exe", Some(100), 10.0));
        map.insert(300, make_info(300, "node.exe", Some(200), 5.0));

        let trees = build_process_trees(&[100], &map);
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].pid, 100);
        assert_eq!(trees[0].children.len(), 1);
        assert_eq!(trees[0].children[0].pid, 200);
        assert_eq!(trees[0].children[0].children[0].pid, 300);
    }

    #[test]
    fn test_excluded_process_skipped() {
        let mut map = HashMap::new();
        map.insert(100, make_info(100, "bash.exe", None, 0.0));
        map.insert(101, make_info(101, "conhost.exe", Some(100), 0.0));
        map.insert(102, make_info(102, "claude.exe", Some(101), 5.0));

        let trees = build_process_trees(&[100], &map);
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].pid, 100);
        // conhost.exe is excluded, claude.exe should be grafted up
        assert_eq!(trees[0].children.len(), 1);
        assert_eq!(trees[0].children[0].pid, 102);
    }
}
