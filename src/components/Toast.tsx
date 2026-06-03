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
          <button onClick={onRetry}>Retry</button>
        </div>
      )}

      {ptyError && (
        <div className={`${styles.toast} ${styles.error}`}>
          <span>PTY Error: {ptyError}</span>
          <button onClick={onDismissPtyError}>Dismiss</button>
        </div>
      )}

      {infoToast && (
        <div className={`${styles.toast} ${styles.info}`}>
          <span>{infoToast}</span>
          <button onClick={onDismissInfo}>Dismiss</button>
        </div>
      )}
    </>
  );
}
