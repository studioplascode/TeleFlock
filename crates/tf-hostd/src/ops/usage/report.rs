//! Bounded queries over omp's stats index (`messages`, `tool_calls`, `user_messages`; omp-stats
//! 18.13.3's schema, older databases tolerated column by column) → [`UsageInsights`].
//!
//! Definitions follow omp-stats so figures match `omp stats`: an error is `stop_reason =
//! 'error'`; an unpriced request has tokens, a zero cost and either `provider = 'xai-oauth'` or
//! `cost_unpriced = 1`; output rate = `output * 1000 / duration` per request with a duration;
//! cache savings compare `cost_no_cache_input` with what those prompts cost. Forks are already
//! deduplicated by omp at ingest (`(entry_id, timestamp)` across files), so sums are plain.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{named_params, Connection, OptionalExtension, Row};
use tf_proto::{
    Millis, UsageActivity, UsageHours, UsageInsights, UsageKeyStat, UsageModelStat, UsageProjectStat, UsageRecords, UsageRequestRecord,
    UsageSessionStat, UsageSpan, UsageStat, UsageToolStat, UsageView, UsageWork,
};

const HOUR_MS: i64 = 3_600_000;
/// Hour buckets sent at most (three years of every hour).
pub(crate) const MAX_HOURS: usize = 3 * 365 * 24;
/// How far back `activity` reaches.
const ACTIVITY_SPAN_MS: i64 = 3 * 365 * 24 * HOUR_MS;
const TOP_PROJECTS: usize = 12;
const TOP_SUBAGENTS: usize = 12;
const TOP_TOOLS: usize = 16;
const TOP_SESSIONS: usize = 10;
const SESSION_MODELS: usize = 4;
/// Requests of a session at most this far apart belong to one stretch of work.
const WORK_PAUSE_MS: i64 = 10 * 60_000;
/// Work stretches sent at most.
pub(crate) const MAX_STRETCHES: usize = 500;

/// The window of one report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Window {
    /// First instant (epoch ms); `None` = all time.
    pub since: Option<Millis>,
    /// End, exclusive; `None` = now (whatever the index holds).
    pub until: Option<Millis>,
    /// Minutes past the UTC hour at which buckets start (0–59).
    pub offset_min: u32,
}

/// The window's bounds as SQL parameters (`:since`, `:until`).
#[derive(Clone, Copy)]
struct Bounds {
    since: Millis,
    until: Millis,
}

/// `timestamp` (of table alias `p`) inside the window.
fn within(p: &str) -> String {
    format!("{p}timestamp >= :since AND {p}timestamp < :until")
}

/// Columns this database's `messages` / `tool_calls` lack get these stand-ins.
struct Cols {
    messages: HashSet<String>,
    tools: Option<HashSet<String>>,
    user_messages: bool,
}

impl Cols {
    fn read(conn: &Connection) -> rusqlite::Result<Option<Self>> {
        let messages = columns(conn, "messages")?;
        if messages.is_empty() {
            return Ok(None);
        }
        let tools = columns(conn, "tool_calls")?;
        let user_messages = columns(conn, "user_messages")?.contains("timestamp");
        Ok(Some(Self { messages, tools: (!tools.is_empty()).then_some(tools), user_messages }))
    }

    /// `name` when `messages` has it, else `fallback`.
    fn m(&self, name: &str, fallback: &'static str) -> String {
        if self.messages.contains(name) { name.to_string() } else { fallback.to_string() }
    }

    fn t(&self, name: &str, fallback: &'static str) -> String {
        match &self.tools {
            Some(t) if t.contains(name) => format!("t.{name}"),
            _ => fallback.to_string(),
        }
    }

    fn unpriced(&self) -> String {
        format!(
            "CASE WHEN total_tokens > 0 AND cost_total = 0 AND (provider = 'xai-oauth' OR {} = 1) THEN 1 ELSE 0 END",
            self.m("cost_unpriced", "0")
        )
    }

