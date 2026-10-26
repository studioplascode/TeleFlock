# HostdOps families (`fs`, `git`, `gh`, `workspace`, `worktree`, `host`, `term`, `ai`)

Owner: HostdOps. Every family exposes
`pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError>`
(dispatcher and `Ctx`: `mod.rs`, owned by HostdCore). Wire types: `tf_proto::methods`.

## Exposed to the rest of tf-hostd
```rust
ops::host::probe_info(ctx).await -> HostInfo        // versions, sessions, setup checklist
ops::host::setup_status(ctx).await -> SetupStatus   // read-only checklist
ops::host::health() -> HostHealth                   // sync; /proc on Linux, sysinfo elsewhere
ops::host::usage_today() -> UsageTotals             // blocking sqlite read (spawn_blocking)
ops::host::invalidate_models().await                // next host.models re-fetches
ops::git::repo_info(&Path).await -> Option<RepoInfo>
ops::term::TermRegistry                             // Ctx.terms (Default + Clone)
ops::term::input(ctx, client, term_id, data).await  // ClientMsg::TermIn
ops::term::client_gone(ctx, client_id).await        // disconnect cleanup
```

## Behavior
- **Processes** run without a shell, with a hard timeout (child killed), `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. Binaries are found on `PATH`, then `~/.local/bin`,
  `~/.bun/bin`, … (non-login SSH execs lack them).
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
  **git.push** without an upstream runs `git push --set-upstream <origin, else the first remote> HEAD`
  (publishes the branch under its own name and tracks it).
- **worktree.create** (new branch): `base` absent → `defaultBase`. A base naming a branch of a
  configured remote (`origin/main`; a local branch spelled the same stays local) is fetched first:
  `git fetch <remote> refs/heads/<branch>` (updates the remote-tracking ref through the configured
  refspec), hookless, `GIT_TERMINAL_PROMPT=0`, ssh `-o BatchMode=yes` appended to the ssh command git
  would use (`GIT_SSH_COMMAND` / `core.sshCommand` / `ssh`; other programs are left alone), 30 s.
  Single-flight per repo + branch, and an attempt answers for 20 s (fan-outs fork from one commit and
  pay one timeout). A failed fetch is logged and creation continues from the existing ref; a base that
  does not exist locally is `invalid_params`. herdr then runs `git worktree add -b <branch> <path>
  <base>`, which makes the branch track a remote base (`branch.autoSetupMerge`); hostd drops exactly
  that upstream, so ahead/behind, review and the first `git.push` (own name) are right. Existing-branch
  mode is unchanged (a remote-only branch becomes a local branch tracking it). Untrusted repos
  (`trust`, git refuses to read them) skip all of this: an absent base is herdr's HEAD there.
- **gh.\***: `gh pr view --json number,url,title,state,isDraft,mergeable,statusCheckRollup`;
  "no pull requests found" → `{ pr: null }`.
- **term.open**: `Shell` targets default to a new **tab** (never shrinks existing panes);
  `split: right|down` splits the workspace's focused pane; `cwd` only → new workspace. One herdr
  bridge per terminal; frames are forwarded as-is (base64). The stream ends with
  `TermEvent::Closed{reason}` (`terminal attach taken over`, `detached`, …). Disconnect detaches.
  An `agent` target that is parked (pane closed by Mark done) fails with `parked`.
- **host.usage**: `~/.omp/stats.db` opened `?mode=ro` (as fresh as omp's last stats sync); days
  are host-local and zero-filled; `input` = input + cache read + cache write tokens.
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
- **agent.archive / agent.resume** (`agent.rs`, done-agent lifecycle, architecture §3.5/§3.7):
  `close: true` parks the agent after a 10 s undo window (closes its exclusive workspace, else its
  pane); un-archiving, prompting or `agent.resume` on a parked card relaunch `omp --resume=<file>`
  (worktree reopened via herdr `worktree.open`). Other per-agent methods on a parked card fail with
  `parked` ("Resume it first"); `session.open` gives a read-only transcript snapshot.
- **host.setupApply** is the only config-mutating path, and only for explicit fix ids:
  `install-herdr-integration` (herdr `integration.install omp`), `enable-global-sharing`
  (`omp config set collab.autoStart control` + `collab.relayUrl ws://127.0.0.1:<port>`),
  `install-global-bridge` (atomic copy of `~/.teleflock/ext/teleflock-bridge.ts` into
  `<omp agent dir>/extensions/`), `move-herdr-out-of-login-session` (`scope.rs`: the herdr server
  behind the session's socket, found via `SO_PEERCRED`, runs in a logind `session-*.scope`; root on
  systemd only: `busctl … StartTransientUnit` with `PIDs` = the server into
  `teleflock-herdr-<session>-<pid>-<ms>.scope` (Delegate, TasksMax=infinity), then
  `AttachProcessesToUnit` for its process tree still in login sessions, parents first, a few passes
  for processes forked meanwhile; never stops anything. Non-root gets an explanation instead).
- **ai.complete** (`ai.rs`): `omp --mode json --no-session --no-tools --no-extensions --no-skills
  --no-rules --no-lsp --no-title --model @<role> --system-prompt <system>`, prompt on stdin,
  `NO_COLOR=1`, cwd = `cwd` if it is a dir, else home. Line breaks in `system` become spaces
  (Windows refuses CR/LF in arguments to `omp.cmd`). Answer = last assistant message of
  `agent_end` (`text` parts joined, thinking ignored; assistant `message_end` if the stream ends
  first); the child is killed as soon as it is in. Role default `tiny` (`^[a-z][a-z0-9-]{0,31}$`),
  one retry with `smol` after a failed attempt when ≥ 1.5 s remain. `timeoutMs` default 20 000,
  clamped 2 000–60 000, semaphore queue included → `timeout` (retryable). 3 omp processes per
  daemon. Prompt and system text are never logged or returned; logs: task, role, model, ms, outcome.

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
| `busy` | `term.open` while another client controls it; resuming a live session | `takeover: true` / open the agent |
| `ai_unavailable` | `ai.complete` without omp, or omp has neither the requested role nor `smol` | install omp ≥ 18.12 / assign the tiny role |
| `ai_failed` | omp exited, reported an error or answered nothing (message: ≤ 300 chars of stderr/error) | — |

## Tests
`cargo test -p tf-hostd ops::` — parsers (porcelain v2, numstat/name-status `-z`, worktree
porcelain, refs, gh JSON, herdr error samples, omp JSONL answers), a git fixture repo in a tempdir
(status, diff, branches, commit, worktree branch planning, badges, default base), a bare-`origin`
fixture whose clone is behind (new worktree forks from the fetched `origin/main` without tracking
it, explicit bases, offline remote, push of the new branch), stats.db fixture, session scan.
`cargo test -p tf-hostd ai -- --ignored --nocapture` calls the real omp (needs a tiny role) and
prints the slug, model and ms.
