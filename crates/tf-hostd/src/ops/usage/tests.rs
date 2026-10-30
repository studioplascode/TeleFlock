//! `host.usage` against a stats.db that omp 18.13.3 itself wrote (`testdata/make-fixture.ts`):
//! a main session with a subagent, an advisor, an error, a side call and a priority-tier
//! request; a fork that copies two of its turns (omp keeps one copy); a second project with an
//! unpriced xai-oauth request. Figures are checked against omp's own dashboard for those rows.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tf_proto::{CostInfo, UsageParams, UsageView};

use super::report::{self, root_file, SessionInfo, Window};
use super::sync::{SyncCmd, Syncer};
use super::Usage;
use crate::state::persist::Persist;

const HOUR: i64 = 3_600_000;
const MIN: i64 = 60_000;

fn expected() -> Value {
    serde_json::from_str(include_str!("testdata/omp-18.13.3.json")).unwrap()
}

/// The fixture's first hour (epoch ms).
fn base() -> i64 {
    expected()["base"].as_i64().unwrap()
}

/// A copy of the omp-written index at `path`.
pub(super) fn omp_fixture(path: &Path) {
    rusqlite::Connection::open(path).unwrap().execute_batch(include_str!("testdata/omp-18.13.3.sql")).unwrap();
}

/// Session heads without the (long gone) session files: id from the name, a made-up title.
struct Stub;
impl SessionInfo for Stub {
    fn head(&self, file: &Path) -> (Option<String>, Option<String>, Option<String>) {
        let id = crate::ops::host::id_from_file_name(file);
        let folder = file.parent().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        (id.clone(), id.map(|i| format!("T:{i}")), Some(format!("/w/{folder}")))
    }
}

fn open(td: &tempfile::TempDir) -> (PathBuf, rusqlite::Connection) {
    let db = td.path().join("stats.db");
    omp_fixture(&db);
    let conn = crate::ops::host::open_ro(&db).unwrap().unwrap();
    (db, conn)
}

fn all() -> Window {
    Window { since: None, until: None, offset_min: 0 }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9 * a.abs().max(1.0)
}

