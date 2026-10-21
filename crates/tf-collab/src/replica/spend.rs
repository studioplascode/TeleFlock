//! Session spend and throughput beyond the main agent's own turns.
//!
//! omp's status line bills a session as `own (+subagents) + advisor`
//! (`pi-tui/status-line/segments.ts` `costSummary`):
//! * **own**: the main session's assistant `usage.cost.total` plus `model_usage` side calls,
//!   minus completed task results (`SessionManager` usage index);
//! * **subagents**: `max(subagent tree, completed task results)`. The tree is every subagent
//!   transcript under the session's artifacts dir, nested subagents and their advisors included
//!   (`sumSubagentTreeCost`); task results are `toolResult(task).details.usage`;
//! * **advisor**: the `__advisor*.jsonl` transcripts at the top of the artifacts dir
//!   (`getAdvisorCost` / `loadAdvisorTranscriptCosts`).
//!
//! Collab mirrors only the main transcript (assistant turns, task results) and the subagents'
//! `progress.cost`; it never mirrors advisors, and `model_usage` entries only reach the replica
//! through the journal. tf-hostd runs next to omp and tails the artifacts dir through
//! [`ArtifactLedger`]; the replica folds everything into one `CostInfo` so every client agrees.
//!
//! **Throughput.** The main agent's rate comes from its streamed deltas. Subagents and advisors
//! stream nowhere a guest can see, so each of their finished replies is replayed at its real
//! decode rate (`usage.output` over `duration − ttft`) from the moment tf-hostd reads it:
//! the area under the sparkline is exact, its timing one reply late.

use std::collections::HashMap;

use serde_json::Value;
use tf_proto::Millis;

use super::util::{f, s, u};

/// Replies that finished longer ago than this are history, not throughput.
const PLAYBACK_MAX_AGE_MS: i64 = 60_000;
const PLAYBACK_MIN_MS: i64 = 250;
const PLAYBACK_MAX_MS: i64 = 120_000;

/// Accumulated omp `Usage` (cost in USD, token counts).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Spend {
    pub usd: f64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Spend {
    /// Adds one omp `Usage` record (`{input, output, cacheRead, cacheWrite, cost: {total}}`).
    pub fn add_usage(&mut self, usage: &Value) {
        self.input += u(usage, "input").unwrap_or(0);
        self.output += u(usage, "output").unwrap_or(0);
        self.cache_read += u(usage, "cacheRead").unwrap_or(0);
        self.cache_write += u(usage, "cacheWrite").unwrap_or(0);
        let usd = usage.get("cost").and_then(|c| f(c, "total")).unwrap_or(0.0);
        if usd.is_finite() {
            self.usd += usd;
        }
    }

    pub fn add(&mut self, o: &Spend) {
        self.usd += o.usd;
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
    }

    pub fn is_empty(&self) -> bool {
        *self == Spend::default()
    }
}

/// Who a transcript under the session's artifacts dir bills to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactKind {
    /// `__advisor.jsonl` / `__advisor.<slug>.jsonl` at the top level: the main session's advisor.
    Advisor,
    /// Any other session transcript: a subagent (`<Id>.jsonl`, nested `<Id>/<Id>.<Child>.jsonl`)
    /// or a subagent's advisor (`<Id>/__advisor.jsonl`), all part of omp's subagent tree.
    Subagent,
}

impl ArtifactKind {
    /// Classifies `rel`, a `/`-separated path relative to the artifacts dir; `None` for non-transcripts.
    pub fn of(rel: &str) -> Option<ArtifactKind> {
        let name = rel.strip_suffix(".jsonl")?;
        let (dir, stem) = name.rsplit_once('/').unwrap_or(("", name));
        let advisor = stem == "__advisor" || stem.starts_with("__advisor.");
        Some(if advisor && dir.is_empty() { ArtifactKind::Advisor } else { ArtifactKind::Subagent })
    }
}

/// One billed model call read from an artifact transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactCall {
    pub kind: ArtifactKind,
    pub spend: Spend,
    /// When the reply finished streaming (`timestamp + duration`); `None` for side calls.
    pub ended_at: Option<Millis>,
    /// How long its output streamed (`duration − ttft`).
    pub decode_ms: Option<i64>,
}

