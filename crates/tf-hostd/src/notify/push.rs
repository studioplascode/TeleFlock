//! Push deliveries from tf-hostd (architecture §3.21): what an ntfy topic, Pushover or a webhook
//! receives, the rate limit, and the HTTP client (the host's `curl`).
//!
//! Requests carry their secrets only where each service wants them (ntfy: `Authorization`;
//! Pushover: the JSON body it requires; webhook: an HMAC signature, never the secret) and reach
//! `curl` on stdin (`-q -K -`), never on its command line, which every local user can read.
//! Nothing here logs a URL, header or body.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::time::Instant;

use tf_proto::{Millis, Notification, NotifyKind};

use super::store::{NtfyTopic, StoredChannel};

/// Why a notification is pushed (webhook `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// No app was connected.
    Offline,
    /// Nobody saw it on a device in time.
    Unseen,
    /// The channel takes every notification.
    Always,
    /// `notify.test`.
    Test,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Offline => "offline",
            Reason::Unseen => "unseen",
            Reason::Always => "always",
            Reason::Test => "test",
        }
    }
}

/// What leaves the host for one notification, after the channel's privacy setting.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: String,
    pub kind: NotifyKind,
    pub agent_id: String,
    pub title: String,
    pub body: String,
    pub at: Millis,
    pub request_id: Option<String>,
    /// Labels of the notification's answers (empty when private).
    pub actions: Vec<String>,
    pub reason: Reason,
}

/// Where a delivery comes from: this host and herdr session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub host: String,
    pub session: String,
}

impl Message {
    pub fn new(n: &Notification, agent_name: Option<&str>, private: bool, reason: Reason) -> Message {
        let (title, body) = if private { private_text(n.kind, agent_name) } else { (n.title.clone(), n.body.clone()) };
        Message {
            id: n.id.clone(),
            kind: n.kind,
            agent_id: n.agent_id.clone(),
            title,
            body,
            at: n.at,
            request_id: n.request_id.clone(),
            actions: if private { Vec::new() } else { n.actions.iter().map(|a| a.label.clone()).collect() },
            reason,
        }
    }

    /// ntfy sequence id: one live notification per agent, like the system notifications.
    pub fn seq(&self, session: &str) -> String {
        let raw = if self.agent_id.is_empty() { format!("tf-{}", self.id) } else { format!("tf-{session}-{}", self.agent_id) };
        let mut s: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        if s.len() > 64 {
            // Long names: keep it unique with a hash of the whole.
            let h = fnv1a(raw.as_bytes());
            s.truncate(55);
            s.push_str(&format!("-{h:08x}"));
        }
        s
    }
}

fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |h, b| (h ^ u32::from(*b)).wrapping_mul(0x0100_0193))
}

/// Title and body that name only the agent and what happened.
fn private_text(kind: NotifyKind, agent: Option<&str>) -> (String, String) {
    let who = agent.filter(|a| !a.is_empty()).unwrap_or("An agent");
    match kind {
        NotifyKind::Needs => (format!("{who} needs you"), "Open TeleFlock to answer.".into()),
        NotifyKind::Finished => (format!("{who} finished"), "Ready for review.".into()),
        NotifyKind::Error => (format!("{who} hit an error"), "Open TeleFlock for details.".into()),
        NotifyKind::Quiet => (format!("{who} has been quiet"), "No activity while working.".into()),
        NotifyKind::Info => ("TeleFlock".into(), "Something happened on your host.".into()),
    }
}

/// One HTTP request.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// The HTTP client: [`curl`] in the daemon, a recorder in tests.
pub type Http = Arc<dyn Fn(Request) -> BoxFuture<'static, Result<Response, String>> + Send + Sync>;

const USER_AGENT: &str = concat!("tf-hostd/", env!("CARGO_PKG_VERSION"));

fn json_request(method: &'static str, url: String, mut headers: Vec<(String, String)>, body: &Value) -> Request {
    headers.insert(0, ("Content-Type".into(), "application/json".into()));
    headers.insert(1, ("User-Agent".into(), USER_AGENT.into()));
    Request { method, url, headers, body: serde_json::to_vec(body).unwrap_or_default() }
}

fn priority(kind: NotifyKind) -> (u8, i8) {
    // (ntfy 1–5, Pushover -2–2)
    match kind {
        NotifyKind::Needs => (4, 1),
        NotifyKind::Error => (4, 0),
        NotifyKind::Finished | NotifyKind::Quiet => (3, 0),
        NotifyKind::Info => (2, -1),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max - 1).chain(std::iter::once('…')).collect() }
}

