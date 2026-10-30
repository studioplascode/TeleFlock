# HostdOps families (`fs`, `git`, `gh`, `workspace`, `worktree`, `host`, `term`, `ai`, `tools`, `omp`, `automation`, `upload`)

Owner: HostdOps. Every family exposes
`pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError>`
(dispatcher and `Ctx`: `mod.rs`, owned by HostdCore). Wire types: `tf_proto::methods`.

## Exposed to the rest of tf-hostd
```rust
ops::host::probe_info(ctx).await -> HostInfo        // versions, sessions, setup checklist
ops::host::setup_status(ctx).await -> SetupStatus   // read-only checklist
ops::host::health() -> HostHealth                   // sync; /proc on Linux, sysinfo elsewhere
ops::usage::start(&paths, persist, cancel)           // daemon: host.usage service (+ 30 min index warm-up on the real home; not on Windows or on battery)
ops::usage::usage_report(ctx, UsageParams).await    // host.usage's answer for other hostd reports (Flock Wrapped)
ops::host::invalidate_models().await                // next host.models re-fetches
ops::git::repo_top(&Path).await -> Result<Option<RepoTop>, ApiError> // state store: the worktree of a folder …
ops::git::repo_info_at(&RepoTop).await -> RepoInfo                   // … and its facts (one status per worktree)
ops::term::TermRegistry                             // Ctx.terms (Default + Clone)
ops::term::input(ctx, client, term_id, data).await  // ClientMsg::TermIn
ops::term::client_gone(ctx, client_id).await        // disconnect cleanup
ops::tools::Tools::load(<home>/tools.json, paths.is_default_home()) // daemon: one updater (auto on by default for ~/.teleflock, off for lab homes); .spawn(cancel)
ops::tools::follow(&Arc<Ctx>)                       // Ctx::create: publish HostInfo.tools for that session
crate::herdr_health::start_session(&Arc<Ctx>)       // Ctx::create: herdr server watch, restarts, idle loads (§3.29)
crate::herdr_health::launch(&home) -> ServerLaunch   // env for servers TeleFlock starts (Ctx::create, install-herdr)
crate::herdr_health::down_error(session) -> Option<ApiError> // `herdr_down` while the server is not up (term.open)
```

## Behavior
- **Processes** run without a shell, with a hard timeout (child killed), `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. Binaries are found on `PATH` (the daemon's PATH already
  merges the user's interactive-shell PATH, `userenv.rs`), then the well-known install dirs
  (`~/.local/bin`, `~/.bun/bin`, …). `omp_bin` prefers an omp that can start (its `#!`
  interpreter is found).
- **fs.list**: dirs first (symlinked dirs count as dirs), case-insensitive, hidden filter (dotfiles;
  Windows hidden attribute), ≤ 5000 entries. **Never runs git** (browsed repos are untrusted; their
  config can name filter drivers). Badges come from the filesystem only: `.git` dir or `gitdir:`
  file → `repoRoot`/`worktree`, branch from `HEAD` (detached → short sha), `dirty` always absent.
  The listing's own `git` badge also covers sub-folders of a repo (nearest ancestor `.git`).
  Dirty counts come from `worktree.list`, `git.status` and registered workspaces' `RepoInfo`.
- **fs.search**: `git ls-files -co --exclude-standard`, else a capped walk (skips dotdirs,
  `node_modules`, `target`, …); candidates cached 15 s per root; fzf-style ranking (segment and
  camel boundaries, consecutive runs, basename bonus). Paths are relative to `root`.
- **fs.read**: default 512 KiB, max 8 MiB; text when UTF-8 without NULs, else base64; `mime` by
  extension.
- **git.status**: porcelain v2 + numstat vs `HEAD` (untracked files get their line count),
  default branch (`origin/HEAD` → `init.defaultBranch` → main/master/trunk/develop, as a local
  branch or `origin/…`), `base` = merge-base of HEAD with the default branch's local *and*
  remote-tracking refs together (`git merge-base HEAD main origin/main`: the latest fork point from
  either, so a branch forked from a fresher `origin/main` doesn't count commits a stale local
  `main` lacks).
