# tf-hostd

Host daemon (architecture §3). Owners: HostdCore (everything not listed below), HostdOps
(`src/ops/{fs,git,gh,workspace,worktree,host,term}.rs`), BridgeExt (`src/bridge.rs`).

## CLI
```
tf-hostd daemon [--relay-port P]                             # exit 3 when another daemon holds the lock
tf-hostd attach [--session S] [--replace] [--relay-port P]   # stdio <-> hostd.sock, starts the daemon if needed
tf-hostd stop [--force]
tf-hostd --version                                           # "tf-hostd 0.1.0 proto 1"
```
- `TF_HOSTD_HOME` overrides `~/.teleflock` (lab: `/tmp/tf-lab-core-home`). Layout in `src/paths.rs`.
- `attach` starts the daemon detached (`setsid`, stdio null; Windows `DETACHED_PROCESS`) and waits ≤ 10 s
  for the socket. stdout carries protocol lines only; diagnostics go to stderr as `tf-hostd: …`.
  On Linux with systemd the daemon runs in its own transient scope (`teleflock-hostd-<pid>-<ms>.scope`,
  `tf_herdr::durable`; root, or a lingering user), so tearing down the attaching login session spares it;
  if `systemd-run` cannot create the unit, `attach` starts the daemon plainly.
- Several devices share one daemon, and their apps update at different times, so a host only moves
  forward (`tf_proto::version::cmp_lines`: semver, then protocol):
  - `attach --replace` (the app just installed its build) stops a running daemon whose binary identity
    (path, size, mtime) differs from its own when that daemon is older; never when it is newer; and for
    the same version only when no client is connected (`replace_policy`). A kept daemon is attached to.
  - While clients are connected, the daemon refuses `stop` from an older build, and from builds that
    predate this rule (they send no version; `daemon::stop_policy`). The refused `attach` connects to
    the running daemon instead. An idle daemon always stops; `tf-hostd stop --force` always stops it.
- One daemon serves every herdr session: the client's `hello.herdrSession` picks the session context.
- Internal control lines on the socket: `{"ctl":"info"|"stop","version":"<--version line>","force":bool}`
  (used by `stop` / `--replace`). `info` reports `version`, `exe`, `pid` and `clients` (connected now);
  a refused `stop` answers `"ok":false,"refused":"<why>"`.
- Logs: `<home>/hostd.log` (rolled to `.log.1` at 8 MiB; level via `TF_HOSTD_LOG`).

## Dispatcher contract (`src/ops/mod.rs`)
One `Ctx` per attached herdr session, shared by its clients (`Arc<Ctx>`).
```rust
pub struct Ctx {
    pub herdr_session: String,
    pub herdr: Arc<tf_herdr::HerdrClient>,
    pub state: crate::state::StateHandle,
    pub omp: crate::omp::OmpHandle,             // shared across herdr sessions
    pub bridge: crate::bridge::BridgeHandle,     // shared across herdr sessions (BridgeExt)
    pub terms: crate::ops::term::TermRegistry,   // HostdOps
    pub paths: crate::paths::Paths,
    pub relay_port: u16,
    pub sessions: crate::state::subs::SessionSubs, // session.open bookkeeping
    pub tools: crate::ops::tools::Tools,         // shared across herdr sessions: omp/herdr updater
    pub auto_answer: crate::autoanswer::AutoAnswers, // decide for me of this session (§3.23)
    pub cancel: CancellationToken,               // cancelled on shutdown
}
fn arc(&self) -> Arc<Ctx>                         // for spawned tasks
// every family:
pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<serde_json::Value, ApiError>
```
Helpers: `ops::to_value(v)`, `ops::herdr_err(HerdrError) -> ApiError`. `state.get` re-sends a snapshot.

### `ClientHandle` (`src/clients.rs`, `Clone`)
```rust
fn id(&self) -> &str
fn info(&self) -> &ClientInfo
fn send(&self, msg: ServerMsg) -> bool       // non-blocking; bounded queue; pulses dropped above 32 pending;
                                             // a client with 8192 pending lines is disconnected (it resyncs)
fn is_closed(&self) -> bool
async fn closed(&self)
```
`ClientMsg::TermIn` → `ops::term::input(ctx, client, &term_id, &data).await`;
disconnect → `ops::term::client_gone(ctx, client_id).await`.

