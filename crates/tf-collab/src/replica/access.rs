//! Which account served a provider request and whether the provider refused the model there
//! (architecture §3.22 "Model access"). omp writes the credential it sent on every assistant
//! message (`credentialId`, its `auth_credentials` row); tf-hostd learns from these which account
//! serves which model. A credential id means something only in the store of the host whose omp
//! wrote the line, so every request carries where it is in its transcript (tf-hostd tells the lines
//! a session brought from another host from the ones written here) and, when omp recorded it, its
//! account's fingerprint.

use std::collections::BTreeMap;

use serde_json::Value;
use tf_proto::Millis;

use super::util::{non_empty, s, ts};

/// One provider request of an omp agent, as its assistant message records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialUse {
    /// omp's credential id (`auth_credentials.id` in its `agent.db`).
    pub credential_id: i64,
    pub provider: String,
    /// Model id as omp requested it.
    pub model: String,
    /// The provider refused the model on that account; else it answered.
    pub denied: bool,
    /// When the request ran (the message's time, else the entry's), by the clock of the host that
    /// wrote it.
    pub at: Millis,
    /// The account's fingerprint as omp records it on the host that wrote the transcript: the
    /// `credential_pin` entry omp writes right after a request moved the session to another account
    /// (`hash`, SHA-256 of provider and identity). A credential id only means something on the host
    /// whose store issued it; the fingerprint names the account anywhere.
    pub account: Option<String>,
    /// The transcript it is in: `""` for the session's own file, else the path relative to the
    /// session's artifacts folder (`Scout.jsonl`, `Scout/Scout.Sub.jsonl`).
    pub file: String,
    /// Where its line ends in that transcript (bytes).
    pub end: u64,
}

impl CredentialUse {
    /// What an assistant message (`message_end`, or a session entry's `message`) shows about its
    /// account: it answered (`stop`, `toolUse`, `length`), or it refused the model
    /// ([`refused_model`]). Limits, outages and aborts say nothing about access: `None`. `entry_at`
    /// is the entry's own time, for a message without one.
    pub fn of(msg: &Value, entry_at: Option<Millis>) -> Option<CredentialUse> {
        if s(msg, "role")? != "assistant" {
            return None;
        }
        let credential_id = msg.get("credentialId")?.as_i64()?;
        let model = non_empty(msg, "model")?;
        let denied = match s(msg, "stopReason")? {
            "stop" | "toolUse" | "length" => false,
            "error" if non_empty(msg, "errorMessage").and_then(refused_model).as_deref() == Some(model) => true,
            _ => return None,
        };
        let provider = non_empty(msg, "provider")?.to_owned();
        Some(CredentialUse { credential_id, provider, model: model.to_owned(), denied, at: ts(msg).or(entry_at)?, account: None, file: String::new(), end: 0 })
    }

    /// [`CredentialUse::of`] for a session entry (`{type: "message", message, timestamp}`).
    pub fn of_entry(entry: &Value) -> Option<CredentialUse> {
        if s(entry, "type")? != "message" {
            return None;
        }
        CredentialUse::of(entry.get("message")?, ts(entry))
    }
}

/// Transcript, credential, model, outcome, and whether the fingerprint is known.
type UseKey = (String, i64, String, bool, bool);

fn key_of(u: &CredentialUse) -> UseKey {
    (u.file.clone(), u.credential_id, u.model.clone(), u.denied, u.account.is_some())
}

/// Collects the requests of transcripts read in file order: the last one per transcript,
/// credential, model and outcome, apart for those whose fingerprint is known (omp records it only
/// after the first request on an account), each paired with the `credential_pin` entry that
/// directly follows it.
#[derive(Debug, Default)]
pub(crate) struct Collector {
    uses: BTreeMap<UseKey, CredentialUse>,
    /// The request the previous line was, while nothing came between it and a pin.
    last: Option<UseKey>,
}

