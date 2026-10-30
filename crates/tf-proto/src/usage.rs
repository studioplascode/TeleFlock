//! `host.usage`: spend and token history from omp's own stats index (`stats.db`), which tf-hostd
//! keeps current with omp's sync (architecture §3.16).
//!
//! Apps ≥ 0.7.0 send `view` and get [`UsageInsights`] over hourly buckets in UTC (the app groups
//! them into its own local days, so hosts in other time zones add up correctly), the index's
//! freshness ([`UsageIndex`]) and what TeleFlock saw live since the last sync ([`UsageLive`]).
//! Older apps send only `days` and keep getting the legacy `today` / `days` / `models` answer.

use crate::model::UsageTotals;
use crate::Millis;

wire_enum! {
    /// What a `host.usage` request asks for (apps ≥ 0.7.0).
    pub enum UsageView {
        /// Totals and the hourly series of the window (the board's Today figure).
        Summary,
        /// Everything: breakdowns, tools, sessions, records and all-time activity.
        Insights,
    }
}

wire_struct! {
    pub struct UsageParams {
        /// Legacy (apps < 0.7.0, no `view`): host-local days of `days` and `models` (1–366).
        #[serde(default)]
        #[ts(as = "Option<u32>", optional)]
        pub days: u32,
        /// The report to build; absent = the legacy answer.
        pub view: Option<UsageView>,
        /// Window start (epoch ms; the app's local midnight of the first day). Absent = all time.
        pub since: Option<Millis>,
        /// Window end, exclusive (a past period, e.g. last week). Absent = now. `activity` stays
        /// all-time.
        pub until: Option<Millis>,
        /// Minutes past each UTC hour at which the app's local hours start (its UTC offset modulo
        /// 60, e.g. 30 in India): hour buckets start there, so they never straddle local midnight.
        pub hour_offset: Option<u32>,
        /// Sync omp's index now, unless a sync finished within the last 30 s.
        pub refresh: Option<bool>,
        /// `insights.version` the app already holds: while it is current, `insights` is omitted.
        pub have: Option<String>,
    }
}

wire_struct! {
    pub struct UsageDay {
        /// `YYYY-MM-DD` (host local).
        pub day: String,
        pub cost_usd: f64,
        pub tokens: u64,
    }
}

wire_struct! {
    pub struct UsageModel {
        pub model: String,
        pub cost_usd: f64,
        pub tokens: u64,
    }
}

wire_struct! {
    pub struct UsageReport {
        /// Legacy answer (requests without `view`): today, host-local …
        pub today: Option<UsageTotals>,
        /// … the last `days` host-local days, oldest first, zero-filled …
        pub days: Option<Vec<UsageDay>>,
        /// … and totals per `provider/model` over them.
        pub models: Option<Vec<UsageModel>>,
        /// With `view`: omp's index and TeleFlock's syncs of it.
        pub index: Option<UsageIndex>,
        /// With `view`: the report. Absent when `unchanged`, and while the index does not exist yet.
        pub insights: Option<UsageInsights>,
        /// `have` is the current `insights.version`: the app keeps the report it has.
        pub unchanged: Option<bool>,
        /// With `view`, after this daemon's first sync: spend TeleFlock saw live since that sync.
        pub live: Option<UsageLive>,
    }
}

wire_struct! {
    /// omp's stats index on the host (`stats.db`) and TeleFlock's syncs of it.
    pub struct UsageIndex {
        /// The database, resolved the way omp resolves it (config dir, profile, XDG).
        pub path: String,
        /// The database exists and has omp's tables. False: nothing is indexed yet (which is
        /// not the same as no usage).
        pub ready: bool,
        /// A sync (`omp stats --summary`) runs now: ask again shortly for fresher figures.
        pub syncing: bool,
        /// When this daemon's last successful sync finished.
        pub synced_at: Option<Millis>,
        /// Requests that sync added to the index.
        pub added: Option<u64>,
        /// Why the last sync failed (cleared by the next success).
        pub error: Option<String>,
        pub error_at: Option<Millis>,
        /// The newest request in the index.
        pub newest: Option<Millis>,
    }
}

wire_struct! {
    /// Spend TeleFlock's live ledger saw after the index's last sync (the sessions on its boards;
    /// the next sync indexes them, with everything else). Add it to the index's figures.
    pub struct UsageLive {
        /// When the sync it counts from finished.
        pub since: Millis,
        pub cost_usd: f64,
        pub tokens: u64,
        pub input: u64,
        pub output: u64,
        /// `HostState.usage` (the live ledger's host-local today) when this answer was built:
        /// its growth after that is newer live spend.
        pub ledger_today: UsageTotals,
    }
}

wire_struct! {
    /// Additive request facts: every field sums (or takes min / max) across hosts.
    pub struct UsageStat {
        pub requests: u64,
        /// Requests that ended in an error.
        pub errors: u64,
        /// API-equivalent USD: requests on a subscription are priced at the public rate card, so
        /// this is an estimate, not a bill.
        pub cost_usd: f64,
        /// Requests without a price (a subscription with no public rate): their $0 is unknown,
        /// not free.
        pub unpriced: u64,
        pub tokens: u64,
        pub input: u64,
        pub output: u64,
        pub cache_read: u64,
        pub cache_write: u64,
        /// Premium requests (Copilot multipliers, priority / fast service tiers).
        pub premium: f64,
        /// Prompt cost without caching, and what those prompts cost with it (priced requests
        /// only): cache savings = 1 − cached / uncached.
        pub uncached_usd: f64,
        pub cached_usd: f64,
        /// Sum and count of request durations (ms) …
        pub duration_ms: f64,
        pub duration_n: u64,
        /// … times to first token (ms) …
        pub ttft_ms: f64,
        pub ttft_n: u64,
        /// … and output rates (tokens/s, output ÷ duration as omp computes it).
        pub tps: f64,
        pub tps_n: u64,
        pub first_at: Option<Millis>,
        pub last_at: Option<Millis>,
    }
}

