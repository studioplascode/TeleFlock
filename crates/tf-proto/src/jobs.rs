//! Background work of an omp agent and of its host (architecture §3.18).
//!
//! * **Jobs** (`jobs.*`, bridge ≥ 2.1.0 with `caps.jobs`): the async jobs of one omp session and of
//!   every subagent below it, as omp's own jobs sheet lists them: background `bash` / `eval`
//!   commands and subagents running as `task` jobs, with status, run time, output tail and omp's
//!   live job widget. [`JobsSummary`] rides on the board card (`OmpInfo.jobs`).
//! * **Services** (`services.*`): the processes omp's daemon broker supervises on the host
//!   (`omp ps`): dev servers and other named `bash` services agents started, the shared browser.

use crate::Millis;

wire_enum! {
    /// A job's state (omp `AsyncJob.status`).
    pub enum JobStatus { Running, Completed, Failed, Cancelled }
}

wire_struct! {
    /// What one glance at a job's live widget reads (omp's `jobWidgetGlance`, the figure its status
    /// line shows): the widget's headline (`140/190`, label `tests`), else the latest figure of its
    /// first chart or meter.
    pub struct JobGlance {
        pub text: String,
        pub label: Option<String>,
        /// The headline's move, e.g. `▲ 15%`.
        pub trend: Option<String>,
        /// `success` (toward better), `error` (away from it) or `muted`.
        pub trend_tone: Option<String>,
    }
}

wire_struct! {
    /// omp's live widget of a job (`JobWidgetView`), reduced to what TeleFlock draws.
    pub struct JobWidget {
        /// What is being watched (`verb-bench · 3 models`).
        pub title: String,
        pub glance: Option<JobGlance>,
        /// What the job does now: a subagent's stage, or the newest line of output.
        pub stage: Option<String>,
        /// The widget's first meter: done fraction 0..=1 and its text (`7/9 trials`).
        pub progress: Option<f32>,
        pub progress_text: Option<String>,
        /// `authoring` (omp's cheap model writes its rules), `live` (rules drive the figures) or
        /// `fallback` (last line and rates only).
        pub state: String,
        /// Epoch ms of the newest data the widget reflects.
        pub updated_at: Millis,
    }
}

wire_struct! {
    /// One background job of an omp session or one of its subagents.
    pub struct Job {
        /// omp's job id (`bg_3`; a subagent's id for `task` jobs).
        pub id: String,
        /// `bash`, `eval` or `task` (a subagent running in the background).
        pub kind: String,
        pub status: JobStatus,
        /// omp's one-line label: the command (cut to 120 characters) or the subagent's task.
        pub label: String,
        /// Full command line of a job that runs a process.
        pub command: Option<String>,
        pub started_at: Millis,
        /// When it settled (`ended_at - started_at` is its run time).
        pub ended_at: Option<Millis>,
        /// The subagent a `task` job runs (omp agent id) and its name.
        pub agent_id: Option<String>,
        pub agent_name: Option<String>,
        /// The subagent that started the job (absent: the session's main agent).
        pub owner_id: Option<String>,
        pub owner_name: Option<String>,
        /// `jobs.cancel` can stop it: it runs, and omp's session API that cancels it was found.
        pub cancellable: bool,
        pub widget: Option<JobWidget>,
        /// Inspected jobs only (`JobsListParams.inspect`): the output tail while the job runs, its
        /// result or error text once settled; at most 16 KiB, the newest part, ANSI removed.
        pub output: Option<String>,
        /// `output` is the end of a longer text.
        pub output_cut: Option<bool>,
        /// Inspected only: live pids of a running command.
        pub pids: Option<Vec<u32>>,
        /// Inspected only: exit status of a settled command.
        pub exit_code: Option<i32>,
        /// Inspected only: the folder the command started in.
        pub cwd: Option<String>,
        /// Inspected only: omp artifact holding the full output (`artifact://<id>` in the session).
        pub artifact_id: Option<String>,
    }
}

wire_struct! {
    /// `jobs.list` / `jobs.cancel`: an agent's background jobs.
    pub struct JobsView {
        /// Running jobs (oldest first), then the settled ones omp still keeps (newest first, at
        /// most 10; omp drops a settled row 30 s after its result was delivered, else after 5 min).
        pub jobs: Vec<Job>,
        /// The main agent's turn is over and only a background job's result can resume it (omp's
        /// "Waiting for background jobs").
        pub waiting: bool,
        /// Host time of the snapshot.
        pub at: Millis,
    }
}