impl Collector {
    /// One session entry of transcript `file` whose line ends at byte `end`, in file order.
    pub fn entry(&mut self, entry: &Value, file: &str, end: u64) {
        if s(entry, "type") == Some("credential_pin") {
            let (Some(key), Some(hash)) = (self.last.take(), non_empty(entry, "hash")) else { return };
            let Some(mut u) = self.uses.remove(&key) else { return };
            if Some(u.provider.as_str()) == non_empty(entry, "provider") {
                u.account = Some(hash.to_owned());
            }
            self.keep(u);
            return;
        }
        self.last = None;
        if let Some(mut u) = CredentialUse::of_entry(entry) {
            (u.file, u.end) = (file.to_owned(), end);
            self.last = Some(key_of(&u));
            self.keep(u);
        }
    }

    /// The complete lines `bytes` of transcript `file`, the first starting at byte `start`.
    pub fn lines(&mut self, file: &str, start: u64, bytes: &[u8]) {
        let mut end = start;
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            end += line.len() as u64;
            // Most lines name neither a credential nor a pin: not parsed.
            if !has(line, b"\"credentialId\"") && !has(line, b"\"credential_pin\"") {
                self.last = None;
                continue;
            }
            match serde_json::from_slice::<Value>(line) {
                Ok(entry) => self.entry(&entry, file, end),
                Err(_) => self.last = None,
            }
        }
    }

    fn keep(&mut self, u: CredentialUse) {
        let key = key_of(&u);
        if self.uses.get(&key).is_none_or(|seen| seen.end <= u.end) {
            self.uses.insert(key, u);
        }
    }

    pub fn take(&mut self) -> Vec<CredentialUse> {
        self.last = None;
        std::mem::take(&mut self.uses).into_values().collect()
    }
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// The longest line [`TranscriptTail`] keeps while it waits for its end: an assistant message that
/// names its credential is far shorter; a longer line (a huge tool result, inline media) is skipped
/// to its newline and counted, never held.
pub const LINE_CAP: usize = 4 << 20;

/// Reads one transcript as omp appends to it, for its requests: fed in chunks of any size, it parses
/// complete lines as they come and holds at most one partial line of at most [`LINE_CAP`] bytes.
#[derive(Debug)]
pub struct TranscriptTail {
    /// Bytes fed so far (where the next chunk starts in the transcript).
    offset: u64,
    /// Where the line in progress starts: always right after a newline (a cursor to resume from).
    boundary: u64,
    /// The line in progress, while it fits the cap.
    carry: Vec<u8>,
    /// The line in progress is longer than the cap: dropped up to its newline.
    skipping: bool,
    /// Lines skipped for their length.
    skipped: u64,
    cap: usize,
    collector: Collector,
}

impl Default for TranscriptTail {
    fn default() -> Self {
        TranscriptTail::resume_at(0)
    }
}

impl TranscriptTail {
    /// A tail that goes on at byte `offset` of the transcript, which must start a line (a
    /// [`Self::boundary`] read before).
    pub fn resume_at(offset: u64) -> TranscriptTail {
        TranscriptTail { offset, boundary: offset, carry: Vec::new(), skipping: false, skipped: 0, cap: LINE_CAP, collector: Collector::default() }
    }

    /// Bytes of the transcript fed so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Where the line in progress starts: everything before it is read.
    pub fn boundary(&self) -> u64 {
        self.boundary
    }

    /// Lines skipped because they were longer than [`LINE_CAP`].
    pub fn skipped(&self) -> u64 {
        self.skipped
    }

