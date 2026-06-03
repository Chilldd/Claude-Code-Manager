use serde::Serialize;
use thiserror::Error;

/// Unified error type for the entire backend.
///
/// Every Tauri command should return `Result<T, AppError>` so the frontend
/// gets structured, actionable error information instead of opaque strings.
///
/// Note: `Serialize` is required by Tauri v2's command error handling.
///       We store all inner values as `String` to satisfy this constraint.
#[derive(Debug, Error, Serialize)]
pub enum AppError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("PTY error: {0}")]
    PtyError(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Workspace error: {0}")]
    Workspace(String),

    #[error("Metrics error: {0}")]
    Metrics(String),
}

/// Auto-convert `String` → `AppError::Internal` for convenience.
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Internal(s)
    }
}
