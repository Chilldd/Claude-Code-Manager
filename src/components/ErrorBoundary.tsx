import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ""}]`, error, info);
    this.props.onError?.(error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          padding: "32px",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-ui)",
          fontSize: "14px",
          textAlign: "center",
          height: "100%",
          background: "var(--bg-base)",
        }}>
          <div style={{ fontSize: "28px", opacity: 0.5 }}>⚠️</div>
          {this.props.name && (
            <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {this.props.name}
            </div>
          )}
          <div>出现错误</div>
          {this.state.error && (
            <div style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              maxWidth: "400px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {this.state.error.message}
            </div>
          )}
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button
              onClick={this.handleRetry}
              style={{
                padding: "6px 16px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                fontSize: "13px",
              }}
            >
              重试
            </button>
            <button
              onClick={this.handleReload}
              style={{
                padding: "6px 16px",
                border: "none",
                borderRadius: "var(--radius-sm)",
                background: "var(--accent)",
                color: "#000",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
