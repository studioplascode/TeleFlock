//! `ai.complete`: one short completion from omp's `tiny` model role (naming, drafting).
//!
//! hostd runs `omp --mode json` without tools, extensions, skills, rules, LSP, session or title,
//! writes the prompt to its stdin, reads the JSONL event stream and takes the final assistant text
//! at `agent_end` (fallback: the assistant `message_end` when the stream ends first). The child is
//! killed as soon as the answer is in (omp otherwise lingers several seconds). A failed `tiny`
//! attempt is retried once with `smol` while time remains. At most [`MAX_CONCURRENT`] omp
//! processes run per daemon; queue time counts against the caller's timeout.
//!
//! Privacy: the prompt and system text go only to omp (and from there to the user's own model
//! provider). They are never logged, stored or echoed in errors.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tf_proto::{AiCompleteParams, AiCompleteResult, ApiError, HostMethod};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Semaphore;
use tokio::time::Instant;

use crate::clients::ClientHandle;
use crate::ops::fs::home_dir;
use crate::ops::host::omp_bin;
use crate::ops::{to_value, Ctx};

const DEFAULT_ROLE: &str = "tiny";
const FALLBACK_ROLE: &str = "smol";
const DEFAULT_TIMEOUT_MS: u32 = 20_000;
const MIN_TIMEOUT_MS: u32 = 2_000;
const MAX_TIMEOUT_MS: u32 = 60_000;
/// Concurrent omp processes per daemon.
const MAX_CONCURRENT: usize = 3;
/// The fallback role is only tried with at least this much time left.
const RETRY_MIN: Duration = Duration::from_millis(1_500);
/// Characters of stderr / error text returned with `ai_failed`.
const ERR_TAIL: usize = 300;
/// stderr bytes kept while the child runs.
const STDERR_CAP: usize = 16 * 1024;

static PERMITS: Semaphore = Semaphore::const_new(MAX_CONCURRENT);