wire_struct! {
    pub struct UsageModelStat {
        pub provider: String,
        pub model: String,
        pub stat: UsageStat,
    }
}

wire_struct! {
    /// One group of a breakdown: a provider, an agent type (`main`, `subagent`, `advisor`) or a
    /// service tier (`""` = none recorded).
    pub struct UsageKeyStat {
        pub key: String,
        pub stat: UsageStat,
    }
}

wire_struct! {
    pub struct UsageProjectStat {
        /// omp's project folder name (`-work-repo`); `""` = every other project, folded.
        pub folder: String,
        /// The project's directory, from one of its session files.
        pub cwd: Option<String>,
        pub stat: UsageStat,
    }
}

wire_struct! {
    pub struct UsageToolStat {
        pub name: String,
        pub calls: u64,
        pub errors: u64,
        /// The cost of the requests that called it, split evenly over their tool calls.
        pub cost_usd: f64,
    }
}

wire_struct! {
    /// One omp session with its subagents and advisors, within the window.
    pub struct UsageSessionStat {
        /// The main session file.
        pub file: String,
        pub id: Option<String>,
        pub title: Option<String>,
        pub cwd: Option<String>,
        /// First request start and last request end within the window.
        pub started_at: Millis,
        pub ended_at: Millis,
        pub requests: u64,
        /// Of `requests`: those of its subagents and advisors.
        pub delegated: u64,
        pub cost_usd: f64,
        pub unpriced: u64,
        pub tokens: u64,
        /// `provider/model`, most requests first (≤ 4).
        pub models: Vec<String>,
    }
}

wire_struct! {
    pub struct UsageRequestRecord {
        pub at: Millis,
        pub provider: String,
        pub model: String,
        pub cost_usd: f64,
        pub tokens: u64,
        pub folder: String,
        /// `main`, `subagent` or `advisor`.
        pub agent: String,
        pub duration_ms: Option<u64>,
    }
}

wire_struct! {
    pub struct UsageRecords {
        /// The most expensive request.
        pub priciest: Option<UsageRequestRecord>,
        /// The request with the most tokens.
        pub biggest: Option<UsageRequestRecord>,
        /// The session with the longest span between its first and last request.
        pub longest_session: Option<UsageSessionStat>,
    }
}

wire_struct! {
    /// Hour buckets with requests, ascending (columns of equal length). Bucket `h` starts at
    /// `h * 3_600_000 + hourOffset * 60_000` (epoch ms).
    pub struct UsageHours {
        pub hour: Vec<i64>,
        pub cost_usd: Vec<f64>,
        pub tokens: Vec<u64>,
        pub input: Vec<u64>,
        pub output: Vec<u64>,
        pub cache_read: Vec<u64>,
        pub cache_write: Vec<u64>,
        pub requests: Vec<u64>,
        pub errors: Vec<u64>,
        /// Requests without a price (see [`UsageStat::unpriced`]).
        pub unpriced: Vec<u64>,
    }
}

wire_struct! {
    /// Requests per hour bucket over all time (at most the last three years), for streaks and
    /// the calendar; same bucketing as [`UsageHours`].
    pub struct UsageActivity {
        pub hour: Vec<i64>,
        pub requests: Vec<u64>,
    }
}

wire_struct! {
    pub struct UsageSpan {
        pub start: Millis,
        pub end: Millis,
    }
}

wire_struct! {
    /// When agents worked. Per session (its subagents and advisors included), the spans of its
    /// requests (`[start, start + duration]`) are joined across pauses of at most 10 min, except
    /// where the human wrote in its main transcript (time waiting for the human never counts).
    pub struct UsageWork {
        /// The sessions' stretches added up (parallel sessions count each), clipped to the window.
        pub agent_ms: u64,
        /// Their union over all sessions, pauses of at most 10 min bridged, ascending, clipped to
        /// the window (≤ 500: the shortest gaps are bridged first).
        pub stretches: Vec<UsageSpan>,
    }
}

wire_struct! {
    /// The report of one host over the window `since`..`until` (absent: all time / now).
    /// `summary` fills `hours` and `totals` only.
    pub struct UsageInsights {
        /// Changes whenever any figure below can change (send it back as `have`).
        pub version: String,
        pub since: Option<Millis>,
        pub until: Option<Millis>,
        pub hour_offset: u32,
        pub hours: UsageHours,
        pub totals: UsageStat,
        /// Most expensive first.
        pub models: Vec<UsageModelStat>,
        pub providers: Vec<UsageKeyStat>,
        /// Most expensive first (≤ 12, the rest folded into `folder: ""`).
        pub projects: Vec<UsageProjectStat>,
        /// By agent type: `main`, `subagent`, `advisor`.
        pub agents: Vec<UsageKeyStat>,
        /// Subagents by name (`Explore` for a `3-Explore.jsonl` transcript), most expensive first
        /// (≤ 12, the rest folded into `key: ""`).
        pub subagents: Vec<UsageKeyStat>,
        /// By service tier (`""` = none recorded).
        pub tiers: Vec<UsageKeyStat>,
        /// Most called first (≤ 16).
        pub tools: Vec<UsageToolStat>,
        /// Most expensive first (≤ 10).
        pub sessions: Vec<UsageSessionStat>,
        /// omp sessions with requests in the window (their subagents and advisors included).
        pub session_count: u64,
        /// Subagent transcripts (task runs) with requests in the window.
        pub subagent_count: u64,
        pub records: UsageRecords,
        pub activity: UsageActivity,
        pub work: UsageWork,
    }
}
