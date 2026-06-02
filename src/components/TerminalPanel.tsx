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

/** Compute grid columns/rows based on item count */
function getGridLayout(n: number): { cols: string; rows: string } {
  if (n <= 1) return { cols: "1fr", rows: "1fr" };
  if (n === 2) return { cols: "1fr 1fr", rows: "1fr" };
  if (n <= 4) return { cols: "1fr 1fr", rows: "1fr 1fr" };
  return { cols: "1fr 1fr", rows: "1fr 1fr" }; // cap at 4
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

      // Fix IME composition: position xterm's hidden helper textarea at
      // the terminal cursor during composition so the native IME candidate
      // window appears at the right place.  We use .xterm-screen for cell
      // dimensions since it excludes padding.
      const imeTextarea = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      if (imeTextarea) {
        const moveToCursor = () => {
          const termEl = term.element;
          const screen = termEl?.querySelector<HTMLDivElement>(".xterm-screen");
          if (!screen) return;
          const sr = screen.getBoundingClientRect();
          const cellW = sr.width / term.cols;
          const cellH = sr.height / term.rows;
          const cx = term.buffer.active.cursorX;
          const cy = term.buffer.active.cursorY;
          imeTextarea.style.position = "fixed";
          imeTextarea.style.left = `${sr.left + cx * cellW}px`;
          imeTextarea.style.top = `${sr.top + cy * cellH}px`;
        };

        imeTextarea.addEventListener("compositionstart", moveToCursor);
        imeTextarea.addEventListener("compositionend", () => {
          imeTextarea.style.position = "absolute";
          imeTextarea.style.left = "-9999px";
          imeTextarea.style.top = "-9999px";
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
    }

    if (count > 0) {
      const layout = getGridLayout(count);
      root.className = "terminal-container split-mode";
      root.style.display = "grid";
      root.style.gridTemplateColumns = layout.cols;
      root.style.gridTemplateRows = layout.rows;

      for (const sid of visibleIds) {
        const inst = instances.get(sid);
        if (!inst) continue;
        inst.container.style.display = "block";
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
      }
      if (selectedSessionId) {
        const inst = instances.get(selectedSessionId);
        if (inst) {
          inst.term.focus();
          const retryFocus = (delay: number) =>
            setTimeout(() => {
              if (!inst.container.isConnected) return;
              const ta = inst.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
              if (ta) { ta.focus(); inst.term.focus(); }
              else inst.term.focus();
            }, delay);
          retryFocus(100);
          retryFocus(400);
        }
      }
    } else {
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

  // ── Refit on window resize ──
  useEffect(() => {
    const onResize = () => {
      const allIds = groupSessions.map((s) => s.id);
      const ids = splitMode
        ? allIds
        : (selectedSessionId && allIds.includes(selectedSessionId) ? [selectedSessionId] : allIds.slice(0, 1));
      setTimeout(() => {
        refitVisible(ids, termInstancesRef.current);
      }, 0);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
      <div className="terminal-container" ref={containerRootRef} />
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
