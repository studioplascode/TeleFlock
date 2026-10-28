//! Sign-in flows that run on this host and are completed from the app (`auth.*`, tf-proto
//! `accounts.rs`; architecture §3.14). A feature starts a flow ([`start`]) and drives it with the
//! returned [`FlowCtl`]: it publishes what the user has to do (URL, device code, prompt) and
//! receives what the user submits. The app long-polls the flow (`auth.wait`) until it is final.
//!
//! Loopback OAuth: the provider redirects the browser to `http://localhost:<port>/…`, where a
//! callback server on this host waits. The app forwards the same port of the device here (a
//! same-port tunnel); when it can't, the user pastes the address the browser landed on and
//! [`replay_redirect`] delivers it to the callback server as the browser would have.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use tf_proto::{ApiError, AuthFlow, AuthFlowList, AuthFlowState, AuthPaste, Empty, HostMethod, Millis};

use crate::ops::to_value;
use crate::util::{clip, new_id, now_ms};

/// Finished flows stay readable this long (a client that polls late still learns the outcome).
const KEEP_FINISHED: Duration = Duration::from_secs(10 * 60);
const DEFAULT_WAIT_MS: u32 = 15_000;
/// Below the app's 30 s request timeout.
const MAX_WAIT_MS: u32 = 20_000;
/// Longest submitted text (a redirect URL with a long code is a few KiB).
const MAX_INPUT: usize = 16 * 1024;
const REPLAY_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `auth.submit` waits for the driver's verdict on a submission.
const SUBMIT_REPLY: Duration = Duration::from_secs(20);
/// How long omp's loopback callback server waits for the browser (`omp login` and MCP sign-ins:
/// 300 s in omp 18.13): a flow that waits on one fails then, so its countdown ends there.
const CALLBACK_WAIT: Duration = Duration::from_secs(5 * 60);

struct Shared {
    tx: watch::Sender<AuthFlow>,
    /// Fires when the flow is cancelled, expires or finishes: drivers stop their work.
    stop: CancellationToken,
    /// When the TTL expires the flow (`expiresAt` unless omp gives up on its callback earlier).
    expires_at: Millis,
}

struct Entry {
    shared: Arc<Shared>,
    input: mpsc::UnboundedSender<FlowInput>,
    finished: Option<Instant>,
}

/// Text the user submitted (`auth.submit`): a pasted code or redirect address, or the answer to
/// the flow's prompt. The driver answers with [`FlowInput::reply`]; `auth.submit` returns that
/// verdict, so a wrong paste is reported where it was made. Dropping it unanswered accepts it.
pub struct FlowInput {
    pub text: String,
    reply: Option<oneshot::Sender<Result<(), ApiError>>>,
}

impl FlowInput {
    pub fn reply(mut self, verdict: Result<(), ApiError>) {
        if let Some(tx) = self.reply.take() {
            let _ = tx.send(verdict);
        }
    }
}

impl Drop for FlowInput {
    fn drop(&mut self) {
        if let Some(tx) = self.reply.take() {
            let _ = tx.send(Ok(()));
        }
    }
}

static FLOWS: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(Default::default);

fn flows() -> MutexGuard<'static, HashMap<String, Entry>> {
    FLOWS.lock().unwrap_or_else(|p| p.into_inner())
}

/// Drops flows that finished more than [`KEEP_FINISHED`] ago.
fn sweep(map: &mut HashMap<String, Entry>) {
    map.retain(|_, e| e.finished.is_none_or(|t| t.elapsed() < KEEP_FINISHED));
}

/// The driver's side of a flow. Dropping it before the flow is final fails the flow.
pub struct FlowCtl {
    id: String,
    shared: Arc<Shared>,
    input: mpsc::UnboundedReceiver<FlowInput>,
}

