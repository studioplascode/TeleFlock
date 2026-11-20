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
//! **Stable sums.** Costs are floats: adding the same calls in another order can change the
//! last digit. A total is therefore always added up the same way (each transcript's calls in
//! file order, the transcripts in path order; the live `progress.cost` of subagents by agent id),
//! so a session built live and the same session rebuilt after a tf-hostd restart bill the same
//! amount, bit for bit, and clients see no change.
//!
//! **Throughput.** The main agent's rate comes from its streamed deltas. Subagents and advisors
//! stream nowhere a guest can see, so each of their finished replies is replayed at its real
//! decode rate (`usage.output` over `duration − ttft`) from the moment tf-hostd reads it:
//! the area under the sparkline is exact, its timing one reply late.
//!
//! **By model.** Each spender's figure is also split by the model that served it ([`ByModel`],
//! `CostSplit.models` / `TpsSplit.models`). Assistant turns and `model_usage` calls name theirs
//! (`model`, `provider`); a subagent's progress and its `task` result name the one it ran on
//! (`resolvedModelIdentity`). The subagents' split comes from the source that won the `max` (the
//! next one with a split when it has none), scaled to the figure. Throughput goes to the replayed
//! reply's model and, for the main agent, to the model of the message it streams. Each model's
//! part is added up like the totals (calls in file order, transcripts in path order, the main
//! session's turns and its journal's side calls apart), so a rebuilt replica splits the same way.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use tf_proto::{Millis, ModelShare, PresentedArtifact, Spender};

use super::access::{Collector, CredentialUse};
use super::subagents::{self, Outcome, TailTurn};
use super::util::{b, f, non_empty, s, u};

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
    /// One omp `Usage` record (`{input, output, cacheRead, cacheWrite, cost: {total}}`).
    pub fn of_usage(usage: &Value) -> Spend {
        let mut spend = Spend::default();
        spend.add_usage(usage);
        spend
    }

    /// Adds one omp `Usage` record.
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

/// The model that served a call, as omp names it: its id (`claude-opus-4-5`) and provider.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ModelKey {
    pub model: String,
    pub provider: Option<String>,
}

impl ModelKey {
    /// An assistant message's or a `model_usage` entry's `model` and `provider`.
    pub(super) fn of_call(v: &Value) -> Option<ModelKey> {
        let model = non_empty(v, "model")?;
        Some(ModelKey { model: model.to_owned(), provider: non_empty(v, "provider").map(str::to_owned) })
    }

    /// omp's session model (`state.model`: `{provider, id}`).
    pub(super) fn of_session(v: &Value) -> Option<ModelKey> {
        let id = non_empty(v, "id")?;
        Some(ModelKey { model: id.to_owned(), provider: non_empty(v, "provider").map(str::to_owned) })
    }

    /// The model a subagent ran on, as its progress and its `task` result name it:
    /// `resolvedModelIdentity` (`openai-codex/gpt-6-luna`), else `resolvedModel` without the
    /// thinking level omp appends to it (`openai-codex/gpt-6-luna:low`).
    pub(super) fn of_subagent(v: &Value) -> Option<ModelKey> {
        if let Some(identity) = non_empty(v, "resolvedModelIdentity") {
            return Some(ModelKey::parse(identity));
        }
        let selector = non_empty(v, "resolvedModel")?;
        let identity = match selector.rsplit_once(':') {
            Some((identity, level)) if super::parse_thinking(level).is_some() => identity,
            _ => selector,
        };
        Some(ModelKey::parse(identity))
    }

    /// `provider/model` (the model id may hold more `/`: `openrouter/qwen/qwen3`), or a bare id.
    fn parse(identity: &str) -> ModelKey {
        match identity.split_once('/') {
            Some((provider, model)) if !provider.is_empty() && !model.is_empty() => {
                ModelKey { model: model.to_owned(), provider: Some(provider.to_owned()) }
            }
            _ => ModelKey { model: identity.to_owned(), provider: None },
        }
    }
}

/// One figure (USD, output tok/s) by model. Each model's part is added up in the order its
/// calls come, like the totals (see "Stable sums").
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct ByModel(BTreeMap<ModelKey, f64>);

impl ByModel {
    /// Adds `value` to `model`'s part. A call that names no model, and a value that is not a
    /// positive number, add nothing.
    pub fn add(&mut self, model: Option<&ModelKey>, value: f64) {
        if let Some(model) = model.filter(|_| value > 0.0 && value.is_finite()) {
            *self.0.entry(model.clone()).or_default() += value;
        }
    }

