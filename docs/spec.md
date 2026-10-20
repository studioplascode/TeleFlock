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

## 3. Information architecture
### Desktop (Windows, custom chrome)
- **Title bar.** Logo, host switcher pill (status orb + latency), global heartbeat, Ctrl+K search, needs-you counter, window controls with Windows Snap Layouts.
- **Sidebar** (collapsible):
  - hosts, then the workspace tree (repo → worktrees → agents with orbs)
  - quick actions: New worktree, Open folder, New agent
  - a footer with host health
- **Views**
  - **Board** (home)
  - **Session**, with a right-hand inspector
  - **Terminal**
  - **Review** (diff & ship)
  - **Activity** (a cross-agent timeline)
  - **Usage** (cost/tokens)
  - **Settings**
- **Split view.** Session + Terminal, or Session + Session, side by side.
- **Overlays.** Command palette, New worktree/agent wizard, quick-answer HUD, notification center, toasts.

### Mobile (Android)
- **Bottom nav:** Flock · Inbox · Terminal · More (hosts, usage, settings).
- **Flock home:**
  - bento widgets: needs-you count, running count with heartbeat, today's cost
  - needs-you cards with inline answers
  - running list with live lines and heartbeats
  - in review, then done (collapsed)
- **Session**
  - Full-screen transcript with a sticky ask card.
  - Composer with mic.
  - **Swipe horizontally between agents** (pager ordered: needs-you first, then running).
  - Pull up the inspector sheet.
- **Terminal.** xterm with an extra-keys row; pinch to zoom the font.
- **Sheets.** New worktree wizard, model/thinking pickers, card actions.
- **Gestures.** Swipe actions on rows (Answer · Terminal · Archive), long-press context menus, pull to refresh, and haptic ticks on state changes.

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
| done (transition) | the card flies to In review via a shared layout animation, plus a burst-ring sparkle |
| idle / done done | calm, desaturated, static |
| stale (host disconnected) | desaturated, with a "last seen" timestamp and a shimmer when reconnecting |

Global liveness:
- an aggregated heartbeat in the title bar
- an ambient background glow that mixes purple (work happening) with sunset (needs you)
- a Windows tray icon in the state color with a count badge
- an Android foreground notification: "3 running · 2 need you"

## 5. Feature set
P0 is required for v1, P1 is strongly wanted, P2 is a stretch.

### Board (P0)
- Columns: **Running · Needs you · In review · Done**.
  - **Running** and **Needs you** are derived from live state.
  - **In review** holds finished, unarchived agents.
  - **Done** holds agents the user archived.
- Drag and drop:
  - In review ↔ Done (archive/unarchive).
  - Dropping into a live lane bounces back with an explanation.
  - Archived state is persisted per host.
- Cards show:
  - agent glyph, name, repo · branch
  - task title (session name or first prompt)
  - live line, heartbeat, todo ring, ctx %, elapsed, diff ±, model/thinking chip, subagent swarm
  - needs-you cards: question plus quick-answer chips (ask) or Allow once / for session / Deny (approval)
  - review cards: Review diff / Open PR / Archive