/// Registers a new flow (`starting`) that expires after `ttl`.
pub fn start(kind: &str, title: impl Into<String>, subject: Option<String>, ttl: Duration) -> FlowCtl {
    let now = now_ms();
    let id = new_id("auth_");
    let expires_at = now + ttl.as_millis() as Millis;
    let flow = AuthFlow {
        flow_id: id.clone(),
        kind: kind.to_string(),
        title: title.into(),
        subject,
        state: AuthFlowState::Starting,
        rev: 1,
        url: None,
        callback_port: None,
        redirect_uri: None,
        user_code: None,
        instructions: None,
        paste: AuthPaste::None,
        prompt: None,
        message: None,
        account: None,
        started_at: now,
        expires_at: Some(expires_at),
        updated_at: now,
    };
    let (tx, _) = watch::channel(flow);
    let shared = Arc::new(Shared { tx, stop: CancellationToken::new(), expires_at });
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    {
        let mut map = flows();
        sweep(&mut map);
        map.insert(id.clone(), Entry { shared: shared.clone(), input: in_tx, finished: None });
    }
    let timer = shared.clone();
    let timer_id = id.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(ttl) => {
                end(&timer_id, &timer, AuthFlowState::Expired, Some("The sign-in took too long and was stopped. Start it again.".into()));
            }
            _ = timer.stop.cancelled() => {}
        }
    });
    FlowCtl { id, shared, input: in_rx }
}

/// Makes the flow final (once) and stops its driver.
fn end(id: &str, shared: &Shared, state: AuthFlowState, message: Option<String>) -> bool {
    let mut changed = false;
    shared.tx.send_if_modified(|f| {
        if f.state.is_final() {
            return false;
        }
        f.state = state;
        if message.is_some() {
            f.message = message;
        }
        f.prompt = None;
        f.rev += 1;
        f.updated_at = now_ms();
        changed = true;
        true
    });
    if changed {
        if let Some(e) = flows().get_mut(id) {
            e.finished = Some(Instant::now());
        }
        shared.stop.cancel();
    }
    changed
}

impl FlowCtl {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn snapshot(&self) -> AuthFlow {
        self.shared.tx.borrow().clone()
    }

    pub fn is_final(&self) -> bool {
        self.shared.tx.borrow().state.is_final()
    }

    /// Changes the flow (ignored once it is final) and wakes its waiters.
    pub fn update(&self, f: impl FnOnce(&mut AuthFlow)) {
        self.shared.tx.send_if_modified(|flow| {
            if flow.state.is_final() {
                return false;
            }
            f(flow);
            flow.rev += 1;
            flow.updated_at = now_ms();
            true
        });
    }

    /// Publishes the page the user opens (`waiting`). An authorization URL that redirects to a
    /// loopback callback here also gets its `callbackPort` / `redirectUri` and a paste fallback, and
    /// `expiresAt` counts down omp's wait for that callback ([`CALLBACK_WAIT`]); the redirect is
    /// returned for [`replay_redirect`].
    pub fn publish_url(&self, url: &str, instructions: Option<String>) -> Option<LoopbackRedirect> {
        let redirect = loopback_redirect(url);
        let callback_ends = redirect.as_ref().map(|_| now_ms() + CALLBACK_WAIT.as_millis() as Millis);
        self.update(|f| {
            f.state = AuthFlowState::Waiting;
            f.url = Some(url.to_string());
            f.instructions = instructions;
            f.callback_port = redirect.as_ref().map(|r| r.port);
            f.redirect_uri = redirect.as_ref().map(|r| r.uri.clone());
            if redirect.is_some() && f.paste == AuthPaste::None {
                f.paste = AuthPaste::Fallback;
            }
            f.expires_at = Some(callback_ends.map_or(self.shared.expires_at, |at| at.min(self.shared.expires_at)));
        });
        redirect
    }

    /// Next submission (`auth.submit`); `None` once the flow is cancelled, expired or finished.
    pub async fn next_input(&mut self) -> Option<FlowInput> {
        tokio::select! {
            biased;
            _ = self.shared.stop.cancelled() => None,
            t = self.input.recv() => t,
        }
    }