impl ArtifactCall {
    /// An artifact transcript line → the call it bills, if any. Advisors bill assistant turns only
    /// (omp `loadAdvisorTranscriptCosts`); subagents also bill `model_usage` side calls
    /// (`directCost`). Task results are skipped: the child's own transcript bills that work.
    pub fn parse(kind: ArtifactKind, entry: &Value) -> Option<ArtifactCall> {
        match s(entry, "type")? {
            "message" => {
                let msg = entry.get("message")?;
                if s(msg, "role")? != "assistant" {
                    return None;
                }
                let mut spend = Spend::default();
                spend.add_usage(msg.get("usage")?);
                let start = msg.get("timestamp").and_then(Value::as_f64);
                let duration = f(msg, "duration").filter(|d| d.is_finite() && *d > 0.0);
                let ttft = f(msg, "ttft").filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(0.0);
                let ended_at = start.zip(duration).map(|(t, d)| (t + d) as Millis);
                let decode_ms = duration.map(|d| (if ttft < d { d - ttft } else { d }) as i64);
                Some(ArtifactCall { kind, spend, ended_at, decode_ms })
            }
            "model_usage" if kind == ArtifactKind::Subagent => {
                let mut spend = Spend::default();
                spend.add_usage(entry.get("usage")?);
                Some(ArtifactCall { kind, spend, ended_at: None, decode_ms: None })
            }
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
struct FileTail {
    offset: u64,
    /// Bytes after the last newline (a line still being written).
    carry: Vec<u8>,
    /// First line was a session header (`type: session`); `None` until it is complete.
    header: Option<bool>,
}

/// Incremental reader of one session's artifact transcripts. The caller (tf-hostd) owns the
/// filesystem: it reads the bytes appended past [`Self::offset`] and feeds them to [`Self::ingest`].
#[derive(Debug, Default)]
pub struct ArtifactLedger {
    files: HashMap<String, FileTail>,
    advisor: Spend,
    subagents: Spend,
}

impl ArtifactLedger {
    /// Bytes of `rel` consumed so far.
    pub fn offset(&self, rel: &str) -> u64 {
        self.files.get(rel).map_or(0, |t| t.offset)
    }

    /// Feeds the bytes appended to `rel` since [`Self::offset`]; returns the calls whose lines
    /// completed. Files that do not start with a session header are ignored.
    pub fn ingest(&mut self, rel: &str, chunk: &[u8]) -> Vec<ArtifactCall> {
        let Some(kind) = ArtifactKind::of(rel) else { return Vec::new() };
        let tail = self.files.entry(rel.to_owned()).or_default();
        tail.offset += chunk.len() as u64;
        tail.carry.extend_from_slice(chunk);
        let Some(last_nl) = tail.carry.iter().rposition(|b| *b == b'\n') else { return Vec::new() };
        let rest = tail.carry.split_off(last_nl + 1);
        let complete = std::mem::replace(&mut tail.carry, rest);
        let mut calls = Vec::new();
        for line in complete.split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)) {
            let Ok(entry) = serde_json::from_slice::<Value>(line) else { continue };
            match tail.header {
                None => {
                    // omp writes a fixed-size `title` slot line ahead of the session header.
                    if s(&entry, "type") != Some("title") {
                        tail.header = Some(s(&entry, "type") == Some("session"));
                    }
                    continue;
                }
                Some(false) => break,
                Some(true) => {}
            }
            if let Some(call) = ArtifactCall::parse(kind, &entry) {
                calls.push(call);
            }
        }
        for c in &calls {
            match c.kind {
                ArtifactKind::Advisor => self.advisor.add(&c.spend),
                ArtifactKind::Subagent => self.subagents.add(&c.spend),
            }
        }
        calls
    }

    pub fn advisor(&self) -> Spend {
        self.advisor
    }

    pub fn subagents(&self) -> Spend {
        self.subagents
    }
}

/// A finished subagent/advisor reply replayed at its decode rate.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Playback {
    pub kind: ArtifactKind,
    pub start: Millis,
    pub end: Millis,
    /// Output tokens per second.
    pub rate: f32,
}

