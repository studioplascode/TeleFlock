//! Small helpers shared by the engine modules.

use std::path::Path;

use tf_proto::{ApiError, Millis};

pub fn now_ms() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

/// POSIX single-quote a string for `sh`.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:@%+,".contains(&b)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Random lowercase hex id with a prefix (`h_3f9a…`).
pub fn rand_id(prefix: &str) -> String {
    let n: u64 = rand::random();
    format!("{prefix}{n:016x}")
}

pub fn io_err(what: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::new("io_error", format!("{what}: {e}"))
}

/// Write a file atomically (temp file + rename) creating parent dirs.
pub async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

/// Write JSON atomically.
pub async fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| ApiError::new("internal", e.to_string()))?;
    write_atomic(path, &bytes).await.map_err(|e| io_err(&format!("write {}", path.display()), e))
}

/// Read JSON; `Ok(None)` when the file does not exist.
pub async fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| ApiError::new("io_error", format!("parse {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(&format!("read {}", path.display()), e)),
    }
}

pub fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new("invalid_params", msg)
}

pub fn to_value<T: serde::Serialize>(v: &T) -> Result<serde_json::Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new("internal", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("abc/def"), "abc/def");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$HOME"), "'$HOME'");
    }
}
