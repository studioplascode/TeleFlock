# herdr for TeleFlock: implementation-grade map

Target: **herdr 0.9.0** (installed at `/root/.local/bin/herdr`, protocol 22, API schema_version 1, endpoint generation 1).
Source: `.research/herdr-src`, a shallow clone checked out at tag `v0.9.0` (b99002ac). Upstream HEAD at research time was 0.9.5 (143bf5f). The objects are still in the clone, so `git -C .research/herdr-src show 143bf5f:<path>` reads the newer code.
Samples: `docs/research/herdr-samples/` contains real outputs from lab session `tf-lab-herdr`. `help-all.txt` holds every subcommand's `--help`.

Evidence tags:
- **[observed]**: I ran it on this host.
- **[source]**: read in code or docs. Paths are relative to `.research/herdr-src/` unless stated. `docs/…` means `docs/next/website/src/content/docs/…`, which at tag v0.9.0 is the 0.9.0 documentation.
- **[inferred]**: my conclusion, not directly verified.

---

## 0. TL;DR for the architecture

1. **Transport.**
   - **No long-lived JSON connection.** The API socket is **one request per connection**. The server answers once and then closes; a second pipelined request gets `ECONNRESET` [observed]. The only exceptions are `events.subscribe` and the wait methods, which keep their connection open.
   - **No herdr relay needed for request/response.** Run each call as a separate SSH exec, `herdr --session S <cli…>`. The CLI prints the same JSON envelope as the socket and costs about 1.2 ms per call on the host [observed: 20 calls in 24 ms].
