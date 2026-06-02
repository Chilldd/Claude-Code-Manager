import { useEffect, useState, useCallback, useRef } from "react";
import {
  onSystemMetrics,
  onProcessTreeUpdated,
  onProcessesDiff,
  onSessionStateChanged,
} from "../api";
import type {
  SystemMetrics,
  ProcessTreePayload,
  ProcessesDiffPayload,
  SessionStatePayload,
  ProcessNode,
  FlatProcessInfo,
} from "../api";
import type { SessionInfo } from "../App";

interface Props {
  sessions: SessionInfo[];
}

/** Recursively flatten a ProcessTree into rows for table display */
function flattenTree(
  nodes: ProcessNode[],
  depth: number = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const node of nodes) {
    rows.push({
      pid: node.pid,
      name: node.name,
      cpu_percent: node.cpu_percent,
      memory_bytes: node.memory_bytes,
      state: node.state,
      depth,
      has_children: node.children.length > 0,
    });
    rows.push(...flattenTree(node.children, depth + 1));
  }
  return rows;
}

interface FlatRow {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_bytes: number;
  state: string;
  depth: number;
  has_children: boolean;
}

/** Compute aggregate from process flat map */
function aggregateProcs(
  procMap: Map<string, Map<number, FlatProcessInfo>>,
) {
  let totalCpu = 0;
  let totalMemBytes = 0;
  let totalCount = 0;
  for (const pidMap of procMap.values()) {
    for (const p of pidMap.values()) {
      totalCpu += p.cpu_percent;
      totalMemBytes += p.memory_bytes;
      totalCount++;
    }
  }
  return { totalCpu, totalMemMb: totalMemBytes / (1024 * 1024), totalCount };
}

