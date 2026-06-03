import { useRef, useState } from "react";
import { cn } from "../utils/cn";
import styles from "./TerminalPanel.module.css";

interface GroupTabItem {
  id: string;
  name: string;
  count: number;
}

interface Props {
  groups: GroupTabItem[];
  activeGroupId: string;
  onSwitchGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onAddGroup: () => void;
  onMoveSessionToGroup: (sessionId: string, targetGroupId: string) => void;
}

export function GroupTabs({
  groups,
  activeGroupId,
  onSwitchGroup,
  onRenameGroup,
  onDeleteGroup,
  onAddGroup,
  onMoveSessionToGroup,
}: Props) {
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const dragSessionIdRef = useRef<string | null>(null);

  return (
    <div className={styles.groupTabs}>
      {groups.map((g) => (
        <div
          key={g.id}
          className={cn(styles.groupTab, g.id === activeGroupId && styles.active, dragOverGroupId === g.id && styles.dragOver)}
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
            if (sid && g.id !== activeGroupId) {
              onMoveSessionToGroup(sid, g.id);
            }
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
              className={styles.groupRenameInput}
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
            <span className={styles.groupTabLabel}>{g.name}</span>
          )}
          {g.count > 0 && <span className={styles.tabBadge}>{g.count}</span>}
          <button
            className={styles.groupTabClose}
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
      <button className={styles.groupAddBtn} onClick={onAddGroup} title="New group">+</button>
    </div>
  );
}
