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
import type { SessionInfo } from "../types";
import styles from "./PerformancePanel.module.css";

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
    <div className={styles.panel}>
      <div className={styles.header}>
        <h2>⚡ Performance</h2>
        <span className={styles.subtitle}>
          Event-driven · Process Graph · Session State Machine
        </span>
      </div>

      {/* ── System Overview Cards ── */}
      <div className={styles.cards}>
        {/* CPU */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardIcon}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <span className={styles.cardTitle}>CPU</span>
          </div>
          <div className={styles.cardValue} data-color="accent">
            {sysStats ? `${sysStats.cpu_percent.toFixed(1)}%` : "—"}
          </div>
          <div className={styles.barTrack}>
            <div className={`${styles.barFill} ${styles.cpu}`} style={{ width: sysStats ? `${Math.min(sysStats.cpu_percent, 100)}%` : "0%" }} />
          </div>
        </div>

        {/* Memory */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardIcon}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1" y="4" width="16" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <rect x="3" y="6" width="2" height="6" rx="0.5" fill="currentColor" opacity="0.5" />
              </svg>
            </span>
            <span className={styles.cardTitle}>Memory</span>
          </div>
          <div className={styles.cardValue} data-color="green">
            {sysStats ? `${sysStats.memory_used_gb.toFixed(1)} / ${sysStats.memory_total_gb.toFixed(0)} GB` : "—"}
          </div>
          <div className={styles.barTrack}>
            <div className={`${styles.barFill} ${styles.memory}`} style={{ width: sysStats ? `${Math.min(sysStats.memory_percent, 100)}%` : "0%" }} />
          </div>
          <span className={styles.barLabel}>{sysStats ? `${sysStats.memory_percent.toFixed(1)}% used` : ""}</span>
        </div>

        {/* Sessions */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardIcon}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1.5" y="1.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="10.5" y="10.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
            <span className={styles.cardTitle}>Sessions</span>
          </div>
          <div className={styles.cardValue} data-color="yellow">
            {sessions.length}
          </div>
          <div className={styles.cardSub}>
            {activeCount} active · {agg.totalCount} processes
          </div>
        </div>

        {/* Terminal Resources */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardIcon}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <polyline points="2,14 7,9 10,12 16,5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className={styles.cardTitle}>Terminal Resources</span>
          </div>
          <div className={styles.cardValue} data-color="accent" style={{ fontSize: "20px" }}>
            {agg.totalCpu.toFixed(1)}% CPU
          </div>
          <div className={styles.cardSub}>
            {agg.totalMemMb.toFixed(1)} MB memory · {agg.totalCount} tracked PIDs
          </div>
        </div>
      </div>

      {/* ── Process Graph Section (collapsible, default collapsed) ── */}
      <div className={styles.section}>
        <div
          className={`${styles.sectionHeader} ${styles.collapsible}`}
          onClick={() => setShowProcessTree((v) => !v)}
        >
          <span className={styles.collapseIcon}>{showProcessTree ? "▼" : "▶"}</span>
          <h3 className={styles.sectionTitle}>
            Process Graph
            <span className={styles.sectionBadge}>
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
            <span className={`${styles.sectionBadge} ${styles.dim}`}>
              {agg.totalCount} processes
            </span>
          </h3>
        </div>

        {showProcessTree && (
          <div className={styles.sessionTreeList}>
            {sessions.length === 0 ? (
              <div className={styles.empty}>
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
                  <div key={session.id} className={styles.sessionTree}>
                    <div
                      className={styles.sessionTreeHeader}
                      onClick={() => toggleSessionExpanded(session.id)}
                    >
                      <span className={styles.collapseIcon}>
                        {isExpanded ? "▼" : "▶"}
                      </span>
                      <span className={`${styles.sessionDot} ${styles[state as keyof typeof styles] || ''}`} />
                      <span className={styles.sessionTreeName}>
                        {session.name}
                      </span>
                      <span className={`${styles.statePill} ${styles[state as keyof typeof styles] || ''}`}>{state}</span>
                      <span className={styles.sessionTreeSummary}>
                        {sessCount} proc · {sessCpu.toFixed(1)}% CPU ·{" "}
                        {sessMem > 100 * 1024 * 1024
                          ? `${(sessMem / (1024 * 1024 * 1024)).toFixed(2)} GB`
                          : `${(sessMem / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    </div>

                    {isExpanded && sessionRows.length > 0 && (
                      <div className={styles.tableWrap}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th>Process Tree</th>
                              <th>PID</th>
                              <th className={styles.perfNum}>CPU%</th>
                              <th className={styles.perfNum}>Memory</th>
                              <th>State</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionRows.map((row) => (
                              <tr key={`${session.id}-${row.pid}`}>
                                <td className={`${styles.perfMono} ${styles.treeCell}`}>
                                  <span
                                    className={styles.treeIndent}
                                    style={{ paddingLeft: `${row.depth * 20}px` }}
                                  />
                                  {row.depth > 0 && (
                                    <span className={styles.treeBranch}>
                                      {row.has_children ? "└─ " : "· "}
                                    </span>
                                  )}
                                  {row.name}
                                </td>
                                <td className={styles.perfMono}>{row.pid}</td>
                                <td className={styles.perfNum}>
                                  <span
                                    className={`${styles.cpuBadge} ${row.cpu_percent > 50 ? styles.high : row.cpu_percent > 10 ? styles.med : ''}`}
                                  >
                                    {row.cpu_percent.toFixed(1)}%
                                  </span>
                                </td>
                                <td className={`${styles.perfNum} ${styles.perfMono}`}>
                                  {row.memory_bytes > 100 * 1024 * 1024
                                    ? `${(row.memory_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
                                    : `${(row.memory_bytes / (1024 * 1024)).toFixed(1)} MB`}
                                </td>
                                <td className={styles.perfMono}>
                                  <span className={`${styles.stateTag} ${styles[row.state.toLowerCase() as keyof typeof styles] || ''}`}>
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
