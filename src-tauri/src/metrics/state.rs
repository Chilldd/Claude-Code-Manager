//! Session state machine — tracks CPU activity and infers state transitions.

use super::FlatProcessInfo;
use std::collections::HashMap;

/// Holds the state of a single tracked session between ticks.
pub(crate) struct TrackedSession {
    pub root_pids: Vec<u32>,
    pub last_proc_map: HashMap<u32, FlatProcessInfo>,
    pub state: String,
    pub idle_ticks: u32,
    pub last_cpu_sum: f32,
}

impl TrackedSession {
    pub fn new(root_pids: Vec<u32>) -> Self {
        Self {
            root_pids,
            last_proc_map: HashMap::new(),
            state: "created".to_string(),
            idle_ticks: 0,
            last_cpu_sum: 0.0,
        }
    }
}

/// Infer the session state from its current process map.
///
/// State machine:
/// - Empty proc map          → "exited"
/// - CPU < 0.5 for 3 ticks   → "idle"
/// - CPU < 0.5 for 6+ ticks  → "zombie"
/// - CPU > 50                → "busy"
/// - Otherwise               → "running"
///
/// This function has **side effects** on `session` because the state machine
/// is stateful (tick counting for debounce).  Call once per tick.
pub(crate) fn infer_session_state(
    session: &mut TrackedSession,
    proc_map: &HashMap<u32, FlatProcessInfo>,
) -> String {
    if proc_map.is_empty() {
        return "exited".to_string();
    }

    let cpu_sum: f32 = proc_map.values().map(|p| p.cpu_percent).sum();

    if cpu_sum < 0.5 {
        session.idle_ticks += 1;
        session.last_cpu_sum = cpu_sum;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_info(cpu: f32) -> FlatProcessInfo {
        FlatProcessInfo {
            pid: 1,
            name: "test.exe".into(),
            cpu_percent: cpu,
            memory_bytes: 0,
            state: "Running".into(),
            parent_pid: None,
        }
    }

    fn single_proc_map(cpu: f32) -> HashMap<u32, FlatProcessInfo> {
        let mut m = HashMap::new();
        m.insert(1, make_info(cpu));
        m
    }

    #[test]
    fn test_empty_map_is_exited() {
        let mut s = TrackedSession::new(vec![1]);
        let state = infer_session_state(&mut s, &HashMap::new());
        assert_eq!(state, "exited");
    }

    #[test]
    fn test_idle_after_three_ticks() {
        let mut s = TrackedSession::new(vec![1]);
        let map = single_proc_map(0.1);

        // Tick 1: still "created" (need 3 idle ticks)
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "created");
        assert_eq!(s.idle_ticks, 1);

        // Tick 2
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "created");
        assert_eq!(s.idle_ticks, 2);

        // Tick 3
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "idle");
        assert_eq!(s.idle_ticks, 3);
    }

    #[test]
    fn test_zombie_after_six_ticks() {
        let mut s = TrackedSession::new(vec![1]);
        let map = single_proc_map(0.1);

        // Advance to "idle" (needs 3 consecutive idle ticks)
        for _ in 0..3 {
            let state = infer_session_state(&mut s, &map);
            s.state.clone_from(&state);
        }
        assert_eq!(s.state, "idle");
        assert_eq!(s.idle_ticks, 3);

        // Two more idle ticks (4 & 5): stays "idle"
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "idle");
        assert_eq!(s.idle_ticks, 4);

        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "idle");
        assert_eq!(s.idle_ticks, 5);

        // Tick 6: crosses zombie threshold
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "zombie");
        assert_eq!(s.idle_ticks, 6);
    }

    #[test]
    fn test_busy_at_high_cpu() {
        let mut s = TrackedSession::new(vec![1]);
        let map = single_proc_map(60.0);
        let state = infer_session_state(&mut s, &map);
        assert_eq!(state, "busy");
        assert_eq!(s.idle_ticks, 0);
    }

    #[test]
    fn test_cpu_spike_resets_idle_ticks() {
        let mut s = TrackedSession::new(vec![1]);
        let low = single_proc_map(0.1);
        let high = single_proc_map(10.0);

        // 2 idle ticks
        infer_session_state(&mut s, &low);
        infer_session_state(&mut s, &low);
        assert_eq!(s.idle_ticks, 2);

        // CPU spike resets
        infer_session_state(&mut s, &high);
        assert_eq!(s.idle_ticks, 0);
    }
}