    /// The next `chunk` of transcript `file` (the bytes from [`Self::offset`] on).
    pub fn ingest(&mut self, file: &str, mut chunk: &[u8]) {
        // The end of the line in progress (carried, or being skipped).
        if self.skipping || !self.carry.is_empty() {
            let Some(nl) = chunk.iter().position(|b| *b == b'\n') else {
                self.offset += chunk.len() as u64;
                self.hold(chunk);
                return;
            };
            let (head, rest) = chunk.split_at(nl + 1);
            self.offset += head.len() as u64;
            if !self.skipping && self.carry.len() + head.len() <= self.cap {
                self.carry.extend_from_slice(head);
                let line = std::mem::take(&mut self.carry);
                self.collector.lines(file, self.boundary, &line);
            } else if !self.skipping {
                self.carry = Vec::new();
                self.skipped += 1;
            }
            self.skipping = false;
            self.boundary = self.offset;
            chunk = rest;
        }
        // Whole lines straight from the chunk; the partial one at its end is held.
        let complete = chunk.iter().rposition(|b| *b == b'\n').map_or(0, |nl| nl + 1);
        if complete > 0 {
            self.collector.lines(file, self.offset, &chunk[..complete]);
            self.offset += complete as u64;
            self.boundary = self.offset;
        }
        let partial = &chunk[complete..];
        self.offset += partial.len() as u64;
        self.hold(partial);
    }

    /// Keeps `bytes` of the line in progress, or starts skipping it once it outgrows the cap.
    fn hold(&mut self, bytes: &[u8]) {
        if self.skipping || bytes.is_empty() {
            return;
        }
        if self.carry.len() + bytes.len() > self.cap {
            self.carry = Vec::new();
            self.skipping = true;
            self.skipped += 1;
        } else {
            self.carry.extend_from_slice(bytes);
        }
    }

    /// The requests read since the last call.
    pub fn take(&mut self) -> Vec<CredentialUse> {
        self.collector.take()
    }
}