#[test]
fn totals_match_omp_stats() {
    let td = tempfile::tempdir().unwrap();
    let (_, conn) = open(&td);
    let r = report::build(&conn, UsageView::Insights, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    let o = &expected()["overall"];
    let t = &r.totals;
    assert_eq!(t.requests, o["totalRequests"].as_u64().unwrap());
    assert_eq!(t.errors, o["failedRequests"].as_u64().unwrap());
    assert_eq!(t.unpriced, o["unpricedRequests"].as_u64().unwrap(), "the xai-oauth request has no price, not a free one");
    assert!(close(t.cost_usd, o["totalCost"].as_f64().unwrap()), "{} vs {}", t.cost_usd, o["totalCost"]);
    assert_eq!(t.input, o["totalInputTokens"].as_u64().unwrap());
    assert_eq!(t.output, o["totalOutputTokens"].as_u64().unwrap());
    assert_eq!(t.cache_read, o["totalCacheReadTokens"].as_u64().unwrap());
    assert_eq!(t.cache_write, o["totalCacheWriteTokens"].as_u64().unwrap());
    assert_eq!(t.tokens, t.input + t.output + t.cache_read + t.cache_write);
    assert!(close(t.premium, o["totalPremiumRequests"].as_f64().unwrap()));
    // The clients' derived figures, from mergeable sums.
    assert!(close(t.duration_ms / t.duration_n as f64, o["avgDuration"].as_f64().unwrap()));
    assert!(close(t.ttft_ms / t.ttft_n as f64, o["avgTtft"].as_f64().unwrap()));
    assert!(close(t.tps / t.tps_n as f64, o["avgTokensPerSecond"].as_f64().unwrap()));
    assert!(close(t.cache_read as f64 / (t.input + t.cache_read) as f64, o["cacheRate"].as_f64().unwrap()));
    assert!(close((t.uncached_usd - t.cached_usd) / t.uncached_usd, o["cacheSavings"].as_f64().unwrap()));
    assert_eq!(t.first_at, o["firstTimestamp"].as_i64());
    assert_eq!(t.last_at, o["lastTimestamp"].as_i64());
}

#[test]
fn breakdowns_match_omp_stats() {
    let td = tempfile::tempdir().unwrap();
    let (_, conn) = open(&td);
    let r = report::build(&conn, UsageView::Insights, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    let exp = expected();
    for m in exp["byModel"].as_array().unwrap() {
        let got = r.models.iter().find(|x| x.model == m["model"].as_str().unwrap() && x.provider == m["provider"].as_str().unwrap()).unwrap();
        assert_eq!(got.stat.requests, m["totalRequests"].as_u64().unwrap(), "{}", got.model);
        assert!(close(got.stat.cost_usd, m["totalCost"].as_f64().unwrap()), "{}", got.model);
        assert_eq!(got.stat.unpriced, m["unpricedRequests"].as_u64().unwrap_or(0), "{}", got.model);
    }
    assert_eq!(r.models.len(), exp["byModel"].as_array().unwrap().len());
    assert_eq!(r.models[0].model, "claude-opus-5-5", "most expensive first");
    for f in exp["byFolder"].as_array().unwrap() {
        let got = r.projects.iter().find(|p| p.folder == f["folder"].as_str().unwrap()).unwrap();
        assert_eq!(got.stat.requests, f["totalRequests"].as_u64().unwrap());
        assert!(close(got.stat.cost_usd, f["totalCost"].as_f64().unwrap()));
    }
    assert_eq!(r.projects[0].cwd.as_deref(), Some("/w/-work-alpha"), "a project's folder comes from one of its session files");
    for a in exp["byAgentType"].as_array().unwrap() {
        let got = r.agents.iter().find(|x| x.key == a["agentType"].as_str().unwrap()).unwrap();
        assert_eq!(got.stat.requests, a["totalRequests"].as_u64().unwrap());
        assert!(close(got.stat.cost_usd, a["totalCost"].as_f64().unwrap()));
    }
    // Providers fold their models.
    let anthropic = r.providers.iter().find(|p| p.key == "anthropic").unwrap();
    assert_eq!(anthropic.stat.requests, 7);
    assert_eq!(r.providers.iter().map(|p| p.stat.requests).sum::<u64>(), 11);
    // Service tiers: one priority request (one premium request), the rest without a tier.
    let priority = r.tiers.iter().find(|t| t.key == "priority").unwrap();
    assert_eq!((priority.stat.requests, priority.stat.premium), (1, 1.0));
    assert_eq!(r.tiers.iter().find(|t| t.key.is_empty()).unwrap().stat.requests, 10);
}

#[test]
fn hourly_buckets_and_offsets() {
    let td = tempfile::tempdir().unwrap();
    let (_, conn) = open(&td);
    let h0 = base() / HOUR;
    let r = report::build(&conn, UsageView::Summary, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    // Requests at +2…6 min, +65/66 min, +130 min, +600/620 min and +900 min.
    assert_eq!(r.hours.hour, vec![h0, h0 + 1, h0 + 2, h0 + 10, h0 + 15]);
    assert_eq!(r.hours.requests, vec![5, 2, 1, 2, 1]);
    assert_eq!(r.hours.errors, vec![0, 1, 0, 0, 0]);
    assert_eq!(r.hours.unpriced, vec![0, 0, 0, 1, 0], "the unpriced xai-oauth request's hour");
    assert!(close(r.hours.cost_usd[0], 0.0315) && close(r.hours.cost_usd[3], 0.05));
    assert!(close(r.hours.cost_usd.iter().sum::<f64>(), r.totals.cost_usd));
    assert_eq!(r.hours.tokens.iter().sum::<u64>(), r.totals.tokens);
    assert_eq!(r.hours.input.iter().sum::<u64>(), r.totals.input);
    assert_eq!(r.hours.output.iter().sum::<u64>(), r.totals.output);
    assert_eq!(r.hours.cache_read.iter().sum::<u64>(), r.totals.cache_read);
    assert_eq!(r.hours.cache_write.iter().sum::<u64>(), r.totals.cache_write);
    // Summary: no breakdowns.
    assert!(r.models.is_empty() && r.sessions.is_empty() && r.activity.hour.is_empty() && r.records.priciest.is_none());

    // A client half an hour off UTC (India): buckets start at :30, so +2…6 min fall in the
    // bucket that started at -0:30 and +600/620 min share one.
    let w = Window { since: None, until: None, offset_min: 30 };
    let r = report::build(&conn, UsageView::Summary, w, base() + 24 * HOUR, &Stub).unwrap().unwrap();
    assert_eq!(r.hour_offset, 30);
    assert_eq!(r.hours.hour, vec![h0 - 1, h0, h0 + 1, h0 + 9, h0 + 14]);
    assert_eq!(r.hours.requests, vec![5, 2, 1, 2, 1]);

    // A window: only requests at or after `since` (here +65 min), in totals and hours alike.
    let w = Window { since: Some(base() + 65 * MIN), until: None, offset_min: 0 };
    let r = report::build(&conn, UsageView::Summary, w, base() + 24 * HOUR, &Stub).unwrap().unwrap();
    assert_eq!(r.totals.requests, 6);
    assert_eq!(r.hours.requests.iter().sum::<u64>(), 6);
    assert_eq!(r.since, Some(base() + 65 * MIN));
    // A past period: `until` is exclusive (+600 min: the beta session's first request is out).
    let w = Window { since: Some(base() + 65 * MIN), until: Some(base() + 600 * MIN), offset_min: 0 };
    let r = report::build(&conn, UsageView::Insights, w, base() + 24 * HOUR, &Stub).unwrap().unwrap();
    assert_eq!((r.totals.requests, r.until), (3, Some(base() + 600 * MIN)));
    assert_eq!(r.hours.hour, vec![h0 + 1, h0 + 2]);
    assert_eq!(r.sessions.len(), 1);
    assert_eq!(r.tools.len(), 0, "the window's requests called no tools");
    assert_eq!(r.activity.requests.iter().sum::<u64>(), 11, "activity stays all-time");
}

#[test]
fn sessions_tools_records_activity() {
    let td = tempfile::tempdir().unwrap();
    let (_, conn) = open(&td);
    let r = report::build(&conn, UsageView::Insights, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    // A with its subagent and advisor (it also owns the two turns its fork copied: omp counts
    // each request once, for the file it indexed first), B, and the fork C.
    let ids: Vec<&str> = r.sessions.iter().map(|s| s.id.as_deref().unwrap()).collect();
    assert_eq!(ids, ["01aaaaaa-0000-7000-8000-00000000000a", "01bbbbbb-0000-7000-8000-00000000000b", "01cccccc-0000-7000-8000-00000000000c"]);
    let a = &r.sessions[0];
    assert_eq!((a.requests, a.delegated), (8, 3), "subagent and advisor requests roll up into their session");
    assert!(a.file.ends_with("_01aaaaaa-0000-7000-8000-00000000000a.jsonl"));
    assert!(close(a.cost_usd, 0.0521));
    assert_eq!(a.started_at, base() + 2 * MIN);
    assert_eq!(a.ended_at, base() + 130 * MIN + 6000);
    assert_eq!(a.models, ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "openai-codex/gpt-6-luna", "openai-codex/gpt-6-astra"]);
    assert_eq!(a.title.as_deref(), Some("T:01aaaaaa-0000-7000-8000-00000000000a"));
    assert_eq!(r.sessions[1].unpriced, 1);
    assert_eq!(r.sessions.iter().map(|s| s.requests).sum::<u64>(), 11);
    // The longest span: A, from +2 min to +130 min (+6 s).
    let long = r.records.longest_session.as_ref().unwrap();
    assert_eq!(long.id.as_deref(), Some("01aaaaaa-0000-7000-8000-00000000000a"));
    assert_eq!(long.ended_at - long.started_at, 128 * MIN + 6000);
    let priciest = r.records.priciest.as_ref().unwrap();
    assert_eq!((priciest.model.as_str(), priciest.folder.as_str(), priciest.duration_ms), ("claude-opus-5-5", "-work-beta", Some(9000)));
    assert!(close(priciest.cost_usd, 0.05));
    assert_eq!(r.records.biggest.as_ref().unwrap().tokens, 7550);
    // Tools: one call each; edit's request cost $0.05, read and bash split $0.014; bash failed.
    assert_eq!(r.tools[0].name, "edit");
    assert!(close(r.tools[0].cost_usd, 0.05));
    let read = r.tools.iter().find(|t| t.name == "read").unwrap();
    assert!(close(read.cost_usd, 0.007) && read.calls == 1);
    assert_eq!(r.tools.iter().find(|t| t.name == "bash").unwrap().errors, 1);
    assert_eq!(r.tools.len(), 4);
    // Subagents by name: the one Explore task (its two requests, $0.01).
    assert_eq!(r.subagents.len(), 1);
    assert_eq!((r.subagents[0].key.as_str(), r.subagents[0].stat.requests), ("Explore", 2));
    assert!(close(r.subagents[0].stat.cost_usd, 0.01));
    assert_eq!(report::subagent_name("/s/-p/x/12-FixParser.jsonl"), "FixParser");
    assert_eq!(report::subagent_name("/s/-p/x/Dispatch-2.jsonl"), "Dispatch-2");
    assert_eq!((r.session_count, r.subagent_count), (3, 1), "sessions A, B and the fork; one subagent run");
    // All-time activity (three years back from `now`): the same buckets as the hours.
    assert_eq!(r.activity.hour, r.hours.hour);
    assert_eq!(r.activity.requests, r.hours.requests);
    let later = report::build(&conn, UsageView::Insights, all(), base() + 4 * 366 * 24 * HOUR, &Stub).unwrap().unwrap();
    assert!(later.activity.hour.is_empty(), "activity reaches back three years");
}

#[test]
fn agent_work_time() {
    let td = tempfile::tempdir().unwrap();
    let (_, conn) = open(&td);
    let r = report::build(&conn, UsageView::Insights, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    let s = |m: i64, ms: i64| base() + m * MIN + ms;
    // A: +2 min … +5 min (+2 s) with its subagent's requests in between; the human wrote at
    // +5:30, so the advisor at +6 min starts a new stretch (0.9 s); +65 … +66 min (the side
    // call 60 s after the error joins it); +130 min (6 s). B: two requests 20 min apart (7 s,
    // 9 s). C: 1 s.
    assert_eq!(r.work.agent_ms, 182_000 + 900 + 60_000 + 6000 + 7000 + 9000 + 1000);
    let spans: Vec<(i64, i64)> = r.work.stretches.iter().map(|x| (x.start, x.end)).collect();
    // The union bridges pauses ≤ 10 min whoever paused, so A's first two stretches join.
    assert_eq!(spans, [(s(2, 0), s(6, 900)), (s(65, 0), s(66, 0)), (s(130, 0), s(130, 6000)), (s(600, 0), s(600, 7000)), (s(620, 0), s(620, 9000)), (s(900, 0), s(900, 1000))]);
    // Clipped to the window: from +5 min on, A's first stretch is 2 s.
    let w = Window { since: Some(s(5, 0)), until: Some(s(600, 0)), offset_min: 0 };
    let r = report::build(&conn, UsageView::Insights, w, base() + 24 * HOUR, &Stub).unwrap().unwrap();
    assert_eq!(r.work.agent_ms, 2000 + 900 + 60_000 + 6000);
    // Summary leaves it empty.
    let r = report::build(&conn, UsageView::Summary, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    assert_eq!((r.work.agent_ms, r.work.stretches.len()), (0, 0));
    // Over the cap the shortest gaps are bridged first.
    let sp = |a: i64, b: i64| tf_proto::UsageSpan { start: a, end: b };
    let capped = report::cap_stretches(vec![sp(0, 1), sp(5, 6), sp(100, 101), sp(103, 104), sp(1000, 1001)], 3);
    assert_eq!(capped, vec![sp(0, 6), sp(100, 104), sp(1000, 1001)]);
}

/// omp stores `duration` and `ttft` as REAL on real hosts (fractional milliseconds) although the
/// column is declared INTEGER: the integer reads must not fail (VerifyC lab on a real stats.db).
#[test]
fn fractional_durations_are_read() {
    let td = tempfile::tempdir().unwrap();
    let db = td.path().join("stats.db");
    omp_fixture(&db);
    rusqlite::Connection::open(&db).unwrap().execute_batch("UPDATE messages SET duration = duration + 0.4, ttft = ttft + 0.4").unwrap();
    let conn = crate::ops::host::open_ro(&db).unwrap().unwrap();
    assert!(conn.query_row("SELECT COUNT(*) FROM messages WHERE typeof(duration) = 'real'", [], |r| r.get::<_, i64>(0)).unwrap() > 0);
    let r = report::build(&conn, UsageView::Insights, all(), base() + 24 * HOUR, &Stub).unwrap().unwrap();
    let a = &r.sessions[0];
    assert_eq!(a.ended_at, base() + 130 * MIN + 6000, "span end from the whole-millisecond part");
    assert_eq!(r.records.priciest.as_ref().unwrap().duration_ms, Some(9000));
    assert!(r.work.agent_ms > 180_000);
}

#[test]
fn older_schemas_and_missing_index() {
    let td = tempfile::tempdir().unwrap();
    // The schema before omp-stats added stop reasons, agent types, tiers and tools.
    let db = td.path().join("old.db");
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER,
           input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
           total_tokens INTEGER, cost_total REAL);
         INSERT INTO messages VALUES (1, '/s/-p/a.jsonl', 'm', 'p', 7200000, 10, 5, 0, 0, 15, 0.5);
         INSERT INTO messages VALUES (2, '/s/-p/a.jsonl', 'm', 'xai-oauth', 7300000, 10, 5, 0, 0, 15, 0);",
    )
    .unwrap();
    drop(c);
    let conn = crate::ops::host::open_ro(&db).unwrap().unwrap();
    let r = report::build(&conn, UsageView::Insights, all(), 8_000_000, &Stub).unwrap().unwrap();
    assert_eq!((r.totals.requests, r.totals.errors, r.totals.unpriced), (2, 0, 1));
    assert_eq!(r.hours.hour, vec![2]);
    assert_eq!(r.agents.len(), 1);
    assert_eq!(r.agents[0].key, "main");
    assert!(r.tools.is_empty() && r.projects.is_empty());
    assert_eq!(r.sessions[0].requests, 2);
    assert_eq!(report::index_facts(&conn).unwrap(), report::IndexFacts { ready: true, newest: Some(7_300_000) });
    // An index without omp's tables is not ready (nothing indexed yet).
    let empty = td.path().join("empty.db");
    rusqlite::Connection::open(&empty).unwrap().execute_batch("CREATE TABLE meta (key TEXT, value TEXT);").unwrap();
    let conn = crate::ops::host::open_ro(&empty).unwrap().unwrap();
    assert!(!report::index_facts(&conn).unwrap().ready);
    assert!(report::build(&conn, UsageView::Insights, all(), 0, &Stub).unwrap().is_none());
}

#[test]
fn transcripts_find_their_session_on_disk() {
    let td = tempfile::tempdir().unwrap();
    let proj = td.path().join("sessions").join("-p");
    std::fs::create_dir_all(proj.join("2026_x").join("1-Task")).unwrap();
    std::fs::write(proj.join("2026_x.jsonl"), "").unwrap();
    std::fs::write(proj.join("2026_x").join("1-Task.jsonl"), "").unwrap();
    let nested = proj.join("2026_x").join("1-Task").join("0-Sub.jsonl");
    assert_eq!(root_file(&nested), proj.join("2026_x.jsonl"), "the outermost session, through a subagent's own artifacts");
    assert_eq!(root_file(&proj.join("2026_x.jsonl")), proj.join("2026_x.jsonl"));
    let lone = proj.join("other").join("y.jsonl");
    assert_eq!(root_file(&lone), lone);
}

// ───────────────────────────── the service ─────────────────────────────

/// A fake omp that finishes its sync once [`let_sync_finish`] ran (a sleep would make the
/// "still syncing" assertions depend on how fast the machine answers).
#[cfg(unix)]
fn fake_omp(dir: &Path) -> Arc<Syncer> {
    let path = dir.join("omp");
    crate::test_exe::write_exe(
        &path,
        format!("#!/bin/sh\nuntil [ -e '{}' ]; do sleep 0.02; done\necho 'Synced 3 new entries from 1 files (11 total)' >&2\n", dir.join("go").display()),
    );
    let cwd = dir.join("cwd");
    Syncer::new(Arc::new(move || Ok(SyncCmd { program: path.clone(), args: vec!["stats".into(), "--summary".into()], cwd: cwd.clone(), watch: None })), Duration::from_secs(10))
}

#[cfg(unix)]
fn let_sync_finish(dir: &Path) {
    std::fs::write(dir.join("go"), "").unwrap();
}

fn params(view: UsageView, have: Option<String>) -> UsageParams {
    UsageParams { days: 0, view: Some(view), since: None, until: None, hour_offset: None, refresh: None, have }
}

fn totals(cost: f64, tokens: u64) -> tf_proto::UsageTotals {
    tf_proto::UsageTotals { cost_usd: cost, tokens, input: tokens, output: 0 }
}

fn spent(usd: f64, input: u64) -> CostInfo {
    CostInfo { usd, input, output: 0, cache_read: 0, cache_write: 0, split: None }
}

#[cfg(unix)]
#[tokio::test]
async fn answers_at_once_while_syncing_and_versions_reports() {
    let td = tempfile::tempdir().unwrap();
    let db = td.path().join("stats.db");
    let syncer = fake_omp(td.path());
    let dbp = db.clone();
    let svc = Usage::new(syncer.clone(), None, Box::new(move || dbp.clone()));

    // Nothing indexed yet: not ready (not zero usage), and the first look starts a sync.
    let r = svc.answer(params(UsageView::Insights, None), totals(0.0, 0)).await.unwrap();
    let idx = r.index.unwrap();
    assert!(!idx.ready && idx.syncing && idx.synced_at.is_none());
    assert_eq!(idx.path, db.display().to_string());
    assert!(r.insights.is_none() && r.unchanged.is_none() && r.today.is_none());
    let_sync_finish(td.path());
    syncer.idle().await;

    omp_fixture(&db);
    let r = svc.answer(params(UsageView::Insights, None), totals(0.0, 0)).await.unwrap();
    let idx = r.index.unwrap();
    assert!(idx.ready && !idx.syncing);
    assert_eq!(idx.added, Some(3));
    assert_eq!(idx.newest, expected()["overall"]["lastTimestamp"].as_i64());
    let first = r.insights.unwrap();
    assert_eq!(first.totals.requests, 11);
    assert_eq!(first.version.len(), 16);

    // Holding the current report: only the index state and live figures come back.
    let r = svc.answer(params(UsageView::Insights, Some(first.version.clone())), totals(0.0, 0)).await.unwrap();
    assert_eq!(r.unchanged, Some(true));
    assert!(r.insights.is_none() && r.index.is_some());
    // Another view or window is another report.
    let r = svc.answer(params(UsageView::Summary, Some(first.version.clone())), totals(0.0, 0)).await.unwrap();
    assert!(r.unchanged.is_none() && r.insights.unwrap().models.is_empty());

    // omp writes to the index: a new version, built again.
    std::thread::sleep(Duration::from_millis(20));
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute("DELETE FROM messages WHERE provider = 'xai-oauth'", []).unwrap();
    drop(c);
    let r = svc.answer(params(UsageView::Insights, Some(first.version.clone())), totals(0.0, 0)).await.unwrap();
    let next = r.insights.unwrap();
    assert_ne!(next.version, first.version);
    assert_eq!((next.totals.requests, next.totals.unpriced), (10, 0));

    // Fresh: looking again does not sync; refresh does (after 30 s, so not yet here).
    assert!(!syncer.status().running);
    svc.answer(params(UsageView::Summary, None), totals(0.0, 0)).await.unwrap();
    assert!(!syncer.status().running);
}

#[cfg(unix)]
#[tokio::test]
async fn live_spend_counts_from_the_last_sync() {
    let td = tempfile::tempdir().unwrap();
    let db = td.path().join("stats.db");
    omp_fixture(&db);
    let persist = Persist::load(td.path().join("state.json"));
    let today = crate::util::local_day(crate::util::now_ms());
    // Spend before the sync: a baseline, then $0.50 of growth.
    persist.update_usage(|u| u.observe("s1", &spent(1.0, 100), &today));
    persist.update_usage(|u| u.observe("s1", &spent(1.5, 150), &today));
    let syncer = fake_omp(td.path());
    let dbp = db.clone();
    let svc = Usage::new(syncer.clone(), Some(persist.clone()), Box::new(move || dbp.clone()));

    // Before this daemon's first sync nothing marks where the index ends: no live figure.
    let r = svc.answer(params(UsageView::Summary, None), totals(0.5, 50)).await.unwrap();
    assert!(r.live.is_none());
    let_sync_finish(td.path());
    syncer.idle().await;

    // After it: only what the ledger saw since then (the index has the rest).
    persist.update_usage(|u| u.observe("s1", &spent(2.25, 250), &today));
    let r = svc.answer(params(UsageView::Summary, None), totals(1.25, 150)).await.unwrap();
    let live = r.live.unwrap();
    assert!(close(live.cost_usd, 0.75), "{}", live.cost_usd);
    assert_eq!((live.tokens, live.input), (100, 100));
    // The mark is taken just before the sync's `synced_at` is published.
    let synced_at = r.index.unwrap().synced_at.unwrap();
    assert!(live.since <= synced_at && synced_at - live.since < 1000, "{} vs {synced_at}", live.since);
    assert!(close(live.ledger_today.cost_usd, 1.25), "HostState.usage at answer time");
}
