import styles from "./Toast.module.css";

interface Props {
  error: string | null;
  ptyError: string | null;
  infoToast: string | null;
  onDismissError: () => void;
  onDismissPtyError: () => void;
  onDismissInfo: () => void;
  onRetry: () => void;
}

export function Toast({
  error,
  ptyError,
  infoToast,
  onDismissError,
  onDismissPtyError,
  onDismissInfo,
  onRetry,
}: Props) {
  return (
    <>
      {error && (
        <div className={`${styles.toast} ${styles.error}`}>
          <span>{error}</span>
          <button onClick={onRetry}>重试</button>
        </div>
      )}

      {ptyError && (
        <div className={`${styles.toast} ${styles.error}`}>
          <span>PTY 错误：{ptyError}</span>
          <button onClick={onDismissPtyError}>关闭</button>
        </div>
      )}

      {infoToast && (
        <div className={`${styles.toast} ${styles.info}`}>
          <span>{infoToast}</span>
          <button onClick={onDismissInfo}>关闭</button>
        </div>
      )}
    </>
  );
}