### `StateHandle` (`src/state/mod.rs`, `Clone`, sync)
```rust
fn snapshot(&self) -> HostState
fn agent(&self, agent_id: &str) -> Option<Agent>
fn agent_by_pane(&self, pane_id: &str) -> Option<Agent>
fn omp_session_of(&self, agent_id: &str) -> Option<String>
fn activity_page(&self, before: Option<Millis>, limit: usize, agent_id: Option<&str>) -> (Vec<ActivityEvent>, bool)
fn record_activity(&self, agent_id: &str, kind: ActivityKind, title: String, detail: Option<String>)
fn refresh(&self)                            // re-pull the herdr snapshot soon (after workspace/tab ops)
fn refresh_repo(&self, cwd: &str)            // re-read git info for a folder (after commits)
fn set_info(&self, info: HostInfo)            // keeps `info.tools` (owned by set_tools)
fn set_tools(&self, tools: Option<ToolUpdates>)
fn set_auto_answer(&self, aa: AutoAnswers)    // once per context: rebuilds call `aa.observe(agent, now, apps)`
fn usage_today(&self) -> UsageTotals
```
### `OmpHandle` (`src/omp.rs`, `Clone`)
`relay_listening()`, `relay_port()`, `session(sid)`, `repoll()`, `usage_today()`.

### Launch recipe (`src/ops/agent.rs`, §3.7)
```rust
pub enum LaunchPane { Target(StartTarget), New(String) }   // From<StartTarget>; New = a root pane hostd just created
pub enum SessionArg<'a> { Resume(&'a str) }                 // --resume=<file> (never --restore: crate::restart decides what goes on)
pub async fn start_agent(ctx: &Ctx, target: impl Into<LaunchPane>, spec: &AgentSpec, session: Option<SessionArg<'_>>) -> Result<Started, ApiError>
```
Passes `--config <home>/omp-overlay.yml` / `-e <home>/ext/teleflock-bridge.ts` only when the app deployed them.
`spec.roleModels` / `spec.fallbackChains` (validated first) become the agent's own overlay
`<home>/agent-config/<id>.yml`, passed as a second `--config` right after it; with `roleModels.default`
the agent gets neither `--model` nor `--thinking` (`omp_args`).
A busy shell (herdr `agent_pane_busy`) is waited for 45 s in a pane hostd made (`New`, `Workspace`, `Cwd`) and 2 s in
a pane the client picked (`StartTarget::Pane`), then fails as a retryable `busy`; the agent gets 90 s to become
interactive and the first prompt/plan mode 90 s for the collab link.

## Behavior summary
- **Board** (`state/`): herdr snapshot + coalesced events (re-snapshot debounced on structure changes),
  replicas, bridge, git (per worktree; on turn ends, cwd changes and connects, 5 min while clients are
  connected) → `HostState`; patches ≤ 10 Hz, one rev per message; pulses per 100 ms. Columns, needs and
  notifications per §3.5; archive/turns/activity/usage in `state.json` (compact; usage-only changes ≤ 1/min).
- **omp** (`omp.rs`): relay on `127.0.0.1:<relay-port>`, registry poll every 1.5 s, one guest + replica per
  room on our relay (rooms on other relays are `notShared`), session events coalesced to one flush / 50 ms
  (`meta` ≤ 2/s per session, the tree only when it changed for apps ≥ 0.5.1)
  and ordered with the `session.open` snapshot. Agents map by herdr `agent_session` id, cross-checked by pid.
- **Controls** (`ops/agent.rs`): collab → bridge → injection (`inject.rs`, §3.6: idle, composer visible,
  no draft, catalog-only canonical commands, re-read + one extra `enter`).
- **The agent's own omp settings** (`agentcfg.rs`, `ops/roles.rs`, §3.7): `agentcfg::Store` keeps
  `<home>/agent-config/agents.json` (herdr session → agent id → overlay file + role/chain maps) and renders
  the per-agent overlays from it (`prepare` before launch, `bind` after, `discard` on failure, `set`/`restore`
  for `agent.setRoleModels`, `forget` on resume, `sweep` from the prune pass for agents gone from the board).
  `agent.getRoleModels` / `agent.setRoleModels` go to the bridge (`caps.roleModels`), else `unsupported`.
