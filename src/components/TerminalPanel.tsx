import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api, onPtyOutput, onPtyExit } from "../api";
import type { PtyOutputEvent, PtyExitEvent } from "../api";
import type { SessionInfo } from "../App";
import "xterm/css/xterm.css";

/* ── Windows Terminal "Dark+" (Campbell) color scheme ── */
const TERM_THEME = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#264f78",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

interface GroupTab {
  id: string;
  name: string;
  count: number;
}

interface Props {
  sessions: SessionInfo[];         // ALL sessions (for lifecycle)
  groupSessions: SessionInfo[];    // sessions in the active group
  groups: GroupTab[];              // group tabs to render
  activeGroupId: string;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSwitchGroup: (groupId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onMoveSessionToGroup: (sessionId: string, targetGroupId: string) => void;
  onAddGroup: () => void;
  onDeleteGroup: (groupId: string) => void;
}

interface TermInstance {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
}

interface GridLayout {
  cols: string;
  rows: string;
  /** Per-item CSS overrides (gridRow/gridColumn) for custom placement. */
  positions: { gridRow?: string; gridColumn?: string }[];
}

/** Compute grid columns/rows based on item count */
function getGridLayout(n: number): GridLayout {
  if (n <= 1) return { cols: "1fr", rows: "1fr", positions: [] };
  if (n === 2) return { cols: "1fr 1fr", rows: "1fr", positions: [] };
  if (n === 3) {
    // First session spans left column full height; two share the right column
    return {
      cols: "1fr 1fr",
      rows: "1fr 1fr",
      positions: [{ gridRow: "1 / 3" }, {}, {}],
    };
  }
  if (n <= 4) return { cols: "1fr 1fr", rows: "1fr 1fr", positions: [] };
  return { cols: "1fr 1fr", rows: "1fr 1fr", positions: [] }; // cap at 4
}

/** Refit visible terminals */
function refitVisible(
  sessionIds: string[],
  instances: Map<string, TermInstance>,
) {
  for (const sid of sessionIds) {
    const inst = instances.get(sid);
    if (!inst) continue;
    try {
      const oldCols = inst.term.cols;
      const oldRows = inst.term.rows;
      inst.fitAddon.fit();
      const dims = inst.fitAddon.proposeDimensions();
      if (dims && (dims.cols !== oldCols || dims.rows !== oldRows)) {
        api.resizePty(sid, dims.cols, dims.rows).catch(() => {});
        inst.term.refresh(0, inst.term.rows - 1);
      }
    } catch { /* ignore */ }
  }
}

export function TerminalPanel({
  sessions,
  groupSessions,
  groups,
  activeGroupId,
  selectedSessionId,
  onSelectSession,
  onSwitchGroup,
  onCloseSession,
  onRenameGroup,
  onMoveSessionToGroup,
  onAddGroup,
  onDeleteGroup,
}: Props) {
  const containerRootRef = useRef<HTMLDivElement>(null);
  const termInstancesRef = useRef<Map<string, TermInstance>>(new Map());
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const onSelectRef = useRef(onSelectSession);
  onSelectRef.current = onSelectSession;
  // Per-group split mode. Defaults to true (split) for any group.
  const [splitModes, setSplitModes] = useState<Record<string, boolean>>({});
  const splitMode = splitModes[activeGroupId] ?? true;
  // Inline rename state
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const dragSessionIdRef = useRef<string | null>(null);

  // ── Session navigation via Ctrl+Arrow / Ctrl+Tab ──
  const switchSessionRef = useRef<((dir: "prev" | "next") => void) | null>(null);
  switchSessionRef.current = (dir) => {
    const ids = groupSessions.map((s) => s.id);
    if (ids.length === 0 || !selectedSessionId) return;
    const idx = ids.indexOf(selectedSessionId);
    if (idx === -1) return;
    const nextIdx = dir === "next"
      ? (idx + 1) % ids.length
      : (idx - 1 + ids.length) % ids.length;
    onSelectSession(ids[nextIdx]);
  };

  // ── PTY event listeners (set up once on mount) ──
  useEffect(() => {
    const unlistenOut = onPtyOutput((payload: PtyOutputEvent) => {
      const instances = termInstancesRef.current;
      const inst = instances.get(payload.session_id);
      if (inst) {
        inst.term.write(payload.data);
      } else {
        if (!pendingOutputRef.current.has(payload.session_id)) {
          pendingOutputRef.current.set(payload.session_id, []);
        }
        pendingOutputRef.current.get(payload.session_id)!.push(payload.data);
      }
    }).catch(() => () => {});

    const unlistenExit = onPtyExit((payload: PtyExitEvent) => {
      const msg = "\r\n\x1b[33m[Process exited]\x1b[0m\r\n";
      const instances = termInstancesRef.current;
      const inst = instances.get(payload.session_id);
      if (inst) {
        inst.term.write(msg);
      } else {
        if (!pendingOutputRef.current.has(payload.session_id)) {
          pendingOutputRef.current.set(payload.session_id, []);
        }
        pendingOutputRef.current.get(payload.session_id)!.push(msg);
      }
    }).catch(() => () => {});

    return () => {
      unlistenOut.then((fn) => fn());
      unlistenExit.then((fn) => fn());
    };
  }, []);

  // ── Session lifecycle: create/destroy xterm instances ──
  useEffect(() => {
    const instances = termInstancesRef.current;
    const root = containerRootRef.current;
    if (!root) return;

    for (const [sid, inst] of instances) {
      if (!sessions.some((s) => s.id === sid)) {
        inst.term.dispose();
        if (inst.container.parentNode) {
          inst.container.parentNode.removeChild(inst.container);
        }
        instances.delete(sid);
      }
    }

    for (const session of sessions) {
      if (instances.has(session.id)) continue;

      const container = document.createElement("div");
      container.className = "term-instance";
      container.dataset.sid = session.id;
      root.appendChild(container);

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cursorInactiveStyle: "none",
        cursorWidth: 2,
        fontSize: 14,
        lineHeight: 1.2,
        fontFamily: "'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', monospace",
        theme: TERM_THEME,
        allowTransparency: false,
        drawBoldTextInBrightColors: true,
        letterSpacing: 0,
      });

      // Make Ctrl+V paste directly (like a native terminal), instead of
      // the default xterm Ctrl+Shift+V behavior.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "v") {
          e.preventDefault();
          navigator.clipboard.readText()
            .then((text) => {
              api.writePty(session.id, text).catch(() => {});
            })
            .catch(() => {});
          return false;
        }
        if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === "V") {
          // Ctrl+Shift+V still works via xterm default handling
          return true;
        }
        if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "Enter") {
          // Ctrl+Enter → send \n instead of the default \r,
          // so Claude Code treats it as a newline in the prompt.
          api.writePty(session.id, "\n").catch(() => {});
          return false;
        }
        return true;
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);

      // Suppress IME composition intermediate data from reaching the PTY.
      // When typing Chinese (pinyin → candidate → commit), the intermediate
      // letters can leak to the terminal before compositionstart fires.
      // We intercept onData during composition and only let the final
      // committed text through after compositionend.
      let isComposing = false;
      let imeSeq = 0;
      // Ring buffer: keep last 5 onData calls so we can dump what was sent
      // just before compositionstart (the likely leak window).
      const onDataRingBuf: string[] = [];
      const imeTextarea = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      if (imeTextarea) {
        imeTextarea.addEventListener("compositionstart", () => {
          imeSeq++;
          console.log("[IME] #%d compositionstart", imeSeq);
          // Dump ring buffer: show what data was sent right before
          // (first character of pinyin often leaks here)
          if (onDataRingBuf.length > 0) {
            console.log("[IME] #%d PRE-start data: %s", imeSeq, onDataRingBuf.join(" "));
            onDataRingBuf.length = 0;
          }
          isComposing = true;
        });
        imeTextarea.addEventListener("compositionend", (e) => {
          console.log("[IME] #%d compositionend data=%s", imeSeq, e.data);
          isComposing = false;
        });
      }

      try {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          api.resizePty(session.id, dims.cols, dims.rows).catch(() => {});
        }
      } catch { /* ignore */ }

      container.addEventListener("click", () => {
        onSelectRef.current(session.id);
      });

      term.onData((data) => {
        if (isComposing) {
          console.log("[IME] #%d BLOCKED", imeSeq, data);
          return;
        }
        // First onData after compositionend = the committed text
        if (imeSeq > 0) {
          console.log("[IME] #%d COMMIT", imeSeq, data);
          imeSeq = 0; // reset so subsequent data doesn't get COMMIT label
        }
        // Keep ring buffer (sliding window of last 5) so we can see
        // what was sent moments before compositionstart.
        onDataRingBuf.push(data);
        if (onDataRingBuf.length > 5) onDataRingBuf.shift();
        api.writePty(session.id, data).catch(() => {
          term.write(data);
        });
      });

      instances.set(session.id, { term, fitAddon, container });

      const buf = pendingOutputRef.current.get(session.id);
      if (buf && buf.length > 0) {
        for (const chunk of buf) {
          term.write(chunk);
        }
        pendingOutputRef.current.delete(session.id);
      }
    }
  }, [sessions]);

  // ── Apply layout: show active group's sessions in grid ──
  const applyLayout = useCallback(() => {
    const instances = termInstancesRef.current;
    const root = containerRootRef.current;
    if (!root) return;

    const allIds = groupSessions.map((s) => s.id);
    const visibleIds = splitMode
      ? allIds
      : (selectedSessionId && allIds.includes(selectedSessionId) ? [selectedSessionId] : allIds.slice(0, 1));
    const count = visibleIds.length;

    // Hide non-selected instances first, then show visible ones.
    // Skip the active/selected session so its xterm textarea doesn't lose
    // focus (important when focus restoration depends on the element
    // staying visible, e.g. notification-click path without user gesture).
    for (const [sid, inst] of instances) {
      if (sid === selectedSessionId) continue;
      inst.container.style.display = "none";
      inst.container.classList.remove("active");
      inst.container.style.gridRow = "";
      inst.container.style.gridColumn = "";
    }

    if (count > 0) {
      const layout = getGridLayout(count);
      root.className = "terminal-container split-mode";
      root.style.display = "grid";
      root.style.gridTemplateColumns = layout.cols;
      root.style.gridTemplateRows = layout.rows;

      visibleIds.forEach((sid, i) => {
        const inst = instances.get(sid);
        if (!inst) return;
        inst.container.style.display = "block";
        // Apply (or clear) per-item grid placement for uneven layouts (e.g. 3)
        const pos = layout.positions[i];
        inst.container.style.gridRow = pos?.gridRow ?? "";
        inst.container.style.gridColumn = pos?.gridColumn ?? "";
        const isActive = sid === selectedSessionId;
        inst.container.classList.toggle("active", isActive);

        // IME guard: overlay on non-active terminals prevents xterm from
        // capturing focus/IME composition directly. Click only selects.
        let overlay = inst.container.querySelector(".term-ime-guard") as HTMLDivElement | null;
        if (isActive) {
          if (overlay) overlay.remove();
        } else if (!overlay) {
          overlay = document.createElement("div");
          overlay.className = "term-ime-guard";
          overlay.addEventListener("click", (e) => {
            e.stopPropagation();
            onSelectRef.current(sid);
          });
          inst.container.appendChild(overlay);
        }
      });
      if (selectedSessionId) {
        const inst = instances.get(selectedSessionId);
        if (inst) {
          // Focus the active terminal so xterm renders a blinking cursor.
          // Use requestAnimationFrame to ensure the browser has finished
          // the layout pass (display:block, grid, IME-guard removal) before
          // attempting focus - setTimeout-based retries could fire mid-layout.
          const doFocus = () => {
            if (!inst.container.isConnected) return;
            const ta = inst.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
            if (ta) ta.focus();
            inst.term.focus();
            // Force a refresh of the cursor row so xterm re-evaluates
            // cursorBlink & cursorStyle with the now-focused state.
            inst.term.refresh(inst.term.buffer.active.cursorY, inst.term.buffer.active.cursorY);
          };
          requestAnimationFrame(() => {
            doFocus();
            // Retry once more after the next frame in case the first
            // attempt fired before the document was fully focused.
            requestAnimationFrame(doFocus);
          });
        }
      }
    } else {
      // Active group is empty — hide all terminal instances
      for (const [, inst] of instances) {
        inst.container.style.display = "none";
        inst.container.classList.remove("active");
      }
      root.className = "terminal-container";
      root.style.display = "";
      root.style.gridTemplateColumns = "";
      root.style.gridTemplateRows = "";
    }

    // Refit after paint
    setTimeout(() => {
      refitVisible(visibleIds, termInstancesRef.current);
    }, 0);
  }, [groupSessions, selectedSessionId, splitMode]);

  useLayoutEffect(() => {
    applyLayout();
  }, [applyLayout]);

  // ── Refit on container resize (sidebar collapse/expand, window resize, etc.) ──
  useEffect(() => {
    const root = containerRootRef.current;
    if (!root) return;

    let debounceId: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        const allIds = groupSessions.map((s) => s.id);
        const ids = splitMode
          ? allIds
          : (selectedSessionId && allIds.includes(selectedSessionId) ? [selectedSessionId] : allIds.slice(0, 1));
        refitVisible(ids, termInstancesRef.current);
      }, 300);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      clearTimeout(debounceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSessions.length, splitMode, selectedSessionId]);

  // ── Global keyboard shortcuts (capture phase = before xterm) ──
  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => {
      // Skip rename/other text inputs, but NOT the xterm helper textarea
      const tag = (e.target as HTMLElement)?.tagName;
      const cl = (e.target as HTMLElement)?.classList;
      const isInput = (tag === "INPUT" || tag === "TEXTAREA") && !cl?.contains("xterm-helper-textarea");
      if (isInput) return;

      // Alt+Arrow → switch sessions (prev/next in active group)
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setTimeout(() => switchSessionRef.current?.("prev"), 0);
        } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setTimeout(() => switchSessionRef.current?.("next"), 0);
        }
      }
    };
    window.addEventListener("keydown", onCapture, { capture: true });
    return () => window.removeEventListener("keydown", onCapture, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ──
  const hasSessions = sessions.length > 0;
  const activeGroupSessions = groupSessions;

  return (
    <div className="terminal-panel">
      {hasSessions && (
        <>
          {/* ── Group Tabs (top row) ── */}
          <div className="group-tabs">
            {groups.map((g) => (
              <div
                key={g.id}
                className={`group-tab ${g.id === activeGroupId ? "active" : ""} ${dragOverGroupId === g.id ? "drag-over" : ""}`}
                onClick={() => onSwitchGroup(g.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverGroupId(g.id);
                }}
                onDragLeave={() => setDragOverGroupId((prev) => prev === g.id ? null : prev)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverGroupId(null);
                  const sid = dragSessionIdRef.current;
                  if (sid && g.id !== activeGroupId && onMoveSessionToGroup(sid, g.id)) {}
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenamingGroupId(g.id);
                  setRenameValue(g.name);
                  setTimeout(() => renameInputRef.current?.select(), 0);
                }}
              >
                {renamingGroupId === g.id ? (
                  <input
                    ref={renameInputRef}
                    className="group-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (renameValue.trim()) onRenameGroup(g.id, renameValue.trim());
                      setRenamingGroupId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (renameValue.trim()) onRenameGroup(g.id, renameValue.trim());
                        setRenamingGroupId(null);
                      } else if (e.key === "Escape") {
                        setRenamingGroupId(null);
                      }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className="group-tab-label">{g.name}</span>
                )}
                {g.count > 0 && <span className="tab-badge">{g.count}</span>}
                <button
                  className="group-tab-close"
                  onClick={(e) => { e.stopPropagation(); onDeleteGroup(g.id); }}
                  title="Delete group"
                >
                  <svg width="7" height="7" viewBox="0 0 7 7">
                    <line x1="1" y1="1" x2="6" y2="6" stroke="currentColor" strokeWidth="1.2" />
                    <line x1="6" y1="1" x2="1" y2="6" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
              </div>
            ))}
            <button className="group-add-btn" onClick={onAddGroup} title="New group">+</button>
          </div>
          {/* ── Session Tabs (bottom row) ── */}
          <div className="terminal-tabs">
            {activeGroupSessions.length > 1 && (
              <button
                className={`split-toggle ${splitMode ? "active" : ""}`}
                onClick={() => setSplitModes((prev) => ({ ...prev, [activeGroupId]: !(prev[activeGroupId] ?? true) }))}
                title={splitMode ? "Single view" : "Split view"}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  {splitMode ? (
                    <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  ) : (
                    <>
                      <rect x="1.5" y="1.5" width="4.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
                      <rect x="8" y="1.5" width="4.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    </>
                  )}
                </svg>
              </button>
            )}
            {activeGroupSessions.map((session) => (
              <div
                key={session.id}
                className={`terminal-tab ${session.id === selectedSessionId ? "active" : ""}`}
                onClick={() => onSelectSession(session.id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', session.id);
                  dragSessionIdRef.current = session.id;
                }}
                onDragEnd={() => { dragSessionIdRef.current = null; setDragOverGroupId(null); }}
              >
                <span className={`tab-indicator ${session.status}`} />
                <span className="tab-label">{session.name}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseSession(session.id);
                  }}
                  title="Close"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" />
                    <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
        <div className="terminal-container" ref={containerRootRef} />
        {hasSessions && activeGroupSessions.length === 0 && (
          <div className="terminal-placeholder">
            <span className="terminal-placeholder-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="6" y="6" width="20" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
                <line x1="12" y1="16" x2="20" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <line x1="16" y1="12" x2="16" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <p>
              此组暂无会话，请从工作区启动新会话
            </p>
            <span className="terminal-placeholder-hint">
              This group is empty. Launch a session from the sidebar.
            </span>
          </div>
        )}
      </div>
      {!hasSessions && (
        <div className="terminal-placeholder">
          <span className="terminal-placeholder-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <polyline points="8,16 14,22 8,28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="18" y1="26" x2="26" y2="26" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
          <p>
            Expand a workspace, then click <strong>+</strong> to start a session
          </p>
          <span className="terminal-placeholder-hint">
            Ctrl+Shift+P to open command palette
          </span>
        </div>
      )}
    </div>
  );
}