- **git.diff**: working tree vs base (default: that merge-base) = committed + staged + unstaged +
  untracked (synthesized new-file hunks, ≤ 200 files). Patch capped at 2 MiB (`truncated`).
  A `base` branch name diffs against its merge-base with HEAD.
- **git.branches**: local + remote-tracking branches (newest first), `defaultBranch` (`main`) and
  `defaultBase` = what new worktrees fork from: `origin/<default>` when that ref exists, else the
  local default's remote-tracking upstream (repos without `origin`), else the local branch.
- **git.commit** (`all` = `git add -A`) records a `committed` activity on agents in that checkout.
  **git.push** pushes plainly only when the branch's upstream is its namesake on a remote; otherwise
  (no upstream, a local one, or another name such as the `origin/main` a worktree forked from) it runs
  `git push --set-upstream <the upstream's remote, else origin, else the first remote> HEAD`
  (publishes the branch under its own name and tracks it; never pushes into the base).
- **worktree.create** (new branch): `base` absent → `defaultBase`. A base naming a branch of a
  configured remote (`origin/main`; a local branch spelled the same stays local) is fetched first:
  `git fetch <remote> refs/heads/<branch>` (updates the remote-tracking ref through the configured
  refspec), hookless, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` (empty: no `core.askPass` /
  `SSH_ASKPASS` dialog), `SSH_ASKPASS_REQUIRE=never`, ssh `-o BatchMode=yes -o ConnectTimeout=5`
  appended to the ssh command git would use (`GIT_SSH_COMMAND` / `core.sshCommand` / an OpenSSH
  `GIT_SSH` program (quoted) / `ssh`; other programs are left alone), 8 s (the fetch must leave the
  agent start its share of the app's 180 s launch timeout on a slow host). Single-flight per repo + branch, and an attempt answers for 20 s
  (fan-outs fork from one commit and pay one timeout). A failed fetch is logged and creation
  continues from the existing ref; a base that does not exist locally is `invalid_params`. herdr then
  runs `git worktree add -b <branch> <path> <base>`, which makes the branch track a remote base
  (`branch.autoSetupMerge`); hostd drops exactly that upstream (retried while parallel creations hold
  `.git/config.lock`, then verified), so ahead/behind and review are right. Existing-branch
  mode is unchanged (a remote-only branch becomes a local branch tracking it). Untrusted repos
  (`trust`, git refuses to read them) skip all of this: an absent base is herdr's HEAD there.
- **worktree.remove**: `workspaceId` → herdr `worktree.remove` (closes the workspace). `workspaceId: ""`
  plus `path` (hosts ≥ 0.5.2) is for a parked agent's worktree (`Parked.worktree`: Mark done closed its
  workspace): a workspace still holding that folder goes through herdr as above; otherwise
  `remove_checkout` runs `git worktree list --porcelain` in the folder (only a linked worktree
  qualifies, never the main checkout: `not_git_repo`) and `git worktree remove [--force]` from the
  main worktree, with `-c safe.directory=*` under `trust`; a folder already gone counts as removed,
  and only its own registration is dropped (`git worktree remove <path>` in the recorded repo root;
  never `git worktree prune`, which would drop every missing worktree, one on an unmounted disk
  included; a locked one is refused). Then no parked record keeps that worktree
  (`forget_parked_worktree`, persisted); the card stays in Done. The branch is kept either way.
- **gh.\***: `gh pr view --json number,url,title,state,isDraft,mergeable,statusCheckRollup`;
  "no pull requests found" → `{ pr: null }`.
- **gh.authStatus / gh.authStart / git.identity / git.setIdentity** (`gh_auth.rs`, architecture
  §3.12, §3.14): gh's accounts (`gh auth status --json hosts`, text before gh 2.81; one look per gh
  binary at a time, cached 60 s) and its device-code sign-in as an `auth.*` flow (`kind: "gh"`, one per
  GitHub host, 15 min): `gh auth login --hostname <h> --git-protocol https --web` with piped stdio, own
  process group, no-op `GH_BROWSER`/`BROWSER`/`PATH` openers; code + `https://github.com/login/device`
  from its stderr, `Logged in as <login>` + exit 0 → `done`, then `gh auth setup-git` (`setupGit`, default
  on) and `HostInfo.setup` republished; cancel kills the group. git's global `user.name` / `user.email`
  (suggested from `gh api user`) set with `git config --global --replace-all` after validation
  (`invalid_params` `name: …` / `email: …`). Host setup items `sign-in-gh` (gh installed, no working
  account, no `GH_TOKEN`/`GITHUB_TOKEN` in the daemon's environment) and `set-git-identity` (git
  installed, either value unset): not `host.setupApply` fixes, completed with these methods.