/// ntfy: JSON publishing to the server's root, the topic in the body.
pub fn ntfy_publish(ch: &StoredChannel, origin: &Origin, m: &Message) -> Result<Request, String> {
    let topic = NtfyTopic::parse(ch.url.as_deref().unwrap_or_default()).map_err(|e| e.message)?;
    let emoji = match m.kind {
        NotifyKind::Needs => "bell",
        NotifyKind::Finished => "white_check_mark",
        NotifyKind::Error => "warning",
        NotifyKind::Quiet => "hourglass",
        NotifyKind::Info => "information_source",
    };
    let mut body = json!({
        "topic": topic.topic,
        "title": clip(&m.title, 250),
        "message": clip(if m.body.is_empty() { &m.title } else { &m.body }, 4000),
        "priority": priority(m.kind).0,
        "tags": [emoji, origin.host],
    });
    if m.reason != Reason::Test {
        body["sequence_id"] = m.seq(&origin.session).into();
    }
    Ok(json_request("POST", topic.base, auth(ch), &body))
}

/// ntfy: marks the notification of sequence `seq` read and dismisses it (ntfy ≥ 2.15; older
/// servers answer 404 and keep it).
pub fn ntfy_clear(ch: &StoredChannel, seq: &str) -> Result<Request, String> {
    let topic = NtfyTopic::parse(ch.url.as_deref().unwrap_or_default()).map_err(|e| e.message)?;
    let mut headers = auth(ch);
    headers.insert(0, ("User-Agent".into(), USER_AGENT.into()));
    Ok(Request { method: "PUT", url: format!("{}{}/{seq}/clear", topic.base, topic.topic), headers, body: Vec::new() })
}

fn auth(ch: &StoredChannel) -> Vec<(String, String)> {
    ch.token.iter().map(|t| ("Authorization".to_string(), format!("Bearer {t}"))).collect()
}

/// Pushover's messages API (JSON body; its keys are part of the body by Pushover's design).
pub fn pushover(ch: &StoredChannel, origin: &Origin, m: &Message) -> Result<Request, String> {
    let (Some(token), Some(user)) = (ch.token.as_deref(), ch.user.as_deref()) else { return Err("the user key or application token is missing".into()) };
    let text = if m.body.is_empty() { m.title.clone() } else { m.body.clone() };
    let body = json!({
        "token": token,
        "user": user,
        "title": clip(&m.title, 250),
        "message": clip(&format!("{text}\n— {}", origin.host), 1024),
        "priority": priority(m.kind).1,
        "timestamp": m.at / 1000,
    });
    Ok(json_request("POST", "https://api.pushover.net/1/messages.json".into(), Vec::new(), &body))
}

