import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "../contexts/ThemeContext";
import { cn } from "../utils/cn";
import styles from "./TitleBar.module.css";

interface Props {
  view: "performance" | "terminal";
  onViewChange: (view: "performance" | "terminal") => void;
  onAddWorkspace: () => void;
}

export function TitleBar({ view, onViewChange, onAddWorkspace }: Props) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header
      className={styles.titlebar}
      onDoubleClick={() => {
        getCurrentWindow().toggleMaximize().catch(console.error);
      }}
    >
      <div className={styles.titlebarLeft} data-tauri-drag-region>
        <span className={styles.titlebarIcon}>⚡</span>
        <span className={styles.titlebarText}>yug-cc-manager</span>
      </div>
      <div className={styles.titlebarCenter} data-tauri-drag-region />
      <div className={styles.titlebarRight}>
        {/* ── Theme Toggle ── */}
        <button
          className={styles.titlebarBtn}
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.3" />
              <line x1="7" y1="1" x2="7" y2="2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="7" y1="11.5" x2="7" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="1" y1="7" x2="2.5" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="11.5" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="2.5" y1="2.5" x2="3.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="10.5" y1="10.5" x2="11.5" y2="11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="2.5" y1="11.5" x2="3.5" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="10.5" y1="3.5" x2="11.5" y2="2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M11 8.5a5 5 0 0 1-5-5A4.9 4.9 0 0 1 6.5 2 5 5 0 1 0 12 7.5a4.9 4.9 0 0 1-1 .5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <div className={styles.titlebarSep} />
        {/* ── View Toggle ── */}
        <button
          className={cn(styles.viewToggle, view === "performance" && styles.active)}
          onClick={() => onViewChange("performance")}
          title="Performance Monitor"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <polyline points="2,12 6,8 8,10 14,4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="14" cy="4" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className={cn(styles.viewToggle, view === "terminal" && styles.active)}
          onClick={() => onViewChange("terminal")}
          title="Terminal View"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <polyline points="4,10 8,6 4,2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="10" y1="13" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div className={styles.titlebarSep} />
        <button
          className={cn(styles.titlebarBtn, styles.primary)}
          onClick={onAddWorkspace}
          title="Add Workspace"
        >
          +
        </button>
        <div className={styles.titlebarSep} />
        <button
          className={styles.winBtn}
          onClick={() => getCurrentWindow().minimize().catch(console.error)}
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className={styles.winBtn}
          onClick={() => getCurrentWindow().toggleMaximize().catch(console.error)}
          title="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1.5" y="1.5" width="7" height="7" rx="0" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className={cn(styles.winBtn, styles.winBtnClose)}
          onClick={() => getCurrentWindow().close().catch(console.error)}
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.2" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  );
}