    /// Resolves when the flow is cancelled, expires or finishes.
    pub fn cancelled(&self) -> tokio_util::sync::WaitForCancellationFuture<'_> {
        self.shared.stop.cancelled()
    }

    /// A token cancelled together with the flow (for helper tasks).
    pub fn stop_token(&self) -> CancellationToken {
        self.shared.stop.clone()
    }

    /// Makes the flow final. No effect when it already is (cancelled / expired meanwhile).
    pub fn finish(&self, state: AuthFlowState, message: Option<String>) -> bool {
        end(&self.id, &self.shared, state, message)
    }
}

impl Drop for FlowCtl {
    fn drop(&mut self) {
        end(&self.id, &self.shared, AuthFlowState::Failed, Some("The sign-in stopped unexpectedly.".into()));
    }
}

fn gone(flow_id: &str) -> ApiError {
    ApiError::new("auth_flow_gone", format!("sign-in `{flow_id}` is not running on this host"))
        .with_hint("It finished a while ago, or tf-hostd restarted. Start the sign-in again.")
}

fn shared_of(flow_id: &str) -> Result<Arc<Shared>, ApiError> {
    let mut map = flows();
    sweep(&mut map);
    map.get(flow_id).map(|e| e.shared.clone()).ok_or_else(|| gone(flow_id))
}

/// The flow once its `rev` is above `after_rev`, or after `wait_ms` (the current flow).
pub async fn wait(flow_id: &str, after_rev: Option<u32>, wait_ms: Option<u32>) -> Result<AuthFlow, ApiError> {
    let shared = shared_of(flow_id)?;
    let mut rx = shared.tx.subscribe();
    let Some(after) = after_rev else { return Ok(rx.borrow().clone()) };
    let wait = Duration::from_millis(u64::from(wait_ms.unwrap_or(DEFAULT_WAIT_MS).min(MAX_WAIT_MS)));
    let _ = tokio::time::timeout(wait, rx.wait_for(|f| f.rev > after)).await;
    let flow = rx.borrow().clone();
    Ok(flow)
}

/// Hands `text` to the flow's driver and returns its verdict: the flow as it is then, or why the
/// text was refused (a wrong paste, a sign-in that ended meanwhile). An empty answer is only taken
/// by a prompt (omp's "blank for the default" questions).
pub async fn submit(flow_id: &str, text: &str) -> Result<AuthFlow, ApiError> {
    let text = text.trim();
    if text.len() > MAX_INPUT {
        return Err(ApiError::new("invalid_params", "that is too long to be a sign-in code or address"));
    }
    let (shared, verdict) = {
        let map = flows();
        let e = map.get(flow_id).ok_or_else(|| gone(flow_id))?;
        let flow = e.shared.tx.borrow().clone();
        if flow.state.is_final() {
            return Err(ApiError::new("invalid_params", "this sign-in has already finished").with_hint("Start it again."));
        }
        if flow.prompt.is_none() && flow.paste == AuthPaste::None {
            return Err(ApiError::new("invalid_params", "this sign-in finishes in the browser; there is nothing to paste"));
        }
        if text.is_empty() && flow.prompt.is_none() {
            return Err(ApiError::new("invalid_params", "nothing to submit"));
        }
        let (tx, rx) = oneshot::channel();
        e.input.send(FlowInput { text: text.to_string(), reply: Some(tx) }).map_err(|_| gone(flow_id))?;
        (e.shared.clone(), rx)
    };
    let stop = shared.stop.clone();
    let verdict = tokio::select! {
        v = tokio::time::timeout(SUBMIT_REPLY, verdict) => match v {
            Ok(Ok(v)) => v,
            // The driver dropped the submission (it stopped): report the flow as it is.
            Ok(Err(_)) => Ok(()),
            Err(_) => Ok(()),
        },
        _ = stop.cancelled() => Ok(()),
    };
    verdict?;
    let flow = shared.tx.borrow().clone();
    Ok(flow)
}

/// Cancels a running flow (its driver stops at once). Finished flows are left as they are.
pub fn cancel(flow_id: &str) -> Result<(), ApiError> {
    let shared = shared_of(flow_id)?;
    end(flow_id, &shared, AuthFlowState::Cancelled, Some("Cancelled.".into()));
    Ok(())
}

