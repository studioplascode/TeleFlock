# TeleFlock feature coverage matrix

Audit date 2026-10-21, updated for 0.4.0 on 2026-10-22 (§0), for 0.4.1 on 2026-10-23, 0.5.0 on 2026-10-26, 0.5.1, 0.5.2 and 0.5.3 on 2026-10-27, 0.6.0, 0.6.1 and 0.7.0 on 2026-10-29 (§0). Sources: `docs/spec.md` §2–§6, `docs/research/omp.md` §1 and §10–§12, `docs/research/herdr.md` §13.
Each row traces the path **UI entry (desktop / mobile) → frontend call → host/app method → hostd path → status**.

**Status key**
- ✅ **verified**: the code path was traced end to end and exercised. "demo" means it was run in headless Chromium on `?demo` at 1440×900 and/or 412×892. "test" means a unit test covers it. "lab" means it ran against a real omp 18.13.3 and herdr 0.9.5 in an isolated lab (own HOME, hostd home and herdr session, a mock model provider, a fake `gh` where a PR was needed), through the real UI in headless Chromium unless it says "protocol".
- ⚠️ **implemented, unverified or partial**: the code path exists, but it was not exercised against a real host, or one platform/variant is missing.
- ❌ **missing**: there is no UI path.

**hostd path legend**: C = collab guest · B = tf-bridge extension (since 0.6.0 also the data plane: live frames + the session file) · I = herdr keystroke injection (guarded by §3.6; idle-only except commands omp runs while streaming, such as `/collab`) · H = herdr API · G = git/gh/fs exec · L = local client (tf-client / Tauri).

## §0 What 0.7.0 changed