- **term.open**: `Shell` targets default to a new **tab** (never shrinks existing panes);
  `split: right|down` splits the workspace's focused pane; `cwd` only → new workspace. One herdr
  bridge per terminal; frames are forwarded as-is (base64). The stream ends with
  `TermEvent::Closed{reason}` (`terminal attach taken over`, `detached`, …). Disconnect detaches.
  An `agent` target that is parked (pane closed by Mark done) fails with `parked`.
- **host.usage** (`usage/`, architecture §3.16): omp's own stats index (`stats.db`, path resolved
  like omp: `PI_CONFIG_DIR`, `OMP_PROFILE`/`PI_PROFILE`, `PI_CODING_AGENT_DIR`, `XDG_DATA_HOME`,
  dotenv files; `usage/dbpath.rs`), opened `?mode=ro`. hostd keeps it current with omp's own sync:
  `omp stats --summary` (output discarded) in the background, single flight, nice 10 / lowest
  best-effort I/O, own process group, 10 min timeout, in the empty `<home>/cache/omp-stats`; when a
  request finds the last sync older than 10 min (`refresh: true`: unless one finished within 30 s;
  failures back off 1 … 30 min) and every 30 min on the real daemon (`TF_HOSTD_USAGE_WARMUP=1|0`
  overrides). Answers never wait: `index {ready, syncing, syncedAt, added, error, newest}`.
  With `view` (apps ≥ 0.7.0): `insights` over `since`..`until` in hour buckets aligned to the
  app's `hourOffset` (UTC hours otherwise), totals and breakdowns (models, providers, projects,
  agent types, subagents, tiers, tools, sessions, records, all-time activity, agent work time),
  cached per index stamp + view + window and versioned (`have` → `unchanged`); `live` = the
  state.json ledger's growth since the last sync. Without `view` (older apps): the legacy
  `today`/`days`/`models` (host-local days, zero-filled; `input` = input + cache read + cache write).
- **host.limits** (`limits.rs`): `omp usage --json` (hostd cache 60 s, `refresh` 10 s; omp itself caches
  each account ~5 min, so provider usage endpoints are not hit more often than omp's own TUI does) +
  `omp usage --history --json --days 8` (10 min). Readings of each window's current period (omp history
  + hostd's own polls, reset drops cut) ride along as `samples` for the client's pace math. Session →
  account from `agent.db` read-only: `cache` `session:sticky:<provider>:<sessionId>` → `credentialId`
  → `auth_credentials.identity_key` (never the `data` column). A failed refresh keeps the last snapshot
  and sets `error`.
- **host.models**: `omp config get modelRoles --json` + headless `omp --mode rpc --no-ui
  --no-session` `get_available_models` (fallback `omp models --json`); cached 5 min.
- **host.sessions**: scans `<omp agent dir>/sessions/*/*.jsonl` (newest first), titles from
  `history.db` (read-only) or the title slot, skips never-prompted sessions, marks `live` from the
  board's omp agents (a parked agent's session carries its `agentId` with `live: false`).
  **host.resume** refuses live sessions (`busy`; resuming would fork); a parked agent's session file
  resumes that agent (`ops::agent::resume_parked`) at the given target.