export function PerformancePanel({ sessions }: Props) {
  // System metrics (from Fast layer, updated every 1s)
  const [sysStats, setSysStats] = useState<SystemMetrics | null>(null);

  // Process tree per session (from Medium layer, updated every 2s)
  const [trees, setTrees] = useState<Map<string, ProcessNode[]>>(new Map());

  // Flat process map for aggregation (kept in sync via diff events)
  const procMapRef = useRef<Map<string, Map<number, FlatProcessInfo>>>(
    new Map(),
  );
  const [agg, setAgg] = useState({ totalCpu: 0, totalMemMb: 0, totalCount: 0 });

  // Session runtime states (from state machine)
  const [sessionStates, setSessionStates] = useState<Map<string, string>>(
    new Map(),
  );

  const [showProcessTree, setShowProcessTree] = useState(false);

  // Per-session expanded state for process tree
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const toggleSessionExpanded = useCallback((sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  // Force re-render for agg changes — batch updates
  const flushAgg = useCallback(() => {
    setAgg(aggregateProcs(procMapRef.current));
  }, []);

  // ── Event listeners (set up once) ──
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    // Fast layer: system metrics (1s)
    unlisteners.push(
      onSystemMetrics((payload: SystemMetrics) => {
        setSysStats(payload);
      }),
    );

    // Medium layer: process tree (2s)
    unlisteners.push(
      onProcessTreeUpdated((payload: ProcessTreePayload) => {
        setTrees((prev) => {
          const next = new Map(prev);
          next.set(payload.session_id, payload.trees);
          return next;
        });
      }),
    );

    // State diff: merge into proc map
    unlisteners.push(
      onProcessesDiff((payload: ProcessesDiffPayload) => {
        const map = procMapRef.current;
        let changed = false;

        if (!map.has(payload.session_id)) {
          map.set(payload.session_id, new Map());
        }
        const pidMap = map.get(payload.session_id)!;

        // Remove exited processes
        for (const pid of payload.removed) {
          if (pidMap.delete(pid)) changed = true;
        }

        // Add new processes
        for (const p of payload.added) {
          pidMap.set(p.pid, p);
          changed = true;
        }

        // Update changed processes
        for (const p of payload.updated) {
          const existing = pidMap.get(p.pid);
          if (existing) {
            pidMap.set(p.pid, p);
            changed = true;
          }
        }

        // Clean up empty session maps
        if (pidMap.size === 0) map.delete(payload.session_id);

        if (changed) flushAgg();
      }),
    );

    // Session state changes
    unlisteners.push(
      onSessionStateChanged((payload: SessionStatePayload) => {
        setSessionStates((prev) => {
          const next = new Map(prev);
          if (payload.state === "exited") {
            next.delete(payload.session_id);
            // Clean up proc map for exited sessions
            const map = procMapRef.current;
            if (map.delete(payload.session_id)) flushAgg();
          } else {
            next.set(payload.session_id, payload.state);
          }
          return next;
        });
      }),
    );

    return () => {
      for (const p of unlisteners) {
        p.then((fn) => fn()).catch(() => {});
      }
    };
  }, [flushAgg]);

  // ── Render ──
  const activeCount = sessions.filter(
    (s) =>
      s.status === "running" ||
      s.status === "thinking" ||
      s.status === "idle",
  ).length;

  return (
    <div className="perf-panel">
      <div className="perf-header">
        <h2>⚡ Performance</h2>
        <span className="perf-subtitle">
          Event-driven · Process Graph · Session State Machine
        </span>
      </div>

      {/* ── System Overview Cards ── */}
      <div className="perf-cards">
        {/* CPU */}
        <div className="perf-card">
          <div className="perf-card-header">
            <span className="perf-card-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <span className="perf-card-title">CPU</span>
          </div>
          <div className="perf-card-value" data-color="accent">
            {sysStats ? `${sysStats.cpu_percent.toFixed(1)}%` : "—"}
          </div>
          <div className="perf-bar-track">
            <div className="perf-bar-fill cpu" style={{ width: sysStats ? `${Math.min(sysStats.cpu_percent, 100)}%` : "0%" }} />
          </div>
        </div>

        {/* Memory */}
        <div className="perf-card">
          <div className="perf-card-header">
            <span className="perf-card-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1" y="4" width="16" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <rect x="3" y="6" width="2" height="6" rx="0.5" fill="currentColor" opacity="0.5" />
              </svg>
            </span>
            <span className="perf-card-title">Memory</span>
          </div>
          <div className="perf-card-value" data-color="green">
            {sysStats ? `${sysStats.memory_used_gb.toFixed(1)} / ${sysStats.memory_total_gb.toFixed(0)} GB` : "—"}
          </div>
          <div className="perf-bar-track">
            <div className="perf-bar-fill memory" style={{ width: sysStats ? `${Math.min(sysStats.memory_percent, 100)}%` : "0%" }} />
          </div>
          <span className="perf-bar-label">{sysStats ? `${sysStats.memory_percent.toFixed(1)}% used` : ""}</span>
        </div>

        {/* Sessions */}
        <div className="perf-card">
          <div className="perf-card-header">
            <span className="perf-card-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1.5" y="1.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="10.5" y="10.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <span className="perf-card-title">Sessions</span>
          </div>
          <div className="perf-card-value" data-color="yellow">
            {sessions.length}
          </div>
          <div className="perf-card-sub">
            {activeCount} active · {agg.totalCount} processes
          </div>
        </div>

        {/* Terminal Resources */}
        <div className="perf-card">
          <div className="perf-card-header">
            <span className="perf-card-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <polyline points="2,14 7,9 10,12 16,5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="perf-card-title">Terminal Resources</span>
          </div>
          <div className="perf-card-value" data-color="accent" style={{ fontSize: "20px" }}>
            {agg.totalCpu.toFixed(1)}% CPU
          </div>
          <div className="perf-card-sub">
            {agg.totalMemMb.toFixed(1)} MB memory · {agg.totalCount} tracked PIDs
          </div>
        </div>
      </div>

      {/* ── Process Graph Section (collapsible, default collapsed) ── */}
      <div className="perf-section">
        <div
          className="perf-section-header collapsible"
          onClick={() => setShowProcessTree((v) => !v)}
        >
          <span className="perf-collapse-icon">{showProcessTree ? "▼" : "▶"}</span>
          <h3 className="perf-section-title">
            Process Graph
            <span className="perf-section-badge">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
            <span className="perf-section-badge dim">
              {agg.totalCount} processes
            </span>
          </h3>
        </div>

        {showProcessTree && (
          <div className="perf-session-tree-list">
            {sessions.length === 0 ? (
              <div className="perf-empty">
                <p>No active sessions. Launch a workspace to see the process tree.</p>
              </div>
            ) : (
              sessions.map((session) => {
                const nodeTrees = trees.get(session.id);
                const isExpanded = expandedSessions.has(session.id);
                const state = sessionStates.get(session.id) ?? "running";
                const sessionRows = nodeTrees ? flattenTree(nodeTrees) : [];
                const sessCpu = sessionRows.reduce((s, r) => s + r.cpu_percent, 0);
                const sessMem = sessionRows.reduce((s, r) => s + r.memory_bytes, 0);
                const sessCount = sessionRows.length;

                return (
                  <div key={session.id} className="perf-session-tree">
                    <div
                      className="perf-session-tree-header"
                      onClick={() => toggleSessionExpanded(session.id)}
                    >
                      <span className="perf-collapse-icon">
                        {isExpanded ? "▼" : "▶"}
                      </span>
                      <span className={`perf-session-dot ${state}`} />
                      <span className="perf-session-tree-name">
                        {session.name}
                      </span>
                      <span className={`perf-state-pill ${state}`}>{state}</span>
                      <span className="perf-session-tree-summary">
                        {sessCount} proc · {sessCpu.toFixed(1)}% CPU ·{" "}
                        {sessMem > 100 * 1024 * 1024
                          ? `${(sessMem / (1024 * 1024 * 1024)).toFixed(2)} GB`
                          : `${(sessMem / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    </div>

                    {isExpanded && sessionRows.length > 0 && (
                      <div className="perf-table-wrap">
                        <table className="perf-table">
                          <thead>
                            <tr>
                              <th>Process Tree</th>
                              <th>PID</th>
                              <th className="perf-num">CPU%</th>
                              <th className="perf-num">Memory</th>
                              <th>State</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionRows.map((row) => (
                              <tr key={`${session.id}-${row.pid}`}>
                                <td className="perf-mono perf-tree-cell">
                                  <span
                                    className="perf-tree-indent"
                                    style={{ paddingLeft: `${row.depth * 20}px` }}
                                  />
                                  {row.depth > 0 && (
                                    <span className="perf-tree-branch">
                                      {row.has_children ? "└─ " : "· "}
                                    </span>
                                  )}
                                  {row.name}
                                </td>
                                <td className="perf-mono">{row.pid}</td>
                                <td className="perf-num">
                                  <span
                                    className={`perf-cpu-badge ${row.cpu_percent > 50 ? "high" : row.cpu_percent > 10 ? "med" : ""}`}
                                  >
                                    {row.cpu_percent.toFixed(1)}%
                                  </span>
                                </td>
                                <td className="perf-num perf-mono">
                                  {row.memory_bytes > 100 * 1024 * 1024
                                    ? `${(row.memory_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
                                    : `${(row.memory_bytes / (1024 * 1024)).toFixed(1)} MB`}
                                </td>
                                <td className="perf-mono">
                                  <span className={`perf-state-tag ${row.state.toLowerCase()}`}>
                                    {row.state}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