    /// Adds `other`'s parts, model by model.
    pub fn merge(&mut self, other: &ByModel) {
        for (model, value) in &other.0 {
            *self.0.entry(model.clone()).or_default() += value;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `spender`'s `figure` in the proportions of these parts, the largest first (equal ones by
    /// model); empty while no part is known. The shares add up to the figure also where the parts
    /// fall short of it (calls that named no model, a subagent figure another source won): what
    /// no model claims is spread over the known ones.
    pub fn shares(&self, spender: Spender, figure: f64) -> Vec<ModelShare> {
        let known: f64 = self.0.values().sum();
        if !(figure > 0.0 && known > 0.0) {
            return Vec::new();
        }
        let scale = figure / known;
        let mut shares: Vec<ModelShare> = self
            .0
            .iter()
            .map(|(k, v)| ModelShare { spender, model: k.model.clone(), provider: k.provider.clone(), value: v * scale })
            .collect();
        // Stable: equal shares stay in model order.
        shares.sort_by(|a, b| b.value.total_cmp(&a.value));
        shares
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
    /// The model that served it (`model`, `provider`), when the line names one.
    pub model: Option<ModelKey>,
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
                let spend = Spend::of_usage(msg.get("usage")?);
                let start = msg.get("timestamp").and_then(Value::as_f64);
                let duration = f(msg, "duration").filter(|d| d.is_finite() && *d > 0.0);
                let ttft = f(msg, "ttft").filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(0.0);
                let ended_at = start.zip(duration).map(|(t, d)| (t + d) as Millis);
                let decode_ms = duration.map(|d| (if ttft < d { d - ttft } else { d }) as i64);
                Some(ArtifactCall { kind, spend, ended_at, decode_ms, model: ModelKey::of_call(msg) })
            }
            "model_usage" if kind == ArtifactKind::Subagent => {
                let spend = Spend::of_usage(entry.get("usage")?);
                Some(ArtifactCall { kind, spend, ended_at: None, decode_ms: None, model: ModelKey::of_call(entry) })
            }
            _ => None,
        }
    }
}

#[derive(Debug)]
struct FileTail {
    kind: ArtifactKind,
    offset: u64,
    /// Bytes after the last newline (a line still being written).
    carry: Vec<u8>,
    /// First line was a session header (`type: session`); `None` until it is complete.
    header: Option<bool>,
    /// What the transcript's calls billed, added up in file order.
    spend: Spend,
    /// The same by model.
    models: ByModel,
    /// How its subagents' runs ended, as its records say (a parent's transcript records the end
    /// of the children it started); a later record of an agent replaces an earlier one.
    outcomes: BTreeMap<String, Outcome>,
    /// Where the transcript's last turn stands (cut off by a dying process or not).
    turn: TailTurn,
}

impl FileTail {
    fn new(kind: ArtifactKind) -> FileTail {
        FileTail {
            kind,
            offset: 0,
            carry: Vec::new(),
            header: None,
            spend: Spend::default(),
            models: ByModel::default(),
            outcomes: BTreeMap::new(),
            turn: TailTurn::default(),
        }
    }
}