wire_struct! {
    /// Background jobs on a board card (`OmpInfo.jobs`; absent while the session has none, and for
    /// bridges without `caps.jobs`).
    pub struct JobsSummary {
        pub running: u32,
        /// Settled jobs omp still lists.
        pub recent: u32,
        /// See [`JobsView::waiting`].
        pub waiting: bool,
        /// The glance of the running job whose live widget saw data last (what omp's status line
        /// appends to its jobs segment).
        pub glance: Option<JobGlance>,
        /// That job's label.
        pub glance_job: Option<String>,
    }
}

wire_struct! {
    pub struct JobsListParams {
        pub agent_id: String,
        /// Jobs to inspect (output tail, pids, exit code, cwd, artifact).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<String>>", optional)]
        pub inspect: Vec<String>,
        /// Inspect every listed job.
        pub inspect_all: Option<bool>,
    }
}

wire_struct! {
    pub struct JobCancelParams {
        pub agent_id: String,
        pub job_id: String,
    }
}

wire_enum! {
    /// A daemon broker scope: one per project folder, plus machine-global services.
    pub enum ServiceScopeKind { Project, Global }
}

wire_struct! {
    /// One process omp's daemon broker supervises (`omp ps`).
    pub struct Service {
        /// Unique within its scope (`web`, `omp.browser.headless`).
        pub name: String,
        pub id: String,
        /// `starting`, `running`, `ready`, `restarting`, `stopping`, `exited` or `failed`.
        pub state: String,
        pub pid: Option<u32>,
        pub created_at: Millis,
        pub started_at: Millis,
        pub ready_at: Option<Millis>,
        pub exited_at: Option<Millis>,
        pub exit_code: Option<i32>,
        pub exit_reason: Option<String>,
        pub restart_count: u32,
        /// Output bytes the broker logged.
        pub output_bytes: u64,
        /// omp session id of the agent that started it.
        pub owner: Option<String>,
        /// The board agent running that omp session, when it is on this herdr session's board.
        pub agent_id: Option<String>,
        /// The log line that made it ready (`Local: http://127.0.0.1:5173/`).
        pub ready_match: Option<String>,
        pub persist: bool,
        pub detached: bool,
        pub command: Option<String>,
        pub cwd: Option<String>,
        /// A live broker answers for it (false: read from its files after its broker died).
        pub supervised: bool,
        /// TCP ports its process tree listens on at a loopback or any address (Linux `/proc`;
        /// elsewhere the port of a loopback URL in `ready_match`): what Preview tunnels to.
        pub ports: Vec<u16>,
    }
}

wire_struct! {
    pub struct ServiceScope {
        pub kind: ServiceScopeKind,
        /// The broker's runtime folder: the scope's stable key.
        pub runtime_dir: String,
        /// Project folder of a project scope (absent when the broker never recorded it).
        pub project_dir: Option<String>,
        /// Name of a global scope (`browser-relay`, `text-predict`).
        pub service: Option<String>,
        /// The scope's broker, while one runs.
        pub broker_pid: Option<u32>,
        /// Live ones first, then exited and failed ones (newest first).
        pub services: Vec<Service>,
    }
}

wire_struct! {
    /// `services.list`: every daemon broker scope on the host and its processes (`omp ps --all`).
    pub struct ServiceList {
        pub scopes: Vec<ServiceScope>,
        pub at: Millis,
    }
}

wire_struct! {
    pub struct ServicesListParams {
        /// Ask omp again now instead of answering from the last 2 s.
        pub refresh: Option<bool>,
    }
}

wire_struct! {
    /// One service: its scope (`dir`, a project folder, or `global`, a global scope's name) and name.
    pub struct ServiceRef {
        pub dir: Option<String>,
        pub global: Option<String>,
        pub name: String,
    }
}

wire_struct! {
    pub struct ServiceLogsParams {
        pub dir: Option<String>,
        pub global: Option<String>,
        pub name: String,
        /// Newest lines to read, 1–1000 (default 200).
        pub lines: Option<u32>,
    }
}

wire_struct! {
    /// `services.logs`: the newest lines a service wrote (terminal rows for pty services).
    pub struct ServiceLogs {
        pub text: String,
        /// The process's state when the log was read.
        pub state: Option<String>,
        pub at: Millis,
    }
}
