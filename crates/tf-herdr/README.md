# tf-herdr

Host-side herdr client used by `tf-hostd`. Protocol background: `docs/research/herdr.md`.
Owner: HostdHerdr. Everything is `async` (tokio); `HerdrClient` is `Clone` (an `Arc` inside).

## Client and discovery

```rust
HerdrClient::discover(session: Option<&str>) -> Result<HerdrClient>          // None = default session
HerdrClient::discover_with(session, DiscoverOptions { bin, socket, request_timeout }) -> Result<HerdrClient>
client.ensure_server() -> Result<Pong>     // ping; else spawn `herdr [--session S] server` detached (setsid, </dev/null; own systemd scope, see below), wait ≤15 s
client.ping() -> Result<Pong>              // running server's version/protocol/capabilities (cached: client.server())
client.server_at_least((0, 9, 2)) -> bool
client.status() -> Result<Status>          // `herdr status --json`
client.list_sessions() -> Result<Vec<SessionEntry>>
client.session() / binary() / endpoint()
```

- Binary search order: `$TF_HERDR_BIN`, `$HERDR_BIN_PATH`, `PATH`, `~/.local/bin/herdr`, Homebrew, linuxbrew, mise installs,
  nix profiles (mise shims skipped). Windows: `PATH`, `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe`.
- Socket: `server.socket` from `status --json`, else `<config>/herdr.sock` or `<config>/sessions/<s>/herdr.sock`
  (`<config>` = `$XDG_CONFIG_HOME/herdr` | `~/.config/herdr` | `%APPDATA%\herdr`). Windows connects to the named
  pipe `\\.\pipe\<full socket path>`.
- Inherited pane env (`HERDR_SOCKET_PATH`, `HERDR_SESSION`, ...) is stripped from every spawned CLI, so the target
  session is always explicit.