- Above the lanes (P0), a bento summary row:
  - Needs-you hero tile (the first pending question, answerable inline)
  - stats (today's cost and tokens, counts)
  - host health
  - a live mini-terminal tile showing the most active agent's output
- Filters (host, repo, kind), search, group by status or repo, J/K navigation, multi-select (P1).

### Session: omp agents (P0)
- **Transcript.** Virtualized and append-only, with streaming markdown and syntax highlighting.
  - Collapsible thinking blocks ("Thought for 12s").
  - Rich tool cards: read, edit/write (inline diff), bash (ANSI output, exit code, duration), grep/glob/find (match counts, expandable), lsp, web_search (sources), browser (screenshot), eval (cell + output), task (subagent cards with live progress), todo (phase checklist), ask (resolved answer), github, and a generic JSON fallback.
- **Ask card.** Single or multi select, Other with free text, editor requests, approvals. It stays sticky until answered.
- **Composer**
  - Prompt while idle. While running, the default is **steer**, with a toggle to **queue a follow-up**. Queued chips can be edited and removed.
  - Stop (Esc).
  - `/` slash palette with argument hints.
  - `@` file mention with remote file search.
  - Image paste/drop (P1).
  - Voice dictation on mobile (P2).
- **Header controls.** Model picker, thinking selector, plan mode, goal mode (objective + budget), fast mode.
- **Inspector**
  - context meter
  - cost (in/out), tok/s sparkline
  - todos by phase
  - subagents (steer · kill · revive · view transcript)
  - changed files ±
  - session tree (fork / branch from any message)
  - actions: compact, fork, handoff, export, rename, new session
- **Non-omp agents.** A terminal-first session view: herdr state plus the embedded terminal plus quick send-keys.

### Terminal (P0)
- xterm.js with the WebGL renderer, attached to a herdr pane through a PTY.
- Tabs for the workspace's panes, takeover, send-keys toolbar (Esc, Ctrl+C, Tab, arrows), copy/paste, font size, search (P1).
- Mobile extra-keys row with sticky Ctrl/Alt.
- Open a new shell pane in a workspace.

### Workspaces and worktrees (P0)
- **New worktree wizard**
  - remote folder browser with git badges (branch, clean/dirty), recent repos
  - new or existing branch, base ref, auto path preview, label
  - start an omp agent: name, model, thinking, plan mode, initial prompt
  - a command preview of what it will run
- Open a folder as a workspace, start an agent in an existing workspace, rename an agent, remove a worktree (dirty check, force), close a workspace.

### Needs-you handling (P0)
- An inbox of everything waiting, oldest first.
- **Answer next** HUD (Ctrl+J): cycles through blocked agents with the full question context.
- Desktop notifications with actions where the OS supports them. Android notifications with action buttons (≤3 options) or inline reply.
- Per-agent mute and quiet hours (P1).

### Command palette (P0)
Navigate to any agent, workspace or host; run any action; run slash commands for the current session; toggle settings. Ranked fuzzy search with recents.

### Review & ship (P1)
- Worktree diff against base: file tree, unified or split view, syntax highlighting.
- Commit (message editor; "ask the agent to write it"), push, `gh pr create`, PR checks, merge.
- Archive the card on merge.

### Activity (P1)
A unified timeline of all agents (finished, asked, tool failures, commits, PRs). Plus a **"While you were away"** digest on reconnect: finished X, needs you Y, spent $Z.

### Usage (P1)
Cost and tokens per agent, per day, and per model; budget hints; a "today" ticker.

### Preview tunnels (P1)
- Detect `http://localhost:PORT` / `127.0.0.1:PORT` in transcripts and terminal output and offer **Open preview**.
- The SSH port forward opens the default browser on desktop and an in-app webview on mobile.

### Fan-out (P2)
Spawn N worktree agents from one prompt with different models or approaches, then compare them in Review.

### Session history (P2)
Browse past omp sessions on a host and resume one in a new pane.

### Templates (P2)
Saved agent presets and prompt snippets.

### Focus mode (P2)
A single-agent zen view: just the stream and the composer.

## 6. Keyboard map (desktop)
- `Ctrl+K` palette
- `Ctrl+J` answer next
- `Ctrl+1…6` views
- `J/K` move between cards
- `Enter` open
- `A` answer
- `T` terminal
- `N` new worktree
- `Esc` stop (in session) / close overlay
- `Ctrl+Enter` send
- `Alt+Enter` queue follow-up
- `Ctrl+\` split
- `Ctrl+B` sidebar
- `?` shortcuts sheet

## 7. Visual language
- Bento (Draft 10) with omp purple `#a35cf0`. omp gradient `#f053d0 → #a15eef → #7fa2e7`.
- Status: running = animated purple→blue, needs-you = sunset `#ff7a18 → #ff3d77`, review = cyan `#22d3ee`, done = lime `#a3e635`.
- Type: Sora (display), Manrope (UI), JetBrains Mono (code).
- Motion: springs everywhere; shared-layout card flights; pointer tilt with a specular highlight; reduced-motion fallbacks that keep the meaning (static color plus text) without the motion.

## 8. Non-goals (v1)
iOS/macOS/Linux packaging (the codebase stays portable). Editing files directly (the agent edits). Multi-user collaboration. Public-internet relays.
