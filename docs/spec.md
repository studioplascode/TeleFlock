# TeleFlock: product spec (v1)

> The whole flock, alive in your hand. A native GUI for omp agents running in herdr, on Windows and Android.

## 1. Principles
1. **Liveness is the product.** At a glance you can always tell what is working, what is waiting on you, what is stuck, and what is done. Motion carries meaning; it is never decoration alone. A frozen UI must never look the same as a frozen agent.
2. **Unblock in one gesture.** A question or approval can be answered where you see it: on the card, in the inbox, from the notification, or with the "answer next" hotkey.
3. **Native, not a terminal.** Every omp capability has a first-class control. The real terminal is always one keystroke away as an escape hatch.
4. **Honest state.** Stale data is marked as stale, a dead connection looks dead, and failures say what failed and what to do next. The app never shows fake success.
5. **Keyboard-first on desktop, thumb-first on mobile.** The same model, with ergonomics native to each form factor.
6. **Leave the hard parts to herdr and omp.** TeleFlock orchestrates; it never reimplements agent logic.

## 2. Hosts and connections
- **Host kinds**
  - `tailscale-ssh` on desktop and Android: hostname/MagicDNS or IP, user, port 22. No credentials; tailnet identity is the auth.
  - `local`: desktop only, herdr running natively on Windows.
  - `wsl`: desktop only. Pick a WSL distro, then use `wsl.exe -d <distro>`.
  - `demo`: a built-in simulated host for trying the app, screenshots, and tests.
- **Multi-host.** Several saved hosts. The board aggregates every connected host and can filter by host. Each host has a herdr session selector (default `default`).
- **Connection lifecycle**
  - Visible phases: connecting → authenticating → (auth-required: Tailscale check-mode URL with an **Open browser** action) → handshaking → online. Then degraded / reconnecting (exponential backoff with a countdown and a **Retry now** button) / offline.
  - Latency is shown live.
  - The connection resumes automatically after network changes and when the app returns to the foreground.
- **Offline-first.** The last snapshot per host is cached and shown instantly with a "stale" treatment (desaturated plus a shimmer) until live data arrives.
- **Host setup and diagnostics.** A checklist with a one-tap fix for each item:
  1. reachable
  2. SSH OK
  3. herdr version OK
  4. omp version OK
  5. herdr omp integration installed
  6. TeleFlock relay running
  7. omp session sharing enabled (with an explanation of what it changes)
- **Host health.** CPU, RAM, load, disk, uptime, plus herdr and omp versions.
- **Tool updates.** Every host's tf-hostd keeps omp and herdr current by itself (on by default, a per-host switch turns it off): it checks 2 minutes after it starts and every 6 hours, installs with `omp update` / plain `herdr update` (never a live herdr handoff, never a channel switch; running herdr servers and agents keep running). The host card shows the versions, an available update, the last check, a spinner while it runs, notes (package-manager installs, a herdr server that switches on its next restart) and errors, plus **Check now** / **Update now**.