- A stopped server is not a discovery error; requests then fail with `server_not_running`.
- `durable::Scope::plan(prefix)`: on Linux with systemd, `ensure_server` starts the server through
  `systemd-run --scope --collect --unit=teleflock-herdr-<session>-<pid>-<ms>.scope` (system manager for root;
  `--user` only when the user lingers), so it and its agents survive the login session that started it. When
  `systemd-run` cannot create the unit (it exits non-zero before exec'ing) the server is started plainly.
  `durable::{cgroup_path, login_session, process_cgroup}` read `/proc/<pid>/cgroup` (tf-hostd uses them too).

## Raw requests and errors

```rust
client.request::<T: DeserializeOwned>(method: &str, params: impl Serialize) -> Result<T>   // T = Value → the `result` object
client.request_with_timeout::<T>(method, params, Duration) -> Result<T>
pub struct HerdrError { pub code: String, pub message: String }   // is(code), is_not_found(), is_server_not_running(),
                                                                  // is_dubious_ownership(), is_transient()
```

One request per connection, default 10 s end-to-end timeout (wait-style calls extend it by their own timeout + 5 s).
herdr codes pass through verbatim (`tf_herdr::code::*`). Local codes: `server_not_running` (no socket / refused),
`transport`, `timeout`, `protocol`, `binary_not_found`, `unknown_method` (0.9.0's `invalid_request` "unknown variant" is
normalised to the 0.9.2 code). Both error envelope shapes (0.9.0 id lost, 0.9.2 id kept) are handled.

## Typed helpers

| Area | Calls |
|---|---|
| session | `snapshot() -> Snapshot { workspaces, tabs, panes, layouts, agents, focused_* , version, protocol }` |
| agent | `agent_list()`, `agent_get(target)`, `agent_read(target, ReadOptions)`, `agent_send_keys(target, &[&str])`, `agent_prompt(target, text, Option<AgentWait>) -> AgentInfo`, `agent_wait(target, AgentWait)`, `agent_rename(target, Option<&str>)`, `agent_start(&AgentStart{name, kind, pane_id, args, timeout_ms}, shell_wait: Duration) -> AgentStarted{agent, argv}`, `agent_explain(target) -> AgentExplain` |
| workspace | `workspace_create(&WorkspaceCreate{cwd, label, env, focus}) -> WorkspaceCreated{workspace, tab, root_pane}`, `workspace_list()`, `workspace_get(id)`, `workspace_rename(id, label)`, `workspace_close(id, group: bool)` |
| worktree | `worktree_list(&WorktreeScope::Cwd(p) \| Workspace(id), trust) -> WorktreeList{source, worktrees}`, `worktree_create(&WorktreeCreate::new(scope){branch, base, path, label, focus, trust_repository}) -> WorktreeCreated{workspace, tab, root_pane, worktree}`, `worktree_open(&WorktreeOpen{scope, target: WorktreeTarget::Branch\|Path, ..}) -> WorktreeOpened`, `worktree_remove(ws, force, trust) -> WorktreeRemoved` |
| tab | `tab_create(&TabCreate) -> TabCreated{tab, root_pane}`, `tab_list(Option<ws>)`, `tab_get(id)`, `tab_rename(id, label)`, `tab_close(id)` |
| pane | `pane_split(&PaneSplit{target_pane_id, workspace_id, direction: SplitDirection::Right\|Down, ratio, cwd, env, focus}) -> PaneInfo`, `pane_close(id)`, `pane_read(id, ReadOptions::new(ReadSource::Visible\|Recent\|RecentUnwrapped\|Detection).ansi().lines(n)) -> PaneRead`, `pane_send_text(id, text)`, `pane_send_keys(id, &[&str])`, `pane_send_input(id, text, keys)`, `pane_run(id, cmd)` (text + Enter), `pane_process_info(id) -> ProcessInfo`, `pane_get(id)`, `pane_list(Option<ws>)`, `pane_layout(Option<pane>)` |

`agent_start` behaves like `herdr agent start`: the raw API returns while the launch is pending (prompting then
fails with `agent_not_ready`), so the helper polls `agent.get` until the agent is idle and `interactive_ready`
(within `timeout_ms`, default 30 s). `agent_pane_busy` (the pane's foreground job is not its bare shell, e.g. a fresh
shell still running its startup files) is retried every 100 ms until `shell_wait` has passed, then returned.

Models (`tf_herdr::model`, all re-exported) ignore unknown fields and default missing ones: `AgentStatus`
(`Idle|Working|Blocked|Done|Unknown`), `PaneInfo`, `AgentInfo` (`name`, `agent` kind, `agent_status`, `agent_session`,
`state_change_seq`, `terminal_title_stripped`, `tokens`, `target()`), `AgentSession` (`session_id()` parses the omp
`_<sessionId>.jsonl` suffix, `path()`), `WorkspaceInfo` (+ `worktree: Option<WorkspaceWorktree{repo_key, ..}>`),
`TabInfo`, `PaneLayout`, `WorktreeEntry`, `WorktreeSource`, `ProcessInfo{shell_pid, foreground_processes[{pid, argv, ..}]}`,
`PaneRead`, `Pong`, `Status`, `SessionEntry`.

## Events

```rust
let mut events: EventStream = client.subscribe(SubscribeOptions::default());   // all global types incl. pane.updated
while let Some(ev) = events.recv().await { match ev { HerdrEvent::Resync => /* snapshot() now */, .. } }
events.set_status_panes(vec!["w1:p1".into()]);   // per-pane pane.agent_status_changed on a 2nd connection
```

- `Resync` is always first and follows every reconnect: take a fresh `snapshot()` and apply the events after it
  (herdr has no replay). `Disconnected { error }` is reported once per outage; reconnects back off 250 ms → 10 s.
- `PaneUpdated` is coalesced to ≤ 4 Hz per pane (`SubscribeOptions::coalesce`), latest wins. Changes of
  `agent_status`, `agent` or `agent_session` pass immediately, and parked updates are flushed before any other event,
  so ordering is preserved.
- Per-pane subscription errors (`pane_not_found`) prune the dead panes (`SubscriptionError { error, dropped_panes }`)
  and re-subscribe the rest; the new status subscription is acked before the old one closes.
- Variants: `Workspace{Created,Updated,Renamed,Closed,Focused}`, `WorkspacesReordered`, `Worktree{Created,Opened,Removed}`,
  `Tab{Created,Closed,Renamed,Focused}`, `TabsReordered`, `Pane{Created,Updated,Closed,Exited,Focused,Moved,AgentDetected}`,
  `AgentStatusChanged{pane_id, workspace_id, agent, agent_status}`, `LayoutUpdated`, `Other{event, data}`.

## Terminal sessions

```rust
let s = client.terminal_session(TerminalOptions { target, mode: TerminalMode::Control | Observe, cols, rows, takeover }).await?;
let (mut events, input) = s.split();
// events: TerminalEvent::Frame(TerminalFrame { seq, full, cols, rows, bytes /* base64, as sent */ }) ... then one Closed { reason }
input.input("ls\r")?; input.input_bytes(b"\x03")?; input.resize(100, 30)?; input.scroll(ScrollDirection::Up, 3)?; input.release()?;
```

Returns after the first frame (always `full: true`); startup failures are `Err` (an existing owner without
`takeover` → `stream_conflict`). Observe sessions reject input/resize/scroll. Dropping every `TerminalInput` clone
detaches (stdin EOF); dropping the receiver kills the bridge.

## Tests

```bash
CARGO_TARGET_DIR=target/HostdHerdr cargo test -p tf-herdr                     # parsers over docs/research/herdr-samples
CARGO_TARGET_DIR=target/HostdHerdr cargo test -p tf-herdr -- --ignored --nocapture   # live: starts/stops lab session tf-lab-hh
```