/// The model a provider answered that the account has no access to. Anthropic answers a model the
/// account's organization cannot use with HTTP 404 and `{"type":"error","error":{"type":
/// "not_found_error","message":"model: <id>"}}`, which omp keeps as the error text `404 {…}`
/// (omp ≥ 18.20 classifies the same answer as an account-policy error and rotates on it).
pub fn refused_model(error: &str) -> Option<String> {
    let body = error.trim_start().strip_prefix("404")?.trim_start();
    // The JSON object may be followed by omp's notes (`retry-after-ms=…`).
    let v: Value = serde_json::Deserializer::from_str(body).into_iter::<Value>().next()?.ok()?;
    let e = v.get("error")?;
    if s(e, "type")? != "not_found_error" {
        return None;
    }
    let model = s(e, "message")?.strip_prefix("model: ")?.trim();
    (!model.is_empty()).then(|| model.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape omp writes for Anthropic's answer to a model the account cannot use: credential 3
    /// is refused Claude Mythos 5.2 (404), credential 5 answers with it.
    const REFUSED: &str = r#"404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-mythos-5-2"},"request_id":"req_test_0001"}"#;

    fn message(credential: i64, stop: &str, error: Option<&str>) -> Value {
        json!({
            "role": "assistant", "api": "anthropic-messages", "provider": "anthropic", "model": "claude-mythos-5-2",
            "credentialId": credential, "stopReason": stop, "errorMessage": error, "timestamp": 1_790_000_000_000_i64, "content": []
        })
    }

    #[test]
    fn a_refused_model_and_an_answer_name_their_account() {
        assert_eq!(refused_model(REFUSED).as_deref(), Some("claude-mythos-5-2"));
        let denied = CredentialUse::of(&message(3, "error", Some(REFUSED)), None).unwrap();
        assert_eq!((denied.credential_id, denied.denied, denied.model.as_str(), denied.at), (3, true, "claude-mythos-5-2", 1_790_000_000_000));
        let served = CredentialUse::of(&message(5, "toolUse", None), None).unwrap();
        assert!(!served.denied && served.provider == "anthropic");
        let entry = json!({ "type": "message", "timestamp": "2026-09-21T14:13:20.000Z", "message": message(3, "error", Some(REFUSED)) });
        assert_eq!(CredentialUse::of_entry(&entry).map(|c| c.credential_id), Some(3));
    }

    #[test]
    fn other_failures_say_nothing_about_access() {
        let limit = r#"429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} retry-after-ms=60000"#;
        assert_eq!(CredentialUse::of(&message(6, "error", Some(limit)), None), None);
        assert_eq!(CredentialUse::of(&message(6, "aborted", None), None), None);
        // Another model's refusal is not this one's (a fallback answered for it).
        let other = REFUSED.replace("claude-mythos-5-2", "claude-fable-5");
        assert_eq!(CredentialUse::of(&message(3, "error", Some(&other)), None), None);
        assert_eq!(refused_model("404 Not Found"), None);
        assert_eq!(refused_model(r#"404 {"type":"error","error":{"type":"not_found_error","message":"file: x"}}"#), None);
        assert_eq!(refused_model(&REFUSED.replacen("404", "400", 1)), None);
        // No credential (an API key from the environment, an older omp): nothing to learn.
        let mut keyless = message(3, "stop", None);
        keyless.as_object_mut().unwrap().remove("credentialId");
        assert_eq!(CredentialUse::of(&keyless, None), None);
        assert_eq!(CredentialUse::of(&json!({ "role": "user", "credentialId": 1 }), None), None);
    }

    fn line(credential: i64) -> String {
        let entry = json!({ "type": "message", "timestamp": "2026-09-21T14:13:20.000Z", "message": message(credential, "toolUse", None) });
        format!("{entry}\n")
    }

    #[test]
    fn a_line_split_between_chunks_is_read_once_where_it_ends() {
        let text = format!("{}{}", line(3), line(5));
        let cut = text.len() / 3;
        let mut tail = TranscriptTail::default();
        tail.ingest("", &text.as_bytes()[..cut]);
        assert!(tail.take().is_empty(), "nothing complete yet");
        assert_eq!(tail.boundary(), 0);
        tail.ingest("", &text.as_bytes()[cut..]);
        let mut got = tail.take();
        got.sort_by_key(|u| u.credential_id);
        assert_eq!(got.iter().map(|u| (u.credential_id, u.end)).collect::<Vec<_>>(), vec![(3, line(3).len() as u64), (5, text.len() as u64)]);
        assert_eq!((tail.offset(), tail.boundary()), (text.len() as u64, text.len() as u64));
    }

    #[test]
    fn an_oversized_line_is_skipped_and_counted_and_the_next_one_read() {
        let mut tail = TranscriptTail { cap: 64, ..TranscriptTail::default() };
        let huge = format!("{{\"type\":\"message\",\"credentialId\":9,\"pad\":\"{}\"}}\n", "x".repeat(500));
        let text = format!("{huge}{}", line(3));
        // Fed in small chunks: the carry never outgrows the cap.
        for chunk in text.as_bytes().chunks(17) {
            tail.ingest("", chunk);
            assert!(tail.carry.len() <= 64, "carry {} over the cap", tail.carry.len());
        }
        assert_eq!(tail.skipped(), 2, "the oversized line, and the message line over this tiny cap");
        let mut small = TranscriptTail { cap: 1 << 12, ..TranscriptTail::default() };
        for chunk in text.as_bytes().chunks(17) {
            small.ingest("", chunk);
            assert!(small.carry.len() <= 1 << 12);
        }
        let got = small.take();
        assert_eq!((small.skipped(), got.len()), (0, 1), "a cap above both lines skips none");
        let mut capped = TranscriptTail { cap: 300, ..TranscriptTail::default() };
        for chunk in text.as_bytes().chunks(17) {
            capped.ingest("", chunk);
        }
        let got = capped.take();
        assert_eq!(capped.skipped(), 1, "only the oversized line");
        assert_eq!(got.iter().map(|u| (u.credential_id, u.end)).collect::<Vec<_>>(), vec![(3, text.len() as u64)], "the next line is read");
        assert_eq!(capped.boundary(), text.len() as u64, "and the cursor ends after it");
        // Resuming at that cursor reads only what comes after.
        let mut resumed = TranscriptTail::resume_at(capped.boundary());
        resumed.ingest("", line(5).as_bytes());
        assert_eq!(resumed.take()[0].end, (text.len() + line(5).len()) as u64);
    }
}