- **Flock Wrapped** (`ops/wrapped/`, §3.19): `host.wrapped {since, until?, hourOffset?, refresh?}` reads the
  week's agents, work, busy stretches, model speeds and subagents from `ops::usage::usage_report`, counts the
  automation runs, and (`code.rs`) gathers commits (`git log --all --no-merges`, your `user.email`, not
  GitHub's merge commits, no lock files) and merged pull requests (`gh pr list --author @me`) in the
  repositories the agents worked in, in the background: single-flight per window, reused 5 min, a request
  waits ≤ 6 s and otherwise answers `pending`.
- **Notifications that find you** (`notify/`, §3.21): `Notifier` (daemon-wide, `ctx.notify`) keeps every app
  past its hello with its `presence`; the state store's `notify` hands notifications to `Notifier::post`,
  which marks them `alert` for the device in use (else the phones), arms escalation for unseen needs-you,
  error and stall notifications (`notifyAlert`; push channels set to `unseen`), retracts reads on the other
  apps (`notifyDone`) and pushes to the channels in `<home>/notify.json` (ntfy, Pushover, webhook;
  `curl -q -K -`, secrets on stdin; burst 5, then one per 20 s, the rest as one summary). With a channel on,
  `notify::start` (daemon start) opens the known sessions so pushes go out before any app connects.
  `notify.config|setPolicy|saveChannel|removeChannel|test`; `presence(session)` / `any_app_connected`.
- **Decide for me** (`autoanswer/`, §3.23): `core.rs` is the pure state machine (policies: host default +
  own per agent; one countdown per agent with an answerable `ask` that has a ★ recommended option; clock
  stops while an app is connected under `onlyWhenNoApp` and for 60 s after the context starts; cancel,
  postpone, sweep); `store.rs` keeps `<home>/auto-answer.json`; `mod.rs` holds `AutoAnswers` (per session,
  `ctx.auto_answer`), the worker that answers at the deadline through the session's data path (as
  `agent.answer`), records activity `answered` "Auto-answered ★ …" and notifies, the four methods and the
  daemon-start hook that opens sessions with something to watch. Lock order: state store, then decide for me.
- **Auto-resume tickets** (`recovery.rs`, §3.22): daemon-wide `recovery::get()`; tickets per herdr session and
  root omp session in `<home>/autoresume.json` with the host setting (`enabled`, `subscribe()`), kinds
  `usageLimit` / `rateLimit` / `restart`. `open` / `close` / `ticket` for detection; `attach` puts
  `Agent.autoResume` on cards (parked too) in the board rebuild; the worker runs due tickets through the
  kind's executor (`rescheduled` = too early, not counted; `gone` = the agent's omp went away: Resume by
  hand), retries retryable failures 3× and closes tickets whose agent works again, was marked done, moved
  to another host or has no card for 10 min. `agent.autoResumeNow|Cancel`, `host.autoResume|Set`.
- **Limit stops** (`limit_resume.rs`, §3.22): bridge `turn_error` (usage / rate limit, after omp gave up)
  → the root session's ticket; `resumeAt` from omp's usage report over every account of the provider
  (`ops::limits::limits_for`, no `Ctx`): another account has room → 1 min, else the earliest reset + 2 min,
  else the provider's retry-after + 30 s, else 15 → 30 → 60 min; a rate limit on an account out of usage is
  a usage limit; an overloaded / failing provider (HTTP 529, 503, 5xx) gets kind `overloaded` /
  `providerError` and plain backoff. Reconcile after a restart (`failedTails`, `reconcilable`): only stops
  ≤ 12 h old, a subagent's only while its parent and the root still wait for it (`went_on` reads their
  transcripts; fixtures in `src/testdata/resume/`). `setAutoResume` pushed to every 2.1.0 bridge,
  `intervened` (prompt, Stop, model, new session, Mark done close the ticket), `agent.retry` (`retry` / `f5`:
  bridge 2.1.0 `retry`, else TUI `/retry`, else `/retry` injected while idle).
