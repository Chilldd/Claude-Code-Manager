import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api, onPtyOutput, onPtyExit } from "../api";
import type { PtyOutputEvent, PtyExitEvent } from "../api";
import { useSession } from "../contexts/SessionContext";
import "xterm/css/xterm.css";
import "../styles/terminal-global.css";
import { GroupTabs } from "./GroupTabs";
import { SessionTabs } from "./SessionTabs";
import { ConfirmDialog } from "./ConfirmDialog";
import styles from "./TerminalPanel.module.css";

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
    return {
      cols: "1fr 1fr",
      rows: "1fr 1fr",
      positions: [{ gridRow: "1 / 3" }, {}, {}],
    };
  }
  if (n <= 4) return { cols: "1fr 1fr", rows: "1fr 1fr", positions: [] };
  return { cols: "1fr 1fr", rows: "1fr 1fr", positions: [] };
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

export function TerminalPanel() {
  const {
    sessions,
    groups,
    activeGroupId,
    selectedSessionId,
    activeGroupSessions,
    selectSession,
    switchGroup,
    stopSession,
    renameGroup,
    moveSessionToGroup,
    addGroup,
    deleteGroup,
  } = useSession();

  const containerRootRef = useRef<HTMLDivElement>(null);
  const termInstancesRef = useRef<Map<string, TermInstance>>(new Map());
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const onSelectRef = useRef(selectSession);
  onSelectRef.current = selectSession;

  // Per-group split mode. Defaults to true (split) for any group.
  const [splitModes, setSplitModes] = useState<Record<string, boolean>>({});
  const splitMode = splitModes[activeGroupId] ?? true;

  // ── Group delete confirmation ──
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const handleConfirmDeleteGroup = useCallback(() => {
    if (confirmDeleteGroupId) {
      deleteGroup(confirmDeleteGroupId);
      setConfirmDeleteGroupId(null);
    }
  }, [confirmDeleteGroupId, deleteGroup]);

  // ── Session navigation via Ctrl+Arrow / Ctrl+Tab ──
  const switchSessionRef = useRef<((dir: "prev" | "next") => void) | null>(null);
  switchSessionRef.current = (dir) => {
    const ids = activeGroupSessions.map((s) => s.id);
    if (ids.length === 0 || !selectedSessionId) return;
    const idx = ids.indexOf(selectedSessionId);
    if (idx === -1) return;
    const nextIdx = dir === "next"
      ? (idx + 1) % ids.length
      : (idx - 1 + ids.length) % ids.length;
    selectSession(ids[nextIdx]);
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
      const msg = "\r\n\x1b[33m[进程已退出]\x1b[0m\r\n";
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

  // ── Unified layout: sync xterm instances + compute grid + refit ──
  // Single entry point for: sessions add/remove, group switch,
  // session selection, split mode toggle.
  useLayoutEffect(() => {
    const instances = termInstancesRef.current;
    const root = containerRootRef.current;
    if (!root) return;

    // ── 1. Sync xterm instances with sessions ──
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
          return true;
        }
        if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "Enter") {
          api.writePty(session.id, "\n").catch(() => {});
          return false;
        }
        return true;
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);

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

    // ── 2. Compute visible sessions and apply grid layout ──
    const allIds = activeGroupSessions.map((s) => s.id);
    const visibleIds = splitMode
      ? allIds
      : (selectedSessionId && allIds.includes(selectedSessionId) ? [selectedSessionId] : allIds.slice(0, 1));
    const count = visibleIds.length;

    for (const [sid, inst] of instances) {
      if (sid === selectedSessionId) continue;
      inst.container.style.display = "none";
      inst.container.classList.remove("active");
      inst.container.style.outline = "";
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
        const pos = layout.positions[i];
        inst.container.style.gridRow = pos?.gridRow ?? "";
        inst.container.style.gridColumn = pos?.gridColumn ?? "";
        const isActive = sid === selectedSessionId;
        inst.container.classList.toggle("active", isActive);
        inst.container.style.outline = isActive ? "1px solid #60cdff" : "";

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
          inst.term.focus();
          requestAnimationFrame(() => {
            if (!inst.container.isConnected) return;
            const ta = inst.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
            if (ta) ta.focus();
            inst.term.focus();
          });
        }
      }
    } else {
      for (const [, inst] of instances) {
        inst.container.style.display = "none";
        inst.container.classList.remove("active");
        inst.container.style.outline = "";
      }
      root.className = "terminal-container";
      root.style.display = "";
      root.style.gridTemplateColumns = "";
      root.style.gridTemplateRows = "";
    }

    // ── 3. Refit after browser paint ──
    setTimeout(() => {
      refitVisible(visibleIds, termInstancesRef.current);
    }, 0);
  }, [sessions, activeGroupSessions, selectedSessionId, splitMode]);

  // ── Refit on container resize (debounce > sidebar transition 250ms) ──
  useEffect(() => {
    const root = containerRootRef.current;
    if (!root) return;

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const allIds = activeGroupSessions.map((s) => s.id);
        const ids = splitMode
          ? allIds
          : (selectedSessionId && allIds.includes(selectedSessionId) ? [selectedSessionId] : allIds.slice(0, 1));
        refitVisible(ids, termInstancesRef.current);
      }, 350);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupSessions.length, splitMode, selectedSessionId]);

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const cl = (e.target as HTMLElement)?.classList;
      const isInput = (tag === "INPUT" || tag === "TEXTAREA") && !cl?.contains("xterm-helper-textarea");
      if (isInput) return;

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
  const groupTabs = groups.map((g) => ({
    id: g.id,
    name: g.name,
    count: g.sessionIds.length,
  }));

  return (
    <div className={styles.panel}>
      {hasSessions && (
        <>
          <GroupTabs
            groups={groupTabs}
            activeGroupId={activeGroupId}
            onSwitchGroup={switchGroup}
            onRenameGroup={renameGroup}
            onDeleteGroup={setConfirmDeleteGroupId}
            onAddGroup={addGroup}
            onMoveSessionToGroup={moveSessionToGroup}
          />
          <SessionTabs
            sessions={activeGroupSessions}
            selectedSessionId={selectedSessionId}
            splitMode={splitMode}
            onSelectSession={selectSession}
            onCloseSession={stopSession}
            onToggleSplitMode={() => setSplitModes((prev) => ({ ...prev, [activeGroupId]: !(prev[activeGroupId] ?? true) }))}
          />
        </>
      )}
      <div style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}>
        <div className="terminal-container" ref={containerRootRef} />
        {hasSessions && activeGroupSessions.length === 0 && (
          <div className={styles.terminalPlaceholder}>
            <span className={styles.terminalPlaceholderIcon}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="6" y="6" width="20" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
                <line x1="12" y1="16" x2="20" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <line x1="16" y1="12" x2="16" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <p>此组暂无会话，请从工作区启动新会话</p>
            <span className={styles.terminalPlaceholderHint}>此组为空，请从侧栏启动会话</span>
          </div>
        )}
      </div>
      {!hasSessions && (
        <div className={styles.terminalPlaceholder}>
          <span className={styles.terminalPlaceholderIcon}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <polyline points="8,16 14,22 8,28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="18" y1="26" x2="26" y2="26" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </span>
          <p>展开工作区，点击 <strong>+</strong> 启动会话</p>
          <span className={styles.terminalPlaceholderHint}>Ctrl+Shift+P 打开命令面板</span>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteGroupId}
        title="删除分组"
        confirmLabel="删除"
        confirmClass="btn-danger"
        message="确定要删除此分组？所有会话将被终止。"
        onConfirm={handleConfirmDeleteGroup}
        onCancel={() => setConfirmDeleteGroupId(null)}
      />
    </div>
  );
}