/// Running flows and recently finished ones, newest first.
pub fn list() -> Vec<AuthFlow> {
    let mut map = flows();
    sweep(&mut map);
    let mut v: Vec<AuthFlow> = map.values().map(|e| e.shared.tx.borrow().clone()).collect();
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.flow_id.cmp(&a.flow_id)));
    v
}

/// `auth.*` requests.
pub async fn handle(req: HostMethod) -> Result<Value, ApiError> {
    match req {
        HostMethod::AuthList(_) => to_value(AuthFlowList { flows: list() }),
        HostMethod::AuthWait(p) => to_value(wait(&p.flow_id, p.after_rev, p.wait_ms).await?),
        HostMethod::AuthSubmit(p) => to_value(submit(&p.flow_id, &p.text).await?),
        HostMethod::AuthCancel(p) => {
            cancel(&p.flow_id)?;
            to_value(Empty {})
        }
        other => Err(ApiError::new("unknown_method", format!("unknown method `{}`", other.name()))),
    }
}

// ───────────────────────────── loopback redirects ─────────────────────────────

/// Where an authorization URL sends the browser back to: a callback server on this host's loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackRedirect {
    pub port: u16,
    /// e.g. `/auth/callback`.
    pub path: String,
    /// The `redirect_uri` as given.
    pub uri: String,
    /// The authorization URL's `state`: completes a pasted bare code.
    pub state: Option<String>,
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `application/x-www-form-urlencoded` value decoding (`+` is a space).
fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => match (b.get(i + 1).copied().and_then(hex_val), b.get(i + 2).copied().and_then(hex_val)) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~') {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// Decoded `key=value` pairs of a query string (without `?`).
fn query_pairs(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (form_decode(k), form_decode(v)),
            None => (form_decode(p), String::new()),
        })
        .collect()
}

fn query_get(q: &str, key: &str) -> Option<String> {
    query_pairs(q).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// An absolute `http(s)://host[:port]/path?query#frag` split into its parts.
struct Url<'a> {
    scheme: &'a str,
    host: &'a str,
    port: Option<u16>,
    path: &'a str,
    query: &'a str,
}

fn split_url(s: &str) -> Option<Url<'_>> {
    let (scheme, rest) = s.split_once("://")?;
    let scheme_ok = !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_ok {
        return None;
    }
    let rest = rest.split('#').next().unwrap_or_default();
    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p.parse().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        (h, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p.parse().ok()?)),
            None => (authority, None),
        }
    };
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, q),
        None => (tail, ""),
    };
    Some(Url { scheme, host, port, path: if path.is_empty() { "/" } else { path }, query })
}

fn is_loopback_host(h: &str) -> bool {
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1"
}

/// The loopback callback `auth_url` redirects to (`redirect_uri=http://localhost:<port>/…`);
/// `None` when it redirects anywhere else (a provider page that shows a code, a custom scheme).
pub fn loopback_redirect(auth_url: &str) -> Option<LoopbackRedirect> {
    let u = split_url(auth_url.trim())?;
    let uri = query_get(u.query, "redirect_uri")?;
    let r = split_url(&uri)?;
    if !r.scheme.eq_ignore_ascii_case("http") || !is_loopback_host(r.host) {
        return None;
    }
    let port = r.port.filter(|p| *p != 0)?;
    let path = r.path.to_string();
    Some(LoopbackRedirect { port, path, state: query_get(u.query, "state").filter(|s| !s.is_empty()), uri })
}

/// Refuses a pasted text that is clearly not for this sign-in: a loopback address of another
/// callback (port or path differ), or text with spaces in it. Anything else may be a code or an
/// address the provider's own parser understands.
pub fn check_paste(t: &LoopbackRedirect, pasted: &str) -> Result<(), ApiError> {
    let text = pasted.trim();
    if text.chars().any(char::is_whitespace) {
        return Err(ApiError::new("invalid_params", "that doesn't look like a sign-in code or address")
            .with_hint("Paste the full address from the browser's address bar, or just the code."));
    }
    if let Some(u) = split_url(text)
        && u.scheme.eq_ignore_ascii_case("http")
        && is_loopback_host(u.host)
        && (u.port != Some(t.port) || u.path != t.path)
    {
        return Err(ApiError::new(
            "invalid_params",
            format!("that address is for {}:{}{} — this sign-in waits on port {} at {}", u.host, u.port.unwrap_or(80), u.path, t.port, t.path),
        )
        .with_hint("It belongs to another sign-in. Start this one again, or paste its own address."));
    }
    Ok(())
}