- **search.\*** / **session.find** (`search.rs` → `crate::find`, architecture §3.27): `session.find`
  searches every row of a session's replica older than `before` (chunks of 256 cloned per lock, on
  the blocking pool), a parked agent's in its session file. `search.start` searches the top-level
  session files (newest first, `cwd` scope) in the background: raw-line prefilter, only message /
  custom-message / compaction / branch-summary entries parsed, per-session count ≤ 1000 and 3
  snippets with row ids; caps 20 s, 2 GiB, `limit` ≤ 500 sessions; long polls (`search.poll`, ≤ 10 s);
  stopped by `search.cancel`, the client's next search, its disconnect or 30 s without a poll; ≤ 4
  running per daemon. `search.read` maps a session file (inside omp's sessions folder only) to rows
  around a row id or time, paging both ways; the last 3 files stay mapped while unchanged. Parked
  agents' read-only `session.open` now pages (`hasMore`, `session.history` from the same file).
- **agent.archive / agent.resume** (`agent.rs`, done-agent lifecycle, architecture §3.5/§3.7):
  `close: true` parks the agent after a 10 s undo window (closes its exclusive workspace, else its
  pane); un-archiving, prompting or `agent.resume` on a parked card relaunch `omp --resume=<file>`
  (worktree reopened via herdr `worktree.open`). Other per-agent methods on a parked card fail with
  `parked` ("Resume it first"); `session.open` gives a read-only transcript snapshot (older rows
  through `session.history`, `session.find` over the file).
- **host.setupApply** is one of two config-mutating paths (the other: `omp.settingsSet`, below), and only for explicit fix ids:
  `install-herdr-integration` (herdr `integration.install omp`), `enable-global-sharing`
  (`omp config set collab.autoStart control` + `collab.relayUrl ws://127.0.0.1:<port>`),
  `install-global-bridge` (atomic copy of `~/.teleflock/ext/teleflock-bridge.ts` into
  `<omp agent dir>/extensions/`), `move-herdr-out-of-login-session` (`scope.rs`: the herdr server
  behind the session's socket, found via `SO_PEERCRED`, runs in a logind `session-*.scope`; root on
  systemd only: `busctl … StartTransientUnit` with `PIDs` = the server into
  `teleflock-herdr-<session>-<pid>-<ms>.scope` (Delegate, TasksMax=infinity), then
  `AttachProcessesToUnit` for its process tree still in login sessions, parents first, a few passes
  for processes forked meanwhile; never stops anything. Non-root gets an explanation instead).
  And it installs what is missing (`install.rs`, architecture §3.12): `install-omp`, `install-bun`,
  `install-herdr`, `install-gh`, `install-git`, `install-ffmpeg` (official installers, the gh
  release archive, or the system package manager as root / passwordless sudo), each under the
  shared install lock through `tools::run`. Every fix runs on its own: failures land in
  `SetupStatus.failed`, fixes still running in `SetupStatus.applying`; the reply comes when the
  batch is done or after 20 s. A consented global bridge copy is kept equal to the uploaded one
  (`refresh_global_bridge`, at daemon start and on every host probe).
- **omp.settings / omp.settingsSet / omp.settingValues** (`omp_config.rs`, owner OmpSettings, architecture §3.10): omp's
  settings schema through the companion extension's dump mode (throwaway `omp --mode rpc … -e
  <home>/ext/teleflock-bridge.ts`, `TF_OMP_SCHEMA_OUT`; cached per omp binary in memory and
  `<home>/cache/omp-settings-schema.json`) + values from `omp config list --json` (10 s);
  `source: "cli"` from the list alone when the schema can't be read. Writes: keys checked first,
  then `omp config set|reset -- <key> [<text>]` in order, omp's validation message →
  `invalid_params`. A batch setting a credential (schema flag; secret-like key names in `cli` mode)
  never uses argv: the extension's settings-write mode (`TF_OMP_SETTINGS_IN`/`_OUT`, bridge ≥ 1.3.0)
  applies it from a 0600 file under `<home>/run` (deleted on read); an older extension → `unsupported`
  (hint: the env override), nothing written. Values cache: a `config list` older than a write never
  fills it. Credentials never leave the host. `omp.settingValues {keys}` (≤ 64 keys) picks just
  those keys from the same cached list (`pick_values`: unknown, unset-without-default and
  `redacted` keys are absent). Real-omp test (temp `PI_CODING_AGENT_DIR`, or
  `TF_LAB_OMP_AGENT_DIR`; scans `/proc/*/cmdline` during the credential write):
  `cargo test -p tf-hostd omp_config -- --ignored --nocapture`.
- **ai.complete** (`ai.rs`): `omp --mode json --no-session --no-tools --no-extensions --no-skills
  --no-rules --no-lsp --no-title --model @<role> --system-prompt <system>`, prompt on stdin,
  `NO_COLOR=1`, cwd = `cwd` if it is a dir, else home. Line breaks in `system` become spaces
  (Windows refuses CR/LF in arguments to `omp.cmd`). Answer = last assistant message of
  `agent_end` (`text` parts joined, thinking ignored; assistant `message_end` if the stream ends
  first); the child is killed as soon as it is in. Role default `tiny` (`^[a-z][a-z0-9-]{0,31}$`),
  one retry with `smol` after a failed attempt when ≥ 1.5 s remain. `timeoutMs` default 20 000,
  clamped 2 000–60 000, semaphore queue included → `timeout` (retryable). 3 omp processes per
  daemon. Prompt and system text are never logged or returned; logs: task, role, model, ms, outcome.
- **host.herdrRestart / host.herdrLoad / host.herdrConfig** (`crate::herdr_health`, architecture §3.29):
  routed from `host.rs`; start a down herdr now (`force`: replace a running or unresponsive one), load the
  installed herdr now (live handoff, else stop + start), per-host `autoRestart` / `idleUpdate` /
  `idleMinutes` (`<home>/herdr.json`). Answer when done or after 20 s with `HerdrHealth`.
- **Setup: herdr's omp integration** (`host.rs`): `integration.list` for the state, `herdr integration
  status` for the versions ("out of date (v9; this herdr ships v10)") and as the fallback without a server.
- **host.toolsUpdate / host.toolsConfig** (`tools.rs`, architecture §3.9): one updater per daemon,
  first run 2 min after start, then every 6 h + jitter while `auto` (`tools.json`; default on for
  `~/.teleflock`, off for other (lab / dev) homes). Installing runs hold `~/.cache/teleflock-tools.lock` (one installer per user
  across daemons); each tool runs in its own process group, killed whole on timeout.
  omp: `omp update --check` → `omp update` (5 min) → `omp --version`. herdr: `herdr --version`,
  `herdr status`, stable manifest via `curl https://herdr.dev/latest.json` → plain `herdr update`
  (5 min; stdin closed, `HERDR_ENV`/`HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`/`HERDR_SESSION`
  removed). Never `--handoff`, `--force` or a channel flag. Package-manager installs, a release that
  needs the server restarted (herdr declines without a terminal) and a stale running herdr server
  become `note`s; failures become `error`s (permission denied explained). `toolsUpdate` joins a
  running run that covers it, answers when done or after 20 s; `checkOnly` never installs.
- **automation.\*** (`automation.rs` → `crate::automations`, architecture §3.11): `list` returns the
  client's herdr session's automations (with `nextRunAt`, `lastRun`), their runs (newest first)
  and the scheduler status; `save` validates (name ≤ 80 chars, 5-field cron that fires at least
  once, absolute existing folder — inside a git repo in worktree mode, prompt unless `plan`) →
  `invalid_params` with a user-facing message; `delete`/`run` only see the session's automations
  (`not_found` otherwise); `run` launches now and answers the recorded `AutomationRun`
  (`failed` runs carry the error, not an `ApiError`); `preview` is pure (parse, next 5 runs in the
  host's time zone, plain-English description). `unavailable` (retryable) before the scheduler
  started.

- **upload.\*** (`upload.rs`, architecture §3.13): files for prompts and pastes under
  `<home>/uploads/<yyyy-mm-dd>/<sanitized unique name>` (0600, folders 0700; any mime). `begin`
  reserves the name (1 B–2 GiB, ≤ 8 running), `chunk` appends base64 ≤ 1 MiB strictly at `offset` =
  bytes received (repeats and gaps → `upload_offset`, past the size → `invalid_params`, nothing
  written), hashing as it goes; `status` says where to resume; `finish` checks size and optional
  SHA-256 and renames `.partial/<id>.part` into place (a retried finish answers the same for a
  day); `cancel` drops a partial or an unsent finished file. Idle 1 h → dropped (swept every 5 min);
  an earlier run's partials go when the first session context starts; finished files are pruned
  after 30 days, then oldest first above 10 GiB. `upload::start(&paths, cancel)` (in `Ctx::create`)
  runs that cleanup and the sweeper once per daemon.

- **move.\*** (`moves/`, architecture §3.28): moving an agent to another host; the app relays.
  `check` (source preflight, asks the remote) / `probe` (target: matching clones, clone path, disk,
  omp version, model) → `start` (source job: push, binary changes patch from a temporary index,
  park the agent marked `moving`, `omp session pack`) → `read` (base64 slices ≤ 1 MiB of the packed
  parts; the app uploads them with `upload.*`) → `receive` (target job: clone?, fetch, checkout or
  new worktree, apply, `omp session unpack --cwd`, resume; every step journals its undo in
  `<home>/moves/<id>/target.json`) → `finish` (`omp session moved --to`, card `moved`; idempotent).
  `status` reports either job; `abort` rolls back (source: the agent resumes where it was). A
  restart turns `moving` cards into `interrupted` and rolls half-done receives back
  (`moves::start`, called in `Ctx::create`) — except a receive at the launch boundary (its journal
  has `launching`): that one is checked against the board/session file until definite (`done`, rollback only when
  surely absent; meanwhile the status is `confirming`, journal kept) and never rolled back under a
  live agent (architecture §3.28). `finished_file` / `discard` in `upload.rs` hand the
  uploaded parts to the receive.

- **mcp.\*** (`mcp/`, architecture §3.15): omp's MCP servers. Config read and written in omp's own
  files and format (`<agent dir>/mcp.json`, `<folder>/.omp/mcp.json`, `.mcp.json` siblings) under omp's
  cross-process lock (`files.rs`: the pi-natives lock name, so a concurrent `/mcp add` never loses an
  edit), key order and unknown fields kept (`json.rs`), secrets masked as `SECRET_MASK` and restored
  from the stored value (`secrets.rs`), enable/disable exactly like omp's `setMcpServerEnabled`.
  Status, tools, `test`, sign-in (`auth.*` flow driving omp's `/mcp reauth` engine), sign-out and
  Smithery search run omp's own code in the embedded helper extension `host/teleflock-mcp/teleflock-mcp.ts`
  (one throwaway omp per request, owner-only request file, JSON-lines answers; `helper.rs`). Checks are
  cached per folder with definition fingerprints; only changed servers are checked again. Every
  change runs omp's `/mcp reload` in the concerned interactive sessions (busy ones when their turn ends;
  `reload.rs`).

- **skills.\*, plugins.\*** (`plugins/`, architecture §3.26): omp's skills (every provider, switched-off
  ones included, Skillshare registry installs with updates) and plugins (npm / git / local packages,
  marketplace plugins, marketplaces, catalogs). Reads run omp's own code in the embedded helper
  `host/teleflock-plugins/teleflock-plugins.ts` (the MCP helper's runner, `HelperSpec` `HELPER`);
  changes run `omp skill …` / `omp plugin …` without a shell or TTY, one at a time (`cli.rs`: argv
  rules, omp's error and script-consent texts → `scripts_need_consent`); skill switches edit
  `disabledExtensions`. Changes reload running sessions with `/reload-plugins` (`mcp/reload.rs`).

- **hostSync.\*** (`hostsync/`, `mcp/sync.rs`, architecture §3.24): make this host like another.
  `export` (source): omp's global layer as written (`omp config list --scope global`, omp ≥ 18.13.3),
  user MCP servers masked, sign-ins of `omp auth export` by identity hash; nothing secret. `plan`
  (target, pure `plan.rs`): one item per setting / role (`modelRoles` + `retry.fallbackChains`) / MCP
  server (+ `mcpSecrets:<name>`) / sign-in, `add|change|remove|same|unknown|unsupported`, notes.
  `keyBegin` (target): one-time X25519 key (memory only, 10 min, one use). `seal` (source): the chosen
  secrets (auth export entries, stored MCP entries, credential setting values) → X25519 + HKDF-SHA256 +
  AES-256-GCM to that key (`seal.rs`). `apply` (target): plan again, open the box (the sealed ids must
  be chosen ones and cover every chosen secret), then `omp auth import -` (stdin), `omp config
  set|reset` per setting (credentials via the extension's settings-write mode), the role records,
  MCP entries under omp's lock, `/mcp reload`; one result per item. Logs: ids, counts, outcomes; a
  refused box as a warning with its code, item count and transfer id prefix.
  Tests: `cargo test -p tf-hostd hostsync ops::mcp::sync`; two-lab run `examples/e2e_hostsync.rs`.

- **cleanup.\*** (`cleanup/`, architecture §3.17): the Cleanup page. `cleanup.worktrees` reports every
  linked worktree of the repositories the session's workspaces, parked agents and automations name
  (git facts, admin-dir times, size walk, `gh pr view`, board agents, omp's newest session there),
  scanned in the background and followed with `waitMs`. `cleanup.remove` checks again (agent working
  → `busy`, locked → `worktree_locked`, detached HEAD with unsaved commits → `orphan_commits` unless
  `force`), then removes exactly like `worktree.remove {path}`; the branch stays. `cleanup.storage` /
  `cleanup.storageRun` run `omp gc --json` with named categories only (`--blobs`, `--wal`,
  `--compress`; never `--archive` or `--stale`, never without a category): a dry run, or an apply one
  category at a time.

- **session.artifacts / session.artifact / session.writeLocal / session.context** (`artifact_files.rs`, `xray.rs`, architecture §3.20): the session's artifacts dir (`local://` files, subagent outputs beside their transcripts, saved handoffs), listed without following symlinks and read only inside its kind's real root (relative `/` names, no `.`/`..`, outputs need their transcript); `session.writeLocal {agentId, text}` saves a paste (1 B–4 MiB) as the next `local://paste-<n>.md` (`n` = highest existing + 1; root created 0700 when missing, an existing root untouched; file 0600 via `O_EXCL`, a taken name moves on, symlinks never followed; no session file → `not_found`; the text is never logged); the bridge's `context` breakdown (`caps.context`, else `unsupported` with the restart hint), parsed leniently and bounded. Tests: `cargo test -p tf-hostd ops::artifact_files ops::xray`.

## Error codes (beyond `tf_proto::ApiError`'s list)
| code | when | hint tells the user |
|---|---|---|
| `untrusted_repo` | git "dubious ownership" | retry with `trust: true` |
| `branch_in_use` | branch checked out in another worktree | which path |
| `branch_exists` | new branch name already exists | use `existing: true` |
| `path_exists` | checkout folder exists | pick another path |
| `dirty_worktree` | remove of a dirty worktree | retry with `force: true` |
| `not_git_repo` | worktree op outside a repo | pick a repo folder |
| `group_close_required` | closing a primary workspace with linked worktrees | `group: true` |
| `worktree_locked` | `cleanup.remove` of a locked worktree (also with `force`) | `git worktree unlock <path>` first |
| `orphan_commits` | `cleanup.remove` of a detached HEAD whose commit no branch, tag or remote branch contains | branch it (`git switch -c`), or `force` |
| `busy` | `term.open` while another client controls it; resuming a live session | `takeover: true` / open the agent |
| `ai_unavailable` | `ai.complete` without omp, or omp has neither the requested role nor `smol` | install omp ≥ 18.12 / assign the tiny role |
| `ai_failed` | omp exited, reported an error or answered nothing (message: ≤ 300 chars of stderr/error) | — |
| `unsupported` | `omp.settingsSet` setting a credential while the deployed extension lacks the settings-write mode | reconnect with the current app, or the setting's `$ENV` override |
| `io_error` (retryable) | resuming a parked agent whose session file cannot be read (not definitely deleted) | try again once it is reachable |
| `upload_offset` | `upload.chunk` at an offset other than the bytes received (a repeat whose answer was lost, or a gap) | ask `upload.status` and continue there |
| `checksum_mismatch` | `upload.finish` with a `sha256` the received bytes don't have (the upload is dropped) | upload the file again |
| `busy` (retryable) | `upload.begin` while 8 uploads run | wait for one to finish |
| `busy` (retryable) | an agent launch whose new pane's shell never became ready (waited 45 s), or whose chosen pane's shell is not at an idle prompt | slow shell startup files; pick an idle pane |
| `sealed_invalid` | `hostSync.apply` with a box that doesn't open with the transfer's key (changed on the way, other items than chosen) | start the copy again |
| `expired` | `hostSync.apply` whose one-time key was used or is older than 10 min | start the copy again |

## Tests
`cargo test -p tf-hostd ops::` — parsers (porcelain v2, numstat/name-status `-z`, worktree
porcelain, refs, gh JSON, herdr error samples, omp JSONL answers), a git fixture repo in a tempdir
(status, diff, branches, commit, worktree branch planning, badges, default base), a bare-`origin`
fixture whose clone is behind (new worktree forks from the fetched `origin/main` without tracking
it, explicit bases, offline remote, push of the new branch), stats.db fixture, session scan.
`cargo test -p tf-hostd ai -- --ignored --nocapture` calls the real omp (needs a tiny role) and
prints the slug, model and ms. `cargo test -p tf-hostd tools` parses captured omp/herdr outputs and
drives the updater against fake `omp`/`herdr`/`curl` scripts in a tempdir (never the real updaters),
including the install lock held by "another daemon" and a timed-out tool whose background child dies
with its process group. `cargo test -p tf-hostd automations` — cron parsing, next/latest fire times
across DST jumps (a POSIX-TZ zone), descriptions, the scheduler's fire/catch-up/pass decision, the
skip-if-busy guard (kept outside the run cap, collapsed repeat skips), distinct agent names for
launches in flight, store validation and round trip (0600, run cap, corrupt file set aside), systemd
unit contents and unit removal without a running user manager.
`cargo test -p tf-hostd upload` — chunks in order (repeats, gaps, overflow, oversized and empty
chunks refused; racing duplicates land once), checksum, size and count caps, name sanitizing and
per-day uniqueness (never overwriting), owner-only modes, cancel (partial and unsent finished
file), idle sweep (busy uploads kept), start-up cleanup of an earlier run's partials, pruning by age
and total.
`cargo test -p tf-hostd gh_auth` — gh 2.102's `gh auth login` output (no-TTY and interactive wording,
gh before 2.40), `gh auth status` JSON and text (before 2.40, 2.40–2.80), identity validation and
profile suggestions, the global config file, the setup items; a scripted `gh` (tempdir): device code
→ done with `setup-git`, a refused approval → failed with gh's reason, cancel kills gh and its
background child, Enter answered for the interactive wording, the status cache (one run, the
checklist not waiting); git identity read and written with a temp `GIT_CONFIG_GLOBAL`.
`cargo test -p tf-hostd gh_real -- --ignored --nocapture` runs the real gh with a temp `GH_CONFIG_DIR`,
`HOME`, XDG dirs and `GIT_CONFIG_GLOBAL`: a fresh config is signed in nowhere, the sign-in reaches a
one-time code and `https://github.com/login/device`, `auth.cancel` leaves no gh process and no
`hosts.yml` (it never completes a sign-in; needs github.com).