    /// The 20 columns [`read_stat`] reads, aggregated over the rows of a query.
    fn stat(&self) -> String {
        let (nci, ci, ccr, ccw) = (self.m("cost_no_cache_input", "NULL"), self.m("cost_input", "0"), self.m("cost_cache_read", "0"), self.m("cost_cache_write", "0"));
        let (dur, ttft) = (self.m("duration", "NULL"), self.m("ttft", "NULL"));
        format!(
            "COUNT(*), COALESCE(SUM(CASE WHEN {stop} = 'error' THEN 1 ELSE 0 END), 0), TOTAL(cost_total), COALESCE(SUM({unpriced}), 0),
             COALESCE(SUM(total_tokens), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
             COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), TOTAL({premium}),
             TOTAL({nci}), TOTAL(CASE WHEN {nci} > 0 THEN {ci} + {ccr} + {ccw} ELSE 0 END),
             TOTAL({dur}), COUNT({dur}), TOTAL({ttft}), COUNT({ttft}),
             TOTAL(CASE WHEN {dur} > 0 THEN output_tokens * 1000.0 / {dur} END), COUNT(CASE WHEN {dur} > 0 THEN 1 END),
             MIN(timestamp), MAX(timestamp)",
            stop = self.m("stop_reason", "''"),
            unpriced = self.unpriced(),
            premium = self.m("premium_requests", "0"),
        )
    }
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let rows = stmt.query_map([table], |r| r.get::<_, String>(0))?;
    rows.collect()
}

fn n(v: i64) -> u64 {
    v.max(0) as u64
}

fn read_stat(r: &Row, at: usize) -> rusqlite::Result<UsageStat> {
    Ok(UsageStat {
        requests: n(r.get(at)?),
        errors: n(r.get(at + 1)?),
        cost_usd: r.get(at + 2)?,
        unpriced: n(r.get(at + 3)?),
        tokens: n(r.get(at + 4)?),
        input: n(r.get(at + 5)?),
        output: n(r.get(at + 6)?),
        cache_read: n(r.get(at + 7)?),
        cache_write: n(r.get(at + 8)?),
        premium: r.get(at + 9)?,
        uncached_usd: r.get(at + 10)?,
        cached_usd: r.get(at + 11)?,
        duration_ms: r.get(at + 12)?,
        duration_n: n(r.get(at + 13)?),
        ttft_ms: r.get(at + 14)?,
        ttft_n: n(r.get(at + 15)?),
        tps: r.get(at + 16)?,
        tps_n: n(r.get(at + 17)?),
        first_at: r.get(at + 18)?,
        last_at: r.get(at + 19)?,
    })
}

/// Adds `b` into `a` (the same merge a client does across hosts).
pub(crate) fn add_stat(a: &mut UsageStat, b: &UsageStat) {
    a.requests += b.requests;
    a.errors += b.errors;
    a.cost_usd += b.cost_usd;
    a.unpriced += b.unpriced;
    a.tokens += b.tokens;
    a.input += b.input;
    a.output += b.output;
    a.cache_read += b.cache_read;
    a.cache_write += b.cache_write;
    a.premium += b.premium;
    a.uncached_usd += b.uncached_usd;
    a.cached_usd += b.cached_usd;
    a.duration_ms += b.duration_ms;
    a.duration_n += b.duration_n;
    a.ttft_ms += b.ttft_ms;
    a.ttft_n += b.ttft_n;
    a.tps += b.tps;
    a.tps_n += b.tps_n;
    a.first_at = min_opt(a.first_at, b.first_at);
    a.last_at = a.last_at.max(b.last_at);
}

fn min_opt(a: Option<Millis>, b: Option<Millis>) -> Option<Millis> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

fn zero_stat() -> UsageStat {
    UsageStat {
        requests: 0,
        errors: 0,
        cost_usd: 0.0,
        unpriced: 0,
        tokens: 0,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        premium: 0.0,
        uncached_usd: 0.0,
        cached_usd: 0.0,
        duration_ms: 0.0,
        duration_n: 0,
        ttft_ms: 0.0,
        ttft_n: 0,
        tps: 0.0,
        tps_n: 0,
        first_at: None,
        last_at: None,
    }
}