2. **Events.**
   - **A push stream exists:** `events.subscribe`. It needs a raw socket connection, and **Tailscale SSH has no `direct-streamlocal`** (tailscale/tailscale#6232, still open) [source]. So the stream has to be bridged through an exec channel:
     - on 0.9.0: `nc -U <sock>` or a python3 one-liner [observed: both work];
     - on 0.9.1 and later: `herdr remote-api-bridge` [source].
   - Better: let the TeleFlock host relay (already planned for omp collab) hold the subscription and coalesce it [inferred].
3. **Terminal.** `herdr terminal session control <pane> --cols C --rows R` is a **JSON-lines stdio protocol** made for bridges:
   - stdout carries base64 ANSI frames;
   - stdin carries `terminal.input`, `terminal.resize`, `terminal.scroll` and `terminal.release`.

   It runs over a plain exec channel with no PTY [observed], and is the right xterm.js feed. Frames are herdr re-renders of the viewport (CUP + `2J` + synchronized output), not raw PTY bytes.
4. **Agent state.**
   - **States:** `working`, `blocked`, `idle`, `done` (= idle and not yet seen by a herdr client) and `unknown`.
   - **omp reports them itself** through `~/.omp/agent/extensions/herdr-omp-agent-state.ts`, from the **root TUI session only**. Herdr does not screen-scrape omp (`screen_detection_skipped: full_lifecycle_hook_authority`) [observed].
   - **Board mapping:** Running = `working`, Needs you = `blocked`, In review = `done`, Done = `idle`.
5. **Correlation key to omp.** `agent_session.value` is the omp session file. Its name ends in `_<sessionId>.jsonl`, and that `sessionId` matches `omp collab list --json` `.sessionId` (confirmed by ResearchOmpCollab). `pane process-info` gives the omp pid as a cross-check.

---

## 1. Versions and compatibility detection

| Probe | Output | Notes |
|---|---|---|
| `herdr --version` | `herdr 0.9.0` | Version of the binary [observed] |
| `herdr status --json` | `{client:{version,channel,protocol,endpoint_protocol_generation,endpoint_capabilities[],binary,session}, server:{status,running,version,protocol,capabilities{live_handoff,detached_server_daemon,endpoint_protocol_generation,surface_interest,health_check},compatible,endpoint_compatible,socket,session,restart_needed,server_binary_stale}, update:{restart_needed,server_binary_stale}}` | Samples: `status-lab.json`, `status-not-running.json` [observed] |
| `herdr status server --json` / `status client --json` | the `server` / `client` halves | `status-server-lab.json`, `status-client.json` [observed] |
| raw `{"id":"x","method":"ping","params":{}}` | `{"id":"x","result":{"type":"pong","version":"0.9.0","protocol":22,"capabilities":{…}}}` | `raw-ping.json`; reports the **running server**, not the binary on PATH [observed] |
| `herdr api schema` | `protocol: 22`, `schema_version: 1`, schemas `error_response, event, request, subscription_event, success_response` | `--json` prints the full JSON Schema (`api-schema.json`, 275 KB, 102 methods) [observed] |
| `session.snapshot` / `herdr api snapshot` | includes `version` and `protocol` | [observed] |

**Recommended remote compatibility check.** This mirrors what herdr itself does in `src/remote/attach.rs:702-909` [source]:

1. `uname -s; uname -m`. herdr supports Linux and macOS hosts on x86_64 and aarch64 only. Windows is never a `--remote` target [source: `docs/windows-beta.mdx`].
2. **Locate the binary.** Run `command -v herdr` in the login shell, then again through `/bin/sh` (non-POSIX shells reject `command -v`). Then try these candidates in order:
   - `$HOME/.local/bin/herdr` (the installer default; on this host it is **not on PATH in a non-login exec** [inferred, verify per host])
   - `/opt/homebrew/bin/herdr`
   - `/usr/local/bin/herdr`
   - `/home/linuxbrew/.linuxbrew/bin/herdr`
   - `~/.local/share/mise/installs/herdr/<v>/bin/herdr`
   - `~/.nix-profile/bin/herdr`
   - `/etc/profiles/per-user/$USER/bin/herdr`
   - `/run/current-system/sw/bin/herdr`

   Ignore `…/mise/shims/herdr` [source `attach.rs:773-875`].
3. **Run `"$H" status --json`:**
   - `server.running`: if false, start the server (§2).
   - `server.version`: require `>= 0.9.0` for the TeleFlock feature set.
   - `server.compatible` / `endpoint_compatible`: compare with the binary.
   - `update.restart_needed` / `server_binary_stale`: true means the binary on disk is newer than the running server. Gate methods on the **server** version from `ping`, not on `api schema`, which describes the binary.
4. **JSON API compatibility rules** [source `docs/socket-api.mdx:936-952`]:
   - Ignore unknown fields.
   - Treat unsupported methods as normal errors.
   - The numbered protocol (22) only matters for the binary client protocol (attach and handoff).
   - On 0.9.0 an unknown method returns `{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `x`, expected one of …"}}`. **The id is lost**, so correlate by connection, which is easy because there is one request per connection [observed].
   - 0.9.2 changed two things: the original request ID is kept in errors, and unknown methods return `unknown_method` [source: CHANGELOG 0.9.2].

**Version deltas that matter.** From the upstream CHANGELOG [source `git show 143bf5f:CHANGELOG.md`]:

| Version | Change |
|---|---|
| 0.9.1 | `herdr --machine <label> <cmd>` CLI forwarding and `herdr remote-api-bridge` (stdio to API socket) were added. `agent focus` now moves attached clients. |
| 0.9.2 | `pane.graphics.*` was removed (`unknown_method`). `terminal session control` accepts `terminal.mouse`. Subscriptions now return an `events_lost` error instead of silently dropping events. Panes set `TERM_PROGRAM=herdr`. Error responses keep the request id. |
| 0.9.4 | Performance and restore fixes only, nothing API-breaking. |

---

## 2. Lab session (verified recipe)

```bash
# START (detached, survives the caller; </dev/null + setsid are REQUIRED)
cd ~ && setsid -f herdr --session tf-lab-herdr server </dev/null >/tmp/tf-lab-herdr.out 2>&1
# CHECK
herdr --session tf-lab-herdr status server --json      # → "running":true, socket …/sessions/tf-lab-herdr/herdr.sock
# USE
herdr --session tf-lab-herdr workspace create --cwd /tmp --label lab --no-focus
herdr --session tf-lab-herdr agent start labomp --kind omp --pane w1:p1 -- --model openai-codex/gpt-6-luna:low
# STOP / DELETE
herdr session stop tf-lab-herdr --json                  # {"session":{…,"running":false},"stopped":true}
herdr session delete tf-lab-herdr --json                # only after stop; else session_delete_failed
```

- **Detaching matters** [observed]. `(setsid nohup herdr … server &)` with no stdin redirect died silently: the socket never appeared and the output was empty. `setsid -f … </dev/null` works. Run in the foreground, the server prints its api socket, client socket and log paths.
  - Server log: `~/.config/herdr/sessions/<name>/herdr-server.log`.
  - Headless default size: 120x40 (`[server] headless_cols/rows`) [observed + `default-config.toml`].
- **`--session` beats inherited env** [observed + source `src/session.rs:80-181`]. Socket resolution order:
  1. `--session <name>`
  2. `HERDR_SOCKET_PATH`
  3. `HERDR_SESSION`
  4. the default session socket

  Inside an orchestrator pane (`HERDR_SOCKET_PATH=/root/.config/herdr/herdr.sock`), `herdr --session tf-lab-herdr status server --json` reported the lab socket. Without the flag, the **CLI targets the default session through the inherited `HERDR_SOCKET_PATH`**, so always pass `--session`. `herdr server stop` is the default session's stop; use `herdr session stop <name>`.
- **Pane env in the lab** [observed]:
  - `HERDR_SESSION=tf-lab-herdr`
  - `HERDR_SOCKET_PATH=…/sessions/tf-lab-herdr/herdr.sock`
  - a fresh `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`
  - `HERDR_ENV=1`, `HERDR_BIN_PATH`, `TERM=xterm-256color`, `COLORTERM=truecolor`

  Herdr-managed variables override caller `--env` [source `docs/socket-api.mdx:301-305`].
- **Broadcast.** The recipe was sent to `agent://all`, including ResearchOmpCollab and ResearchOmpSurface.
- **Lab state left running:**
  - `tf-lab-herdr` with w1 (omp agent `labomp2` on w1:p1), w2 (shells), w3 (repo `/tmp/tf-lab-repo`) and w6 (linked worktree `feat/y` at `/root/.herdr/worktrees/tf-lab-repo/feat-y`);
  - an event probe writing to `/tmp/tf-events.log` (it exits after 30 minutes).

---

## 3. CLI surface

**General rules** [observed]:
- **Success:** most subcommands print one JSON envelope `{"id":"cli:<area>:<verb>","result":{"type":…}}` on **stdout** and exit 0.
- **Silent on success:** `pane send-text`, `pane send-keys`, `pane run` and `pane report-metadata` print nothing and exit 0. `agent send-keys` prints `{"result":{"type":"ok"}}`.
- **API errors:** the JSON envelope `{"error":{"code","message"},"id":"cli:…"}` goes to **stderr**, exit 1. Samples: `error-*.json`.
- **Usage errors:** plain-text usage on stderr, exit 2.
- **Text-only commands:** `integration status`, `herdr status` without `--json`, and `pane read` / `agent read` (raw text by default) are not JSON.
- **The trailing help footer** ("Are you an AI?…") appears only on `--help`.

| Area | Commands and flags (0.9.0) | JSON? | Sample |
|---|---|---|---|
| status | `status [server\|client] [--json]` | with `--json` | `status-*.json` |
| api | `api snapshot`; `api schema [--json] [--output PATH]` | yes / `--json` | `api-snapshot.json`, `api-schema.json` |
| workspace | `list`, `create [--cwd P] [--label T] [--env K=V]… [--focus\|--no-focus]`, `get <id>`, `focus <id>`, `rename <id> <label…>`, `report-metadata <id> --source ID [--token N=V] [--clear-token N] [--seq N] [--ttl-ms N]`, `close <id> [--group]` | yes | `workspace-*.json`, `raw-workspace-list.json` |
| worktree | `list [--workspace ID\|--cwd P] [--trust-repository]`, `create [--workspace\|--cwd] [--branch N] [--base REF] [--path P] [--label T] [--focus\|--no-focus] [--trust-repository]`, `open [--workspace\|--cwd] (--path P\|--branch N) [--label] [--focus] [--trust-repository]`, `remove [--workspace ID] [--force] [--trust-repository]` | yes | `worktree-*.json` |
| tab | `list [--workspace]`, `create [--workspace] [--cwd] [--label] [--env]… [--focus]`, `get`, `focus`, `rename <id> <label…>`, `close` | yes | `tab-*.json` |
| pane | `list [--workspace]`, `current [--pane\|--current]`, `get <id>`, `layout`, `process-info`, `neighbor/focus/resize --direction`, `edges`, `zoom [--toggle\|--on\|--off]`, `read <id> [--source visible\|recent\|recent-unwrapped\|detection] [--lines N] [--format text\|ansi\|--ansi] [--raw]`, `rename <id> [label…\|--clear]`, `input --right-click herdr\|pane`, `split [<id>] [--direction right\|down] [--ratio F] [--cwd] [--env] [--focus]`, `swap`, `move`, `close <id>`, `send-text <id> <text>`, `send-keys <id> <key…>`, `wait-output <id> (--match T\|--regex R) [--source] [--lines N] [--timeout MS] [--raw]`, `run <id> <cmd…>`, `report-agent`, `report-agent-session`, `release-agent`, `report-metadata` | yes, except read (text), send-*/run/report-metadata (silent) | `pane-*.json`, `pane-read-*` |
| agent | `list`, `get <target>`, `read <target> [--source] [--lines] [--format\|--ansi]`, `send-keys <target> <key…>`, `prompt <target> <text> [--wait] [--until S]… [--timeout MS]`, `rename <target> <name>\|--clear`, `focus <target>`, `wait <target> [--until S]… [--timeout MS]`, `attach <target> [--takeover]`, `start <name> --kind K --pane ID [--timeout MS] [-- args…]`, `explain [target] [--json] [-v]` | yes, except read and attach | `agent-*.json` |
| terminal | `attach <terminal_id> [--takeover]` (TUI, PTY required); `session control <target> [--takeover] [--cols N] [--rows N]`; `session observe <target> [--cols] [--rows]`; `title set\|clear` | `session *` emits JSON lines | `terminal-session-*.jsonl` |
| notification | `show <title> [--body T] [--position top-left\|…] [--sound none\|done\|request]` | yes | `notification-show.json` |
| session | `list [--json]`, `attach <name>`, `stop <name> [--json]`, `delete <name> [--json]` | with `--json` | `session-list.json` |
| machine | `list [--json]`, `add <ssh_target> --label L [--remote-session N]`, `rename <id> --label L`, `remove <id>`, `enable <id>`, `disable <id>` | `list --json` | `machine-list.json` (`[]`) |
| integration | `install\|uninstall <target>`, `status [--outdated-only]` | **no JSON** (raw API `integration.list` is JSON) | |
| server | `herdr server` (run headless), `stop`, `reload-config`, `agent-manifests [--json]`, `update-agent-manifests [--json]`, `reload-agent-manifests` | `--json` | `server-agent-manifests.json` |
| config | `check`, `reset-keys` | text | |
| plugin | `install`, `uninstall`, `link`, `unlink`, `enable`, `disable`, `list`, `config-dir`, `action`, `log`, `pane` (hidden from top-level help) | | |

**Targets** [observed + source `docs/agents.mdx:119`]:
- Agent targets are a unique live agent **name** or a pane id. Terminal ids and bare kind labels are not accepted.
- Pane ids look like `w1:p1`, tab ids `w1:t1`, terminal ids `term_<hex>`.

**Error codes.** The full list comes from grepping `code:` literals in `src/` (140 codes). The ones TeleFlock must handle, grouped:

| Area | Codes |
|---|---|
| Server and request | `server_not_running`, `invalid_request`, `invalid_params`, `timeout` |
| Lookup | `not_found`, `pane_not_found`, `workspace_not_found`, `tab_not_found`, `agent_not_found`, `agent_target_ambiguous`, `agent_name_taken` |
| Agent | `agent_blocked`, `agent_prompt_stalled`, `agent_pane_busy`, `agent_start_failed`, `unsupported_agent_kind`, `invalid_key`, `pane_send_failed` |
| Worktree and workspace | `not_git_worktree`, `worktree_list_failed`, `worktree_create_failed`, `worktree_open_failed`, `worktree_remove_failed`, `worktree_not_found`, `dirty_worktree_requires_force`, `workspace_group_close_required` |
| Other | `stream_conflict`, `feature_disabled`, `platform_unsupported` |

Observed messages:
```json
{"error":{"code":"server_not_running","message":"no herdr server is running at /root/.config/herdr/sessions/tf-lab-nonexistent/herdr.sock; run `herdr session attach tf-lab-nonexistent` to start or attach it"},"id":"cli:workspace:list"}
{"error":{"code":"agent_blocked","message":"agent w1:p1 is blocked and requires interactive input"},"id":"cli:agent:prompt"}
{"error":{"code":"timeout","message":"timed out waiting for agent status"},"id":"cli:agent:wait"}
{"error":{"code":"agent_pane_busy","message":"agent target pane w1:p1 is not an available shell"},"id":"cli:agent:start"}
```

---

## 4. Socket API

### Transport [source `src/ipc.rs:35-79`, `src/session.rs:157-185`, `docs/socket-api.mdx:652-693`]

| Platform | API socket | Client (binary) socket |
|---|---|---|
| Linux/macOS default | `~/.config/herdr/herdr.sock` (`$XDG_CONFIG_HOME/herdr/…` if set) | `~/.config/herdr/herdr-client.sock` |
| Named session | `~/.config/herdr/sessions/<name>/herdr.sock` | `…/sessions/<name>/herdr-client.sock` |
| Windows | Named pipe `\\.\pipe\` + the **full path string** `%APPDATA%\herdr\herdr.sock`. herdr also writes a marker file at that path. Config dir order: `%XDG_CONFIG_HOME%\herdr` → `%APPDATA%\herdr` → `%USERPROFILE%\AppData\Roaming\herdr` | same scheme |

The Windows form `\\.\pipe\${HERDR_SOCKET_PATH}` is confirmed by the omp extension (`herdr-omp-agent-state.ts:13-14`).

### Framing [observed]

- Newline-delimited JSON, UTF-8. Request: `{"id":"<string>","method":"<dot.name>","params":{…}}`. `params` is required; send `{}` when empty.
- **One request per connection.** The server writes one response line and closes. Pipelining three pings returned one pong, then `ECONNRESET`. The herdr client also opens a new connection per request (`src/api/client.rs:50-61`).
- **Long-lived connections** are only `events.subscribe` (ack, then events forever). `events.wait`, `agent.wait`, `agent.prompt` with `wait`, and `pane.wait_for_output` hold the connection until they match or time out.
- **Response:** `{"id":…,"result":{"type":"<snake_type>", …}}` or `{"id":…,"error":{"code","message"}}`.

### Methods (0.9.0, 102)

`ping`, `server.stop`, `server.live_handoff`, `server.reload_config`, `server.agent_manifests`, `server.reload_agent_manifests`, `notification.show`, `product_announcement.dismiss`, `release_notes.dismiss`, `command.invoke`, `client.window_title.set`, `client.window_title.clear`, `client_shell.surface.set`, `session.snapshot`, `workspace.{create,list,get,focus,rename,move,move_block,report_metadata,close}`, `worktree.{list,create,open,remove}`, `tab.{create,list,get,focus,rename,move,close}`, `agent.{list,get,read,explain,send_keys,rename,view.set,view.clear,focus,start,prompt,wait}`, `pane.{split,swap,move,zoom,layout,process_info}`, `layout.{export,apply,set_split_ratio}`, `pane.{neighbor,edges,focus_direction,resize,scroll,edit_scrollback,selection.read,copy_motion,copy_search,list,current,get,focus,input.set,link.activate,rename,send_text,send_keys,send_input,read,graphics.set,graphics.clear,graphics.info,report_agent,report_agent_session,report_metadata,clear_agent_authority,release_agent,close}`, `popup.close`, `events.subscribe`, `events.wait`, `pane.wait_for_output`, `integration.{list,install,uninstall}`, `plugin.{link,list,unlink,enable,disable,action.list,action.invoke,log.list,pane.open,pane.focus,pane.close}`.

Source: `jq '.schemas.request.oneOf[].properties.method.const' api-schema.json` [observed].

### Key request schemas (from `api-schema.json` `$defs`) [observed]

```jsonc
AgentPromptParams   {target, text, wait?: {until?: AgentStatus[], timeout_ms?}}
AgentStartParams    {name, kind, pane_id, args?: string[], timeout_ms?: 3001..300000}
AgentTarget         {target}                         // agent.get/read/focus/explain…
PaneReadParams      {pane_id, source: "visible"|"recent"|"recent_unwrapped"|"detection", format?: "text"|"ansi", lines?, strip_ansi?: true}
PaneSendInputParams {pane_id, text?, keys?: string[]}   // text, then keys, in one call
WorkspaceCreateParams {cwd?, label?, env?: {K:V}, focus?: false, source_workspace_id?}
WorktreeCreateParams  {workspace_id?|cwd?, branch?, base?, path?, label?, focus?: false, trust_repository?}
EventsSubscribeParams {subscriptions: Subscription[]}
EventsWaitParams      {match_event: EventMatch /* {"event":"pane_created",…} */, timeout_ms?}
```

Key strings for `send_keys` / `send_input.keys`: printable keys, `enter`, `esc`, `tab`, `ctrl+x`, `alt+x`, `shift+tab`, `f1`, `minus`, `plus`. `prefix+` bindings are not accepted [source `docs/socket-api.mdx:136-140`]. Text goes in as a bracketed paste when the app enabled bracketed paste; otherwise as raw bytes [source `src/app/api_helpers.rs:24-31`].

### Response shapes (captured)

- `ping`: `{"type":"pong","version":"0.9.0","protocol":22,"capabilities":{…}}` (`raw-ping.json`)
- `session.snapshot`: `{"type":"session_snapshot","snapshot":{"version","protocol","focused_workspace_id","focused_tab_id","focused_pane_id","workspaces":[…],"tabs":[…],"panes":[PaneInfo],"layouts":[PaneLayoutSnapshot],"agents":[AgentInfo]}}`. Size: 3.6 KB in the lab, 7.9 KB on the user's default session (`api-snapshot.json`).
- `PaneInfo` keys: `pane_id, terminal_id, workspace_id, tab_id, focused, agent?, agent_status, agent_session?, cwd, foreground_cwd?, label?, revision, scroll{offset_from_bottom,max_offset_from_bottom,viewport_rows}, terminal_title?, terminal_title_stripped?, title?, display_agent?, state_labels?, tokens?`
- `AgentInfo` keys: the PaneInfo set minus `scroll`/`label`, plus `name, interactive_ready, launch_pending?, screen_detection_skipped, state_change_seq`.
- Workspace: `{workspace_id, number, label, focused, active_tab_id, pane_count, tab_count, agent_status (rollup), worktree?{checkout_path,is_linked_worktree,repo_key,repo_name,repo_root}, tokens?}`.
- Tab: `{tab_id, workspace_id, number, label, focused, pane_count, agent_status}`.
- `pane.read`: `{"type":"pane_read","read":{pane_id,workspace_id,tab_id,source,format,text,revision:0,truncated}}`. `revision` is always 0 [observed].

### Event subscriptions (push stream): YES

Request (one connection, held open):
```json
{"id":"sub","method":"events.subscribe","params":{"subscriptions":[{"type":"workspace.created"},{"type":"pane.updated"},{"type":"pane.agent_status_changed","pane_id":"w1:p1"}]}}
```

**Subscription types** [observed in schema]:
- **Global, no params:**
  - workspace: `workspace.created|updated|metadata_updated|renamed|moved|reordered|closed|focused`
  - worktree: `worktree.created|opened|removed`
  - tab: `tab.created|closed|focused|renamed|moved`
  - pane: `pane.created|closed|updated|focused|moved|exited|agent_detected`
  - `layout.updated`
- **Per pane:**
  - `pane.agent_status_changed {pane_id, agent_status?}`
  - `pane.scroll_changed {pane_id}`
  - `pane.output_matched {pane_id, source, match:{type:"substring"|"regex",value}, lines?, strip_ansi?}`

  `pane_id` is **required** for these. Omitting it fails the whole request with `invalid_request`.

**Wire behavior** [observed, `events-subscribe-sample.log`, probe `subscribe-probe.py`]:
- **Ack:** `{"id":"sub","result":{"type":"subscription_started"}}`. No replay of past events.
- **Event envelope:** `{"event":"<name>","data":{…,"type":"<name>"}}`.
- **Naming is inconsistent.** Lifecycle events use snake_case (`pane_updated`, `pane_created`, `workspace_created`, `tab_focused`, `layout_updated`, `pane_agent_detected`, `pane_exited`, `worktree_created|opened|removed`, `workspace_closed`). The per-pane ones use dot names (`pane.agent_status_changed`, `pane.scroll_changed`).
- **Payloads:**

  | Event | Payload |
  |---|---|
  | `pane_updated` | full PaneInfo, including `agent_status`, `terminal_title`, `tokens` |
  | `pane.agent_status_changed` | `{agent, agent_status, pane_id, workspace_id}` |
  | `workspace_*` / `worktree_*` | full workspace record |
  | `layout_updated` | full tab layout |

- **Per-pane initial event.** A per-pane `agent_status_changed` with an `agent_status` filter that already matches emits **one immediate event**. Without a filter there is no initial event.
- **One bad target kills the whole subscription.** An unknown `pane_id` returns `{"id":"sx:sub:0:probe","error":{"code":"pane_not_found",…}}`.
- **Closing a workspace** emits `workspace_closed` only, with no per-pane `pane_closed`. A shell exiting emits `pane_exited` and then `layout_updated`; the pane is gone afterwards.
- **Volume:**
  - omp puts a spinner in the *middle* of its OSC title (`π ⠧ tmp`). The spinner change survives `terminal_title_stripped`, so every frame emits `pane_updated`.
  - Measured: **10 events/s, about 600 B each, about 6 KB/s per working omp pane**. 796 `pane_updated` against 10 status changes in about 10 minutes.
  - Idle panes are quiet.

**Bootstrap without a gap** [source `docs/socket-api.mdx:118-127`]:
1. Open the subscription and wait for the ack.
2. Buffer events while calling `session.snapshot`.
3. Apply the buffered events, then stream.
4. Re-snapshot after any reconnect.

**Recommended strategy for TeleFlock** [inferred]:
- **A. With the host relay (preferred).** The relay holds one `events.subscribe` covering all global types, including `pane.updated`, on the local socket. It coalesces `pane_updated` per pane to at most 2–4 Hz, or forwards only fields that changed (`agent_status`, `terminal_title_stripped`, `tokens`, `cwd`), and pushes deltas to the app.
- **B. Without a relay (Local/WSL mode, or before the relay exists).** Bridge the subscription through one exec channel:
  - 0.9.0: `nc -U "$SOCK"` or the python3 one-liner below;
  - ≥0.9.1: `herdr --session S remote-api-bridge`.

  Write the subscribe line to stdin and read events from stdout [observed: python3 bridge got the ack]. Accept about 6 KB/s per working omp agent, or, on mobile, drop `pane.updated` and use status-only mode:
  - global `pane.created|exited|agent_detected` plus workspace and tab events;
  - per-pane `pane.agent_status_changed` subscriptions on a second connection, rebuilt (new connection, then close the old one) whenever the pane set changes;
  - `agent list` every 5–10 s for titles and tokens. Cost: about 1–4 KB per poll plus 1.2 ms of host CPU.
- **C. Polling only (fallback).** `herdr --session S api snapshot` every 1–2 s. Cost: snapshot size (3–8 KB on these sessions) per poll, about 4–8 KB/s at 1 Hz. Up to 2 s of status latency.

```bash
# stdio↔socket bridge usable from any exec channel (0.9.0)
python3 -c 'import socket,sys,threading;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1])
threading.Thread(target=lambda:[s.sendall(l) for l in sys.stdin.buffer],daemon=True).start()
while (d:=s.recv(65536)): sys.stdout.buffer.write(d); sys.stdout.flush()' "$SOCK"
# one-shot request
printf '%s\n' '{"id":"1","method":"ping","params":{}}' | nc -U -q 1 "$SOCK"
```

---

## 5. Remote bridging

### `herdr --remote <target> [--session N]` [source `src/remote/attach.rs`, `src/remote/host_unix.rs`]

- **SSH invocation.** `ssh [-F <managed cfg> -S <ctl> -o ControlMaster=auto -o ControlPersist=yes] -T <target> <cmd>`. Saved machines add `-o BatchMode=yes -o NumberOfPasswordPrompts=0 -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=4` (`attach.rs:402-415, 573-606`).
- **Probes:**
  - `/bin/sh -s` with `uname -s\nuname -m\n` on stdin;
  - `command -v herdr`;
  - a candidate-path script;
  - `test -x <bin> && <bin> status client --json` (checks `endpoint_protocol_generation` and `surface_interest`).
- **Install path.** If the binary is missing or old, and the user approves interactively, herdr runs `tee <tmp>` over ssh with the local binary on stdin, then `chmod 755` and `mv` to `$HOME/.local/bin/herdr`.
- **Runtime command:** `exec "$HOME/.local/bin/herdr" [--session N] remote-client-bridge` (`attach.rs:1727-1743`).
- **What the bridge does.** `remote-client-bridge` auto-spawns the server daemon if needed. It then splices **stdin/stdout to the session's client socket** (`herdr-client.sock`), not the JSON API (`host_unix.rs:8-74`).
- **Wire protocol.** That stream is the **binary client protocol**: `[u32 LE length][bincode(standard)]` frames, max 2 MiB (32 MiB for graphics) (`src/protocol/wire.rs:1592-1650`).
  - Messages: `ClientMessage::{TerminalHello, Input, Resize, Detach, AttachTerminal, ObserveTerminal, ControlTerminal, ClientShellHello, ClientShellEndpointRequest{boot_id, request}, EndpointControl{kind,data}, …}` and `ServerMessage::{Welcome, Terminal(frame), ServerShutdown, Notify, …}`.
  - Variant order is frozen for endpoint generation 1. API calls tunnel through `ClientShellEndpointRequest`.
  - **TeleFlock should not speak this protocol.** It is Rust/bincode-internal [inferred].
- **Windows hosts** reject `remote-client-bridge` ("remote Windows hosts are not supported yet", `src/remote.rs:15-20`).

### `herdr --machine <label> <cmd>`: not in 0.9.0

It was added in 0.9.1 [source CHANGELOG]. In 0.9.5 (`git show 143bf5f:src/cli/target.rs`):
- `--machine` wraps any API-backed CLI command. It starts a `SavedSshApiBridge`: a local socket where each accepted connection becomes an ssh exec of `<bin> --session <S> remote-api-bridge`.
- `remote-api-bridge` = connect to the session's **JSON API socket** and splice stdio (`143bf5f:src/remote.rs:15-38`). `--check` prints `herdr-api-bridge-v1`.
- Because the server allows one request per connection, this is **one ssh channel per request**. Status probes retry; mutating requests are never replayed.

### Can TeleFlock use ONE long-lived exec channel for the herdr JSON API?

**Not natively.** Every request needs its own socket connection [observed]. The options, best first [inferred]:

1. **Per-request exec channel** running the CLI: `"$H" --session S agent list`. It emits the API JSON envelope.
   - Cost: one SSH channel open per call (one RTT to Tailscale, sub-ms on the host).
   - russh multiplexes channels on one connection, so this is cheap enough for user actions.
   - **Recommended for all request/response calls.** It is also the most version-robust, because the CLI hides socket and pipe differences on Windows and WSL.
2. **One long-lived exec per event stream:** `nc -U`, python3, or `remote-api-bridge` (≥0.9.1) plus the `events.subscribe` line (§4).
3. **One long-lived exec per terminal:** `herdr terminal session control …` (§6).
4. **The host relay** (TeleFlock's own, planned for omp collab). A single exec or `direct-tcpip` connection can multiplex every herdr request, because the relay opens a new local socket connection per request and owns the subscription. Choose this if the relay ships anyway.

### Does anything need the unix socket directly?

- `events.subscribe` and any raw API request do: CLI equivalents exist for everything **except** event streaming. There is no `herdr events` CLI in 0.9.0.
- `terminal attach/session` use the client socket, but through the CLI.
- **Tailscale SSH rejects `direct-streamlocal@openssh.com`.** tailscale/tailscale#6232 "make Tailscale SSH port forwarding work with unix socket" is OPEN, last activity 2026-03 [source, `gh issue view`]. Local `direct-tcpip` forwarding works; reverse forwarding does not (tailscale/tailscale#6575) [source].
- So: no streamlocal. Use exec bridges or a TCP relay on `127.0.0.1` through `direct-tcpip`.
- Prior art: another herdr client (Heeler, `subezhj/tailscaled_app` ADR-0011) uses OpenSSH `direct-streamlocal` per request and keeps the "one-request-per-socket contract" [source]. That approach does not work on Tailscale SSH.

### Starting the server remotely

0.9.0 CLI API commands do **not** auto-start a server; they return `server_not_running`. Start it with `setsid -f "$H" [--session S] server </dev/null >/dev/null 2>&1` [observed for named sessions]. `remote-client-bridge` auto-spawns, but it is binary-protocol only.

---

## 6. Terminal

### `terminal session control` / `observe`: the xterm.js feed [observed + source `src/client/terminal_sessions.rs`]

```
herdr --session S terminal session control <pane|agent|terminal target> [--takeover] [--cols 120] [--rows 40]
herdr --session S terminal session observe <target> [--cols 120] [--rows 40]
```

- **No PTY needed.** Plain pipes work (tested over `|` and `subprocess.PIPE`). Defaults are 120x40.
- **stdout** (one JSON per line):
  - `{"type":"terminal.frame","seq":N,"encoding":"ansi","width":W,"height":H,"full":bool,"bytes":"<base64>"}`
  - and finally `{"type":"terminal.closed","reason":"detached"|"terminal attach taken over"|…}`
- **Frame content.** Frames are **re-rendered viewport updates**: `ESC[?2026h` (synchronized output), `ESC[?25l`, OSC 8 reset, `ESC[2J ESC[1;1H` on full frames, then absolute CUP plus SGR runs. Incremental frames (`full:false`) repaint only the changed cells. Observed sizes: a full 80x24 shell frame 2.9 KB, an incremental 176 B, a full omp 100x30 frame 6.6 KB.
- **stdin (control only)** [source `terminal_sessions.rs:159-277`]:

  | Message | Effect |
  |---|---|
  | `{"type":"terminal.input","text":"…"}` or `{"type":"terminal.input","bytes":"<base64>"}` | raw input bytes; Enter is `\r` |
  | `{"type":"terminal.resize","cols":C,"rows":R,"cell_width_px":0,"cell_height_px":0}` | resizes the PTY |
  | `{"type":"terminal.scroll","direction":"up"\|"down","lines":N,"source":"wheel"\|"page_key","column":?,"row":?,"modifiers":0}` | host scrollback |
  | `{"type":"terminal.release"}` (or stdin EOF) | detach |

  `terminal.mouse` arrives only in 0.9.2.
- **Resize semantics:**
  - **control** resizes the actual PTY to the client size and takes a resize lock while attached [source `src/server/headless.rs:1850-1878`]. Observed: `stty size` became `20 90` and **stayed at that size after release** in the lab, which has no TUI client.
  - With a herdr TUI client viewing the same tab, the last focuser controls tab sizing [source `docs/concepts.mdx:73`]. Expect fights over the pane size when the user's TUI and TeleFlock both show it [inferred].
  - **observe** does not resize. It **crops** the PTY viewport to its own size from the top-left (observed: 40x6 observe of a 100x30 pane showed the first 40 cols and 6 rows).
- **Multiple clients:**
  - There is one writable owner per terminal (`terminal attach`, `agent attach` and `session control` share it). A second control or attach without `--takeover` fails: "terminal attach failed: terminal term_… already has an attached client; retry with --takeover".
  - `--takeover` evicts the old owner, which gets `terminal.closed` with reason "terminal attach taken over".
  - Observers are unlimited and coexist with a controller [observed].
  - Normal herdr TUI clients are not attach owners.
- **Scrollback:** frames use absolute positioning, so xterm.js will not build useful scrollback from them. Run xterm.js with `scrollback: 0` and map the wheel or PageUp to `terminal.scroll`, which herdr's host scrollback serves. Alternatively show history from `pane read` [inferred].

### `terminal attach` / `agent attach` (TUI attach, PTY required) [observed + source `src/client/attach.rs`]

- These use the alt screen and take the same exclusive owner with `--takeover`. The PTY follows the client size.
- **Detach key is `Ctrl+B` then `q`** (hard-coded prefix 0x02). `Ctrl+B Ctrl+B` sends a literal `^B`. Detaching exits 0 [observed].
- Not available on Windows: "direct terminal attach is not supported on Windows yet".
- `agent attach` resolves agent names and pane ids. A non-agent pane gives `agent_not_found` [observed]. `pane attach` does not exist.

### Reading output

- **`pane read`** [source `src/app/api_helpers.rs:109-141`]:
  - **Sources:** `visible` (the screen), `recent` (scrollback, wrapped), `recent-unwrapped` (joins soft wraps; good for logs), `detection` (the bottom buffer herdr uses for screen detection).
  - **Line limits:** `--lines` is capped at **1000**. `recent` defaults to 80.
  - **Format:** `--format ansi` (or `--ansi`) keeps SGR colors (`pane-read-visible.ansi`). The CLI prints raw text; the API returns JSON with `truncated`.
  - **omp scrollback is short.** omp produced only about 62 lines of `recent` history even with `--lines 100000` [observed]. omp repaints in place, so long history must come from omp's transcript, not from herdr.
  - Scrollback memory is limited by `[advanced] scrollback_limit_bytes` (default 10 MB per pane) [source `default-config.toml`].
- **Initial xterm render.** Send `terminal.resize` to the xterm size, then rely on the **first frame, which is `full:true`**. If history is wanted, prepend `pane read --source recent --format ansi --lines 1000` with the last `rows` lines dropped [inferred].
- **Input methods:**
  - `pane send-text <id> <text>`: literal text, bracketed paste if enabled.
  - `pane send-keys <id> enter esc ctrl+c …`
  - `pane run <id> <cmd…>`: text plus Enter.
  - raw `pane.send_input {text, keys}`: one call [observed].

  All work on any pane. The `agent *` variants resolve names.

---

## 7. Agents

**Commands** (lab, omp with the `tiny` model) [observed]:

| Command | Result |
|---|---|
| `agent start labomp --kind omp --pane w1:p1 --timeout 60000 -- --model openai-codex/gpt-6-luna:low` | ready in about 3 s, returns `{"type":"agent_started","agent":AgentInfo,"argv":["omp","--model",…]}`. The pane must be at an idle shell prompt, otherwise `agent_pane_busy`. Kinds: `pi claude codex gemini cursor devin agy cline omp mastracode opencode copilot kimi kiro droid amp grok hermes kilo qodercli qwen maki muse`. |
| `agent prompt <t> "<text>" [--wait] [--until S]… [--timeout MS]` | `{"type":"agent_prompted","agent":…}`. Rejected with `agent_blocked` while blocked. With `--wait`, it must observe `working`/`blocked` within 5 s, otherwise `agent_prompt_stalled`. It then matches idle/done/blocked by default. It does **not track turns** [source help text]. Mechanics: bracketed paste of the text, a 300 ms delay, then Enter in the app's key encoding [source `src/app/api/agents.rs:13`, `api_helpers.rs:46-60`]. Slash commands work: `agent prompt w1:p1 "/session"` opened omp's session overlay [observed]. |
| `agent wait <t> [--until S]… [--timeout MS]` | returns `agent_info` as soon as the state matches. The current state counts: an agent that is already blocked matches at once. Without `--until` it matches idle/done/blocked. A timeout gives the `timeout` error. |
| `agent send-keys <t> enter` | answered omp's `ask` (selected "Yes"); blocked → working → idle |
| `agent rename <t> <name>` / `--clear` | names are unique (`agent_name_taken`); the name can then be used as a target |
| `agent read <t>` | same as `pane read` |
| `agent explain <t> --json` | `{agent, state, screen_detection_skipped:true, screen_detection_skip_reason:"full_lifecycle_hook_authority", matched_rule:null, …}` for omp (`agent-explain.json`) |

### States

| `agent_status` | Meaning | Source |
|---|---|---|
| `working` | omp reported `working` (from `agent_start` until `agent_end`, or a retryable-error grace of 2.5 s) | hook |
| `blocked` | omp reported `blocked`: an `ask` tool is running, or `tool_approval_requested`, or a retryable error persisted past the grace period | hook |
| `idle` | idle **and seen** | hook + seen |
| `done` | idle and **not seen**. Set when a working→idle transition happens while the pane is not in the active tab (or the outer terminal is unfocused) | `src/app/actions.rs:1945-1965`, `api_helpers.rs:96-107` |
| `unknown` | no agent detected yet, or a plain shell | detection |

- **seen semantics** [observed]:
  - Prompting while another workspace was focused produced `working` → `done`.
  - `workspace focus w1` immediately emitted `pane.agent_status_changed` with `idle`.
  - `seen` is cleared by herdr focus actions only: `workspace.focus`, `tab.focus`, `agent.focus` (≥0.9.1 also moves attached clients).
  - **Therefore TeleFlock must not use focus to acknowledge.** It would move the user's herdr view. Keep a client-side `acknowledged[pane_id] = state_change_seq` and show In review while `agent_status ∈ {done}` or (`idle` and `state_change_seq` > ack). Herdr's own client uses the same pattern (`src/client/shell/endpoint_agent_state.rs:75-86`) [inferred].
- **Ordering:** `state_change_seq` increments per state transition. `revision` increments on every pane update (title spinner) [observed].
- **Rollups:** `agent_status` on workspace and tab records is the max-attention rollup (blocked > done > working > idle > unknown) [source `api_helpers.rs:1-9`].
- **The `report_agent` `message` is not exposed** via `agent get/list` or snapshot. This covers omp's blocked text such as the ask question. AgentInfo has no message field [observed + schema]. omp does put status in the title: `π ! tmp` while blocked, `π > ⟦ASK: Ask Proceed yes or no⟧` [observed]. Use omp collab for the question text.

### Correlating a herdr agent with omp

- `agent_session`: `{"source":"herdr:omp","agent":"omp","kind":"path","value":"/root/.omp/agent/sessions/-tmp/2026-10-20T21-52-05-658Z_01a15b4c-da1a-735a-94c6-af07601f04d1.jsonl"}`. `kind:"id"` with a session id is used when no file exists.
- The file name ends in `_<sessionId>.jsonl`, which matches `omp collab list --json` `.sessionId` (confirmed by ResearchOmpCollab). The sessionId rotates on `/new`, `/resume` and `/fork`, so re-join on `pane_updated` when `agent_session` changes.
- `pane process-info --pane wX:pY` gives `{shell_pid, foreground_process_group_id, foreground_processes:[{pid,name,argv,cmdline,cwd}]}`, and the omp pid is there (`pane-process-info.json`). This matches collab's `pid`.
- Also available: `cwd`, `foreground_cwd`, `terminal_title(_stripped)`, `name`, `terminal_id`.

### What omp reports (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`, integration v9, managed by herdr) [source]

- **Enabled only if** `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are all set. On Windows the socket becomes `\\.\pipe\<path>`.
- **Transport:** one socket connection per request. It waits 500 ms, retries once with 1500 ms, and requests are serialized.
- **`pane.report_agent`:** `{pane_id, source:"herdr:omp", agent:"omp", state:"working"|"blocked"|"idle", message?, seq, agent_session_path|agent_session_id}`, with `seq = Date.now()*1000 + n`.
- **`pane.report_agent_session`:** `{pane_id, source, agent:"omp", seq, session_start_source:"startup"|<switch reason>, agent_session_path|id}`. Sent on `session_start`, `session_switch` and `agent_start`.
- **Root-session only:** it activates only when `ctx.hasUI === true`. Headless, RPC or print omp and **omp subagents do not report**, so herdr would fall back to screen detection or `unknown`. **Keep omp as the interactive TUI** [inferred].
- **Restore drops agent args** [observed by ResearchOmpCollab in `tf-lab-collab`, herdr 0.9.0]. After `herdr session stop` and a restart, omp panes come back as `omp --resume=<session.jsonl>`. The original args (`--model`, `--config …`) are dropped. Panes started with other args came back as bare shells (`agent` null). Agent names persist. Do not rely on per-process omp flags surviving a server restart; re-apply settings after restore.
- **State machine:**
  - `blocked` while `blockedCount > 0`. Sources: the `ask` tool (message = first question), `tool_approval_requested` (message = reason or "<Tool> approval"), and the custom `pi.events` `herdr:blocked {active,label}` that other extensions can emit.
  - `working` from `agent_start` until `agent_end` (ignored when `willContinue`).
  - `idle` after a 250 ms debounce (`HERDR_OMP_IDLE_DEBOUNCE_MS`).
  - Retryable provider errors hold `working` for 2500 ms (`HERDR_OMP_RETRY_GRACE_MS`), then `blocked` with the error text.

---

## 8. Worktrees, workspaces and folder picking

[observed in the lab with `/tmp/tf-lab-repo`; samples `worktree-*.json`, `error-worktree-*.json`]

- **`worktree list --cwd <repo>`** returns `{"type":"worktree_list","source":{repo_key,repo_name,repo_root,source_checkout_path},"worktrees":[{branch,path,label,is_linked_worktree,is_bare,is_detached,is_prunable,open_workspace_id?}]}`.
- **`worktree create --cwd <repo> --branch feat/x [--base REF] [--path P] [--label T] --no-focus`:**
  - creates `~/.herdr/worktrees/<repo_name>/<branch with / → ->` (the `[worktrees] directory` default, `~/.herdr/worktrees`);
  - opens the **source repo as a primary workspace** (w3, `is_linked_worktree:false`) plus the new linked workspace (w4);
  - returns `{"type":"worktree_created","workspace":{…,"worktree":{checkout_path,is_linked_worktree:true,repo_key,repo_name,repo_root}},"tab","root_pane"}`;
  - events: `workspace_created`, `tab_created`, `pane_created` and `worktree_created`.
  - If the branch exists locally it is checked out; otherwise it is created from `--base` or HEAD [source].
- **Grouping:** workspaces sharing `worktree.repo_key` form a group. The primary workspace has `is_linked_worktree:false`.
- **`worktree open --branch|--path`:** `{"type":"worktree_opened","already_open":bool,"workspace":…}`.
- **`worktree remove --workspace <linked ws> [--force]`:** `{"type":"worktree_removed","forced":true,"path":…,"workspace_id":…}`. It closes the workspace and **never deletes the branch** (`feat/x` remained).

**Error cases** (all exit 1, JSON on stderr):

| Case | Code / message |
|---|---|
| Path not in a repo | `not_git_worktree` "Herdr worktree actions require a path inside a Git work tree" |
| Untrusted repo (owned by another uid) | `worktree_list_failed` / `…_create_failed` with git's "detected dubious ownership … safe.directory". **Detect the substring `dubious ownership`** and offer to retry with `--trust-repository`, which passes `-c safe.directory=<root>` per command and never edits gitconfig [source `src/worktree.rs:154-165`]. |
| Branch checked out elsewhere | `worktree_create_failed` "fatal: 'main' is already used by worktree at '/tmp/tf-lab-repo'" |
| Target path exists | `worktree_create_failed` "fatal: '/root/.herdr/worktrees/tf-lab-repo/feat-x' already exists" |
| Dirty checkout on remove | `dirty_worktree_requires_force` "…contains modified or untracked files, use --force to delete it" |
| Close a primary that has linked workspaces | `workspace_group_close_required`. Use `workspace close <id> --group` (API `close_group:true`). |

- **`workspace create --cwd P --label L [--env K=V] --no-focus`:** `workspace_created` with `root_pane`. **Gotcha: a non-existent `--cwd` silently falls back to `$HOME`** (observed `/nonexistent/dir` → cwd `/root`). TeleFlock must validate the path first.
- **Labels:** `workspace rename <id> <label…>` and `tab rename`. Display-only tokens go through `workspace report-metadata --token`.
- **Remote folder picking: herdr has no filesystem API.** Recommended exec approach [inferred]:
  - list a directory: `sh -c 'cd -- "$1" && find . -mindepth 1 -maxdepth 1 -printf "%y\t%f\n" 2>/dev/null | sort' _ <dir>` (Linux; macOS has no `-printf`, so fall back to `ls -1Ap`). Or use the relay's fs endpoint.
  - mark repos: `test -e <dir>/.git`, or `git -C <dir> rev-parse --show-toplevel`.
  - validate and enumerate: `herdr worktree list --cwd <dir>`, which also yields the branches that are already open.
  - SFTP over Tailscale SSH is another option if russh's SFTP client is used [inferred, unverified].
  - Start from `$HOME`, recent cwds from `agent list` / `workspace list`, and `worktrees.directory`.

---

## 9. Notifications

- **Herdr has no notification list or history API** [observed; schema has only `notification.show`]. Agent notifications (done / needs input) are produced inside the server and delivered **only to attached herdr clients**, as toasts, terminal OSC or system notifications according to `[ui.toast] delivery` (default commented `off`) and `[ui.sound]` [source `default-config.toml`, `src/app/actions.rs:1978-2046`].
- **`notification show "<title>" [--body] [--position] [--sound none|done|request]`** returns `{"type":"notification_show","shown":false,"reason":"disabled"}` in the lab [observed]. Possible reasons: `shown | disabled | rate_limited | no_foreground_client | busy`. Title is capped at 80 characters and body at 240. This only pushes *to herdr clients*, which is useless for TeleFlock.
- **TeleFlock must derive its notifications from events** [inferred]:
  - `pane.agent_status_changed` (or `pane_updated` diffs) → `blocked`: "needs you";
  - `working` → `idle`/`done`: "finished";
  - `pane_exited`: crashed or exited.

  The Android foreground service needs a live event stream (§4) or polling.

---

## 10. Sessions and machines

- **`herdr session list --json`** → `{"sessions":[{"name","default":bool,"running":bool,"session_dir","socket_path"}]}` [observed]. Sessions are directories under `~/.config/herdr/sessions/`, plus the default session at `~/.config/herdr`. Other agents' labs (`tf-lab-omp`, `tf-lab-collab`) appeared there.
- `session stop <name> --json` → `{"session":{…},"stopped":true}`.
- `session delete <name> --json` → `{"deleted":true,"session":{…}}`. Running sessions give `session_delete_failed` [observed].
- **`machine list --json`** → `[]` on this host [observed].
  - A profile is `{id (opaque), label, target (ssh target), session, enabled}`. It stores no secrets [source `docs/connecting-machines.mdx`].
  - Machines are a herdr-client feature: one profile targets one remote session. Multi-machine is Linux/macOS clients only.
  - TeleFlock does not need herdr machine profiles. It has its own host list. Optionally, import `machine list --json` targets as host suggestions [inferred].

---

## 11. Plugins

[source `docs/plugins.mdx`, `docs/socket-api.mdx:493-650`, `src/api/schema/events.rs:286-329`]

- **What a plugin is.** A manifest `herdr-plugin.toml` with `id`, `name`, `version`, `min_herdr_version` (required) and `platforms`. It can declare:
  - `[[build]]`, `[[startup]]`;
  - `[[actions]]` (invokable via `plugin.action.invoke`, keybindings and context menus);
  - `[[events]] on="<event>"`, run per event with `HERDR_PLUGIN_EVENT_JSON`;
  - `[[panes]]` (overlay/popup/split/tab/zoomed terminal UIs);
  - `[[link_handlers]]`.
- **Installing:** `herdr plugin link <dir>` / `install <github>`. This writes `plugins.json` next to `session.json`, which **mutates the user's herdr state**, so it needs consent.
- **Hookable events:** the workspace, worktree and tab lifecycle events, `pane.created|closed|focused|moved|exited|agent_detected|agent_status_changed`. Not `pane.updated` or metadata events.
- **Startup hooks are one-shot, not supervised daemons.** They run after restore and again after live handoff, but not on client attach.
- **Would a TeleFlock plugin help? Not for v1** [inferred]:
  - Everything a plugin's event hook sees, `events.subscribe` delivers without spawning a process per event.
  - The useful niches are:
    - (a) a `[[startup]]` hook that `setsid`-launches the TeleFlock host relay whenever the herdr server starts, so the relay comes up with herdr;
    - (b) an `[[actions]]` "Open in TeleFlock" entry or a `[[panes]]` QR pairing pane inside the herdr TUI;
    - (c) `agent.view.set` to mirror TeleFlock's filters into the herdr sidebar.
  - Plugins are "preview" on Windows.
- **Cheaper alternative for display data:** `pane report-metadata --source tf:… --token todos=3/7 --token ctx=41% --ttl-ms N` puts arbitrary tokens on panes. They are visible in `agent get/list` as `tokens`, and herdr's sidebar can render them as `$todos` [observed: tokens round-tripped]. Limits: 16 keys per report, 32 per pane, 80-character values, not restored after a restart.

---

## 12. Windows and WSL

- **Native Windows herdr is GA** [source `docs/windows-beta.mdx`]:
  - Install: `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`, or `install.cmd` through curl.
  - Releases go to `%USERPROFILE%\.herdr\packages\standalone\releases`, with the active versioned dir on PATH and a stable alias at `%LOCALAPPDATA%\Programs\Herdr\bin`.
  - Config, sockets and sessions live in `%APPDATA%\herdr\` (`herdr.sock` marker file plus the named pipe `\\.\pipe\<full path>`; sessions under `sessions\<name>\`).
  - Panes use ConPTY.
- **Unsupported on Windows:** `terminal attach` (TUI direct attach), Windows as a `--remote` target, live handoff, Unix foreground process groups.
- **`terminal session control/observe` are not platform-gated in source** (`src/cli.rs:542-592` calls the client socket via `interprocess`), so they should work on Windows [inferred, unverified]. **This is TeleFlock's terminal path in Local mode.** Use the CLI, not the raw pipe, for portability, as herdr itself recommends [source `docs/plugins.mdx:277-283`].
- **Local Windows mode:** spawn `herdr.exe …` as a child process with piped stdio. Use the same CLI JSON and the same `terminal session control` JSON lines. Event streaming needs a named-pipe client: Rust `tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\C:\Users\…\AppData\Roaming\herdr\herdr.sock")`, using one connection per request plus one for the subscription [inferred from `ipc.rs`].
- **WSL mode.** Spawn `wsl.exe -d <Distro> --exec /home/<u>/.local/bin/herdr --session S …` with piped stdio [inferred]:
  - `--exec` avoids shell quoting.
  - Resolve the path once with `wsl.exe -d <D> -- sh -lc 'command -v herdr || echo "$HOME/.local/bin/herdr"'`. `~/.local/bin` is often missing from non-login PATH (§1).
  - Set `WSL_UTF8=1` so wsl.exe's own messages are UTF-8. Linux stdout passes through as raw bytes.
  - Events: `wsl.exe … --exec nc -U <sock>`, or python3.
  - Terminal: `wsl.exe … --exec herdr terminal session control …` (pipes, no ConPTY needed).
  - **The WSL distro must keep running:** WSL shuts an idle VM down. A detached `herdr server` keeps it alive while running, but `wsl --shutdown` kills everything.

---

## 13. TeleFlock feature → herdr mapping

`$H` = resolved herdr path; `-S` = `--session <name>` (omit for default). Events = §4 stream (relay or exec bridge).

| TeleFlock feature | herdr call(s) | Live source | Gaps / risks |
|---|---|---|---|
| Host connect / health | `$H status --json`; raw `ping` | — | 0.9.0 errors lose the request id. Start the server with `setsid -f $H server </dev/null`. |
| Board bootstrap | `$H api snapshot` (`session.snapshot`) | `events.subscribe` (ack, then snapshot, then buffered events) | No replay: re-snapshot after a reconnect. |
| Column Running / Needs you / In review / Done | `agent_status` `working` / `blocked` / `done` (or idle with seq > local ack) / `idle` | `pane.agent_status_changed` (per pane) or `pane_updated` (global) | "done" is server-side unseen state; ack locally by `state_change_seq`. Never `focus` just to ack. |
| Agent card: name, cwd, kind | `agent list`: `name, agent, cwd, foreground_cwd, workspace_id, tab_id` | `pane_updated`, `pane_agent_detected` | Non-omp agents work the same. |
| Agent card live line | `terminal_title_stripped` (omp: `π <spinner\|>\|!> <cwd or ASK: …>`) | `pane_updated` at 10 Hz per working omp pane | Rich live text needs omp collab. Coalesce title updates. |
| Card todos / ctx | not in herdr. Optionally mirror via `pane report-metadata --token` | omp collab | `report_agent` `message` is not exposed. |
| Start agent | `$H -S workspace create --cwd P --label L --no-focus` (or `tab create` / `pane split`), then `$H -S agent start <name> --kind omp --pane <root_pane> -- [omp args]` | `agent_started` response, `pane_agent_detected` | The pane must be at an idle shell. Startup timeout default 30 s, max 300 s. |
| Stop agent | `agent send-keys <t> esc` (interrupt), then `pane send-keys <id> ctrl+c ctrl+c` or `pane send-text "/exit"`+enter; `pane close <id>` / `workspace close` | `pane_exited`, `workspace_closed` | There is no graceful-stop API. Closing kills the process. |
| Send prompt / slash command | `agent prompt <t> "<text>" [--wait --until idle --until done --until blocked]` | events | Rejected while `blocked`. No per-turn tracking. |
| Answer blocked (ask / approval) | `agent send-keys <t> up/down/enter/esc` or `pane send-text`; better through omp collab `ui-response` | `agent_status_changed` → working | The question text is not in herdr (title shows only a prefix). Key navigation is fragile. |
| New worktree | `worktree create --cwd <repo> --branch B [--base R] [--label L] --no-focus [--trust-repository]`, then `agent start …` in `result.root_pane.pane_id` | `worktree_created` etc. | Handle `dubious ownership`, branch-in-use and path-exists. Remove never deletes the branch. |
| Open existing folder / repo | exec dir listing (§8), then `worktree list --cwd` (repo?), then `workspace create --cwd` or `worktree open --cwd --branch\|--path` | `workspace_created` | No fs API. Bad cwd silently becomes `$HOME`. |
| Terminal (xterm.js) | long-lived exec `$H -S terminal session control <pane> --cols C --rows R [--takeover]` | stdout frames | Resizes the real PTY (conflicts with the user's TUI on the same tab). Single writer. No mouse in 0.9.0. Not raw bytes. Use `observe` for read-only previews. |
| Terminal preview / thumbnail | `terminal session observe <pane> --cols --rows` or `pane read --source visible --format ansi` | frames | observe crops top-left. Read is a poll. |
| Workspace / tab management | `workspace list/rename/close [--group]`, `tab create/rename/close`, `pane split/move/swap/zoom` | workspace, tab, pane and layout events | Don't `focus` on behalf of the user unless asked. |
| Host stats | not herdr. exec `cat /proc/loadavg /proc/meminfo; nproc; df -P ~` (or relay) | poll | — |
| Notifications | none in herdr for us. Derive them from status transitions and `pane_exited`. | events (Android foreground service holds the stream) | `notification show` targets herdr clients only. |
| Sessions picker | `herdr session list --json` | poll | Each session has its own socket and stream. |
| Correlate with omp collab | `agent_session.value` → `_<sessionId>.jsonl` suffix; `pane process-info` → pid | `pane_updated` when `agent_session` changes | The id rotates on `/new`, `/resume` and `/fork`. |

### Top risks

1. **Event bandwidth.** About 6 KB/s per working omp agent via `pane_updated`. Mitigate with relay-side coalescing or status-only subscriptions on mobile.
2. **Terminal size contention.** `terminal session control` resizes the shared PTY and holds a resize lock while attached. It needs a UX rule, for example taking over only while the terminal view is focused and releasing on blur.
3. **No streamlocal on Tailscale SSH.** Events need an exec bridge (`nc`/python3 on 0.9.0, `remote-api-bridge` on ≥0.9.1) or the relay.
4. **0.9.0 quirks:**
   - errors lose ids;
   - CLI errors go to stderr;
   - silent success for `pane send-*`, `run` and `report-metadata`;
   - mixed event naming (`pane_updated` vs `pane.agent_status_changed`);
   - a non-existent `--cwd` falls back to `$HOME`.
5. **Blocked question text and omp internals (todos, ctx) are absent from herdr.** That is the omp collab dependency.
6. **Windows.** No direct attach. `terminal session` on Windows is unverified.
7. **Server restarts.** Agents resume as `omp --resume=<file>` without their original flags (§7). Anything TeleFlock configured through CLI flags must be re-applied.