Every 0.7.0 slice was built and then checked by a different agent in a lab; ⚠️ names what no lab could reach: real Windows, macOS and Android devices, real provider limits and accounts, real push services. The "bring agents back" row is the one slice whose lab report was still outstanding when this table was written.

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| Automatic app updates ran never (since 0.2.0): the background check sent `settings.get` a `null` instead of `{}`, so "Automatic updates" always counted as off; the same call kept the tray from reading the saved motion setting at startup | Settings → Updates, tray | Android: the same shared check | `src-tauri/src/update/mod.rs`, `lib.rs` `watch_motion` (L) | ✅ test (regression test fails on the old code); ⚠️ no real download or install run, the Android and macOS flows are untouched code that now actually runs |
| Unattended updates install only while the main window is away (hidden, minimized or unfocused for 20 s); in front they wait as "ready" with a toast and **Restart now**; a `.deb` never asks for its password unattended; only the AppImage installs at quit | Settings → Updates, toast | — | `update/apply.rs` (pure decision), `UpdatePhase::Ready`, `UpdateStatus.needsPassword` (L) | ✅ tests (24 `update::` tests, `cargo xwin check` for Windows); ⚠️ no real download, install or restart; Windows does not install at quit by design |
| Auto-resume after provider usage and rate limits: the host schedules a resume for when the accounts' limit windows reopen and continues the subagents, then the agent, without a new prompt; limit errors are kept out of every later model request; per-host switch, **Resume now**, **Don't auto-resume** | board badge, session strip, Settings → Auto-resume | same | bridge `turnError` / `resumeTree` / `limitGuard`; hostd `recovery.rs`, `limit_resume.rs`, `host.autoResume*`, `agent.autoResume*` (B) | ✅ lab (mock 429 with a retry-after: one ticket, kept across a hostd restart and shown with no app connected, the subagent resumed and its result reached the root once, the root went on, no limit text in later requests); ✅ lab (the bridge's `context` guard removed the error turn in real omp); ⚠️ the several-accounts rule, the `overloaded` / `providerError` kinds and the after-the-fact tickets are unit-tested only; never run against a real provider limit |
| "Rate limit · retrying in 4:54 (1/10)" while omp still retries, instead of a quiet chip or "answer in the terminal"; repeated limit errors fold into one row | board card, session | same | replica `retry.rs`, `OmpInfo.retry`, `state/build.rs` mapping | ✅ lab (live countdown on the card); ⚠️ herdr's own `blocked` state was never seen in a lab (no herdr omp integration there), tests only |
| **Resume** (F5, `/retry`) continues a stopped or failed agent without a new prompt; failed subagents have **Retry** | session header, subagent viewer | session top bar | `agent.retry` (B `retry`, else `/retry`) | ✅ lab (Stop, then `agent.retry` continued without a user message); ⚠️ subagent Retry through bridge tests only |
| Decide for me: after a wait the host answers omp's ★ recommended option, per agent, per Dispatch message, per automation or host default, optionally only while no app is connected; never approvals or plan reviews | Agent options, Settings, ask card, board chip | same | `agent.setAutoAnswer`, `host.autoAnswerSet`; hostd `autoanswer/` | ✅ lab (`e2e_autoanswer`: answered at the deadline, only-when-no-app stood still with an app connected and was answered with none, cancel, a countdown kept across a daemon restart); ⚠️ UI only on the demo host, desktop and Android builds not run |
| Errors say what happened: request failures with message and status, provider refusals with category and explanation, omp's warnings and fallback notices in the transcript; the `xd://` mount notice stays out | transcript | same | replica `failure.rs`, `live_rows.rs`; bridge `notice`; hostd `live_rows.rs` | ✅ lab (refusal, HTTP 400 and 503, fallback, extension and config warnings, all back after two hostd restarts); ⚠️ the `xd://` notice is filtered but the lab could not confirm omp's notice reaches hostd (replica test only) |
| Subagents: finished ones collapse into a group; green or red by their real outcome (no more blue "Parked"), "Stopped" when a crash cut them off | subagents panel | same | replica `subagents.rs`, `ArtifactLedger` tail check | ✅ tests; the cut-off rule checked on the real transcripts of today's agents; ⚠️ the "Stopped" label was not re-run in a lab or screenshot after the last change |
| Model roles and fallback chains for one agent, at launch or while it runs; the omp settings page edits Retry Fallback Chains | New agent, Roles (this session), Settings → omp | same | `AgentSpec.roleModels` / `fallbackChains`, `agent.getRoleModels` / `agent.setRoleModels`; hostd `agentcfg.rs`, `ops/roles.rs` | ✅ lab (roles took effect, chains fell back, settings saved to omp's config); ⚠️ Dispatch, Fan out, Automations and New worktree forms and role changes of running subagents not exercised live; hosts before 0.7.0 show an update note instead |
| Large pastes become chips: omp's attachment block, a file the agent reads, or inline | session composer, Dispatch | same | `paste.largeMenuThreshold`, `session.writeLocal` | ✅ lab (the agent received exactly what omp's own terminal sends); ⚠️ native undo of a paste only in headless Chromium, the "host too old" message not run, Dispatch cannot attach as a local file (no session yet) |
| Find (`Ctrl+F`) in the transcript, tool output included; Past sessions searches the text of every session | session, Past sessions | same | `session.find`, `search.*`; hostd `find/`, `ops/search.rs` | ✅ lab (copies of real sessions; four bugs found and fixed); ⚠️ Tauri and Android WebViews, the ring shown without the highlight API, parked agents, older hosts not run |
| Inspector: background jobs with output and Stop, "Waiting for N background jobs", services of omp's daemon with logs and preview | session inspector, Hosts → Services | tab "jobs" | `jobs.*`, `services.*`; bridge `jobs` | ✅ lab (jobs, Kill on both kinds, natural finish; a service with restart, stop, kill and a preview chip); a card stuck Running after Kill was fixed (`JobsWait`); ⚠️ without herdr's omp integration the waiting line never shows; a hostd restart forgets a wait |
| Session documents (plans, reports, handoffs, subagent outputs) with viewer and Mention | inspector → Artifacts | tab "Docs" | `session.artifacts`, `session.artifact` | ✅ lab (`local://` files and a plan); ⚠️ a pending plan review never appeared (the mock offered no `exit_plan_mode`) |
| Context X-ray with compact-with-focus and drop-images | `/context`, context meter | same | `session.context` (B `context`) | ✅ lab (figures equal omp's own `/context` overview, threshold mark included); ⚠️ compact reached omp but only answered "Nothing to compact" |
| omp's idle recap on Review and Done cards | board | same | hostd `state/recaps.rs` | ✅ lab (appears after the idle time, cleared by a new turn) |
| **Make it green** and **Rebase and resolve** on a pull request | Review | same | `/green` and rebase prompts to the agent | ✅ lab (fake `gh` serving failing and conflicting PRs; both delivered to the agent) |
| Dispatch **Auto** weighs each host's remaining subscription window | Dispatch | same | `src/core/workload.ts` | ✅ tests; ⚠️ never run: it needs two hosts with real limits |
| Quick capture: global shortcut (off until one is set in Settings), tray item, `teleflock://capture`; dispatch, answer or attach a screenshot from any app | tray, Settings | — | `src-tauri/src/capture.rs`, `src/capture/` | ✅ tests; ✅ real binary under Xvfb (the shortcut opened and hid the window); ⚠️ no Windows or macOS run (shortcut registration, "taken" detection, always-on-top placement); the page itself did not load in that debug run |
| Share to TeleFlock: text, links, screenshots and GitHub issues into Dispatch | — | Android share sheet | `Share.kt`, `take_shares`, `androidShare.ts` | ✅ tests; Kotlin and merged manifest compile; ⚠️ no device or emulator: the share flow, cold start and URI grants are unseen |
| Move an agent to another host with worktree changes, session, subagents and documents; a failed step rolls back what the move did; a launch that can't be confirmed yet keeps the move "confirming" (source parked, nothing removed) until the target's board answers; never rolled back under an agent that started | card menu, session actions → Move to host… | same | `move.*`; hostd `ops/moves/` (`target.rs` launch journal); app relay `src/core/move.ts` | ✅ lab (two hostds, host B over SSH: full move, an 80 MB copy resumed after B's daemon was killed, injected unpack failure rolled back, a cancel after B's sshd died); ✅ tests (journal at each crash window, failed journal writes, confirming → done / rolled back, keepalive, finish after the source job expired); ⚠️ the crash-window and confirming paths are unit-tested only (no lab), the "Try again" fix after a rollback is unit-tested only; phone and Android not run |
| Make this host like that one: omp settings, roles and MCP servers after a diff, sign-ins sealed end to end | Hosts → host card | same | `hostSync.*`; hostd `ops/hostsync/` | ✅ lab (two labs through the UI: 10 changes applied, B answered with A's copied key, a replayed and a tampered box refused, no secret on the wire or in any log); ⚠️ only made-up credentials |
| Cleanup: worktrees with PR state, size and age, bulk removal with the usual checks, omp storage cleanup that never touches sessions, low-disk notice | `#/cleanup`, host card Disk tile, board notice | More → Cleanup | `cleanup.*`; hostd `ops/cleanup/` | ✅ lab (merged, closed, dirty, locked, stale, gone and detached worktrees classified; refusals `dirty_worktree`, `worktree_locked`, `orphan_commits`, `busy`; a real `omp gc` on 474 MB left the session tree checksum unchanged); data-safety fixes after review (missing folders never bulk-pruned, symlinked paths, ignored files named in the confirms) ✅ tests; ⚠️ the low-disk notice was not screenshotted on a real host, nor a removal through a herdr worktree workspace |
| Skills and plugins page; GitHub CLI sign-in and git identity check in Host setup | omp area → Skills & plugins, Host setup | More | `skills.*`, `plugins.*`, `gh.auth*`; hostd `ops/plugins/`, `ops/gh_auth.rs` | ✅ lab (listing equals `omp skill list`; marketplace and linked-folder installs; a skill and a plugin switched off; `/reload-plugins` in a live omp; sign-in cancelled with the gh process gone and no config written; identity saved); ⚠️ no sign-in completed with a real account, Android not run, the real skills registry answered empty |
| Notifications that find you: native on Linux and macOS, the device in use first and the others after a wait, retracted when read; push to ntfy, Pushover or a webhook with no app connected | system notifications, bell, host alert settings | same | `notify.*`, `presence`; hostd `notify/`; `src-tauri` `xdg_notify.rs`, `mac_notify.rs`, `idle.rs` | ✅ lab (two devservers on one hostd: routing, escalation, a read retracted on the other device within milliseconds, a signed webhook `done`, ntfy cleared); ⚠️ macOS and Windows code only type-checked, Android presence and Doze not run, no real ntfy, Pushover or HTTPS endpoint, a real Linux desktop session not run; questions still pending after a hostd restart are pushed once more |
| Usage page from omp's own index: history in your time zone by model, provider, project and agent type | Usage | More → Usage | `host.usage`; hostd `ops/usage/` | ✅ lab (a real `stats.db` copy: requests, errors, cost, tokens, durations and rates equal `omp stats --json` for the same 24 h; daily totals equal on requests); a real-data crash (REAL durations) and a render loop found and fixed ✅ tests; ⚠️ hosts before 0.7.0 get an "update it" error instead of the page |
| Flock Wrapped | `#/wrapped` | same | `host.wrapped` | ✅ lab (17 commits and +155,341/−8,162 lines equal `git log`; PNG export); ⚠️ merged pull requests never counted (no GitHub access: the "GitHub did not answer" note), the Android image share was only compiled |
| Wall (2×2 or 3×3 live transcripts) and Ambient mode | `#/wall`, Ambient | Ambient (the wall needs a bigger screen) | `src/features/wall` | ✅ demo, 29 tests; ⚠️ no real host, Tauri build or Android; a 3×3 wall costs about 1.8× the board under demo load; no idle figure |
| herdr health: stop or crash noticed within seconds, restarted with backoff or **Restart herdr**; a newer herdr loaded by live handoff once the host is idle | board, Hosts → herdr | same | `host.herdrRestart` / `herdrLoad` / `herdrConfig`; hostd `herdr_health/`, `tf-herdr` `lifecycle.rs` | ✅ lab (restart; the handoff 0.9.4 → 0.9.5 in 0.36 s with both omp processes keeping their PIDs; idle gating; the update ran by itself in the set window); ⚠️ macOS and Windows not run, clearing a saved session whose file is gone and the "agent working" blocker are unit-tested only |
| Agents come back after herdr stops or crashes, an omp ends or the host restarts: they stay on the board as ended cards (cause, last step) and are relaunched under their names with TeleFlock's launch (`--resume`, never `--restore`); a cut-off turn goes on only where its last step is safe to repeat, otherwise the agent gets a note; an omp stopped on purpose (SIGTERM/SIGINT), a crash loop (more than three ends in ten minutes) and an agent that ended before its first reply wait for Continue — the last keeps its first prompt and images (recorded when hostd starts the agent) and Continue starts it again with them, delivered once; ended cards never share a key with a live agent (herdr reuses ids; decisions compare omp sessions) | board (ended cards, Continue / Dismiss), session strip, Settings → Auto-resume (bring back after a reboot) | same | `restart/` (`ledger.rs`, `decide.rs`, `launch.rs`, `images.rs`), `recovery.rs`; `<home>/ledger.json`, `<home>/ledger-images/`; boot keepalive (systemd) | ✅ lab (herdr stopped under four agents — idle, waiting on a subagent, mid-bash, mid-reply: no card left the board, all came back by name, the cut-off bash did not run again, the cut-off reply was written again, the subagent finished; a reboot simulation with no app connected and a power-cut variant with a fileless agent; SIGTERM held, SIGKILL relaunched, the crash-loop hold; fileless cards: prompt and image kept, typed prompts refused, Continue delivers exactly once, a second Continue is `busy`; hostd killed right after Continue's start: delivered exactly once; a new agent taking an ended card's id: both cards and prompts kept, each delivered once to its own agent; state files valid, nothing set aside); ✅ tests; ⚠️ not run: a real reboot (the lab can't change the boot id), herdr's own relaunch with TeleFlock taking over (fakes only), Windows, macOS and WSL hosts; an agent cut off inside `wait` may show "replying" on its ended card |
| WSL and SSH hosts whose login shell is nushell (or fish, tcsh and others): commands reach only a POSIX shell, deterministic failures stop retrying and offer Copy diagnostics | connection, Copy diagnostics | — | `tf-transport` `quote.rs`, `wsl.rs`; `tf-hostd` `userenv.rs`; `tf-client` `diag.rs` | ✅ tests (fake nu and tcsh, real nushell, fish, zsh, tcsh and bash with their own rc files); Windows build checked with `cargo xwin check`; ⚠️ no real WSL distro or Windows machine run; csh and tcsh read PATH from `.tcshrc` / `.cshrc` only, elvish, xonsh and pwsh untested |
| A transcript could freeze while the agent kept working (omp cut an emoji in half in subagent progress); a stalled feed reloads itself; a session open raced by a close | session | same | `lossy_json.rs`, `feed.rs` `check_stall`; tf-client `sessions.rs` `heal_due` | ✅ lab (v0.6.1 froze on the emoji, the current tree reached the final message); ✅ tests; ⚠️ the open/close race and the self-heal (injected message loss) are test-only, no Android or Tauri run |
| Phone transcripts shorter than the screen lost their first rows | session | phone | `transcript/estimate.ts` (`initialScrollOffset`) | ✅ lab (412×892 after the fix; long transcripts still land at the bottom) |

## §0 What 0.6.1 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| tokio 1.54.1 in the app and `tf-hostd` (1.54.0, in 0.5.0 to 0.6.0, was withdrawn: an `Interval` race could free memory still in use, GHSA-5wjr-9356-4wc8) | — | — | `Cargo.lock` | ✅ Rust workspace tests |
| A close (from the view, or a page close) that lands while a session open waits its turn or loads the cache wins: the open is not marked open, so no later link subscribes it | session view | same | tf-client `sessions.rs` (close count per mirror), `engine.rs` `session_open` (L) | ✅ tests (offline and online opens with a stalled cache, closed by the view and by a page close; they fail with the fix disabled) |

## §0 What 0.6.0 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| Sessions served by the bridge: live frames + the session `.jsonl`, no collab join; collab only as the fallback (old bridges, sessions without one) | session view, board | same | bridge 2.0.0 `liveSubscribe` / `live` / `resync`; hostd `bridge.rs`, `feed.rs`, `journal.rs`, `omp.rs` transports (B) | ✅ lab (omp 18.13.2/18.13.3 + herdr 0.9.5: live with relay `guests=0`, prompt streamed, five parallel subagents incl. a nested one stayed live, 1.4.0 bridge still via collab, `SIGKILL` + restart back via the bridge in ~5 s with identical rows); replay tests on recorded bridge frames |
| Questions and approvals answered from the app through the bridge | AskCard, approval card | same | bridge dialog wrappers, `uiResponse` (B) | ✅ lab (real omp: an `ask` answered from the UI reached omp; an approval answered from a probe) |
| Subagent chat / stop / revive through the bridge | subagent viewer | same | `agentCmd` (B, `AgentLifecycleManager`) | ✅ lab (chat revived an idle subagent, which answered) |
| Precise link states (starting, syncing, bridge lost, room closed, fallback…) with the terminal as the fallback | LinkGate | same | `OmpInfo.linkReason` / `linkVia` / `linkSince` | ✅ tests; demo (the bridge-drop strip is not staged in the demo) |
| Rows identical whether built live or rebuilt after a daemon restart (authors, tool args, durations, meta) | transcript | same | replica notes (`notes.rs`), canonical tool rows | ✅ tests (golden live vs rebuilt, replay with a restart); lab (13–15 rows identical after a restart) |
| Session sync: delta snapshots from `have`, `seq`, row hashes, append offsets, meta/tree patches | every session view | same | features `sessionSync`; hostd `sync.rs`; tf-client `sessions.rs` (L) | ✅ lab (real 3.5 MB session: first open 428 → 78 KB, cached re-open 477 → 3 KB, reconnect 475 → 3 KB; all rows equal a fresh snapshot); tests |
| zstd on the hostd ⇄ app link | — | — | feature `zstd`; hostd `clients.rs`; tf-client `link.rs` (L) | ✅ tests (framing, old peers both ways); lab byte counters |
| Cached sessions on the device, opened at once (also while the host connects or is offline) | session view | same | `session_cache.rs`, `engine.rs` `session_open` (L) | ✅ tests; ✅ lab (app restart re-opened with 0 rows resent); ⚠️ the offline strip not browser-checked |
| MCP servers per host: list with status and tools, add (templates, Smithery registry, custom), edit with masked secrets, test, on/off, remove, reload of running sessions | omp area → MCP servers, host card, palette, Settings | More → MCP servers | `mcp.*`; hostd `ops/mcp/*`, helper `host/teleflock-mcp` | ✅ lab (stdio server connected with its tools in a lab omp; on/off/remove reloaded a running session); demo; tests |
| MCP OAuth sign-in from the app (same-port tunnel, paste fallback) | MCP servers → Sign in | same | `mcp.authStart` + `auth.*`; `tunnel.open {localPort}` | ✅ lab (host in its own network namespace: tunnel and paste paths against a fake OAuth MCP server) |
| Subscription accounts per host: plans, live sessions, quota windows, prefer, unlink, re-link | omp area → Accounts, host card, palette, Usage limits Re-link | More → Accounts | `accounts.*`; hostd `ops/accounts.rs` | ✅ demo; tests; ✅ lab (isolated agent dir listing) |
| Link an account from the app (browser + tunnel, device code, paste, questions) | Accounts → Link account | same | `accounts.link` + `auth.*` (`authflow.rs`) | ✅ lab (Claude and GitHub Copilot `omp login` up to the sign-in page / device code; cancel closed the tunnel and stopped `omp login`); ⚠️ not completed with a real account |
| First run, board notices, toasts above composers, phone nav for the new pages, long-transcript scroll estimate, prefetch | onboarding, board, session, Dispatch | same | UI | ✅ demo (before/after screenshots at 1440×900 and 412×915) |
| Pasting an image attached it twice on Chromium webviews (WebView2, Android) | composer, Dispatch, terminal | same | `src/core/clipboardImages.ts` | ✅ headless Chromium 150 (one paste: +2 before, +1 after); test |

## §0 What 0.5.3 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| Delete worktree on a card whose folder is already gone drops only that worktree's git registration (0.5.2 ran a repository-wide `git worktree prune`, dropping every other missing worktree too); a locked one is refused | AgentCard, card ⋯ | Flock row ⋯ | `worktree.remove {path}` → hostd `remove_checkout` (`git worktree remove <path>` in the repo root) | ✅ test with real git (two worktrees with deleted folders: removing one keeps the other registered; locked refused), failing before the fix; ✅ lab hostd (parked card's folder deleted by hand, another missing worktree of the repo stayed registered, the card forgot its worktree) |

## §0 What 0.5.2 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| Delete worktree on Done cards whose pane Mark done closed (0.5.1 offered it only while the worktree's workspace was open) | AgentCard, card ⋯ | Flock row ⋯ | `Parked.worktree`, `gh.prStatus {cwd: path}`, `worktree.remove {workspaceId: "", path}` → hostd `remove_checkout` (`git worktree remove`) | ✅ real stack (tf-devserver, lab hostd, herdr session, omp): worktree agent → Mark done → parked after 11 s with its worktree → merged PR (stand-in `gh`) → button → confirm → checkout gone, branch kept, card stays in Done without the button; ✅ demo (gobump seeded parked); unit tests (main checkout refused, dirty needs force, already-gone counts) |

## §0 What 0.5.1 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| One bridge per omp process (global + `-e` copies) | — | — | bridge 1.4.0 `BridgeSlot`, `/teleflock-control`; hostd `bridge.rs` routes only the newest copy of a pid | ✅ lab (omp 18.13.1 with the ambient 1.1.0 copy: newSession/navigate/branch 17/17 + 3/3, was 7/10); unit tests |
| Daemon runs with the user's interactive-shell PATH | — | — | `userenv.rs` (`$SHELL -i -l -c`, 6 s cap, well-known dirs) | ✅ lab (`PATH=/usr/bin:/bin` daemon runs an `env bun` omp from `~/.bun/bin`); unit tests |
| Host setup installs what's missing; fixes apply independently with per-fix outcomes | Hosts → Host setup | More → Hosts | `host.setupApply` (`SetupStatus.applying/failed`), `ops/install.rs` | ✅ lab with sandbox `HOME` (real bun, omp, herdr, gh installs; fake package-manager failure reported per fix); ✅ demo; ⚠️ Windows-local installers, `sudo -n` and wget-only paths not run |
| Connect while the agent works; composer parser for omp 18.13 | session Connect / Retry now | same | `agent.connect` (`When::AlsoStreaming`, `retry_now`), `inject::parse_composer` | ✅ lab (streaming unshared omp connected in 0.8 s); ✅ 94 real pane captures (`docs/research/omp-samples/composer/`) |
| Slow hosts: pane shells (45 s), interactive (90 s), link joins (backoff, room reset), longer app timeouts | — | — | `tf-herdr` `agent_start{shell_wait}`, `omp.rs` join backoff, `Relay::reset_room`, `tf-client` `link::timeout_for` | ✅ CPU-quota lab (3 resumed sessions at 10 % CPU all live, no `error`); ⚠️ no real WSL laptop |
| Password / private-key SSH (Advanced) | HostEditor → Advanced: authentication | same (key import/paste) | `hosts.save/test {secrets}`, `hosts.secretStatus`, `tf-transport` `ssh/auth.rs`, `tf-client` `secrets.rs` | ✅ tests + real OpenSSH 10 sshd from /tmp; ✅ demo; ⚠️ Android key import not run on a device |
| Video attachments | Composer, Dispatch (picker, drop, paste) | same | `upload.begin/chunk/status/finish/cancel`, `src/core/upload.ts` | ✅ lab (14.4 MB mp4 read by a real omp agent; 3 MiB through tf-devserver → tf-client → hostd, SHA-256 checked); ✅ demo; ⚠️ Android picker not run |
| Images/videos into the terminal (paste, drop, phone image key); text pastes as one bracketed paste | TerminalPane | ExtraKeys image key | `uploadFile` + bracketed path paste; `pasteTextInput` | ✅ lab (omp attached a pasted PNG; a two-line paste stayed in omp's composer, where the old path ran a shell's first line); ✅ demo |
| Desktop file drops reach the page | composer, Dispatch, terminal | — | `dragDropEnabled: false`, `shell/fileDrops.ts` guard | ⚠️ desktop app not run here |
| Repository chips, repo filter, Delete worktree for merged/closed PRs | AgentCard, BoardToolbar, card ⋯ | Flock rows, Repos sheet, row ⋯ | `gh.prStatus` (lazy, cached), `worktree.remove` | ✅ demo at 1440×900 and 412×892; ⚠️ gh missing/unauthenticated host covered by unit tests only; parked Done cards fixed in 0.5.2 (above) |
| Android dictation with the microphone permission | — | composer mic | plugin `Dictation.kt` (`SpeechRecognizer`, `RECORD_AUDIO`) | ⚠️ compiled (Gradle, cargo for aarch64); not run on a device |
| Phone layout: no overflow at 360–412 px; keyboard return key matches Enter (newline) in every composer | — | Flock rows/tiles, session composer + header chips, Dispatch, Hosts, Settings, agent chat, New agent | layout only; `enterKeyHint="enter"` | ✅ demo sweep of 45 phone screens at 360×780 and 412×892 (no element past its box); ⚠️ not run on a phone |
| Lighter on slow machines: React Compiler coverage (Babel 7 + build canary), Calm board idles, hidden/inactive window gating, fewer host spawns and writes, coalesced session metas, link survives sleep, WSL distro keepalive, batched webview events, static tray in Calm | — | — | `vite.config.ts`, `src/design`, `state/`, `omp.rs`, `link.rs`, `clients.rs`, `wsl.rs`, `core.rs`, `tray.rs` | ✅ measured before/after (headless Chromium at 1× and 4×; lab hostd with strace; paused-clock tests; a SIGSTOP'd stack kept its link); ⚠️ WebView2, WSL keepalive and tray on real Windows not run |

## §0 What 0.4.0 changed

| Capability | Desktop | Mobile | Method / module | Status |
|---|---|---|---|---|
| AI naming and drafts through omp's tiny role | Dispatch (prefetch while typing, "Naming…" phase), wizard "Name it from the task", New agent name, Fan out name, Rename / workspace rename / template "✨ Suggest", Review "✨ Write it" (commit) and "✨ Write title & description" (PR) | same dialogs and sheets | `ai.complete` → hostd `ops/ai.rs` (`omp --mode json … --model @tiny`, `smol` retry, 3 at once) · `src/core/ai.ts` (cache, dedupe, unavailable memo, fallback) | ✅ demo + unit tests (`ai.test.ts`, `ops/ai.rs`); ✅ real omp 18.12.3 tiny role on Linux (ignored test, ~4 s) |
| One vocabulary (lanes, states, actions, send keys) | `features/shell/vocab.ts` everywhere: board, sidebar, palette, menus, `?` sheet | Flock, More, sheets | — | ✅ demo |
| Glossary terms + self-retiring hints | `<Term>` (tooltip), `useFirstUse` captions, `?` sheet Terms section, Settings → Hints | `<Term>` (tap popover), pager hint | `glossary.ts`, `hints.tsx`, `usePrefs` | ✅ demo |
| First steps checklist | board summary row (demo + new hosts; retires) | — | `board/firstSteps.ts` | ✅ demo |
| Motion budget (Calm default / Lively / Reduced) | Settings → Motion; `html[data-motion]` | same | `useLivelyMotion`, design CSS | ✅ demo |
| Inbox = needs you + unread updates; bell = peek | Inbox, bell | Inbox tab (More → Notifications removed) | `useNotifications` | ✅ demo |
| Setup gaps on the board | `SetupGaps` strip → `#/hosts?setup=<id>` (Host setup opens itself) | Flock strip | `HostInfo.setup` | ✅ demo |

## Before → after (this audit)

| Status | Before | After |
|---|---|---|
| ✅ | 74 | 84 |
| ⚠️ | 44 | 41 |
| ❌ | 17 | 10 |

What closed the ❌ and ⚠️ rows:
- **Slash catalog.** The `/` palette now lists all 87 omp builtins plus their aliases, with argument pickers. hostd's catalog previously rejected 32 of them as unknown.
- **Custom commands.** Extension, prompt-template and skill commands are listed in the palette (`agent.commands`) and accepted by hostd.
- **Queue editing.** Queued chips can be edited or removed (`agent.dequeue`).
- **`/copy`, `/dump`, `/open`.** These now act on this device instead of the host's clipboard or browser.
- **Plan review.** Free-text "Other" now becomes `refine` + feedback, and disabled choices are hidden.
- **Mobile terminal.** Mobile now opens the terminal from the composer (`/terminal` and the TUI-only commands); before, it set an invisible split.

## §2 Hosts and connections

| Capability | Desktop entry | Mobile entry | Frontend → method | hostd/app path | Status |
|---|---|---|---|---|---|
| SSH host (Tailscale SSH, or Advanced: private key / password) | Hosts → HostEditor (address/user/port, Advanced: authentication, Test) | More → Hosts → editor sheet | `hosts.save/test/connect`, `hosts.secretStatus` | L `tf-client/engine.rs`, `secrets.rs`, `tf-transport` SSH | ⚠️ Tailscale SSH against a real peer not exercised; key/password run against a real OpenSSH sshd (0.5.1) |
| Local host | HostEditor kind "Local" | — (Android: SSH + demo only, by spec) | `hosts.save/connect` | L `tf-transport/local.rs` | ⚠️ Windows build not run here |
| WSL host + distro picker | HostEditor kind "WSL" → distro select | — (by spec) | `wsl.distros`, `hosts.save` | L `tf-transport/wsl.rs` (`wsl.exe -d`) | ⚠️ needs Windows |
| Demo host | HostEditor kind "Demo" | same | all host methods | `src/core/demo` | ✅ demo |
| Multi-host aggregate + filter | Title-bar host pill (worst orb, "1/2 online"), sidebar host row click | Flock host chip → filter sheet (worst orb, "1/2 online") | `useHosts().setFilter`, `hostsHealth()` | frontend | ✅ demo |
| herdr session per host | HostEditor → Advanced "herdr session" | same sheet | `hosts.save` → attach `--session` | L `conn.rs`, hostd `daemon.rs` | ✅ (lab sessions use it) |
| Several devices on one host (desktop + phone, apps on different versions) | automatic | automatic | — | L `deploy.rs` never replaces a newer tf-hostd; hostd `attach --replace` / `stop` only move the host forward (architecture §3.2) | ✅ real binaries: a 0.2.0 app reconnecting to a newer daemon attaches to it instead of restarting it; upgrades drop older clients once |
| Phases + Open browser + host-key trust | ConnStatusCard (Open browser, Trust and connect) | More → inline card | `app.openExternal`, `hosts.trustKey` | L `conn.rs` | ✅ demo (simulated auth + fingerprint) |
| Backoff countdown, Retry now, latency | ConnStatusCard, host pill | same | `hosts.connect` | L `conn.rs` | ✅ demo |
| Resume on foreground/network | automatic | automatic (Android network callback) | `Engine::resume` | L `src-tauri/lib.rs` | ⚠️ needs a device |
| Offline-first stale cache | board/sidebar stale treatment | StaleHosts strip | cached `HostState` | L `engine.rs` | ✅ demo (studio-pc host is stale) |
| Setup checklist + one-tap fixes | Hosts → Host setup | More → Hosts | `host.setup/setupApply` | H/B `ops/host.rs`, `ops/install.rs`, `ops/scope.rs` | ⚠️ there is no separate "SSH OK" row; a relay that is down cannot be fixed with one tap (hostd owns the port). `move-herdr-out-of-login-session` (0.4.1): run on a throwaway herdr lab session started from a login scope, all of its processes moved into a new scope and kept running. 0.5.1: installs (omp, bun, herdr, gh, git, ffmpeg) and per-fix outcomes, see §0 |
| Host health | Hosts view, sidebar host rows (CPU sparkline + RAM bar), board Hosts tile (one row per host, load) | More → Hosts | state push (`host.health` exists but is not called directly) | L `ops/host.rs` | ✅ demo |
| Tool updates (omp, herdr) | Hosts → host card: versions, available update, last check, notes/errors, Check now / Update now, auto switch | More → Hosts (same card) | `HostInfo.tools`, `host.toolsUpdate`, `host.toolsConfig` | H `ops/tools.rs` (daemon updater, architecture §3.9) | ✅ demo (forge: omp update waiting; studio-pc: auto off, Homebrew herdr) + lab hostd with fake omp/herdr/curl; hidden for older hostds |

## §3 Information architecture

| Capability | Desktop | Mobile | Status |
|---|---|---|---|
| Title bar (logo, host pill, heartbeat, Ctrl+K, needs pill → Answer next, notification peek, window controls/Snap) | DesktopShell/TitleBar | — (More shows Search) | ✅ demo |
| Sidebar: New task, launchers with descriptions, Board · Inbox · Activity · Usage, hosts with health and actions, workspace tree, Settings | Sidebar | — (FAB sheet + palette) | ✅ demo |
| Board / Session+inspector / Terminal / Review / Activity / Usage / Settings | sidebar | bottom nav + More | ✅ demo |
| Split session+terminal, session+session | Ctrl+\\, "Terminal beside" / "Open beside" | — (mobile opens the full terminal view instead) | ✅ demo (desktop) |
| Palette (descriptions + synonyms), wizards, answer HUD, notification peek, toasts | global overlays | More → Search; Inbox (updates); toasts at the bottom, one at a time | ✅ demo |
| Mobile: bottom nav, Flock widgets, session pager, inspector sheet, terminal extra keys + pinch, swipe rows, long-press, pull-to-refresh, haptics | — | MobileShell, FlockHome, MobileSession, ExtraKeys, SwipeRow | ⚠️ pull-to-refresh skips full-bleed routes; haptics are tied to actions, not every state change (MobileUx scope) |

## §4 Liveness

Board cards, Flock rows and the session header render every encoding listed in the spec table: streaming, tool ring, thinking, swarm, needs-you glow, quiet chip, done flight, calm, stale, global heartbeat/glow/tray. ✅ demo on desktop and phone (412×892 / Pixel 5): Flock rows show the heartbeat with its last-event age, the tok/s sparkline, subagent % done, the diff and the quiet chip. The default motion is Calm (spec §4 motion budget); Lively shows every encoding at once.

## §5 Features

| Capability | Desktop entry | Mobile entry | Frontend → method | hostd path | Status |
|---|---|---|---|---|---|
| Board columns Needs you · Running · Review · Done, drag Review↔Done, live-lane bounce | Kanban | Flock sections + swipe Mark done/Reopen + ⋯ | `agent.archive` | state persist | ✅ demo |
| Done agents close their panes (parked): "closed" chip, Resume / Reopen / Terminal / prompt resume under a new id and views follow; pruned agents vanish (notifications, drafts, mute, toasts, Dispatch, terminal memory) | Kanban Done lane, ⋯ menu, session gate, terminal notice, Settings switch | Flock rows + ⋯, session gate | `agent.archive {close}`, `agent.resume`, `agent.prompt`, `HostInfo.pruned` | herdr pane close + `omp --resume` | ✅ demo |
| Card contents (five zones), quick answers, approvals, input requests ("Answer…" → HUD) | AgentCard/QuickAnswer | Flock needs cards | `agent.answer` | C | ✅ demo |
| Review card: next ship step (Commit N files / Push / Open PR / Merge), Mark done, Open; Delete worktree once the PR is merged or closed (parked Done cards too: by path, hosts ≥ 0.5.2) | AgentCard (`shipMemo` from Review, else lazy `gh.prStatus` for visible worktree cards) | Flock row: Mark done / Review, ⋯ Delete worktree | route + `agent.archive`, `gh.prStatus`, `worktree.remove` | G | ✅ demo; ✅ real stack for parked cards (0.5.2) |
| Summary row (first steps, spend + tightest limit, hosts, live terminal; one strip on short windows) | BentoRow | Flock tiles (Answer →, running ↓, today ›) | state | — | ✅ demo + lab (0.4.1: the tile observes the pane at its real size, fills the tile's width and keeps the newest rows at every window size) |
| Filters (host, repository)/search/group/J-K/H-L | BoardToolbar, useBoardKeys | host filter sheet, Repos sheet | frontend | — | ✅ demo |
| Multi-select (P1) | `X` / Ctrl+click → SelectionBar (Mark done, Reopen, Stop turn, Mute) | long-press → SelectionBar | `agent.archive`, `agent.abort`, settings | — | ✅ demo |
| Transcript, tool cards, thinking | SessionPane | MobileSession pager | `session.open/history` | C replica | ✅ demo |
| Ask card: select/multi/editor/confirm/input | AskCard | same | `agent.answer` | C ui-response | ✅ demo |
| Plan review answer | AskCard (planReview) | same | `agent.answer` | B `resolvePlanReview` (ids execute/compact/keep/refine/save) | ✅ code + test. Fixed here: "Other" text → `refine` + feedback; disabled choices hidden; Dismiss is hidden for plan reviews and hostd rejects `cancel` with a hint |
| Prompt / steer | Composer Enter | Composer send | `agent.prompt` (auto) | C → B → I | ✅ demo + lab (0.4.1: a steer shows as a queued chip at once and stays until its row lands; hostd lists collab-guest steers itself because omp's queue band misses them) |
| Queue follow-up | Alt+Enter, `/queue` | queue button | `agent.prompt` (followUp) / `agent.slash /queue` | B `/queue` → I `ctrl+q` | ✅ demo (queued chip at once, "Sending…" until the host accepts it) |
| **Edit / remove queued chips** | ✎ / ✕ next to the queue chips (on the chip omp pops next, highlighted) | same | **`agent.dequeue` (new)** | B `editor.onDequeue()` (operator draft preserved) | ✅ demo (pull back → composer; remove). Sessions without the bridge get a "needs the bridge" error |
| Stop turn | Esc, header "Stop turn" | composer Stop, ⋯ sheet, swipe | `agent.abort` | C → B → I `esc` | ✅ demo |
| `/` palette | Composer | Composer | see the slash table below | | ✅ demo + test |
| `@` mention | Composer | Composer | `fs.search` | G | ✅ demo |
| Image and video paste/drop | Composer | attach button | `agent.prompt{images}`; videos: `upload.*`, then the host path in the prompt text | C `prompt.images` | ⚠️ images need a collab link; follow-ups with images are rejected (omp's TUI queue has no remote image path); omp needs ffmpeg on the host to read videos |
| Drafts: every text field keeps its value (composers, answers, dialogs, filters) + composer images | everywhere | same | `drafts` / `useDraft` (localStorage `tf.drafts`), images in IndexedDB | — | ✅ demo (survives view switches and reloads; cleared on a successful send/submit) |
| Image viewer: zoom (wheel, pinch, double-click/tap, 1:1), pan, gallery | click a transcript attachment, a tool image or a composer thumbnail | tap; pinch, swipe, swipe down to close | `Lightbox` (`@/design`); transcript images without an inline payload: **`session.image` (new)**; originals: `session.image {original, agentId}` | omp blob store (`<agent dir>/blobs/<sha256>`); hostd `originals/` | ✅ demo; `session.image` run against a real blob store, the journal heal is covered by a replica test. Opens at most at actual size (no blurry upscale). Images the journal or history pages hold as `blob:sha256:` refs, and payloads collab cut from entries over 1 MiB (healed from the journal within seconds), load the full original from the host. 0.4.1: omp downscales images queued while it works (and TUI pastes) before saving them; the viewer swaps in the original when it opens (hostd keeps what TeleFlock sent for 30 days, at most 1 GiB; TUI pastes use the file omp records). Markdown images are not rendered (the parser has no `![]()`) |
| Voice dictation | — | mic (Android: `SpeechRecognizer` through the plugin, asks for `RECORD_AUDIO`; browsers: Web Speech) | text → `agent.prompt` | — | ⚠️ not run on a device |
| Header model/thinking/plan/fast (on/off shown) | Controls | one "model · thinking" chip + Plan/Fast/Goal chips | `agent.setModel/setThinking/setPlan/setFast` | B → I | ✅ demo |
| Goal (objective + budget) | Goal chip → dialog | same | `agent.goal` | B `/goal …` | ⚠️ the call works; **the goal chip state is read from collab meta only**: the bridge `CtlState.goal` is not in `MetaOverlay` (`omp.rs`); HostdCore owns this |
| Inspector: can-it-keep-going (ctx used / limit left), spend, throughput, todos, files | Inspector | inspector sheet (labelled tabs) + composer status pill | session meta | C/B | ✅ demo |
| Subagents steer/kill/revive/transcript | Inspector → Subagents | sheet | `agent.subagent`, `session.subagentTranscript` | C `agent-cmd`, `fetch-transcript` | ✅ demo; ⚠️ real host needs collab |
| Agent chat (omp IRC): inline chat bubbles (inbound left, sends right with delivery state, grouped), Chat tab grouped by peer with unread, jump-to-row, open subagent, direct message | Transcript rows; Inspector → Agent chat | sheet → chat tab | `TranscriptItem::Irc`, `ToolView::Irc`; direct message = `agent.subagent` chat | C replica (`irc:incoming`, parent `<irc>` steer, `write agent://`, `wait`) | ✅ demo + real host (golden samples 18/18b). Direct messages land as the user's message in the subagent, not as IRC (no external IRC endpoint); agent↔agent relays between subagents aren't visible (omp doesn't mirror them) |
| Subagent completion estimate + context % (omp TUI `· 40%` / `· 2.4%/272K`) | Subagents panel, task tool card (+ header "1 live · 40% done"), subagent viewer, board card footer (mean of running subagents) | same | `Subagent.completionPct` / `Subagent.context`, `SubagentSummary.completionPct` | C `AgentProgress.completionPercent` / `contextTokens` / `contextWindow` | ✅ demo + real host (estimate first arrives after ~2 min, interactive omp TUI only) |
| Session tree navigate/branch/fork-from | Inspector → Tree | sheet | `agent.navigate/branch/fork` | B | ✅ demo; ⚠️ fork-from-entry needs the bridge |
| Compact / handoff / export / rename / new / btw | Actions menu + dialogs; Inspector → BTW | Session actions | `agent.compact/handoff/export/rename/newSession/btw`, `agent.btwCancel`, `agent.btwHistory` | B → I; btw = omp's own `/btw` (composer submit, history panel follow-up) | ✅ demo + lab (0.4.1: GUI btws appear in the omp TUI and `/btw` history, follow-ups continue them from either side, TUI btws show in the GUI) |
| Rename herdr handle | — | — | `agent.renameHandle` (no UI caller) | H `agent rename` | ❌ **no UI**: the method exists; needs a field in the Rename dialog (FrontSession) |
| Non-omp agents: terminal-first + send-keys | NonOmpView | same | `agent.keys` | H | ✅ demo |
| Terminal attach, pane tabs, takeover, send-keys, copy/paste, font | TerminalView/Pane | Terminal tab + ExtraKeys | `term.*` | H `terminal session control`; observers open at the pane's PTY size (`TIOCGWINSZ`, Unix) | ✅ demo + lab |
| Existing panes (shells + agents, incl. ones opened in herdr's TUI) listed and attached without creating one; labelled by foreground process / title, folder, tab | TerminalView "Running panes" list (bare route attaches the last-used / focused pane with the list open), sidebar shell rows, workspace menu "Open shell …", palette "Shell · …" | Terminal tab chooser (agents first, then shells with workspace › tab · process · folder) | `term.open{pane}`; `PaneInfo.process` | H `pane.process_info` once per pane terminal, then `/proc` tpgid→comm on rebuilds (Linux; herdr refetch every 60 s elsewhere); new panes appear via herdr `pane.created`/`tab.created` → re-snapshot | ✅ demo + lab (panes from herdr's CLI show in ~0.25 s, `top`/`vi` as process in 0.5–1.6 s) |
| Terminal search (P1) | Ctrl+F / tab menu / palette "Terminal: Find on screen" | same | `@xterm/addon-search` (visible screen) | — | ✅ demo |
| New shell pane (tab / split right / down) | TerminalView "New shell" | same | `term.open{shell,split}` | H | ✅ demo |
| Close a shell pane / rename tab / close tab | tab strip right-click → Rename tab… / Close tab… / Close pane… (confirmed) | long-press a tab | `tab.rename`, `tab.close`, `pane.close` | H | ✅ demo |
| Worktree wizard (browser, badges, recents, new/existing branch, base = `defaultBase` `origin/main` fetched by hostd, path, label, agent, preview) | NewWorktreeDialog | responsive sheet | `fs.list`, `git.branches`, `worktree.create{existing}` | G + H `worktree create` | ✅ demo; ✅ lab (stale clone → fetched base, no upstream); ⚠️ an *already checked-out* worktree is opened via "Open folder", not `worktree.open` |
| Open folder / agent in workspace | NewAgentDialog | palette | `workspace.create`, `agent.start` | H | ✅ demo |
| Dispatch: one message (text and/or images) → named worktree + omp agent, live thread per repo; Auto over a host group (least busy host); base `origin/<default>` | sidebar "New task", `D`, palette | Dispatch tab, FAB "New task" | `ai.complete`, `git.branches`, `fs.list`, `worktree.create{agent{images}}`, `agent.answer` | H `worktree create` + agent start; first prompt + images via collab | ✅ demo (Auto picker, union repos, items-only paste, image-only send, origin/main chip); ✅ real stack (tf-devserver + herdr/omp, pre-0.5); ⚠️ first-prompt images unit-tested in hostd, not yet run against a lab omp |
| Remove worktree (dirty/force), close workspace (+group), rename workspace | Sidebar workspace menu | Review → Workspace actions | `worktree.remove`, `workspace.close{group}`, `workspace.rename` | H | ✅ demo (desktop) |
| Inbox (needs you + updates), Answer-next HUD (Ctrl+J, needs pill) | Inbox, Ctrl+J, title-bar pill | Inbox tab, Flock "Answer →" tile, palette | `agent.answer` | C | ✅ demo |
| Notifications with actions / inline reply | Windows toast actions | Android action buttons + reply | `agent.answer` from `NotifyAction` | L `platform.rs`, `Notifications.kt` | ⚠️ needs a device |
| Quiet hours | Settings | Settings | `settings.set` | L `settings.rs` | ✅ code |
| Per-agent mute (P1) | card ⋯ / session ⋯ / palette; Settings → Muted agents | row ⋯, long-press bar | `settings.set` (`mutedAgents`) | L | ✅ demo |
| Command palette | Ctrl+K | More → Search | — | — | ✅ demo; raw "Run a slash command…" now goes through the same router as the composer |
| Review & ship (diff, commit with ✨ draft or ask agent, push, PR create with ✨ draft, checks, merge, Mark done) | Review + ShipPanel (stepper strip + next-step button below 1360 px) | Review | `git.*`, `gh.*`, `ai.complete` | G | ✅ demo |
| Activity + while-away | Activity | More → Activity | `host.activity` | state | ✅ demo |
| Usage (limits first) | Usage | More → Usage | `host.usage` | `omp stats` | ✅ demo; ⚠️ no budget hints |
| Subscription limits (per account/window, reset countdown, pace projection; inspector tile + header chip < 20 % left) | Usage → Subscriptions & limits; inspector Session pane; session header | More → Usage; session inspector | `host.limits` | `omp usage --json` + `--history --json`, `agent.db` session pin (read-only) | ✅ demo; ✅ real stack (omp 18.12.3, 3 Claude + 1 Codex account) |
| Preview tunnels | link buttons in transcript/terminal | same (in-app webview) | `tunnel.open` | L SSH forward | ✅ demo |
| Session history + resume in new pane | Past sessions | palette | `host.sessions/resume` | G scan + H start `--resume` | ✅ demo |
| Fan-out (P2), templates (P2), focus mode (P2) | Fan out dialog, templates in every start dialog, Focus mode (`F`) | Fan out sheet, templates | `worktree.create` ×N | H | ✅ demo |
| Automations (P1): scheduled agents (worktree or in place), presets + cron with host preview, Run now, enable, runs history, scheduler status, catch-up, skip while busy | Automations (`#/automations[/:hostId]`, Ctrl+7) | More → Automations (sheet editor) | `automation.list/save/delete/run/preview` | hostd `automations/` scheduler → `worktree.create` / `agent.start` recipe (H); systemd keepalive timer → `tf-hostd ensure` | ✅ demo; ✅ unit tests (cron + DST, decide, skip, store, units); ✅ lab: every-minute run started omp in a new worktree, catch-up after downtime, keepalive timer revived the stopped daemon (own scope) |
| Settings honoured | Settings (Motion, Hints, AI naming, notifications, quiet hours, muted, templates, updates) | Settings | `settings.set`, `usePrefs` | L | ✅ demo |
| omp settings (every `omp config` key with omp's own tabs/groups/labels/choices, search, model-roles editor, Other tab for keys omp's panel lacks; the GUI side of omp's `/settings` and `/model roles`) | Settings → New agents → omp settings, host card ⋯ → omp settings, palette, Ctrl+8 | More → omp settings | `omp.settings`, `omp.settingsSet`, `host.models` | hostd `ops/omp_config.rs` (schema via bridge dump mode, `omp config list/set/reset`) | ✅ demo + unit tests (`ompSettings/model.test.ts`, `ops/omp_config.rs`); ✅ real omp 18.12.3 in a temp `PI_CODING_AGENT_DIR` (ignored test + lab hostd) |

## §6 Keyboard map

Ctrl+K, Ctrl+J, Ctrl+1…6, J/K, H/L, Enter, A, T, X, N, D, 1…9, Esc, Enter / Shift+Enter / Alt+Enter, Ctrl+Enter (forms), Ctrl+\\, Ctrl+B and ? are all handled (`shell/keyboard.ts`, `useBoardKeys.ts`, `Composer.tsx`, `SessionPane.tsx`) and listed in the `?` sheet from `vocab.ts`. ✅ demo on desktop. Mobile has no keyboard map, by design.

## omp §1: slash commands (all 87 builtins)

Every builtin is reachable from the session `/` palette, on desktop and mobile. The palette shows argument hints, and its sub-pickers are built from omp's own subcommand metadata. Routing is decided per argument form (`src/features/session/composer/slash.ts`, catalog in `src/core/ompCommands.ts`). hostd accepts exactly the same names (`inject.rs::CATALOG`); `slash.test.ts` asserts that the two lists match.

| Mode | Meaning | Commands |
|---|---|---|
| native | Runs a TeleFlock control | `/model` `/switch` (picker or `agent.setModel`), `/effort`, `/fast on/off`, `/plan` (toggle), `/goal` (dialog; set/pause/resume/drop/budget), `/compact [focus]`, `/handoff`, `/rename`, `/fork [pane]`, `/new`, `/export`, `/btw`, `/tree` and `/branch`/`/rewind` (inspector tree), `/todo` (inspector) and `/todo copy`, `/copy [code\|cmd\|link]`, `/open`, `/dump` (local clipboard), `/collab [start]` (`agent.connect`), plus app-only `/stop` and `/terminal` |
| direct | `agent.slash` (B, or guarded I); the effect shows in the session | `/switch …`, `/effort <lvl>`, `/fast ultra`, `/slow`, `/plan <prompt>`, `/guided-goal`, `/vibe`, `/loop`, `/queue`, `/skillful`, `/extended-context`, `/computer`, `/prewalk`, `/modelpreset save/switch/delete`, `/ratchet`, `/advisor on/off`, `/force`, `/resume <id>`, `/fork window/tab`, `/pin`, `/seance <id>`, `/tan`, `/session pin`, `/delete`*, `/join`, `/leave`, `/todo append/start/done/drop/rm/export/import/expand/collapse`, `/compact <mode>`, `/shake`, `/clear`*, `/fresh`, `/retry`, `/forget-approvals`, `/move <p>`, `/wt`, `/add-dir`, `/remove-dir`, `/jobs kill`, `/cleanse`, `/omfg`, `/browser`, `/reload-plugins`, `/usage reset`, `/logout <p>`, `/restart`*, `/exit` `/quit` `/q`* (* = confirmation toast with a Run button) |
| report | `agent.slash`, then the agent's terminal opens, because omp prints the result only in its TUI | `/fast status` and the other `… status` forms, `/goal show`, `/modelpreset list`, `/advisor status/dump`, `/export <path>`, `/dump all/anon`, `/share`, `/session [info]`, `/collab view/list/status/stop`, `/context`, `/memory …`, `/dirs`, `/jobs [full]`, `/tools`, `/skills …`, `/mcp …`, `/security …`, `/ssh …`, `/marketplace …`, `/plugins …`, `/usage`, `/changelog`, `/hotkeys`, `/stats`, `/todo` (bare, in omp) |
| terminal | "Opens in terminal": one click opens the split terminal (mobile: the terminal view) and runs the command there, so the user continues in omp's own selector | `/model roles`, bare `/switch` `/effort` `/resume` `/seance` `/modelpreset` `/move` `/logout`, `/plan-review`, `/settings`, `/setup` `/providers`, `/login`, `/advisor configure`, `/session delete`, `/todo edit`, `/mcp reauth`, `/marketplace` (bare), `/trace`, `/agents`, `/hub`, `/extensions` `/status`, `/debug`, `/git`, `/pause`, `/live`, `/record` |
| custom | listed from the session (`agent.commands` → B `pi.getCommands()`), sent via `agent.slash` (hostd checks the name against the same list) | prompt templates, extension commands, `/skill:<name>` (free-text `/skill:<name>` still works without the bridge) |

Verification: demo at 1440×900 and 412×892. The sessions exercised the following:
- 91 palette options rendered.
- `/rev` matched the demo's `review` (prompt) and `deploy-preview` (extension) commands.
- `/jobs ` showed the `full` / `kill` picker; `/jobs kill all` ran.
- `/settings` opened the split terminal with an "opens in the terminal" toast.
- `/delete` showed the confirmation toast.
- `/tree` focused the inspector tree.
- `/hotkeys` on mobile navigated to `#/terminal/forge/a/pool`.
- `tab.errors()` was empty.

`bun test` `slash.test.ts` (7 tests) and `cargo test -p tf-hostd` (`catalog_validation`, `command_names`) also cover the routing.

## omp §10 capability table

| Capability | Path | Status |
|---|---|---|
| Prompt idle / steer | C prompt → B → I | ✅ demo; ⚠️ without collab, the bridge fallback queues instead of steering |
| Follow-up queue / dequeue-edit | B `/queue` + `onDequeue` → I `ctrl+q` | ✅ demo |
| Stop | C abort → B → I esc | ✅ |
| Model, thinking, fast/slow, plan | B → I `/switch`, `/effort`, `/fast`, `/slow`, `/plan` | ✅ demo; ⚠️ the injection fallback is idle-only |
| Plan review | B `resolvePlanReview` | ✅ (fixed: Other→refine, disabled hidden) |
| Goal | B/I `/goal …` | ⚠️ the chip does not show a goal set through the bridge (`MetaOverlay` lacks goal) |
| Builtin slash with args / selector-only | B submit / I guarded; selector-only → terminal mode | ✅ |
| `@file` | literal text through C | ⚠️ expansion in a collab prompt is unverified upstream |
| Images | C `prompt.images`; in the terminal: host path pasted (omp attaches it) | ⚠️ collab only from the composer |
| Voice | app-side dictation → text (Android speech recognizer, Web Speech elsewhere) | ⚠️ not run on a device |
| Ask, approvals | C ui-response | ✅ |
| Todos view / edit | C entries / `/todo …` | ✅ |
| Subagents list / transcript / steer / kill / revive | C | ✅ demo |
| Tool cards, thinking, context, cost, tok/s | C (+B context) | ✅ |
| Compaction, handoff, export, rename, new, resume, btw, fork, branch, tree | B → I | ✅ demo |
| Changed files / diff / commit / PR | G | ✅ demo |
| Working/blocked, discovery, model catalog | H + C, `omp models` | ✅ |

## herdr §13 mapping

| Feature | herdr call | Status |
|---|---|---|
| Connect/health, board bootstrap, columns | `status`, `session.snapshot`, `events.subscribe` | ✅ |
| Card name/cwd/kind, live line, todos/ctx | `agent list`, title + collab | ✅ desktop; ⚠️ cwd not displayed |
| Start / stop agent | `workspace create`, `agent start`, send-keys, `pane close` | ✅ |
| Prompt / slash / answer | `agent prompt`, send-keys (fallbacks) | ✅ |
| New worktree / open folder | `worktree create`, `workspace create` | ✅ |
| Terminal + preview | `terminal session control/observe` | ✅ |
| Workspace rename/close(+group) | `workspace rename/close --group` | ✅ |
| Tab rename/close, generic pane close | `tab rename/close`, `pane close` | ❌ blocked on tf-proto host methods |
| Agent handle rename | `agent rename` via `agent.renameHandle` | ❌ no UI |
| Host stats | exec `/proc` | ✅ |
| Notifications | derived from status transitions | ✅ |
| herdr sessions picker | `session list --json` | ⚠️ the session name is typed in the host editor; no list picker |
| Correlate omp | `agent_session` → collab | ✅ |

## Remaining gaps and their blockers

1. **Goal chip with the bridge only.** Add `goal` to `MetaOverlay` in `tf-hostd/src/omp.rs` (HostdCore). The call itself works.
2. **Herdr handle rename UI.** `agent.renameHandle` works; it needs a field in the session Rename dialog (FrontSession).
3. **AI naming on non-Linux hosts.** `ai.complete` was exercised against a real omp 18.12.3 tiny role on Linux; macOS and Windows hosts (npm `omp.cmd` shim) are covered by code and tests only.
4. **Needs real devices or hosts.** Windows local/WSL, Android notification actions and the real SSH connect stay ⚠️ until they are run on a device or host.