/// The callback query a pasted text stands for: the address the browser landed on (or its
/// `?query` part), else `code` or `code#state` as providers show it.
fn callback_query(t: &LoopbackRedirect, pasted: &str) -> Result<String, ApiError> {
    let text = pasted.trim();
    check_paste(t, text)?;
    if let Some(u) = split_url(text) {
        if !u.scheme.eq_ignore_ascii_case("http") || !is_loopback_host(u.host) {
            return Err(ApiError::new("invalid_params", format!("`{}` is not the address this sign-in waits for", clip(text, 80)))
                .with_hint(format!("Paste the address that starts with http://localhost:{}", t.port)));
        }
        return checked_query(u.query);
    }
    let q = text.trim_start_matches(['?', '#']);
    if q.contains("code=") || q.contains("error=") {
        return checked_query(q);
    }
    let (code, state) = match text.split_once('#') {
        Some((c, s)) if !s.is_empty() => (c, Some(s.to_string())),
        Some((c, _)) => (c, None),
        None => (text, None),
    };
    let state = state.or_else(|| t.state.clone());
    let mut q = format!("code={}", form_encode(code));
    if let Some(s) = state {
        q.push_str(&format!("&state={}", form_encode(&s)));
    }
    Ok(q)
}

fn checked_query(q: &str) -> Result<String, ApiError> {
    let pairs = query_pairs(q);
    if pairs.iter().any(|(k, v)| (k == "code" || k == "error") && !v.is_empty()) {
        Ok(q.to_string())
    } else {
        Err(ApiError::new("invalid_params", "that address has no sign-in code")
            .with_hint("Paste the full address from the browser's address bar after you approved the sign-in."))
    }
}

/// Delivers a pasted redirect address (or code) to the callback server on this host, as the browser
/// would have: `GET http://127.0.0.1:<port><path>?<query>`. Returns the callback's HTTP status.
pub async fn replay_redirect(t: &LoopbackRedirect, pasted: &str) -> Result<u16, ApiError> {
    let query = callback_query(t, pasted)?;
    let target = format!("{}?{}", t.path, query);
    let mut last = None;
    for ip in ["127.0.0.1", "::1"] {
        match tokio::time::timeout(REPLAY_TIMEOUT, http_get(ip, t.port, &target)).await {
            Ok(Ok(status)) => return Ok(status),
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => last = Some(e.to_string()),
            Ok(Err(e)) => return Err(ApiError::new("io_error", format!("sign-in callback on port {}: {e}", t.port))),
            Err(_) => return Err(ApiError::new("timeout", format!("the sign-in callback on port {} did not answer", t.port))),
        }
    }
    Err(ApiError::new("not_found", format!("nothing waits for the sign-in on port {} of this host anymore", t.port))
        .with_hint(last.map(|e| format!("Start the sign-in again ({e}).")).unwrap_or_else(|| "Start the sign-in again.".into())))
}

