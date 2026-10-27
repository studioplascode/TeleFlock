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
fn usage_today(&self) -> UsageTotals
```
### `OmpHandle` (`src/omp.rs`, `Clone`)
`relay_listening()`, `relay_port()`, `session(sid)`, `repoll()`, `usage_today()`.

### Launch recipe (`src/ops/agent.rs`, §3.7)
```rust
pub enum LaunchPane { Target(StartTarget), New(String) }   // From<StartTarget>; New = a root pane hostd just created
pub async fn start_agent(ctx: &Ctx, target: impl Into<LaunchPane>, spec: &AgentSpec, resume: Option<&str>) -> Result<Started, ApiError>
```
Passes `--config <home>/omp-overlay.yml` / `-e <home>/ext/teleflock-bridge.ts` only when the app deployed them.
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

## Tests
`cargo test -p tf-hostd` (unit + `tests/attach.rs` lifecycle through the real binary, no herdr needed).
Lab e2e: `examples/e2e.rs` (see its header).