- **Bring agents back** (`restart/`, §3.25): a per-session worker (`start_session`) keeps the agent ledger
  (`ledger.rs`, `<home>/ledger.json`: every live omp agent with its card record, pane, process and command
  line, own settings and policy copies, what it was doing, boot and herdr server). An entry whose omp is
  gone without anyone closing it (herdr down per `herdr_health`, another boot or herdr server, omp gone from
  a pane that is still there, a pane that died) becomes an ended card (`Parked.ended`, Review) with a plan
  (`decide.rs` over `detect.rs`'s facts: what omp's restore would repeat, the calls that never returned, a
  reply cut off by a signal, subagents cut off mid-turn or in a reply); herdr going down makes the cards at
  once (`restart::herdr_down`, called by `herdr_health` right before `herdr_gone`; plans follow), and a
  `restart` ticket per ended card opens while herdr runs. `continue_session` (the executor) relaunches with
  `--resume` under its name (`ops::agent::resume_parked`; its restored pane when that is a shell), never
  while an omp runs the session (`herdr::omp_running` and the ledger's recorded process,
  `restart::still_running`, checked by `resume_parked` too), waits for a built board, replaces a limit
  ticket on an ended card with its restart, takes over an omp someone else started
  (`launch::restart_in_place`, rechecking the pid's command line before SIGTERM, when it lacks TeleFlock's launch), starts an agent ended in its first turn
  (no session file yet) as a new session with its prompts (`start_fresh`), and once it is live on its
  bridge goes on by the plan: selective `restore` (`caps.restoreSelect`) of what only reads and of
  subagents' cut-off replies, `retry` of a cut-off reply, one note otherwise (at most once; the plan is put
  back only when the error proves omp never got the call). An agent that ended more than three times in 10
  minutes, an omp stopped with SIGTERM/SIGINT, and a pane lost while hostd was not watching wait for
  Continue (`Entry.hold`, `Entry.ends`). An ended card whose omp never saved its session (its first turn was
  cut off) is never started again by itself: its ticket is manual (`restart_hold`), the ledger keeps its
  prompts and images (`restart/images.rs`, `<home>/ledger-images/`), and Continue or a prompt on the card
  (`session.open` shows the ledger's prompts) goes through `start_fresh`: a new agent by the normal
  `start_agent` with the kept prompt and images, guarded by `Entry.launching` against a second start (`busy`
  "It is starting again as <name>"). The old card and entry stay until the new agent's session file exists
  (`Worker::launched`), so a hostd that dies in between leaves the card, never a resend. The card is never
  pruned for lack of a file.
  `launch::after_timeout` renames an agent herdr's start timed out on. `herdr.rs` reports `--resume` with
  TeleFlock's flags to herdr (`pane.report_agent_session` `resume_argv`, herdr ≥ 0.9.4) and rebinds the
  agent's own settings to a restored pane. `restart::start` opens the ledger's herdr sessions at daemon
  start; the systemd keepalive stays while the ledger has agents and the host setting "Bring agents
  back after a reboot" is on (default; `autoresume.json` `bringBack`; real home only, else
  `TF_HOSTD_KEEPALIVE=1`; `host.autoResume` reports `bootService`: systemd with root or lingering only).
  Stores are fsynced (`paths::write_atomic`) and an unreadable `state.json` or `ledger.json` is set aside
  as `.bad-<ms>`, never overwritten; an unreadable `autoresume.json` is copied to `.bad-<ms>` and replaced
  at once, atomically (the primary is never moved away), by the fail-closed settings (auto-resume and
  bring-back off, `AutoResumeConfig.notice` says why), so every later start stays closed.
- **herdr's server lifecycle** (`herdr_health/`, §3.29): a worker per herdr session context probes the
  server every 1.5 s (peer pid + start time = one instance; `epoch` bumps per new instance), drops the
  dead herdr view at once when it is gone (`StateHandle::herdr_gone`), starts it again (2 s, 5 s, 15 s, then
  60 s; per-host `autoRestart`), and loads a newer installed herdr once the session was idle for
  `idleMinutes` (live handoff, else stop + start; `idle.rs` lists what blocks). Servers TeleFlock starts read
  `<home>/herdr-config.toml` (`HERDR_CONFIG_PATH`: the user's config with `resume_agents_on_restore = false`).
  `subscribe` / `current` for agent recovery, `down_error` for requests, `HostInfo.herdrHealth` for apps.

## Tests
`cargo test -p tf-hostd` (unit + `tests/attach.rs` lifecycle through the real binary, no herdr needed).
Lab e2e: `examples/e2e.rs` (see its header); decide for me: `examples/e2e_autoanswer.rs` (real omp in a lab; its mock model and omp settings in `src/autoanswer/testdata/`).
Agent recovery: `cargo test -p tf-hostd restart recovery` (session facts, the decision table and note, the ledger, never-double-launch, names, start-timeout rename, herdr's argv rules, ticket policy); lab `examples/e2e_lifeboat.rs` (see its header).
herdr lifecycle: `cargo test -p tf-hostd herdr_health` (state machine, idle gating, managed config, stale saved sessions).