/// What a webhook receives.
#[derive(Debug, Clone, Copy)]
pub enum Event<'a> {
    Notification(&'a Message),
    /// Read on a device, or its request was answered: the receiver may retract it.
    Done { id: &'a str, reason: &'a str, by: Option<&'a str> },
    /// Rate-limited notifications, delivered together.
    Batch(&'a [Message]),
}

fn notification_json(origin: &Origin, m: &Message) -> Value {
    let mut v = json!({
        "id": m.id,
        "at": m.at,
        "host": origin.host,
        "session": origin.session,
        "kind": m.kind,
        "agentId": m.agent_id,
        "title": m.title,
        "body": m.body,
        "reason": m.reason.as_str(),
    });
    if let Some(r) = &m.request_id {
        v["requestId"] = r.clone().into();
    }
    if !m.actions.is_empty() {
        v["actions"] = m.actions.clone().into();
    }
    v
}

/// The webhook request: JSON body, `X-TeleFlock-*` headers and, with a secret,
/// `X-TeleFlock-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
pub fn webhook(ch: &StoredChannel, origin: &Origin, ev: Event, now_s: i64, delivery: &str) -> Result<Request, String> {
    let url = ch.url.clone().ok_or("the webhook URL is missing")?;
    let (name, mut body) = match ev {
        Event::Notification(m) => ("notification", notification_json(origin, m)),
        Event::Done { id, reason, by } => {
            let mut v = json!({ "id": id, "host": origin.host, "session": origin.session, "reason": reason });
            if let Some(by) = by {
                v["by"] = by.into();
            }
            ("done", v)
        }
        Event::Batch(items) => ("batch", json!({ "host": origin.host, "session": origin.session, "items": items.iter().map(|m| notification_json(origin, m)).collect::<Vec<_>>() })),
    };
    body["event"] = name.into();
    let mut req = json_request(
        "POST",
        url,
        vec![("X-TeleFlock-Event".into(), name.into()), ("X-TeleFlock-Delivery".into(), delivery.into()), ("X-TeleFlock-Timestamp".into(), now_s.to_string())],
        &body,
    );
    if let Some(secret) = ch.secret.as_deref() {
        let sig = signature(secret, now_s, &req.body);
        req.headers.push(("X-TeleFlock-Signature".into(), format!("sha256={sig}")));
    }
    Ok(req)
}

/// Lowercase hex HMAC-SHA256 of `<timestamp>.<body>`.
pub fn signature(secret: &str, ts: i64, body: &[u8]) -> String {
    use hmac::{Hmac, KeyInit, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes keys of any length");
    mac.update(ts.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// One message standing for several rate-limited ones (ntfy, Pushover).
pub fn summary(items: &[Message], dropped: usize) -> Message {
    let rank = |k: NotifyKind| match k {
        NotifyKind::Needs => 0,
        NotifyKind::Error => 1,
        NotifyKind::Quiet => 2,
        NotifyKind::Finished => 3,
        NotifyKind::Info => 4,
    };
    let kind = items.iter().map(|m| m.kind).min_by_key(|k| rank(*k)).unwrap_or(NotifyKind::Info);
    let total = items.len() + dropped;
    let mut lines: Vec<String> = items.iter().take(6).map(|m| format!("• {}", m.title)).collect();
    if total > lines.len() {
        lines.push(format!("… and {} more", total - lines.len()));
    }
    let last = items.last();
    Message {
        id: last.map(|m| m.id.clone()).unwrap_or_default(),
        kind,
        agent_id: String::new(),
        title: format!("{total} TeleFlock notifications"),
        body: lines.join("\n"),
        at: last.map(|m| m.at).unwrap_or_default(),
        request_id: None,
        actions: Vec::new(),
        reason: last.map(|m| m.reason).unwrap_or(Reason::Offline),
    }
}

/// A short, secret-free description of a server's answer or a transport error.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for s in secrets {
        out = out.replace(s.as_str(), "***");
    }
    clip(&out, 160)
}

// ───────────────────────────── rate limit ─────────────────────────────

/// Per channel: a burst of [`Bucket::BURST`], then one per [`Bucket::EVERY`]. Notifications over
/// the limit wait and leave together as one summary.
#[derive(Debug, Clone)]
pub struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    pub const BURST: f64 = 5.0;
    pub const EVERY: Duration = Duration::from_secs(20);

    pub fn new(now: Instant) -> Bucket {
        Bucket { tokens: Self::BURST, at: now }
    }

    fn refill(&mut self, now: Instant) {
        let gained = now.saturating_duration_since(self.at).as_secs_f64() / Self::EVERY.as_secs_f64();
        self.tokens = (self.tokens + gained).min(Self::BURST);
        self.at = now;
    }

    pub fn take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Until the next token.
    pub fn wait(&mut self, now: Instant) -> Duration {
        self.refill(now);
        if self.tokens >= 1.0 { Duration::ZERO } else { Self::EVERY.mul_f64(1.0 - self.tokens) }
    }
}

// ───────────────────────────── curl ─────────────────────────────

/// The daemon's HTTP client: the host's `curl` (system trust store and proxy settings, nothing
/// added to the static binary). Config on stdin, `~/.curlrc` ignored (`-q`), no redirects.
pub fn curl() -> Http {
    Arc::new(|req| Box::pin(curl_run(req)))
}

/// A curl config-file string: `"…"` with `\\`, `\"`, `\n`, `\r`, `\t` escaped.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The curl config for `req` (stdin of `curl -q -K -`).
fn curl_config(req: &Request) -> Result<String, String> {
    let body = std::str::from_utf8(&req.body).map_err(|_| "request body is not text".to_string())?;
    let mut cfg = format!("url = {}\nrequest = {}\n", quote(&req.url), req.method);
    for (k, v) in &req.headers {
        cfg.push_str(&format!("header = {}\n", quote(&format!("{k}: {v}"))));
    }
    if !body.is_empty() {
        // `data-binary` reads a file for `@…`; JSON never starts with `@`.
        if body.starts_with('@') {
            return Err("request body starts with @".into());
        }
        cfg.push_str(&format!("data-binary = {}\n", quote(body)));
    }
    cfg.push_str("silent\nshow-error\nproto = \"=http,https\"\nmax-redirs = 0\nconnect-timeout = 10\nmax-time = 20\nwrite-out = \"\\n%{http_code}\"\n");
    Ok(cfg)
}

async fn curl_run(req: Request) -> Result<Response, String> {
    let bin = crate::ops::git::resolve_bin("curl").ok_or("curl is not installed on this host")?;
    let cfg = curl_config(&req)?;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["-q", "-K", "-"])
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't run curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(cfg.as_bytes()).await.map_err(|e| format!("curl: {e}"))?;
    }
    let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| "no answer within 30 s".to_string())?
        .map_err(|e| format!("curl: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    match (out.status.success(), code.trim().parse::<u16>()) {
        (true, Ok(status)) if status > 0 => Ok(Response { status, body: body.to_string() }),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("curl failed");
            Err(line.trim_start_matches("curl: ").to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{Answer, NotifyAction, PushKind, PushWhen};

    fn channel(kind: PushKind) -> StoredChannel {
        StoredChannel {
            id: "c".into(),
            kind,
            name: "c".into(),
            enabled: true,
            when: PushWhen::Offline,
            kinds: vec![NotifyKind::Needs],
            private: false,
            url: None,
            token: None,
            user: None,
            secret: None,
            last: None,
        }
    }

    fn needs() -> Notification {
        Notification {
            id: "n1".into(),
            at: 1_793_205_679_470,
            kind: NotifyKind::Needs,
            agent_id: "w1:p2".into(),
            title: "fix-auth · Allow tool: bash?".into(),
            body: "rm -rf build".into(),
            request_id: Some("r1".into()),
            actions: vec![NotifyAction { id: "Allow".into(), label: "Allow".into(), answer: Some(Answer { choices: vec!["Allow".into()], text: None, cancel: false, chat: false }) }],
        }
    }

    fn origin() -> Origin {
        Origin { host: "forge".into(), session: "default".into() }
    }

    fn body(r: &Request) -> Value {
        serde_json::from_slice(&r.body).unwrap()
    }

    fn header<'a>(r: &'a Request, k: &str) -> Option<&'a str> {
        r.headers.iter().find(|(h, _)| h == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn ntfy_publishes_json_with_one_sequence_per_agent() {
        let mut ch = channel(PushKind::Ntfy);
        ch.url = Some("https://ntfy.example.com/sub/tf-topic".into());
        ch.token = Some("tk_secret".into());
        let m = Message::new(&needs(), Some("fix-auth"), false, Reason::Offline);
        let r = ntfy_publish(&ch, &origin(), &m).unwrap();
        assert_eq!((r.method, r.url.as_str()), ("POST", "https://ntfy.example.com/sub/"));
        assert_eq!(header(&r, "Authorization"), Some("Bearer tk_secret"));
        assert_eq!(
            body(&r),
            json!({"topic": "tf-topic", "title": "fix-auth · Allow tool: bash?", "message": "rm -rf build", "priority": 4, "tags": ["bell", "forge"], "sequence_id": "tf-default-w1-p2"})
        );
        let clear = ntfy_clear(&ch, "tf-default-w1-p2").unwrap();
        assert_eq!((clear.method, clear.url.as_str()), ("PUT", "https://ntfy.example.com/sub/tf-topic/tf-default-w1-p2/clear"));
        assert!(clear.body.is_empty());
        let long = Message { agent_id: "x".repeat(80), ..m };
        let seq = long.seq("default");
        assert!(seq.len() <= 64 && super::super::store::valid_ntfy_id(&seq), "{seq}");
    }

    #[test]
    fn private_channels_send_only_who_and_what() {
        let m = Message::new(&needs(), Some("fix-auth"), true, Reason::Unseen);
        assert_eq!((m.title.as_str(), m.body.as_str()), ("fix-auth needs you", "Open TeleFlock to answer."));
        assert!(m.actions.is_empty());
        let mut ch = channel(PushKind::Pushover);
        ch.token = Some("azGDORePK8gMaC0QOYAMyEEuzJnyUi".into());
        ch.user = Some("uQiRzpo4DXghDmr9QzzfQu27cmVRsG".into());
        let r = pushover(&ch, &origin(), &m).unwrap();
        assert_eq!(r.url, "https://api.pushover.net/1/messages.json");
        assert_eq!(
            body(&r),
            json!({"token": "azGDORePK8gMaC0QOYAMyEEuzJnyUi", "user": "uQiRzpo4DXghDmr9QzzfQu27cmVRsG", "title": "fix-auth needs you", "message": "Open TeleFlock to answer.\n— forge", "priority": 1, "timestamp": 1_793_205_679})
        );
        assert!(!String::from_utf8_lossy(&r.body).contains("rm -rf"));
    }

    #[test]
    fn webhooks_are_signed_and_carry_no_secret() {
        let mut ch = channel(PushKind::Webhook);
        ch.url = Some("https://hooks.example.com/tf".into());
        ch.secret = Some("whsec_lab".into());
        let m = Message::new(&needs(), None, false, Reason::Offline);
        let r = webhook(&ch, &origin(), Event::Notification(&m), 1_793_205_679, "d1").unwrap();
        let b = body(&r);
        assert_eq!(b["event"], "notification");
        assert_eq!(b["actions"], json!(["Allow"]));
        assert_eq!((b["kind"].as_str(), b["requestId"].as_str(), b["reason"].as_str()), (Some("needs"), Some("r1"), Some("offline")));
        assert_eq!(header(&r, "X-TeleFlock-Timestamp"), Some("1793205679"));
        let sig = header(&r, "X-TeleFlock-Signature").unwrap();
        assert_eq!(sig, format!("sha256={}", signature("whsec_lab", 1_793_205_679, &r.body)));
        assert!(!String::from_utf8_lossy(&r.body).contains("whsec_lab"));
        // The format, pinned against `printf '1700000000.{"a":1}' | openssl dgst -sha256 -hmac whsec_lab`.
        assert_eq!(signature("whsec_lab", 1_700_000_000, br#"{"a":1}"#), "a0602f53e7e628a77677fb87f36fd76afb31384140c97af4010971229994e2e7");
        let done = webhook(&ch, &origin(), Event::Done { id: "n1", reason: "read", by: Some("Laptop") }, 5, "d2").unwrap();
        assert_eq!(body(&done), json!({"event": "done", "id": "n1", "host": "forge", "session": "default", "reason": "read", "by": "Laptop"}));
    }

    #[test]
    fn bursts_then_one_every_twenty_seconds() {
        let t0 = Instant::now();
        let mut b = Bucket::new(t0);
        for _ in 0..5 {
            assert!(b.take(t0));
        }
        assert!(!b.take(t0));
        assert_eq!(b.wait(t0), Bucket::EVERY);
        assert!(!b.take(t0 + Duration::from_secs(19)));
        assert!(b.take(t0 + Duration::from_secs(20)));
        assert!(b.take(t0 + Duration::from_secs(400)) && b.take(t0 + Duration::from_secs(400)));
        let items: Vec<Message> = (0..3).map(|i| Message { id: format!("n{i}"), kind: if i == 1 { NotifyKind::Needs } else { NotifyKind::Finished }, ..Message::new(&needs(), None, false, Reason::Offline) }).collect();
        let s = summary(&items, 4);
        assert_eq!((s.title.as_str(), s.kind, s.id.as_str()), ("7 TeleFlock notifications", NotifyKind::Needs, "n2"));
        assert!(s.body.ends_with("… and 4 more"), "{}", s.body);
    }

    #[test]
    fn curl_gets_everything_on_stdin_escaped() {
        let req = Request {
            method: "POST",
            url: "https://h/x".into(),
            headers: vec![("Authorization".into(), "Bearer a\"b".into())],
            body: br#"{"m":"line\nnext \\ \"q\""}"#.to_vec(),
        };
        let cfg = curl_config(&req).unwrap();
        assert!(cfg.starts_with("url = \"https://h/x\"\nrequest = POST\nheader = \"Authorization: Bearer a\\\"b\"\n"), "{cfg}");
        assert!(cfg.contains(r#"data-binary = "{\"m\":\"line\\nnext \\\\ \\\"q\\\"\"}""#), "{cfg}");
        assert!(curl_config(&Request { body: b"@/etc/passwd".to_vec(), ..req }).is_err());
        assert_eq!(scrub("bad token tk_123 for\n topic", &["tk_123".into()]), "bad token *** for topic");
    }
}