pub async fn handle(_ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::AiComplete(p) => to_value(complete(&p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not an ai method", other.name()))),
    }
}

/// Runs one completion (see the module docs).
pub async fn complete(p: &AiCompleteParams) -> Result<AiCompleteResult, ApiError> {
    let started = Instant::now();
    let role = p.role.as_deref().unwrap_or(DEFAULT_ROLE);
    if !valid_role(role) {
        return Err(ApiError::new("invalid_params", format!("ai.complete: invalid role `{role}`")));
    }
    let limit = clamp_timeout(p.timeout_ms);
    let deadline = started + limit;
    let task: String = p.task.chars().take(32).collect();
    let res = run(p, role, deadline, limit).await;
    let ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    match res {
        Ok((answer, used_role)) => {
            tracing::info!(task = %task, role = used_role, model = answer.model.as_deref().unwrap_or("?"), ms, outcome = "ok", "ai.complete");
            Ok(AiCompleteResult { text: answer.text, model: answer.model, ms })
        }
        Err(e) => {
            tracing::info!(task = %task, role, ms, outcome = %e.code, "ai.complete");
            Err(e)
        }
    }
}

/// Queue + attempts. Returns the answer and the role that produced it.
async fn run<'a>(p: &AiCompleteParams, role: &'a str, deadline: Instant, limit: Duration) -> Result<(Answer, &'a str), ApiError> {
    let Some(bin) = omp_bin() else { return Err(unavailable("omp is not installed on this host")) };
    let cwd = p.cwd.as_deref().map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(home_dir);
    let _permit = match tokio::time::timeout_at(deadline, PERMITS.acquire()).await {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => return Err(ApiError::new("internal", "ai semaphore closed")),
        Err(_) => return Err(timed_out(limit)),
    };
    let system = one_line(&p.system);
    let roles: &[&'a str] = if role == FALLBACK_ROLE { &[role] } else { &[role, FALLBACK_ROLE] };
    let mut last: Option<Attempt> = None;
    let (mut tried, mut unresolved) = (0, 0);
    for (i, r) in roles.iter().copied().enumerate() {
        if i > 0 && deadline.saturating_duration_since(Instant::now()) < RETRY_MIN {
            break;
        }
        tried += 1;
        match attempt(&bin, r, &system, &p.prompt, &cwd, deadline).await {
            Ok(answer) => return Ok((answer, r)),
            Err(Attempt::Missing) => return Err(unavailable("omp is not installed on this host")),
            Err(Attempt::TimedOut) => return Err(timed_out(limit)),
            Err(a) => {
                if matches!(a, Attempt::Unresolved) {
                    unresolved += 1;
                }
                tracing::debug!(role = r, "ai.complete attempt failed");
                last = Some(a);
            }
        }
    }
    if unresolved == tried {
        return Err(ApiError::new("ai_unavailable", format!("omp has no `{role}` model role on this host"))
            .with_hint("Assign omp's tiny (or smol) model role on the host (`omp config`), with omp ≥ 18.12"));
    }
    Err(match last {
        Some(Attempt::Failed(msg)) if !msg.is_empty() => ApiError::new("ai_failed", format!("omp failed: {msg}")),
        _ => ApiError::new("ai_failed", "omp failed"),
    })
}

fn unavailable(msg: &str) -> ApiError {
    ApiError::new("ai_unavailable", msg).with_hint("Install omp ≥ 18.12 on the host")
}

fn timed_out(limit: Duration) -> ApiError {
    ApiError::new("timeout", format!("omp's model did not answer within {} s", limit.as_secs())).retryable()
}

/// Role names omp accepts after `@` (and nothing that could read as a flag or path).
pub(crate) fn valid_role(role: &str) -> bool {
    let b = role.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub(crate) fn clamp_timeout(ms: Option<u32>) -> Duration {
    Duration::from_millis(ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) as u64)
}

// ───────────────────────────── one omp run ─────────────────────────────

#[derive(Debug)]
enum Attempt {
    /// The omp binary could not be spawned (not found).
    Missing,
    /// omp does not know the role (`Model "@<role>" not found`).
    Unresolved,
    TimedOut,
    /// Exit / error event / empty answer: short error tail (never prompt text).
    Failed(String),
}

async fn attempt(bin: &Path, role: &str, system: &str, prompt: &str, cwd: &Path, deadline: Instant) -> Result<Answer, Attempt> {
    let model = format!("@{role}");
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args([
        "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title",
        "--model", &model, "--system-prompt", system,
    ])
    .current_dir(cwd)
    .env("NO_COLOR", "1")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console window from the background daemon.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Attempt::Missing),
        Err(e) => return Err(Attempt::Failed(tail(&e.to_string()))),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let input = prompt.as_bytes().to_vec();
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stderr = child.stderr.take().map(|mut err| {
        tokio::spawn(async move {
            let mut kept = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > STDERR_CAP {
                    kept.drain(..kept.len() - STDERR_CAP);
                }
            }
            String::from_utf8_lossy(&kept).into_owned()
        })
    });
    let Some(stdout) = child.stdout.take() else { return Err(Attempt::Failed("no stdout".into())) };
    let mut lines = BufReader::new(stdout).lines();
    let mut stream = Stream::default();
    let outcome = loop {
        match tokio::time::timeout_at(deadline, lines.next_line()).await {
            Err(_) => {
                let _ = child.kill().await;
                return Err(Attempt::TimedOut);
            }
            Ok(Ok(Some(line))) => {
                if let Some(done) = stream.feed(&line) {
                    break Some(done);
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) => break None,
        }
    };
    if let Some(done) = outcome {
        // The answer is in; omp would otherwise linger for seconds.
        let _ = child.kill().await;
        return done.map_err(|e| Attempt::Failed(tail(&e)));
    }
    // stdout closed without `agent_end`: wait for the exit, then use what streamed.
    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(s)) => Some(s),
        Ok(Err(_)) => None,
        Err(_) => {
            let _ = child.kill().await;
            return Err(Attempt::TimedOut);
        }
    };
    let err_text = match stderr {
        Some(h) => tokio::time::timeout(Duration::from_millis(500), h).await.ok().and_then(Result::ok).unwrap_or_default(),
        None => String::new(),
    };
    let exited_ok = status.is_some_and(|s| s.success());
    match stream.finish() {
        Ok(answer) if exited_ok => Ok(answer),
        res => {
            if unresolved_role(&err_text, role) {
                return Err(Attempt::Unresolved);
            }
            // The stream's own error first, then stderr, then the exit status.
            let msg = match res {
                Err(e) if !e.is_empty() => e,
                _ if !err_text.trim().is_empty() => err_text,
                _ => format!("omp exited with {}", status.and_then(|s| s.code()).map_or("a signal".to_string(), |c| format!("code {c}"))),
            };
            Err(Attempt::Failed(tail(&msg)))
        }
    }
}