async fn http_get(ip: &str, port: u16, target: &str) -> std::io::Result<u16> {
    let mut s = tokio::net::TcpStream::connect((ip, port)).await?;
    let req = format!("GET {target} HTTP/1.1\r\nHost: localhost:{port}\r\nUser-Agent: tf-hostd\r\nAccept: text/html\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await?;
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    while !head.windows(2).any(|w| w == b"\r\n") && head.len() < 8192 {
        let n = s.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let line = String::from_utf8_lossy(&head);
    let status = line.split_whitespace().nth(1).and_then(|c| c.parse().ok());
    status.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no HTTP status line"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn ttl() -> Duration {
        Duration::from_secs(600)
    }

    #[tokio::test]
    async fn wait_returns_on_change_or_timeout() {
        let ctl = start("account", "Test", None, ttl());
        let id = ctl.id().to_string();
        let first = wait(&id, None, None).await.unwrap();
        assert_eq!(first.state, AuthFlowState::Starting);
        // Nothing changes: the long poll returns the same rev after its wait.
        let t0 = Instant::now();
        let same = wait(&id, Some(first.rev), Some(50)).await.unwrap();
        assert_eq!(same.rev, first.rev);
        assert!(t0.elapsed() >= Duration::from_millis(45));
        // A change wakes a pending wait at once.
        let waiter = tokio::spawn({
            let id = id.clone();
            async move { wait(&id, Some(first.rev), Some(10_000)).await.unwrap() }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        ctl.update(|f| {
            f.state = AuthFlowState::Waiting;
            f.url = Some("https://example.com/auth".into());
        });
        let got = tokio::time::timeout(Duration::from_secs(2), waiter).await.unwrap().unwrap();
        assert_eq!(got.state, AuthFlowState::Waiting);
        assert!(got.rev > first.rev);
        assert!(ctl.finish(AuthFlowState::Done, None));
        // Final: updates are ignored, a second finish has no effect.
        ctl.update(|f| f.state = AuthFlowState::Waiting);
        assert_eq!(ctl.snapshot().state, AuthFlowState::Done);
        assert!(!ctl.finish(AuthFlowState::Failed, Some("late".into())));
    }

    #[tokio::test]
    async fn submissions_reach_the_driver_and_return_its_verdict() {
        let mut ctl = start("mcp", "Server", Some("srv".into()), ttl());
        let id = ctl.id().to_string();
        ctl.update(|f| {
            f.state = AuthFlowState::Waiting;
            f.paste = AuthPaste::Fallback;
        });
        let pending = tokio::spawn({
            let id = id.clone();
            async move { submit(&id, "  http://localhost:1/cb?code=x  ").await }
        });
        let input = ctl.next_input().await.unwrap();
        assert_eq!(input.text, "http://localhost:1/cb?code=x", "trimmed");
        input.reply(Err(ApiError::new("invalid_params", "wrong sign-in")));
        assert_eq!(pending.await.unwrap().unwrap_err().message, "wrong sign-in");
        // An unanswered (dropped) submission is accepted.
        let pending = tokio::spawn({
            let id = id.clone();
            async move { submit(&id, "code").await }
        });
        drop(ctl.next_input().await.unwrap());
        assert_eq!(pending.await.unwrap().unwrap().flow_id, id);
        // A submission the driver never reads returns once the flow is cancelled.
        let pending = tokio::spawn({
            let id = id.clone();
            async move { submit(&id, "late").await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel(&id).unwrap();
        let flow = tokio::time::timeout(Duration::from_secs(1), pending).await.unwrap().unwrap().unwrap();
        assert_eq!(flow.state, AuthFlowState::Cancelled);
    }

    #[tokio::test]
    async fn cancel_stops_the_driver_and_input() {
        let mut ctl = start("mcp", "Server", Some("srv".into()), ttl());
        let id = ctl.id().to_string();
        ctl.update(|f| {
            f.state = AuthFlowState::Waiting;
            f.paste = AuthPaste::Fallback;
        });
        cancel(&id).unwrap();
        tokio::time::timeout(Duration::from_secs(1), ctl.cancelled()).await.expect("cancelled() fires on cancel");
        assert!(ctl.next_input().await.is_none());
        let f = wait(&id, None, None).await.unwrap();
        assert_eq!(f.state, AuthFlowState::Cancelled);
        assert_eq!(submit(&id, "code").await.unwrap_err().code, "invalid_params", "final flows take no input");
        // The driver finishing afterwards does not overwrite the cancel.
        assert!(!ctl.finish(AuthFlowState::Done, None));
        assert_eq!(wait(&id, None, None).await.unwrap().state, AuthFlowState::Cancelled);
    }

    #[tokio::test]
    async fn submit_needs_a_paste_or_prompt() {
        let mut ctl = start("account", "Device", None, ttl());
        let id = ctl.id().to_string();
        ctl.update(|f| {
            f.state = AuthFlowState::Waiting;
            f.user_code = Some("ABCD-EFGH".into());
        });
        assert_eq!(submit(&id, "x").await.unwrap_err().code, "invalid_params");
        assert_eq!(submit(&id, "   ").await.unwrap_err().code, "invalid_params");
        assert_eq!(submit(&id, &"x".repeat(MAX_INPUT + 1)).await.unwrap_err().code, "invalid_params");
        ctl.update(|f| f.prompt = Some(tf_proto::AuthPrompt { message: "Key".into(), placeholder: None, secret: true }));
        let pending = tokio::spawn({
            let id = id.clone();
            async move { submit(&id, "sk-1").await }
        });
        assert_eq!(ctl.next_input().await.unwrap().text, "sk-1");
        assert!(pending.await.unwrap().is_ok());
        assert_eq!(submit("auth_nope", "x").await.unwrap_err().code, "auth_flow_gone");
        assert_eq!(wait("auth_nope", None, None).await.unwrap_err().code, "auth_flow_gone");
    }

    #[tokio::test(start_paused = true)]
    async fn flows_expire_after_their_ttl() {
        let ctl = start("account", "Slow", None, Duration::from_secs(300));
        let id = ctl.id().to_string();
        tokio::time::sleep(Duration::from_secs(299)).await;
        assert_eq!(ctl.snapshot().state, AuthFlowState::Starting);
        tokio::time::sleep(Duration::from_secs(2)).await;
        tokio::time::timeout(Duration::from_secs(1), ctl.cancelled()).await.expect("cancelled() fires on expiry");
        assert_eq!(wait(&id, None, None).await.unwrap().state, AuthFlowState::Expired);
    }

    #[tokio::test]
    async fn dropping_the_driver_fails_the_flow() {
        let ctl = start("account", "Crash", None, ttl());
        let id = ctl.id().to_string();
        drop(ctl);
        let f = wait(&id, None, None).await.unwrap();
        assert_eq!(f.state, AuthFlowState::Failed);
        assert!(list().iter().any(|f| f.flow_id == id), "finished flows stay listed");
    }

    #[tokio::test]
    async fn a_loopback_page_counts_down_omps_callback_wait() {
        // An account link may wait 15 min (a device code); omp's callback server gives up after 5.
        let ctl = start("account", "Claude", None, Duration::from_secs(15 * 60));
        let limit = ctl.snapshot().expires_at.unwrap();
        let before = now_ms();
        ctl.publish_url("https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=s", None);
        let at = ctl.snapshot().expires_at.unwrap();
        assert!((before + 300_000..=now_ms() + 300_000).contains(&at), "{at} is not 5 min after {before}");
        // A page with no callback here (a device code) waits as long as the flow may.
        ctl.publish_url("https://github.com/login/device", None);
        assert_eq!(ctl.snapshot().expires_at, Some(limit));
        // A flow limited below omp's wait keeps its own limit.
        let short = start("mcp", "Server", None, Duration::from_secs(60));
        let limit = short.snapshot().expires_at;
        short.publish_url("https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback", None);
        assert_eq!(short.snapshot().expires_at, limit);
    }

    #[test]
    fn finds_the_loopback_redirect_of_auth_urls() {
        let codex = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&state=abc123&originator=omp";
        let r = loopback_redirect(codex).unwrap();
        assert_eq!((r.port, r.path.as_str(), r.uri.as_str(), r.state.as_deref()), (1455, "/auth/callback", "http://localhost:1455/auth/callback", Some("abc123")));
        let gemini = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A8085%2Foauth2callback&state=s";
        assert_eq!(loopback_redirect(gemini).unwrap().port, 8085);
        let v6 = "https://x.example/authorize?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A9000%2F";
        let r = loopback_redirect(v6).unwrap();
        assert_eq!((r.port, r.path.as_str(), r.state), (9000, "/", None));
        for none in [
            "https://gitlab.com/oauth/authorize?redirect_uri=vscode%3A%2F%2Fgitlab.gitlab-workflow%2Fauthentication",
            "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback",
            "https://x.example/authorize?redirect_uri=http%3A%2F%2Flocalhost.evil.com%3A1455%2Fcb",
            "https://x.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcb",
            "https://x.example/authorize?state=1",
            "not a url",
        ] {
            assert_eq!(loopback_redirect(none), None, "{none}");
        }
    }

    fn target(port: u16) -> LoopbackRedirect {
        LoopbackRedirect { port, path: "/callback".into(), uri: format!("http://localhost:{port}/callback"), state: Some("st8".into()) }
    }

    #[test]
    fn pasted_text_becomes_the_callback_query() {
        let t = target(54545);
        assert_eq!(callback_query(&t, "http://localhost:54545/callback?code=c1&state=s1").unwrap(), "code=c1&state=s1");
        assert_eq!(callback_query(&t, "http://127.0.0.1:54545/callback?code=c1&state=s1#frag").unwrap(), "code=c1&state=s1");
        assert_eq!(callback_query(&t, "?code=c2&state=s2").unwrap(), "code=c2&state=s2");
        assert_eq!(callback_query(&t, "code=c2").unwrap(), "code=c2");
        assert_eq!(callback_query(&t, "http://localhost:54545/callback?error=access_denied&state=s").unwrap(), "error=access_denied&state=s");
        // Bare codes: `code#state` as shown by the provider, else the auth URL's state.
        assert_eq!(callback_query(&t, "abc#xyz").unwrap(), "code=abc&state=xyz");
        assert_eq!(callback_query(&t, "a/b+c").unwrap(), "code=a%2Fb%2Bc&state=st8");
        let no_state = LoopbackRedirect { state: None, ..target(1) };
        assert_eq!(callback_query(&no_state, "abc").unwrap(), "code=abc");
        // Wrong place, no code, not a code.
        assert_eq!(callback_query(&t, "http://localhost:1455/auth/callback?code=c").unwrap_err().code, "invalid_params");
        assert_eq!(callback_query(&t, "http://localhost:54545/other?code=c").unwrap_err().code, "invalid_params");
        assert_eq!(callback_query(&t, "https://evil.example:54545/callback?code=c").unwrap_err().code, "invalid_params");
        assert_eq!(callback_query(&t, "http://localhost:54545/callback?state=s").unwrap_err().code, "invalid_params");
        assert_eq!(callback_query(&t, "two words").unwrap_err().code, "invalid_params");
    }

    #[test]
    fn form_coding_roundtrips() {
        assert_eq!(form_decode("a%2Fb+c%3D%zz%"), "a/b c=%zz%");
        assert_eq!(form_decode(&form_encode("x y/z?&=é")), "x y/z?&=é");
    }

    /// A callback server stand-in: answers one request and reports its request line.
    async fn fake_callback(status: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").as_bytes()).await.unwrap();
            req.lines().next().unwrap_or_default().to_string()
        });
        (port, task)
    }

    #[tokio::test]
    async fn replay_delivers_the_redirect_to_the_callback_server() {
        let (port, server) = fake_callback("200 OK").await;
        let t = target(port);
        let status = replay_redirect(&t, &format!("http://localhost:{port}/callback?code=abc&state=st8")).await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(server.await.unwrap(), "GET /callback?code=abc&state=st8 HTTP/1.1");
        // A bare code gets the auth URL's state.
        let (port, server) = fake_callback("302 Found").await;
        assert_eq!(replay_redirect(&target(port), "the-code").await.unwrap(), 302);
        assert_eq!(server.await.unwrap(), "GET /callback?code=the-code&state=st8 HTTP/1.1");
    }

    #[tokio::test]
    async fn replay_reports_a_gone_callback_server() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let err = replay_redirect(&target(port), "code").await.unwrap_err();
        assert_eq!(err.code, "not_found", "{err:?}");
    }
}