impl Playback {
    /// `None` for side calls, empty replies and replies that ended over a minute before `now`.
    pub fn of(call: &ArtifactCall, now: Millis) -> Option<Playback> {
        let ended_at = call.ended_at?;
        if call.spend.output == 0 || now - ended_at > PLAYBACK_MAX_AGE_MS {
            return None;
        }
        let ms = call.decode_ms?.clamp(PLAYBACK_MIN_MS, PLAYBACK_MAX_MS);
        Some(Playback { kind: call.kind, start: now, end: now + ms, rate: call.spend.output as f32 * 1000.0 / ms as f32 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kinds() {
        assert_eq!(ArtifactKind::of("__advisor.jsonl"), Some(ArtifactKind::Advisor));
        assert_eq!(ArtifactKind::of("__advisor.default.jsonl"), Some(ArtifactKind::Advisor));
        assert_eq!(ArtifactKind::of("Scout.jsonl"), Some(ArtifactKind::Subagent));
        assert_eq!(ArtifactKind::of("Scout/Scout.Child.jsonl"), Some(ArtifactKind::Subagent));
        // A subagent's own advisor belongs to the subagent tree.
        assert_eq!(ArtifactKind::of("Scout/__advisor.jsonl"), Some(ArtifactKind::Subagent));
        assert_eq!(ArtifactKind::of("12.bash.log"), None);
    }

    fn line(v: Value) -> Vec<u8> {
        let mut b = serde_json::to_vec(&v).unwrap();
        b.push(b'\n');
        b
    }

    fn assistant(cost: f64, output: u64, ts: i64, duration: f64, ttft: f64) -> Value {
        json!({"type": "message", "id": "x", "message": {"role": "assistant", "timestamp": ts, "duration": duration, "ttft": ttft,
            "usage": {"input": 100, "output": output, "cacheRead": 10, "cacheWrite": 0, "cost": {"total": cost}}}})
    }

    #[test]
    fn ledger_tails_split_lines_and_skips_non_sessions() {
        let mut l = ArtifactLedger::default();
        let mut bytes = line(json!({"type": "session", "id": "s"}));
        bytes.extend(line(assistant(0.25, 40, 1_000, 3_000.0, 1_000.0)));
        bytes.extend(line(json!({"type": "message", "message": {"role": "toolResult", "toolName": "task",
            "details": {"usage": {"output": 999, "cost": {"total": 9.0}}}}})));
        bytes.extend(line(json!({"type": "model_usage", "usage": {"output": 2, "cost": {"total": 0.01}}})));
        let (a, b) = bytes.split_at(70);
        assert!(l.ingest("Scout.jsonl", a).is_empty());
        let calls = l.ingest("Scout.jsonl", b);
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(calls[0].ended_at, Some(4_000));
        assert_eq!(calls[0].decode_ms, Some(2_000));
        assert!((l.subagents().usd - 0.26).abs() < 1e-9);
        assert_eq!(l.subagents().output, 42);
        assert_eq!(l.offset("Scout.jsonl"), bytes.len() as u64);

        // Advisors bill assistant turns only.
        let mut adv = line(json!({"type": "session", "id": "a"}));
        adv.extend(line(assistant(0.5, 10, 0, 1_000.0, 0.0)));
        adv.extend(line(json!({"type": "model_usage", "usage": {"output": 2, "cost": {"total": 0.01}}})));
        l.ingest("__advisor.default.jsonl", &adv);
        assert!((l.advisor().usd - 0.5).abs() < 1e-9);

        // Not a session transcript.
        let junk = line(assistant(7.0, 1, 0, 1.0, 0.0));
        assert!(l.ingest("other.jsonl", &[junk.clone(), junk].concat()).is_empty());
        assert!((l.subagents().usd - 0.26).abs() < 1e-9);
    }

    #[test]
    fn playback_replays_recent_replies_only() {
        let call = ArtifactCall {
            kind: ArtifactKind::Advisor,
            spend: Spend { output: 100, ..Spend::default() },
            ended_at: Some(10_000),
            decode_ms: Some(2_000),
        };
        let p = Playback::of(&call, 11_000).unwrap();
        assert_eq!((p.start, p.end), (11_000, 13_000));
        assert!((p.rate - 50.0).abs() < 1e-3);
        assert!(Playback::of(&call, 10_000 + PLAYBACK_MAX_AGE_MS + 1).is_none());
        assert!(Playback::of(&ArtifactCall { ended_at: None, ..call.clone() }, 11_000).is_none());
    }
}