## 3. Information architecture
### Desktop (Windows, custom chrome)
- **Title bar.** Logo, host switcher pill (worst status orb across hosts + "1/2 online"; it is the host filter), global heartbeat ("last event …"), Ctrl+K search, needs-you pill (opens Answer next, like Ctrl+J), notifications bell (a peek at the Inbox's updates, neutral badge), window controls with Windows Snap Layouts.
- **Sidebar** (collapsible, drag to resize):
  - **＋ New task** (D → Dispatch), then the start launchers New worktree (N) · New agent · Fan out · Open folder · Past sessions, labelled from 240 px with their one-line descriptions in tooltips
  - nav: Board · Inbox · Activity · Usage (Ctrl+1–4); the Inbox badge is the needs-you count, a dot marks unread updates
  - HOSTS ("Manage ›" → Hosts, Ctrl+5): one row per host with status, latency, CPU and RAM, and its connection action (Connect / Retry / Sign in / Verify) when it isn't online; a row click filters to that host
  - the workspace tree (repo → worktrees → agents with orbs and state words) takes the remaining height
  - footer: Settings (Ctrl+6) and collapse
- **Views**
  - **Board** (home)
  - **Dispatch**: a chat-like task launcher (pick a repo, every message becomes a worktree + omp agent, named by omp's tiny model)
  - **Session**, with a right-hand inspector
  - **Terminal**
  - **Review** (diff & ship)
  - **Inbox** (what needs you, then unread updates)
  - **Activity** (a cross-agent timeline)
  - **Usage** (cost/tokens, subscription limits first)
  - **Hosts**, **Settings**
- **Split view.** Session + Terminal, or Session + Session, side by side.
- **Overlays.** Command palette (every action with its description), New worktree/agent wizards, Fan out, Answer-next HUD, notification peek, toasts.
- **One fact, one place.** A fact is drawn once per screen with its unit and verb (`ctx 61%`, `turn 27:24`); duplicates are pointers (a link), never a second rendering of the same control.

### Mobile (Android)
- **Bottom nav:** Flock · Inbox · Dispatch · Terminal · More (hosts, usage, activity, settings). Inbox: needs-you count + a dot for unread updates; More: a dot only for a host problem. Terminal reopens the terminal used last, else an "Attach to…" list.
- **Flock home:**
  - tiles that act: needs-you count (Answer → opens the HUD), running count with heartbeat (scrolls to Running), today's cost (opens Usage)
  - needs-you cards with inline answers (each option's description in its button)
  - running list with live lines, heartbeats, tok/s, ctx, subagents and diff, a ⋯ menu per row
  - review (Mark done / Review on each row), then done (collapsed)
- **Session**
  - Full-screen transcript with a sticky ask card.
  - Composer with mic.
  - **Swipe horizontally between agents** (pager ordered: needs-you first, then running); a **Next** chip above the composer jumps to the next agent waiting on you.
  - A status pill in the composer (ctx · $ · todos) and the header both open the inspector sheet.
- **Terminal.** xterm with an extra-keys row; pinch to zoom the font.
- **Sheets.** New worktree wizard, model+thinking picker, session ⋯ menu, card actions.
- **Gestures** (each has a visible twin: a ⋯ menu or a button). Swipe actions on rows (Answer · Terminal · Stop turn · Mark done), long-press multi-select, pull to refresh, and haptic ticks on state changes.

## 4. Liveness system (the #1 ask)
Liveness per agent is computed from the herdr state, the time since the last omp event, streaming status, the active tool, tokens/s, and subagents.

| Situation | Encoding |
|---|---|
| streaming tokens | fast-breathing purple orb, shimmering live line with caret, heartbeat spikes per chunk, tok/s sparkline |
| tool running | rotating conic ring around the orb, tool chip with a ticking elapsed timer, a progress bar if known |
| waiting on the model (no tokens yet) | slow deep pulse, "thinking…" shimmer with a timer |
| subagents live | orbiting swarm dots (count = live subagents) |
| needs you | sunset glow + pulse, a gentle nudge animation every 20s, the card lifts in the Needs-you lane, global ambient bloom turns warm, taskbar/tray badge |
| quiet while "working" (no events for over 90s) | amber "quiet for 2m" chip and a flatline heartbeat, so the user knows it might be stuck |
| done (transition) | the card flies to Review via a shared layout animation, plus a burst-ring sparkle |
| idle / done done | calm, desaturated, static |
| stale (host disconnected) | desaturated, with a "last seen" timestamp and a shimmer when reconnecting |

**Motion budget.** Settings → Motion: **Calm** (default, follows the OS reduced-motion setting) animates only changes and what needs you; running cards keep the heartbeat trace and the tool ring, without glow borders, breathing orbs, ring comets or orbiting swarms. **Lively** restores every encoding above. **Reduced** removes motion; every state keeps its colour and text.

Global liveness:
- an aggregated heartbeat in the title bar
- an ambient background glow that mixes purple (work happening) with sunset (needs you)
- a Windows tray icon in the state color with a count badge
- an Android foreground notification: "3 running · 2 need you"

## 5. Feature set
P0 is required for v1, P1 is strongly wanted, P2 is a stretch.

### Board (P0)
- Columns: **Needs you · Running · Review · Done** (Needs you leads: it is the lane that asks for action).
  - **Needs you** and **Running** are derived from live state.
  - **Review** holds finished agents not yet marked done, and fresh agents waiting for their first prompt.
  - **Done** holds agents the user marked done.
  - Each lane header carries its legend (sort order + what the card time means).
- Drag and drop:
  - Review ↔ Done (mark done / reopen). Mark done has an Undo toast, no confirmation; "Mark done & remove worktree…" asks first.
  - Mark done also closes the agent's pane (and its worktree workspace when nothing else runs there) once it is idle, after a 10 s undo window (Settings › "Close panes of done agents", on by default). The card stays in Done with a quiet "closed" chip; Resume, Reopen, Terminal or a message resumes it (`omp --resume`) under a new id, and open views follow it. An agent whose omp session file is deleted disappears from every view.
  - Dropping into a live lane bounces back with an explanation.
  - Done state is persisted per host.
- Cards: five fixed zones in every lane.
  1. state strip: state word (Question / Approval / Running · tool / To review / Waiting for prompt / Done) and the time with its verb (`waiting 6:13`, `turn 27:24`, `finished 25m ago`)
  2. identity: todo ring or glyph, name, host name chip (several hosts), repo · branch
  3. task title (session name or first prompt)
  4. lane body: live line, tool chip with timer, heartbeat, tok/s | question with answers (each option's description in its button; "+N more" opens the HUD) or Allow once / for session / Deny | the next ship step (Commit 3 files / Push / Open PR / Merge), Mark done, Open
  5. meters in one order that wraps rather than hides: `ctx 61%` · `subs 59%` · `+188 −74 · 3 files` · model · thinking
- Above the lanes (P0), a summary row (one ~72 px strip on windows ≤ 820 px tall):
  - First steps (demo and new hosts only; retires itself)
  - today's cost and tokens with the tightest subscription window (→ Usage)
  - hosts: one row per host with status, latency, CPU, RAM and load (→ Hosts)
  - a live mini-terminal tile showing the most active agent's output
  - strips for offline hosts (snapshot age, read-only) and for setup gaps (Fix… → Host setup)
- Filters (host via the title-bar pill, repo, kind), search, group by status or repo, J/K and H/L navigation, multi-select (P1).

### Session: omp agents (P0)
- **Transcript.** Virtualized and append-only, with streaming markdown and syntax highlighting.
  - Collapsible thinking blocks ("Thought for 12s").
  - Rich tool cards: read, edit/write (inline diff), bash (ANSI output, exit code, duration), grep/glob/find (match counts, expandable), lsp, web_search (sources), browser (screenshot), eval (cell + output), task (subagent cards with live progress), todo (phase checklist), ask (resolved answer), github, and a generic JSON fallback.
- **Ask card.** Single or multi select (options numbered 1…N, Other = N+1, recommended marked with ★), Other with free text, editor requests, approvals, Skip (answer nothing). It stays sticky until answered. The same option control renders on cards, the Inbox, the HUD and the phone.
- **Composer**
  - `Enter` sends while idle and **steers** while running; `Alt+Enter` queues a **follow-up**; `Shift+Enter` is a newline. A steer or follow-up shows as a queued chip the moment it is sent and stays until it lands in the transcript; queued chips can be edited and removed.
  - Stop turn (Esc).
  - `/` slash palette with argument hints.
  - `@` file mention with remote file search.
  - Image paste/drop (P1).
  - Voice dictation on mobile (P2).
- **Header controls.** Model picker, thinking selector, plan mode, goal mode (objective + budget), fast mode, each showing whether it is on. Cost shows in the header only while the inspector is hidden.
- **Inspector** (ordered by what you ask first)
  - can it keep going: context used and subscription left, as two labelled bars (`ctx 61% used`, `limit 41% left`)
  - spend: total, main / subagents / advisor, tokens in/out
  - throughput: tok/s sparkline, now/peak, per source
  - todos by phase (with the blocked count)
  - subagents (steer · kill · revive · view transcript)
  - changed files ± (→ Review)
  - agent chat, BTW (omp's own `/btw`: the same conversations as the TUI and its `/btw` history, including ones asked in the terminal, each with follow-ups and cancel), session tree (fork / branch from any message)
  - actions (⋯ menu, each with a one-line description): compact, hand off, fork, rename, export, new session, mute, stop turn, end session (exit omp / close pane, which asks first)
- **Fresh agents** show starter prompts (they fill the composer; nothing is sent) and a one-line legend of the header controls.
- **Non-omp agents.** A terminal-first session view: herdr state plus the embedded terminal plus quick send-keys.

### Terminal (P0)
- xterm.js with the WebGL renderer, attached to a herdr pane through a PTY.
- Tabs for the workspace's panes, takeover, send-keys toolbar (Esc, Ctrl+C, Tab, arrows), copy/paste, font size, search (P1).
- Every pane already running on the host (shells and agents, including ones opened in herdr's own TUI) is listed and attachable without creating anything: the desktop Terminal view's "Running panes" list (by workspace and tab, named by foreground process or title, with the folder), sidebar shell rows under each workspace, workspace menus ("Open shell …"), palette "Shell · …" entries, and the phone chooser.
- Mobile extra-keys row with sticky Ctrl/Alt.
- Open a new shell pane in a workspace (a separate, explicit action).

### Workspaces and worktrees (P0)
- **New worktree wizard**
  - remote folder browser with git badges (branch, clean/dirty), recent repos
  - new or existing branch, base ref (default: the remote's default branch, e.g. `origin/main`, fetched first so a stale local `main` never becomes the base; the new branch does not track it), auto path preview, label
  - start an omp agent: name, model, thinking, plan mode, initial prompt
  - the branch can be left to omp's tiny model ("Name it from the task"): it names the branch and the agent from the prompt at the Create step, editable
  - a command preview of what it will run
- Open a folder as a workspace, start an agent in an existing workspace, rename an agent (✨ Suggest), remove a worktree (dirty check, force), close a workspace.

### Needs-you handling (P0)
- The **Inbox**: everything waiting on you, oldest first, then unread updates (finished, errors, quiet). The bell peeks at the same updates.
- **Answer next** HUD (Ctrl+J, or the title-bar needs-you pill): cycles through blocked agents with the full question context, including typed-answer (editor) and confirm requests.
- Desktop notifications with actions where the OS supports them. Android notifications with action buttons (≤3 options) or inline reply.
- Per-agent mute and quiet hours (P1).

### Command palette (P0)
Navigate to any agent, workspace or host; run any action (each with its one-line description); run slash commands for the current session; toggle settings. Ranked fuzzy search with recents and synonyms ("task", "archive", "answer").

### Review & ship (P1)
- Worktree diff against base: file tree, unified or split view, syntax highlighting.
- Commit (message editor; ✨ draft with omp's tiny model, or ask the agent to write it), push, `gh pr create` (✨ title and description), PR checks, merge.
- A ship stepper (Commit · Push · PR · Merge · Done) with the next step as a button, always visible; Review cards on the board show the same next step.
- Mark done (or Mark done & remove worktree…) from the Done stage.

### Activity (P1)
A unified timeline of all agents (finished, asked, tool failures, commits, PRs). Plus a **"While you were away"** digest on reconnect: finished X, needs you Y, spent $Z.

### Usage (P1)
Subscription limits and today first, then cost and tokens per day, per model and per agent; budget hints.

### Preview tunnels (P1)
- Detect `http://localhost:PORT` / `127.0.0.1:PORT` in transcripts and terminal output and offer **Open preview**.
- The SSH port forward opens the default browser on desktop and an in-app webview on mobile.

### Fan-out (P2)
Spawn N worktree agents from one prompt with different models or approaches, then compare them in Review.

### Dispatch
Fire tasks at a repository like messages in a chat. Pick a host — or a host group as "Auto · <group>" — and a repo (recent repos from open workspaces, or browse) and a base branch (default: `origin/<default>`, fetched before forking); each message creates a `dispatch/<slug>` worktree with an omp agent whose first prompt is the message and its images (attach, paste or drop screenshots; image-only tasks are fine). In Auto, the repos are those of the group's hosts (matched by their origin remote) and each message goes to the least busy online host that has the repo (by running agents, dispatches on their way, CPU, memory); the card says where it went and why. The slug comes from omp's tiny model (fetched while you type, so most sends don't wait), or from the message's lead sentence when AI naming is off, slow or answers like an agent instead of a name. Sends run independently, so many tasks go out back to back. The thread (per host or group + repo, kept across restarts; images kept on the device) shows each message with a live reply card: naming, launch steps, then status, streaming line, inline answers for Needs-you, Open session / Terminal / Review, and readable failures with fixes (trust the repo, retry). Per-dispatch options: template or model + thinking, plan mode. Links under the composer open New worktree and Fan out with the repository filled in.

### AI assistance (P1)
TeleFlock's AI provider is omp itself: `ai.complete` runs one `omp --mode json` completion on the host with the `tiny` model role (falling back to `smol`), without tools, session, extensions or title, and stops the process as soon as the answer is in. It names Dispatch worktrees, wizard branches and agents, fan-out runs and templates, suggests renames, and drafts commit messages and PR titles/descriptions. Results are marked ✨, always editable, cached for 10 minutes, and replaced by a name from the user's own words when AI naming is off (Settings), unavailable or slow. Prompts are never logged or stored.

### Session history (P2)
Browse past omp sessions on a host and resume one in a new pane.

### Templates (P2)
Saved agent presets and prompt snippets.

### Focus mode (P2)
A single-agent zen view: just the stream and the composer.

## 6. Keyboard map (desktop)
- `Ctrl+K` palette
- `Ctrl+J` answer next
- `Ctrl+1…6` views: Board · Inbox · Activity · Usage · Hosts · Settings
- `D` new task (Dispatch), `N` new worktree
- `J/K` move between cards, `H/L` between lanes
- `Enter` open session
- `A` answer
- `T` terminal
- `X` / `Ctrl+click` select
- `1…9` pick an answer (Other = N+1)
- Typing: `Enter` send / steer, `Shift+Enter` newline, `Alt+Enter` queue a follow-up (while the agent works); `Ctrl+Enter` submits multi-field forms (wizards, commit, PR)
- `Esc`: close the overlay, else leave focus mode, else stop the turn (in a session)
- `Ctrl+\` split
- `Ctrl+B` sidebar
- `?` shortcuts sheet (with the Terms glossary)

## 7. Visual language
- Bento (Draft 10) with omp purple `#a35cf0`. omp gradient `#f053d0 → #a15eef → #7fa2e7`.
- Status: running = animated purple→blue, needs-you = sunset `#ff7a18 → #ff3d77`, review = cyan `#22d3ee`, done = lime `#a3e635`, warn/quiet = amber. **These hues mean state and nothing else.** Host identity uses a muted palette that shares no hue with them (`HOST_COLORS`), always next to the host's name; meters stay neutral until they reach a warning level.
- Vocabulary: one word per lane, state and action (`src/features/shell/vocab.ts`); terms that need explaining carry a dotted underline (`<Term>`, `glossary.ts`).
- Type: Sora (display), Manrope (UI), JetBrains Mono (code).
- Motion: springs everywhere; shared-layout card flights; pointer tilt with a specular highlight; Calm by default (only change and needs-you move), Lively on request; reduced-motion fallbacks that keep the meaning (static color plus text) without the motion.

## 8. Non-goals (v1)
iOS/macOS/Linux packaging (the codebase stays portable). Editing files directly (the agent edits). Multi-user collaboration. Public-internet relays.