/// omp's message for an unknown model / role: `Model "@<role>" not found`.
fn unresolved_role(stderr: &str, role: &str) -> bool {
    stderr.contains(&format!("\"@{role}\" not found"))
}

/// `--system-prompt` without CR/LF: Rust refuses line breaks in arguments to batch files
/// (`omp.cmd`, Windows npm installs), so a multi-line system prompt would never spawn there.
pub(crate) fn one_line(s: &str) -> String {
    s.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

/// Last [`ERR_TAIL`] characters of `s`, trimmed, on one line.
fn tail(s: &str) -> String {
    let s = s.trim();
    let n = s.chars().count();
    let t: String = if n > ERR_TAIL { s.chars().skip(n - ERR_TAIL).collect() } else { s.to_string() };
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ───────────────────────────── JSONL extraction ─────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    pub text: String,
    /// `provider/model` of the answering message.
    pub model: Option<String>,
}

/// Incremental reader of omp's `--mode json` event stream.
#[derive(Debug, Default)]
pub(crate) struct Stream {
    /// Last assistant `message_end` (used when `agent_end` never comes).
    last: Option<Result<Answer, String>>,
}

impl Stream {
    /// Feeds one stdout line; `Some` once the final answer (or a fatal error) is known.
    pub(crate) fn feed(&mut self, line: &str) -> Option<Result<Answer, String>> {
        let line = line.trim();
        if !line.starts_with('{') {
            return None;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { return None };
        match ev.get("type").and_then(Value::as_str)? {
            "agent_end" => {
                let last = ev
                    .get("messages")
                    .and_then(Value::as_array)
                    .and_then(|m| m.iter().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("assistant")));
                Some(match last {
                    Some(m) => message_answer(m),
                    None => self.last.take().unwrap_or_else(|| Err("no answer".into())),
                })
            }
            "message_end" => {
                let m = ev.get("message")?;
                if m.get("role").and_then(Value::as_str) == Some("assistant") {
                    self.last = Some(message_answer(m));
                }
                None
            }
            "error" => {
                let msg = ["error", "message"]
                    .iter()
                    .find_map(|k| match ev.get(*k) {
                        Some(Value::String(s)) => Some(s.clone()),
                        Some(v @ Value::Object(_)) => v.get("message").and_then(Value::as_str).map(str::to_string),
                        _ => None,
                    })
                    .unwrap_or_else(|| "omp reported an error".into());
                Some(Err(msg))
            }
            _ => None,
        }
    }

    /// End of stream without `agent_end`.
    pub(crate) fn finish(self) -> Result<Answer, String> {
        self.last.unwrap_or_else(|| Err(String::new()))
    }
}

/// The text of one assistant message (`content[]` items of type `text`; thinking ignored).
fn message_answer(m: &Value) -> Result<Answer, String> {
    let stop = m.get("stopReason").and_then(Value::as_str).unwrap_or("");
    if stop == "error" || stop == "aborted" {
        let msg = m.get("errorMessage").and_then(Value::as_str).unwrap_or(stop);
        return Err(msg.to_string());
    }
    let text: String = m
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .or_else(|| m.get("content").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return Err("empty answer".into());
    }
    let model = m.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|model| {
        match m.get("provider").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(p) => format!("{p}/{model}"),
            None => model.to_string(),
        }
    });
    Ok(Answer { text: text.to_string(), model })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_stream(lines: &[&str]) -> Result<Answer, String> {
        let mut s = Stream::default();
        for l in lines {
            if let Some(done) = s.feed(l) {
                return done;
            }
        }
        s.finish()
    }

    const USER_END: &str = r#"{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Add offline caching\n"}]}}"#;

    #[test]
    fn agent_end_takes_last_assistant_text_without_thinking() {
        let end = r#"{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"Add offline caching"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"**Selecting slug**"},{"type":"text","text":"offline-client"},{"type":"text","text":"-caching\n"}],"provider":"openai-codex","model":"gpt-6-luna","stopReason":"stop"}]}"#;
        let got = run_stream(&[r#"{"type":"session","version":3}"#, r#"{"type":"agent_start"}"#, USER_END, "not json", end, r#"{"type":"advisor_yielded"}"#]);
        assert_eq!(got, Ok(Answer { text: "offline-client-caching".into(), model: Some("openai-codex/gpt-6-luna".into()) }));
    }

    #[test]
    fn message_end_is_the_fallback_when_agent_end_never_comes() {
        let msg = r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":" fix-login-redirect "}],"model":"tiny-1"}}"#;
        assert_eq!(run_stream(&[USER_END, msg]), Ok(Answer { text: "fix-login-redirect".into(), model: Some("tiny-1".into()) }));
        // The user's own message_end is never an answer.
        assert_eq!(run_stream(&[USER_END]), Err(String::new()));
    }

    #[test]
    fn thinking_only_is_empty() {
        let end = r#"{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"offline-cache"}]}]}"#;
        assert_eq!(run_stream(&[end]), Err("empty answer".into()));
        let blank = r#"{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"  \n"}]}]}"#;
        assert_eq!(run_stream(&[blank]), Err("empty answer".into()));
    }

    #[test]
    fn error_events_and_error_stops_fail() {
        assert_eq!(run_stream(&[r#"{"type":"error","error":"No API key for provider"}"#]), Err("No API key for provider".into()));
        assert_eq!(run_stream(&[r#"{"type":"error","error":{"message":"boom"}}"#]), Err("boom".into()));
        let end = r#"{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"429 rate limited"}]}"#;
        assert_eq!(run_stream(&[end]), Err("429 rate limited".into()));
        // A retried error message_end is superseded by the next one.
        let bad = r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"overloaded"}}"#;
        let good = r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(run_stream(&[bad, good]).map(|a| a.text), Ok("ok".into()));
        assert_eq!(run_stream(&[bad]), Err("overloaded".into()));
    }

    #[test]
    fn roles_are_validated() {
        for ok in ["tiny", "smol", "a", "slow-2", "abcdefghijklmnopqrstuvwxyz012345"] {
            assert!(valid_role(ok), "{ok}");
        }
        for bad in ["", "Tiny", "-tiny", "1tiny", "ti ny", "tiny/x", "@tiny", "abcdefghijklmnopqrstuvwxyz0123456", "tïny"] {
            assert!(!valid_role(bad), "{bad}");
        }
    }

    #[test]
    fn timeouts_are_clamped() {
        assert_eq!(clamp_timeout(None), Duration::from_millis(20_000));
        assert_eq!(clamp_timeout(Some(0)), Duration::from_millis(2_000));
        assert_eq!(clamp_timeout(Some(5_000)), Duration::from_millis(5_000));
        assert_eq!(clamp_timeout(Some(600_000)), Duration::from_millis(60_000));
    }

    #[test]
    fn system_prompts_are_flattened() {
        assert_eq!(one_line("Reply in this format:\r\nTitle: x\nBody:\ry"), "Reply in this format: Title: x Body: y");
        assert_eq!(one_line("plain"), "plain");
    }

    #[test]
    fn unresolved_roles_and_tails() {
        assert!(unresolved_role("Model \"@zzz\" not found\n\nRun `omp models find <pattern>`", "zzz"));
        assert!(!unresolved_role("Model \"@zzz\" not found", "tiny"));
        let long = "x".repeat(400) + "\nend";
        let t = tail(&long);
        assert_eq!(t.chars().count(), ERR_TAIL);
        assert!(t.ends_with("x end"));
    }

    /// Calls the real omp on this machine: `cargo test -p tf-hostd ai -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs omp with a configured tiny role"]
    async fn ai_real_omp_branch_slug() {
        let p = AiCompleteParams {
            task: "branch".into(),
            system: "Reply with ONLY a kebab-case git branch slug of 2-5 words describing the task. No prefix, no quotes.".into(),
            prompt: "Add offline caching to the client".into(),
            role: None,
            timeout_ms: Some(40_000),
            cwd: None,
        };
        let res = complete(&p).await.expect("omp answered");
        println!("slug={} model={:?} ms={}", res.text, res.model, res.ms);
        assert!(!res.text.is_empty());
        assert!(res.ms < 40_000);
    }
}