/// Incremental reader of one session's artifact transcripts. The caller (tf-hostd) owns the
/// filesystem: it reads the bytes appended past [`Self::offset`] and feeds them to [`Self::ingest`].
/// Its totals do not depend on the order the bytes arrive in (see "Stable sums" above): while
/// omp writes, a scan reads a few lines of several transcripts; after a tf-hostd restart, one
/// scan reads every transcript whole, in whatever order the directory lists them.
#[derive(Debug, Default)]
pub struct ArtifactLedger {
    /// By path relative to the artifacts dir.
    files: BTreeMap<String, FileTail>,
    /// Past its first scan ([`Self::go_live`]): what the transcripts gain from now on is new.
    live: bool,
    /// Documents the transcripts' `present` calls showed since the ledger went live.
    presented: Vec<PresentedArtifact>,
    /// The newest request per credential, model and outcome the transcripts recorded since
    /// [`Self::take_credentials`] (history too: what an account served before is still news).
    credentials: Collector,
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
        let tail = self.files.entry(rel.to_owned()).or_insert_with(|| FileTail::new(kind));
        let start = tail.offset - tail.carry.len() as u64;
        tail.offset += chunk.len() as u64;
        // Only the new bytes can end the line in progress: fed a long line chunk by chunk, the
        // carry is not searched again each time.
        let Some(last_nl) = chunk.iter().rposition(|b| *b == b'\n') else {
            tail.carry.extend_from_slice(chunk);
            return Vec::new();
        };
        let mut complete = std::mem::take(&mut tail.carry);
        complete.extend_from_slice(&chunk[..=last_nl]);
        tail.carry = chunk[last_nl + 1..].to_vec();
        let mut calls = Vec::new();
        let mut end = start;
        for line in complete.split_inclusive(|b| *b == b'\n') {
            end += line.len() as u64;
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
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
                tail.spend.add(&call.spend);
                tail.models.add(call.model.as_ref(), call.spend.usd);
                calls.push(call);
            }
            if self.live
                && let Some(m) = entry.get("message").filter(|m| s(m, "role") == Some("toolResult") && !b(m, "isError"))
                && let Some(a) = super::tools::presented(s(m, "toolName").unwrap_or(""), m.get("details"))
            {
                self.presented.push(a);
            }
            self.credentials.entry(&entry, rel, end);
            let (details, tool) = match s(&entry, "type") {
                Some("custom_message") => (entry.get("details"), ""),
                Some("message") => entry.get("message").map_or((None, ""), |m| (m.get("details"), s(m, "toolName").unwrap_or(""))),
                _ => (None, ""),
            };
            for (id, outcome) in details.map(|d| subagents::recorded(d, tool)).unwrap_or_default() {
                tail.outcomes.insert(id, outcome);
            }
            tail.turn.note(&entry);
        }
        calls
    }

    /// From now on, the documents a subagent (or advisor) presents are kept for
    /// [`Self::take_presented`]. tf-hostd calls it after each scan, so what the transcripts held
    /// before the ledger's first scan (a tf-hostd restart, a rewritten transcript read again from
    /// the start) is never reported as presented now.
    pub fn go_live(&mut self) {
        self.live = true;
    }

    /// The documents presented since the last call, oldest first.
    pub fn take_presented(&mut self) -> Vec<PresentedArtifact> {
        std::mem::take(&mut self.presented)
    }

    /// The requests the transcripts recorded since the last call: per credential, model and
    /// outcome (answered or refused), the newest.
    pub fn take_credentials(&mut self) -> Vec<CredentialUse> {
        self.credentials.take()
    }

    /// How the subagents' runs ended, as the transcripts record it: each transcript's records in
    /// file order, the transcripts in path order, so the result does not depend on when bytes arrive.
    pub(super) fn outcomes(&self) -> BTreeMap<String, Outcome> {
        let mut all = BTreeMap::new();
        for t in self.files.values() {
            all.extend(t.outcomes.iter().map(|(id, o)| (id.clone(), *o)));
        }
        all
    }

    /// The subagents whose own transcript ends mid-turn: omp's process died under them.
    pub(super) fn interrupted(&self) -> BTreeSet<String> {
        self.files
            .iter()
            .filter(|(_, t)| t.kind == ArtifactKind::Subagent && t.turn.cut_off())
            .filter_map(|(rel, _)| rel.rsplit('/').next()?.strip_suffix(".jsonl"))
            .filter(|id| !id.starts_with("__advisor"))
            .map(str::to_owned)
            .collect()
    }

    pub fn advisor(&self) -> Spend {
        self.total(ArtifactKind::Advisor)
    }

    pub fn subagents(&self) -> Spend {
        self.total(ArtifactKind::Subagent)
    }

    /// Each transcript's spend of `kind`, added up in path order.
    fn total(&self, kind: ArtifactKind) -> Spend {
        let mut sum = Spend::default();
        for t in self.files.values().filter(|t| t.kind == kind) {
            sum.add(&t.spend);
        }
        sum
    }

    /// [`Self::advisor`] or [`Self::subagents`] by model: each transcript's parts, added up in
    /// path order.
    pub(super) fn models(&self, kind: ArtifactKind) -> ByModel {
        let mut all = ByModel::default();
        for t in self.files.values().filter(|t| t.kind == kind) {
            all.merge(&t.models);
        }
        all
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
    pub model: Option<ModelKey>,
}

