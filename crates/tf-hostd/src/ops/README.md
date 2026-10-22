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
  default branch (`origin/HEAD` → `init.defaultBranch` → main/master/trunk/develop; local branch
  preferred over `origin/…`), `base` = merge-base with it.
- **git.diff**: working tree vs base (default: that merge-base) = committed + staged + unstaged +
  untracked (synthesized new-file hunks, ≤ 200 files). Patch capped at 2 MiB (`truncated`).
  A `base` branch name diffs against its merge-base with HEAD.
- **git.commit** (`all` = `git add -A`) records a `committed` activity on agents in that checkout.
  **git.push** sets upstream on first push (`origin`, else the only remote).
- **gh.\***: `gh pr view --json number,url,title,state,isDraft,mergeable,statusCheckRollup`;
  "no pull requests found" → `{ pr: null }`.
- **term.open**: `Shell` targets default to a new **tab** (never shrinks existing panes);
  `split: right|down` splits the workspace's focused pane; `cwd` only → new workspace. One herdr
  bridge per terminal; frames are forwarded as-is (base64). The stream ends with
  `TermEvent::Closed{reason}` (`terminal attach taken over`, `detached`, …). Disconnect detaches.
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
  board's omp agents. **host.resume** refuses live sessions (`busy`; resuming would fork).
- **host.setupApply** is the only config-mutating path, and only for explicit fix ids:
  `install-herdr-integration` (herdr `integration.install omp`), `enable-global-sharing`
  (`omp config set collab.autoStart control` + `collab.relayUrl ws://127.0.0.1:<port>`),
  `install-global-bridge` (atomic copy of `~/.teleflock/ext/teleflock-bridge.ts` into
  `<omp agent dir>/extensions/`).
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
(status, diff, branches, commit, worktree branch planning, badges), stats.db fixture, session scan.
`cargo test -p tf-hostd ai -- --ignored --nocapture` calls the real omp (needs a tiny role) and
prints the slug, model and ms.
