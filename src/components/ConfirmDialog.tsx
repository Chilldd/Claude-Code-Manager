import type { ReactNode } from "react";

interface Props {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  confirmClass?: "btn-primary" | "btn-danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  confirmClass = "btn-primary",
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="confirm-text">{message}</p>
        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className={confirmClass} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