impl Playback {
    /// `None` for side calls, empty replies and replies that ended over a minute before `now`.
    pub fn of(call: &ArtifactCall, now: Millis) -> Option<Playback> {
        let ended_at = call.ended_at?;
        if call.spend.output == 0 || now - ended_at > PLAYBACK_MAX_AGE_MS {
            return None;
        }
        let ms = call.decode_ms?.clamp(PLAYBACK_MIN_MS, PLAYBACK_MAX_MS);
        Some(Playback { kind: call.kind, start: now, end: now + ms, rate: call.spend.output as f32 * 1000.0 / ms as f32, model: call.model.clone() })
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

    /// `entry` (an assistant message line or a `model_usage` entry) as served by `identity` (`provider/model`).
    fn served(mut entry: Value, identity: &str) -> Value {
        let (provider, model) = identity.split_once('/').unwrap();
        let call = if entry["type"] == "message" { &mut entry["message"] } else { &mut entry };
        call["provider"] = provider.into();
        call["model"] = model.into();
        entry
    }

    fn key(identity: &str) -> ModelKey {
        ModelKey::parse(identity)
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

    /// The totals are the same, bit for bit, however the lines arrive: while omp writes, a scan
    /// reads a reply of one transcript, then of another; after a tf-hostd restart one scan reads
    /// each transcript whole, in the order the directory lists them. Added up as they arrived,
    /// these costs (real subagent replies) differ in the last digit between the two, the total
    /// and the part of the model two of the transcripts share alike.
    #[test]
    fn totals_do_not_depend_on_the_order_lines_arrive() {
        let header = line(json!({"type": "session", "id": "s"}));
        let files: [(&str, &str, [f64; 2]); 3] = [
            ("Scout.jsonl", "anthropic/claude-sonnet-5", [2.8100000000000002e-05, 0.0007311]),
            ("Probe.jsonl", "openai-codex/gpt-6-luna", [2.82e-05, 0.00010804]),
            ("Scout/Scout.Helper.jsonl", "anthropic/claude-sonnet-5", [0.0006979000000000001, 3e-05]),
        ];
        let reply = |usd: f64, model: &str| line(served(assistant(usd, 1, 0, 1_000.0, 0.0), model));
        let mut live = ArtifactLedger::default();
        for (rel, ..) in &files {
            live.ingest(rel, &header);
        }
        for i in 0..2 {
            for (rel, model, costs) in &files {
                live.ingest(rel, &reply(costs[i], model));
            }
        }
        let mut rebuilt = ArtifactLedger::default();
        for (rel, model, costs) in files.iter().rev() {
            rebuilt.ingest(rel, &[header.clone(), reply(costs[0], model), reply(costs[1], model)].concat());
        }
        assert_eq!(live.subagents().usd.to_bits(), rebuilt.subagents().usd.to_bits(), "{} vs {}", live.subagents().usd, rebuilt.subagents().usd);
        assert_eq!(live.subagents(), rebuilt.subagents());
        let sum: f64 = files.iter().flat_map(|(.., c)| c).sum();
        assert!((live.subagents().usd - sum).abs() < 1e-15);

        let (by_model, again) = (live.models(ArtifactKind::Subagent), rebuilt.models(ArtifactKind::Subagent));
        assert_eq!(by_model, again);
        let sonnet = by_model.0[&key("anthropic/claude-sonnet-5")];
        let as_they_came: f64 = 2.8100000000000002e-05 + 0.0006979000000000001 + 0.0007311 + 3e-05;
        assert_ne!(sonnet.to_bits(), as_they_came.to_bits(), "the costs tell the two orders apart");
        assert_eq!(sonnet.to_bits(), ((2.8100000000000002e-05 + 0.0007311) + (0.0006979000000000001 + 3e-05_f64)).to_bits(), "transcripts in path order");
        assert_eq!(by_model.0[&key("openai-codex/gpt-6-luna")], 2.82e-05 + 0.00010804);
        assert!(live.models(ArtifactKind::Advisor).is_empty());
    }

    #[test]
    fn model_keys() {
        let call = json!({"type": "model_usage", "provider": "openai-codex", "model": "gpt-6-luna", "usage": {}});
        assert_eq!(ModelKey::of_call(&call), Some(key("openai-codex/gpt-6-luna")));
        assert_eq!(ModelKey::of_call(&json!({"model": " ", "provider": "x"})), None);
        assert_eq!(ModelKey::of_session(&json!({"provider": "anthropic", "id": "claude-opus-5", "name": "Opus 5"})), Some(key("anthropic/claude-opus-5")));
        // A subagent: omp's identity, else the selector it resolved without the thinking level.
        let both = json!({"resolvedModelIdentity": "openai-codex/gpt-6-luna", "resolvedModel": "openai-codex/gpt-6-luna:low"});
        assert_eq!(ModelKey::of_subagent(&both), Some(key("openai-codex/gpt-6-luna")));
        assert_eq!(ModelKey::of_subagent(&json!({"resolvedModel": "anthropic/claude-sonnet-5:high"})), Some(key("anthropic/claude-sonnet-5")));
        // A `:` that names no thinking level belongs to the id, and so does every `/` after the provider.
        let routed = ModelKey::of_subagent(&json!({"resolvedModel": "openrouter/qwen/qwen3-coder:free"})).unwrap();
        assert_eq!((routed.model.as_str(), routed.provider.as_deref()), ("qwen/qwen3-coder:free", Some("openrouter")));
        assert_eq!(ModelKey::of_subagent(&json!({"resolvedModel": "gpt-5.5"})), Some(ModelKey { model: "gpt-5.5".into(), provider: None }));
        assert_eq!(ModelKey::of_subagent(&json!({"modelRole": "task"})), None, "not resolved yet");
    }

    #[test]
    fn shares_add_up_to_the_figure_largest_first() {
        let (opus, sonnet, luna) = (key("anthropic/claude-opus-5"), key("anthropic/claude-sonnet-5"), key("openai-codex/gpt-6-luna"));
        let mut m = ByModel::default();
        m.add(Some(&luna), 0.25);
        m.add(Some(&sonnet), 0.75);
        m.add(Some(&opus), 0.5);
        m.add(Some(&luna), 0.25);
        m.add(None, 9.0);
        m.add(Some(&opus), f64::NAN);
        m.add(Some(&opus), -1.0);
        let shares = m.shares(Spender::Main, 1.75);
        let parts: Vec<(&str, Option<&str>, f64)> = shares.iter().map(|s| (s.model.as_str(), s.provider.as_deref(), s.value)).collect();
        assert_eq!(
            parts,
            [("claude-sonnet-5", Some("anthropic"), 0.75), ("claude-opus-5", Some("anthropic"), 0.5), ("gpt-6-luna", Some("openai-codex"), 0.5)],
            "the largest first, equal ones by model; calls without a model and non-amounts add nothing"
        );
        assert!(shares.iter().all(|s| s.spender == Spender::Main));
        // A figure the parts fall short of (calls that named no model, another source's subagent
        // total) is spread over the models in proportion.
        let shares = m.shares(Spender::Subagents, 3.5);
        assert_eq!(shares.iter().map(|s| s.value).collect::<Vec<_>>(), [1.5, 1.0, 1.0]);
        assert!(m.shares(Spender::Main, 0.0).is_empty());
        assert!(ByModel::default().shares(Spender::Main, 1.0).is_empty(), "no model known: no split");
    }

    /// A subagent's `present` results are the session's presented documents, but only those its
    /// transcript gains once the ledger is live: what a restart reads again was shown before.
    #[test]
    fn presented_documents_count_from_the_first_scan_on() {
        let present = |call: &str, version: u32, error: bool| {
            line(json!({"type": "message", "id": call, "message": {"role": "toolResult", "toolCallId": call, "toolName": "present", "isError": error,
                "content": [{"type": "text", "text": "Presented"}],
                "details": {"title": "Q3 report", "kind": "html", "name": format!("presented/q3-report-v{version}.html"), "slug": "q3-report", "version": version, "size": 10, "assets": 0}}}))
        };
        let mut l = ArtifactLedger::default();
        l.ingest("Scout.jsonl", &[line(json!({"type": "session", "id": "s"})), present("c1", 1, false)].concat());
        assert!(l.take_presented().is_empty(), "read before the ledger went live: history");
        l.go_live();
        l.ingest("Scout.jsonl", &[present("c2", 2, false), present("c3", 3, true)].concat());
        // A nested subagent's transcript that appears later is new from its first line.
        l.ingest("Scout/Scout.Probe.jsonl", &[line(json!({"type": "session", "id": "p"})), present("c4", 3, false)].concat());
        let shown: Vec<(String, u32)> = l.take_presented().into_iter().map(|a| (a.name, a.version)).collect();
        assert_eq!(shown, [("presented/q3-report-v2.html".to_string(), 2), ("presented/q3-report-v3.html".to_string(), 3)], "a failed call shows nothing");
        assert!(l.take_presented().is_empty());
        // Another tool's result is no document.
        l.ingest("Scout.jsonl", &line(json!({"type": "message", "message": {"role": "toolResult", "toolName": "write", "details": {"name": "presented/x-v1.md", "slug": "x", "version": 1}}})));
        assert!(l.take_presented().is_empty());
    }

    #[test]
    fn playback_replays_recent_replies_only() {
        let call = ArtifactCall {
            kind: ArtifactKind::Advisor,
            spend: Spend { output: 100, ..Spend::default() },
            ended_at: Some(10_000),
            decode_ms: Some(2_000),
            model: Some(key("openai/gpt-5.5")),
        };
        let p = Playback::of(&call, 11_000).unwrap();
        assert_eq!((p.start, p.end), (11_000, 13_000));
        assert!((p.rate - 50.0).abs() < 1e-3);
        assert_eq!(p.model, call.model);
        assert!(Playback::of(&call, 10_000 + PLAYBACK_MAX_AGE_MS + 1).is_none());
        assert!(Playback::of(&ArtifactCall { ended_at: None, ..call.clone() }, 11_000).is_none());
    }

    mod replica {
        use serde_json::{Value, json};
        use tf_proto::{CostSplit, ModelShare, Spender};

        use super::{assistant, line, served};
        use crate::frame::{HostFrame, Welcome};
        use crate::guest::{GuestEvent, Snapshot};
        use crate::replica::{ArtifactLedger, Replica};

        const NOW: i64 = 1_792_000_000_000;

        fn snapshot(state: Value, entries: Vec<Value>) -> GuestEvent {
            let welcome: Welcome = serde_json::from_value(json!({
                "proto": 1, "header": { "id": "s1", "timestamp": "2026-10-21T17:00:00.000Z", "cwd": "/w" }, "state": state,
                "agents": [], "entryCount": entries.len(),
            }))
            .unwrap();
            GuestEvent::Snapshot(Snapshot { welcome, entries, resync: false })
        }

        fn frame(r: &mut Replica, v: Value) {
            r.apply(&GuestEvent::Frame(HostFrame::from_value(v)), NOW);
        }

        /// A main-session turn that cost `usd`, served by `identity`.
        fn turn(id: &str, at: i64, identity: &str, usd: f64) -> Value {
            let msg = json!({ "type": "message", "id": id, "timestamp": "2026-10-21T17:01:00.000Z", "message": { "role": "assistant",
                "content": [{ "type": "text", "text": "ok" }], "stopReason": "stop", "timestamp": at,
                "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "cost": { "total": usd } } } });
            served(msg, identity)
        }

        fn side_call(identity: &str, usd: f64) -> Value {
            served(json!({ "type": "model_usage", "id": "u1", "purpose": "title", "usage": { "output": 3, "cost": { "total": usd } } }), identity)
        }

        fn progress(r: &mut Replica, id: &str, model: Value, usd: f64) {
            let mut p = json!({ "id": id, "status": "running", "cost": usd });
            p.as_object_mut().unwrap().extend(model.as_object().unwrap().clone());
            frame(r, json!({ "t": "bus", "channel": "task:subagent:progress", "data": { "progress": p } }));
        }

        fn task_result(id: &str, usd: f64, results: Value) -> Value {
            json!({ "type": "message", "id": id, "message": { "role": "toolResult", "toolCallId": id, "toolName": "task", "isError": false,
                "content": [{ "type": "text", "text": "done" }], "details": { "results": results, "usage": { "output": 10, "cost": { "total": usd } } } } })
        }

        fn of(split: &CostSplit, spender: Spender) -> Vec<(String, f64)> {
            split.models.iter().filter(|m| m.spender == spender).map(|m| (m.model.clone(), m.value)).collect()
        }

        fn adds_up(split: &CostSplit) {
            for (spender, figure) in [(Spender::Main, split.main), (Spender::Subagents, split.subagents), (Spender::Advisor, split.advisor)] {
                let parts = of(split, spender);
                if !parts.is_empty() {
                    let sum: f64 = parts.iter().map(|p| p.1).sum();
                    assert!((sum - figure).abs() <= 1e-12 * figure, "{spender:?}: {parts:?} add up to {sum}, not {figure}");
                }
            }
        }

        fn close(parts: &[(String, f64)], want: &[(&str, f64)]) -> bool {
            parts.len() == want.len() && parts.iter().zip(want).all(|(p, w)| p.0 == w.0 && (p.1 - w.1).abs() < 1e-12)
        }

        /// The main agent's turns and its side calls (judges, titles) by the model that served
        /// each, the same bit for bit live and rebuilt. Live, the journal's side call is read
        /// between the turns; a rebuild reads the journal first: added up as they came into one
        /// sum, Luna would bill (0.1 + 0.2) + 0.0006954 live and (0.0006954 + 0.1) + 0.2 rebuilt.
        #[test]
        fn main_spend_by_model_is_the_same_live_and_rebuilt() {
            let turns = [
                turn("e1", NOW - 40_000, "anthropic/claude-opus-5", 0.4),
                turn("e2", NOW - 30_000, "openai-codex/gpt-6-luna", 0.1),
                turn("e3", NOW - 20_000, "openai-codex/gpt-6-luna", 0.2),
                turn("e4", NOW - 10_000, "anthropic/claude-opus-5", 0.35),
            ];
            let side = side_call("openai-codex/gpt-6-luna", 0.0006954);
            let mut live = Replica::new("Main");
            live.apply(&snapshot(json!({}), vec![]), NOW);
            for (i, entry) in turns.iter().enumerate() {
                frame(&mut live, json!({ "t": "entry", "entry": entry }));
                if i == 2 {
                    live.apply_journal_entries(std::slice::from_ref(&side), 100);
                }
            }
            let mut rebuilt = Replica::new("Main");
            rebuilt.apply_journal_entries(&[side], 100);
            rebuilt.apply(&snapshot(json!({}), turns.to_vec()), NOW);

            let cost = live.usage().unwrap();
            assert_eq!(rebuilt.usage().as_ref(), Some(&cost), "live and rebuilt bill the same, model by model");
            let split = cost.split.unwrap();
            assert!(close(&of(&split, Spender::Main), &[("claude-opus-5", 0.75), ("gpt-6-luna", 0.3006954)]), "{:?}", split.models);
            assert_eq!(split.models[0].provider.as_deref(), Some("anthropic"));
            adds_up(&split);
            assert_eq!(live.meta().cost.as_ref().and_then(|c| c.split.as_ref()), Some(&split), "meta carries the split");
        }

        /// The subagents bill `max(task results, artifact tree, progress)`; their split by model
        /// is the winner's, else the next source's that has one, scaled to the figure.
        #[test]
        fn the_subagent_split_comes_from_the_source_that_wins() {
            let mut r = Replica::new("Main");
            r.apply(&snapshot(json!({}), vec![]), NOW);
            // Without the artifacts dir, live progress: each subagent's cost goes to the model it runs on.
            progress(&mut r, "Scout", json!({ "resolvedModel": "openai-codex/gpt-6-luna:low" }), 0.02);
            progress(&mut r, "Probe", json!({ "resolvedModelIdentity": "anthropic/claude-sonnet-5" }), 0.06);
            let split = r.usage().unwrap().split.unwrap();
            assert!(close(&of(&split, Spender::Subagents), &[("claude-sonnet-5", 0.06), ("gpt-6-luna", 0.02)]), "{:?}", split.models);

            // A finished call's result bills more: omp sums it from each child's own usage.
            let results = json!([
                { "id": "Scout", "exitCode": 0, "resolvedModelIdentity": "openai-codex/gpt-6-luna", "usage": { "cost": { "total": 0.05 } } },
                { "id": "Probe", "exitCode": 0, "resolvedModel": "anthropic/claude-sonnet-5:high", "usage": { "cost": { "total": 0.1 } } },
            ]);
            frame(&mut r, json!({ "t": "entry", "entry": task_result("t1", 0.15, results) }));
            let split = r.usage().unwrap().split.unwrap();
            assert!((split.subagents - 0.15).abs() < 1e-12);
            assert!(close(&of(&split, Spender::Subagents), &[("claude-sonnet-5", 0.1), ("gpt-6-luna", 0.05)]), "{:?}", split.models);

            // The tree bills the most (Probe's side call on another model, Scout's advisor): its split.
            let header = line(json!({ "type": "session", "id": "s" }));
            let mut ledger = ArtifactLedger::default();
            ledger.ingest("Scout.jsonl", &[header.clone(), line(served(assistant(0.05, 10, 0, 1_000.0, 0.0), "openai-codex/gpt-6-luna"))].concat());
            let probe = [line(served(assistant(0.1, 10, 0, 1_000.0, 0.0), "anthropic/claude-sonnet-5")), line(side_call("google/gemini-3-pro", 0.04))];
            ledger.ingest("Probe.jsonl", &[header.clone(), probe.concat()].concat());
            ledger.ingest("Scout/__advisor.jsonl", &[header.clone(), line(served(assistant(0.01, 10, 0, 1_000.0, 0.0), "openai/gpt-5.5"))].concat());
            ledger.ingest("__advisor.jsonl", &[header.clone(), line(served(assistant(0.03, 10, 0, 1_000.0, 0.0), "openai/gpt-5.5"))].concat());
            r.apply_artifacts(&ledger, &[], NOW);
            let split = r.usage().unwrap().split.unwrap();
            assert!((split.subagents - 0.2).abs() < 1e-12);
            let want = [("claude-sonnet-5", 0.1), ("gpt-6-luna", 0.05), ("gemini-3-pro", 0.04), ("gpt-5.5", 0.01)];
            assert!(close(&of(&split, Spender::Subagents), &want), "{:?}", split.models);
            assert!(close(&of(&split, Spender::Advisor), &[("gpt-5.5", 0.03)]), "the session's own advisor: {:?}", split.models);
            adds_up(&split);

            // A result that names no child's usage (an older omp) wins again: what it adds is spread
            // over the task results' own split.
            frame(&mut r, json!({ "t": "entry", "entry": task_result("t2", 0.15, json!([{ "id": "Late", "exitCode": 0 }])) }));
            let split = r.usage().unwrap().split.unwrap();
            assert!((split.subagents - 0.3).abs() < 1e-12);
            assert!(close(&of(&split, Spender::Subagents), &[("claude-sonnet-5", 0.2), ("gpt-6-luna", 0.1)]), "{:?}", split.models);
            adds_up(&split);
            // With no split of their own at all, the tree's stands in, scaled to the task total.
            let mut older = Replica::new("Main");
            older.apply(&snapshot(json!({}), vec![task_result("t2", 0.4, json!([{ "id": "Late", "exitCode": 0 }]))]), NOW);
            older.apply_artifacts(&ledger, &[], NOW);
            let split = older.usage().unwrap().split.unwrap();
            let want = [("claude-sonnet-5", 0.2), ("gpt-6-luna", 0.1), ("gemini-3-pro", 0.08), ("gpt-5.5", 0.02)];
            assert!(close(&of(&split, Spender::Subagents), &want), "{:?}", split.models);
            adds_up(&split);
        }

        /// Throughput goes to the model of the message the main agent streams (its session model
        /// when the message names none) and to each replayed reply's model.
        #[test]
        fn throughput_by_model() {
            let state = json!({ "model": { "provider": "anthropic", "id": "claude-opus-5", "name": "Opus 5" } });
            let streaming = |model: Option<&str>| {
                let msg = json!({ "role": "assistant", "content": [{ "type": "text", "text": "x".repeat(120) }], "timestamp": NOW });
                let msg = model.map_or(msg.clone(), |m| served(json!({ "type": "message", "message": msg }), m)["message"].clone());
                json!({ "t": "event", "event": { "type": "message_update", "message": msg, "assistantMessageEvent": { "type": "text_delta" } } })
            };
            let main_share = |r: &Replica| {
                let split = r.liveness(NOW + 10).tps_split.unwrap();
                assert!((split.main - 10.0).abs() < 1e-3, "120 chars in 3 s: {split:?}");
                split.models
            };
            let mut r = Replica::new("Main");
            r.apply(&snapshot(state.clone(), vec![]), NOW);
            frame(&mut r, json!({ "t": "event", "event": { "type": "agent_start" } }));
            frame(&mut r, streaming(None));
            let share = |model: &str, provider: &str, value: f64| ModelShare { spender: Spender::Main, model: model.into(), provider: Some(provider.into()), value };
            assert_eq!(main_share(&r), [share("claude-opus-5", "anthropic", 10.0)], "the session's model");
            let mut r = Replica::new("Main");
            r.apply(&snapshot(state, vec![]), NOW);
            frame(&mut r, json!({ "t": "event", "event": { "type": "agent_start" } }));
            frame(&mut r, streaming(Some("openai-codex/gpt-6-luna")));
            assert_eq!(main_share(&r), [share("gpt-6-luna", "openai-codex", 10.0)], "a fallback model serves this message");

            // Finished subagent and advisor replies replay at output / (duration − ttft) = n / 2 s.
            let reply = |out: u64, model: &str| line(served(assistant(0.01, out, NOW - 3_000, 2_500.0, 500.0), model));
            let header = line(json!({ "type": "session", "id": "s" }));
            let mut ledger = ArtifactLedger::default();
            let mut calls = ledger.ingest("Scout.jsonl", &[header.clone(), reply(40, "openai-codex/gpt-6-luna")].concat());
            calls.extend(ledger.ingest("Probe.jsonl", &[header.clone(), reply(100, "anthropic/claude-sonnet-5")].concat()));
            calls.extend(ledger.ingest("Scout/Scout.Helper.jsonl", &[header.clone(), reply(80, "openai-codex/gpt-6-luna")].concat()));
            calls.extend(ledger.ingest("__advisor.jsonl", &[header, reply(60, "openai/gpt-5.5")].concat()));
            r.apply_artifacts(&ledger, &calls, NOW);
            let split = r.liveness(NOW + 500).tps_split.unwrap();
            assert!((split.subagents - 110.0).abs() < 1e-3 && (split.advisor - 30.0).abs() < 1e-3, "{split:?}");
            let rates: Vec<(Spender, &str, f64)> = split.models.iter().map(|m| (m.spender, m.model.as_str(), m.value)).collect();
            let want = [(Spender::Main, "gpt-6-luna", 10.0), (Spender::Subagents, "gpt-6-luna", 60.0), (Spender::Subagents, "claude-sonnet-5", 50.0), (Spender::Advisor, "gpt-5.5", 30.0)];
            assert_eq!(rates.len(), want.len(), "{rates:?}");
            assert!(rates.iter().zip(&want).all(|(a, b)| a.0 == b.0 && a.1 == b.1 && (a.2 - b.2).abs() < 1e-3), "{rates:?}");
            assert!(r.liveness(NOW + 2_001).tps_split.unwrap().models.iter().all(|m| m.spender == Spender::Main), "the replays ended");
        }
    }
}