/// Micro-dollars are plenty and keep the hourly columns short.
fn usd6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// What the index holds overall: whether it exists with omp's tables, and its newest request.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct IndexFacts {
    pub ready: bool,
    pub newest: Option<Millis>,
}

pub(crate) fn index_facts(conn: &Connection) -> rusqlite::Result<IndexFacts> {
    if columns(conn, "messages")?.is_empty() {
        return Ok(IndexFacts::default());
    }
    let newest: Option<Millis> = conn.query_row("SELECT MAX(timestamp) FROM messages WHERE timestamp > 0", [], |r| r.get(0))?;
    Ok(IndexFacts { ready: true, newest })
}

/// Session titles and folders for the sessions a report names.
pub(crate) trait SessionInfo {
    /// `(id, title, cwd)` of a main session file.
    fn head(&self, file: &Path) -> (Option<String>, Option<String>, Option<String>);
}

/// The report over `w` (`version` left empty for the caller). `None`: no `messages` table.
/// `now` bounds the all-time activity series.
pub(crate) fn build(conn: &Connection, view: UsageView, w: Window, now: Millis, info: &dyn SessionInfo) -> rusqlite::Result<Option<UsageInsights>> {
    let Some(c) = Cols::read(conn)? else { return Ok(None) };
    let b = Bounds { since: w.since.unwrap_or(i64::MIN), until: w.until.unwrap_or(i64::MAX) };
    let off = i64::from(w.offset_min.min(59)) * 60_000;
    let stat = c.stat();
    let wm = within("");

    let totals = conn.query_row(&format!("SELECT {stat} FROM messages WHERE {wm}"), named_params! {":since": b.since, ":until": b.until}, |r| read_stat(r, 0))?;
    let hours = hours(conn, &c, b, off)?;
    let mut out = UsageInsights {
        version: String::new(),
        since: w.since,
        until: w.until,
        hour_offset: w.offset_min.min(59),
        hours,
        totals,
        models: vec![],
        providers: vec![],
        projects: vec![],
        agents: vec![],
        subagents: vec![],
        tiers: vec![],
        tools: vec![],
        sessions: vec![],
        session_count: 0,
        subagent_count: 0,
        records: UsageRecords { priciest: None, biggest: None, longest_session: None },
        activity: UsageActivity { hour: vec![], requests: vec![] },
        work: UsageWork { agent_ms: 0, stretches: vec![] },
    };
    if view == UsageView::Summary {
        return Ok(Some(out));
    }

    // Models, and providers folded from them.
    let mut stmt = conn.prepare(&format!(
        "SELECT provider, model, {stat} FROM messages WHERE {wm} GROUP BY provider, model ORDER BY TOTAL(cost_total) DESC, SUM(total_tokens) DESC"
    ))?;
    out.models = stmt
        .query_map(named_params! {":since": b.since, ":until": b.until}, |r| Ok(UsageModelStat { provider: r.get(0)?, model: r.get(1)?, stat: read_stat(r, 2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let mut providers: Vec<UsageKeyStat> = Vec::new();
    for m in &out.models {
        match providers.iter_mut().find(|p| p.key == m.provider) {
            Some(p) => add_stat(&mut p.stat, &m.stat),
            None => providers.push(UsageKeyStat { key: m.provider.clone(), stat: m.stat.clone() }),
        }
    }
    providers.sort_by(|a, b| b.stat.cost_usd.total_cmp(&a.stat.cost_usd).then(b.stat.tokens.cmp(&a.stat.tokens)));
    out.providers = providers;

    out.agents = key_stats(conn, &c.m("agent_type", "'main'"), &stat, b)?;
    (out.subagents, out.subagent_count) = subagents(conn, &c, &stat, b)?;
    out.tiers = key_stats(conn, &format!("COALESCE({}, '')", c.m("service_tier", "NULL")), &stat, b)?;
    out.projects = projects(conn, &c, &stat, b, info)?;
    out.tools = tools(conn, &c, b)?;
    let (sessions, longest, session_count) = sessions(conn, &c, b, info)?;
    out.sessions = sessions;
    out.session_count = session_count;
    out.records = UsageRecords { priciest: record(conn, &c, b, "cost_total")?, biggest: record(conn, &c, b, "total_tokens")?, longest_session: longest };
    out.activity = activity(conn, (now - ACTIVITY_SPAN_MS).max(1), off)?;
    out.work = work(conn, &c, b, now)?;
    Ok(Some(out))
}

/// A subagent's name from its transcript: omp numbers a session's tasks (`3-Explore.jsonl`).
pub(crate) fn subagent_name(file: &str) -> String {
    let stem = Path::new(file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match stem.split_once('-') {
        Some((n, name)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && !name.is_empty() => name.to_string(),
        _ => stem,
    }
}

/// Subagents by name, and how many transcripts (task runs) they had.
fn subagents(conn: &Connection, c: &Cols, stat: &str, b: Bounds) -> rusqlite::Result<(Vec<UsageKeyStat>, u64)> {
    if !c.messages.contains("agent_type") {
        return Ok((vec![], 0));
    }
    let mut stmt = conn.prepare(&format!("SELECT session_file, {stat} FROM messages WHERE {} AND agent_type = 'subagent' GROUP BY session_file", within("")))?;
    let mut by_name: Vec<UsageKeyStat> = Vec::new();
    let mut runs = 0;
    for row in stmt.query_map(named_params! {":since": b.since, ":until": b.until}, |r| Ok((r.get::<_, String>(0)?, read_stat(r, 1)?)))? {
        let (file, s) = row?;
        runs += 1;
        let name = subagent_name(&file);
        match by_name.iter_mut().find(|k| k.key == name) {
            Some(k) => add_stat(&mut k.stat, &s),
            None => by_name.push(UsageKeyStat { key: name, stat: s }),
        }
    }
    by_name.sort_by(|a, b| b.stat.cost_usd.total_cmp(&a.stat.cost_usd).then(b.stat.requests.cmp(&a.stat.requests)).then(a.key.cmp(&b.key)));
    if by_name.len() > TOP_SUBAGENTS {
        let mut rest = zero_stat();
        for k in by_name.drain(TOP_SUBAGENTS..) {
            add_stat(&mut rest, &k.stat);
        }
        by_name.push(UsageKeyStat { key: String::new(), stat: rest });
    }
    Ok((by_name, runs))
}

fn hours(conn: &Connection, c: &Cols, b: Bounds, off: i64) -> rusqlite::Result<UsageHours> {
    // Newest first under the cap, put back in order below. Undated rows (omp's 0 sentinel) have
    // no hour.
    let mut stmt = conn.prepare(&format!(
        "SELECT (timestamp - :off) / 3600000 AS h, TOTAL(cost_total), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), COUNT(*),
                COALESCE(SUM(CASE WHEN {stop} = 'error' THEN 1 ELSE 0 END), 0), COALESCE(SUM({unpriced}), 0)
         FROM messages WHERE {wm} AND timestamp > :off GROUP BY h ORDER BY h DESC LIMIT :cap",
        stop = c.m("stop_reason", "''"),
        unpriced = c.unpriced(),
        wm = within(""),
    ))?;
    let mut h = UsageHours {
        hour: vec![],
        cost_usd: vec![],
        tokens: vec![],
        input: vec![],
        output: vec![],
        cache_read: vec![],
        cache_write: vec![],
        requests: vec![],
        errors: vec![],
        unpriced: vec![],
    };
    let mut rows = stmt.query(named_params! {":since": b.since, ":until": b.until, ":off": off, ":cap": MAX_HOURS as i64})?;
    while let Some(r) = rows.next()? {
        h.hour.push(r.get(0)?);
        h.cost_usd.push(usd6(r.get(1)?));
        h.tokens.push(n(r.get(2)?));
        h.input.push(n(r.get(3)?));
        h.output.push(n(r.get(4)?));
        h.cache_read.push(n(r.get(5)?));
        h.cache_write.push(n(r.get(6)?));
        h.requests.push(n(r.get(7)?));
        h.errors.push(n(r.get(8)?));
        h.unpriced.push(n(r.get(9)?));
    }
    for col in [&mut h.tokens, &mut h.input, &mut h.output, &mut h.cache_read, &mut h.cache_write, &mut h.requests, &mut h.errors, &mut h.unpriced] {
        col.reverse();
    }
    h.hour.reverse();
    h.cost_usd.reverse();
    Ok(h)
}

fn activity(conn: &Connection, since: Millis, off: i64) -> rusqlite::Result<UsageActivity> {
    let mut stmt = conn.prepare("SELECT (timestamp - :off) / 3600000 AS h, COUNT(*) FROM messages WHERE timestamp >= :since AND timestamp > :off GROUP BY h ORDER BY h")?;
    let mut a = UsageActivity { hour: vec![], requests: vec![] };
    let mut rows = stmt.query(named_params! {":since": since, ":off": off})?;
    while let Some(r) = rows.next()? {
        a.hour.push(r.get(0)?);
        a.requests.push(n(r.get(1)?));
    }
    Ok(a)
}

fn key_stats(conn: &Connection, key_expr: &str, stat: &str, b: Bounds) -> rusqlite::Result<Vec<UsageKeyStat>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {key_expr} AS k, {stat} FROM messages WHERE {} GROUP BY k ORDER BY TOTAL(cost_total) DESC, SUM(total_tokens) DESC",
        within("")
    ))?;
    let rows = stmt.query_map(named_params! {":since": b.since, ":until": b.until}, |r| {
        Ok(UsageKeyStat { key: r.get::<_, Option<String>>(0)?.unwrap_or_default(), stat: read_stat(r, 1)? })
    })?;
    rows.collect()
}

fn projects(conn: &Connection, c: &Cols, stat: &str, b: Bounds, info: &dyn SessionInfo) -> rusqlite::Result<Vec<UsageProjectStat>> {
    if !c.messages.contains("folder") {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT folder, {stat} FROM messages WHERE {} GROUP BY folder ORDER BY TOTAL(cost_total) DESC, SUM(total_tokens) DESC",
        within("")
    ))?;
    let all: Vec<(String, UsageStat)> = stmt
        .query_map(named_params! {":since": b.since, ":until": b.until}, |r| Ok((r.get(0)?, read_stat(r, 1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let main = c.m("agent_type", "'main'");
    let mut pick = conn.prepare(&format!("SELECT session_file FROM messages WHERE folder = ?1 ORDER BY ({main} = 'main') DESC, timestamp DESC LIMIT 1"))?;
    let mut out = Vec::new();
    let mut rest: Option<UsageStat> = None;
    for (i, (folder, s)) in all.into_iter().enumerate() {
        if i < TOP_PROJECTS {
            let file: Option<String> = pick.query_row([&folder], |r| r.get(0)).optional()?;
            let cwd = file.and_then(|f| info.head(&root_file(Path::new(&f))).2);
            out.push(UsageProjectStat { folder, cwd, stat: s });
        } else {
            add_stat(rest.get_or_insert_with(zero_stat), &s);
        }
    }
    if let Some(s) = rest {
        out.push(UsageProjectStat { folder: String::new(), cwd: None, stat: s });
    }
    Ok(out)
}

fn tools(conn: &Connection, c: &Cols, b: Bounds) -> rusqlite::Result<Vec<UsageToolStat>> {
    if c.tools.is_none() {
        return Ok(vec![]);
    }
    let (calls_in_turn, is_error) = (c.t("calls_in_turn", "1"), c.t("is_error", "NULL"));
    // A tool's cost share: the cost of the request that called it, split over its tool calls.
    let mut stmt = conn.prepare(&format!(
        "SELECT t.tool_name, COUNT(*), COALESCE(SUM(CASE WHEN {is_error} = 1 THEN 1 ELSE 0 END), 0),
                TOTAL(COALESCE(m.cost_total, 0) / MAX({calls_in_turn}, 1))
         FROM tool_calls t LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
         WHERE {} GROUP BY t.tool_name ORDER BY 2 DESC, 4 DESC LIMIT {TOP_TOOLS}",
        within("t.")
    ))?;
    let rows = stmt.query_map(named_params! {":since": b.since, ":until": b.until}, |r| {
        Ok(UsageToolStat { name: r.get(0)?, calls: n(r.get(1)?), errors: n(r.get(2)?), cost_usd: r.get(3)? })
    })?;
    rows.collect()
}

/// The main session file a transcript belongs to: subagent and advisor transcripts live in the
/// session's artifacts dir (`<project>/<session>/…/<id>.jsonl` next to `<project>/<session>.jsonl`).
/// Without a `.jsonl` named like one of its folders, a file is its own session.
pub(crate) fn root_file(file: &Path) -> PathBuf {
    let mut best = None;
    for anc in file.ancestors().skip(1).take(6) {
        let Some(name) = anc.file_name() else { break };
        let candidate = anc.with_file_name(format!("{}.jsonl", name.to_string_lossy()));
        if candidate.is_file() {
            best = Some(candidate);
        }
    }
    best.unwrap_or_else(|| file.to_path_buf())
}

/// Transcripts of a window → the main session file they belong to. A transcript inside the
/// artifacts dir of a main file of the window belongs to it (no disk access); other main files
/// are their own; anything else is looked up on disk ([`root_file`]).
struct Roots {
    mains: HashSet<String>,
    known: HashMap<String, String>,
}

impl Roots {
    fn new<'a>(mains: impl Iterator<Item = &'a str>) -> Self {
        Self { mains: mains.map(str::to_string).collect(), known: HashMap::new() }
    }

    fn of(&mut self, file: &str, agent: &str) -> String {
        if let Some(r) = self.known.get(file) {
            return r.clone();
        }
        let nested = Path::new(file).ancestors().skip(1).take(6).find_map(|anc| {
            let candidate = format!("{}.jsonl", anc.display());
            self.mains.contains(&candidate).then_some(candidate)
        });
        let root = nested.unwrap_or_else(|| if agent == "main" { file.to_string() } else { root_file(Path::new(file)).display().to_string() });
        self.known.insert(file.to_string(), root.clone());
        root
    }
}

struct SessionAcc {
    started: Millis,
    ended: Millis,
    requests: u64,
    delegated: u64,
    cost: f64,
    unpriced: u64,
    tokens: u64,
    models: HashMap<String, u64>,
}

/// The top sessions, the longest one, and how many there were.
fn sessions(conn: &Connection, c: &Cols, b: Bounds, info: &dyn SessionInfo) -> rusqlite::Result<(Vec<UsageSessionStat>, Option<UsageSessionStat>, u64)> {
    let agent = c.m("agent_type", "'main'");
    let dur = c.m("duration", "0");
    let mut stmt = conn.prepare(&format!(
        "SELECT session_file, {agent}, provider || '/' || model, COUNT(*), TOTAL(cost_total), COALESCE(SUM({unpriced}), 0),
                COALESCE(SUM(total_tokens), 0), MIN(timestamp), CAST(MAX(timestamp + COALESCE({dur}, 0)) AS INTEGER)
         FROM messages WHERE {wm} GROUP BY session_file, 2, 3",
        unpriced = c.unpriced(),
        wm = within(""),
    ))?;
    let rows: Vec<(String, String, String, u64, f64, u64, u64, Millis, Millis)> = stmt
        .query_map(named_params! {":since": b.since, ":until": b.until}, |r| {
            Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get(2)?, n(r.get(3)?), r.get(4)?, n(r.get(5)?), n(r.get(6)?), r.get(7)?, r.get(8)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut roots = Roots::new(rows.iter().filter(|r| r.1 == "main").map(|r| r.0.as_str()));
    let mut acc: HashMap<String, SessionAcc> = HashMap::new();
    for (file, agent, model, requests, cost, unpriced, tokens, first, last) in &rows {
        let root = roots.of(file, agent);
        let a = acc.entry(root.clone()).or_insert(SessionAcc {
            started: *first,
            ended: *last,
            requests: 0,
            delegated: 0,
            cost: 0.0,
            unpriced: 0,
            tokens: 0,
            models: HashMap::new(),
        });
        a.started = a.started.min(*first);
        a.ended = a.ended.max(*last);
        a.requests += requests;
        if *file != root {
            a.delegated += requests;
        }
        a.cost += cost;
        a.unpriced += unpriced;
        a.tokens += tokens;
        *a.models.entry(model.clone()).or_default() += requests;
    }
    let finish = |file: &str, a: &SessionAcc| {
        let (id, title, cwd) = info.head(Path::new(file));
        let mut models: Vec<(&String, &u64)> = a.models.iter().collect();
        models.sort_by(|x, y| y.1.cmp(x.1).then(x.0.cmp(y.0)));
        UsageSessionStat {
            file: file.to_string(),
            id,
            title,
            cwd,
            started_at: a.started,
            ended_at: a.ended,
            requests: a.requests,
            delegated: a.delegated,
            cost_usd: a.cost,
            unpriced: a.unpriced,
            tokens: a.tokens,
            models: models.into_iter().take(SESSION_MODELS).map(|(m, _)| m.clone()).collect(),
        }
    };
    let longest = acc.iter().max_by(|x, y| (x.1.ended - x.1.started).cmp(&(y.1.ended - y.1.started)).then(y.0.cmp(x.0))).map(|(f, a)| finish(f, a));
    let mut ranked: Vec<(&String, &SessionAcc)> = acc.iter().collect();
    ranked.sort_by(|x, y| y.1.cost.total_cmp(&x.1.cost).then(y.1.tokens.cmp(&x.1.tokens)).then(x.0.cmp(y.0)));
    let top = ranked.into_iter().take(TOP_SESSIONS).map(|(f, a)| finish(f, a)).collect();
    Ok((top, longest, acc.len() as u64))
}

/// When agents worked ([`UsageWork`]): per session, its request spans joined across pauses of at
/// most [`WORK_PAUSE_MS`] unless the human wrote in its main transcript during the pause.
fn work(conn: &Connection, c: &Cols, b: Bounds, now: Millis) -> rusqlite::Result<UsageWork> {
    let agent = c.m("agent_type", "'main'");
    let dur = c.m("duration", "0");
    let mut stmt = conn.prepare(&format!(
        "SELECT session_file, {agent}, timestamp, CAST(MAX(COALESCE({dur}, 0), 0) AS INTEGER) FROM messages WHERE {} AND timestamp > 0 ORDER BY timestamp",
        within("")
    ))?;
    let rows: Vec<(String, String, Millis, Millis)> = stmt
        .query_map(named_params! {":since": b.since, ":until": b.until}, |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut roots = Roots::new(rows.iter().filter(|r| r.1 == "main").map(|r| r.0.as_str()));
    // The human's messages in main transcripts (none in databases without `user_messages`).
    let mut human: HashMap<String, Vec<Millis>> = HashMap::new();
    if c.user_messages {
        let mut stmt = conn.prepare(&format!("SELECT session_file, timestamp FROM user_messages WHERE {} ORDER BY timestamp", within("")))?;
        for row in stmt.query_map(named_params! {":since": b.since, ":until": b.until}, |r| Ok((r.get::<_, String>(0)?, r.get::<_, Millis>(1)?)))? {
            let (file, at) = row?;
            if roots.mains.contains(&file) {
                human.entry(file).or_default().push(at);
            }
        }
    }
    let mut spans: HashMap<String, Vec<(Millis, Millis)>> = HashMap::new();
    for (file, agent, at, d) in &rows {
        spans.entry(roots.of(file, agent)).or_default().push((*at, at + d));
    }
    let end = b.until.min(now);
    let mut agent_ms: u64 = 0;
    let mut all: Vec<UsageSpan> = Vec::new();
    let mut keep = |s: Millis, e: Millis| {
        let (s, e) = (s.max(b.since), e.min(end));
        if e > s {
            agent_ms += (e - s) as u64;
            all.push(UsageSpan { start: s, end: e });
        }
    };
    for (root, list) in &spans {
        let cuts = human.get(root).map(Vec::as_slice).unwrap_or(&[]);
        let mut cur: Option<(Millis, Millis)> = None;
        // Rows come in timestamp order, so every session's spans do too.
        for &(s, e) in list {
            cur = match cur {
                Some((cs, ce)) if s - ce <= WORK_PAUSE_MS && !wrote_between(cuts, ce, s) => Some((cs, ce.max(e))),
                Some((cs, ce)) => {
                    keep(cs, ce);
                    Some((s, e))
                }
                None => Some((s, e)),
            };
        }
        if let Some((cs, ce)) = cur {
            keep(cs, ce);
        }
    }
    all.sort_by_key(|s| (s.start, s.end));
    let mut union: Vec<UsageSpan> = Vec::new();
    for s in all {
        match union.last_mut() {
            Some(last) if s.start - last.end <= WORK_PAUSE_MS => last.end = last.end.max(s.end),
            _ => union.push(s),
        }
    }
    Ok(UsageWork { agent_ms, stretches: cap_stretches(union, MAX_STRETCHES) })
}

/// Whether the human wrote after `after` and no later than `until` (`cuts` ascending).
fn wrote_between(cuts: &[Millis], after: Millis, until: Millis) -> bool {
    let i = cuts.partition_point(|&u| u <= after);
    cuts.get(i).is_some_and(|&u| u <= until)
}

/// At most `cap` stretches: the shortest gaps are bridged first.
pub(crate) fn cap_stretches(v: Vec<UsageSpan>, cap: usize) -> Vec<UsageSpan> {
    if v.len() <= cap || cap == 0 {
        return v;
    }
    let mut gaps: Vec<(Millis, usize)> = v.windows(2).enumerate().map(|(i, w)| (w[1].start - w[0].end, i)).collect();
    gaps.sort();
    let bridged: HashSet<usize> = gaps.iter().take(v.len() - cap).map(|g| g.1).collect();
    let mut out: Vec<UsageSpan> = Vec::with_capacity(cap);
    for (i, s) in v.into_iter().enumerate() {
        match out.last_mut() {
            Some(last) if bridged.contains(&(i - 1)) => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

fn record(conn: &Connection, c: &Cols, b: Bounds, by: &str) -> rusqlite::Result<Option<UsageRequestRecord>> {
    let sql = format!(
        "SELECT timestamp, provider, model, cost_total, total_tokens, {folder}, {agent}, CAST({dur} AS INTEGER) FROM messages
         WHERE {wm} AND {by} > 0 ORDER BY {by} DESC, timestamp DESC LIMIT 1",
        folder = c.m("folder", "''"),
        agent = c.m("agent_type", "'main'"),
        dur = c.m("duration", "NULL"),
        wm = within(""),
    );
    conn.query_row(&sql, named_params! {":since": b.since, ":until": b.until}, |r| {
        Ok(UsageRequestRecord {
            at: r.get(0)?,
            provider: r.get(1)?,
            model: r.get(2)?,
            cost_usd: r.get(3)?,
            tokens: n(r.get(4)?),
            folder: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            agent: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            duration_ms: r.get::<_, Option<i64>>(7)?.map(n),
        })
    })
    .optional()
}
