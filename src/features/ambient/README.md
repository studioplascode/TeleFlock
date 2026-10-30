# features/ambient (owner: Wall)

Ambient mode (`#/ambient`): one orb per agent for an old tablet or a second screen. Glanceable from across
the room, cheap enough to stay open all day.

```ts
// @/features/ambient/AmbientView — route screen (lazy), desktop and phone layouts.
export function AmbientView(): JSX.Element;
```

Entry points: sidebar nav (Ambient), phone More › Ambient, the palette (Views › Ambient), the phone wall page.
The shell steps aside on this route (`isBare` in `src/app/routes.tsx`): no sidebar or split on desktop, no bottom
nav on phones; the title bar stays (window controls, drag region). `Esc` or the bar's × leaves for the board.

## What it shows

- **Orbs** (`AmbientOrb.tsx`): every agent that isn't done (the bar's ring button adds done agents, dimmed), in
  the core's stable order (host, workspace, name), so an orb stays where you last saw it whatever its state.
  Each orb carries the board's liveness encodings at room scale (spec §4): state colours; needs you = sunset
  glow + ping (a muted agent keeps the glow, without the nudge); tool running = conic ring; subagents = the
  design `Swarm`; quiet for 90 s while working = amber ring and "quiet 3m"; a ring bursts once when an agent
  changes lane (not into Done); stale host = grey with "last seen". Under the orb: name, state word (· host when
  there are several) · time in minutes, and one detail line (the question, the tool, "thinking…", the title).
- **Layout** (`layout.ts`, tested): `fitOrbs` picks the column count that gives the biggest orbs while every agent
  fits on screen with its label (28–168 px); `ambientTime` words the state's time in minutes ("waiting 6m",
  "turn 1h 04m", "finished 25m ago", "quiet 3m"), redrawn every 15 s rather than every second.
- **Tap:** a needs-you orb opens the answer HUD on that agent (`openAnswerHud`: options, Other…, approvals,
  the HUD's own keys); any other orb opens its session.
- **Bar:** counts ("2 need you · 5 running · 3 to review"), a clock, then controls that stay faint until touched
  or hovered: chimes, keep the screen on, show done, full screen, leave.

## Chimes (`chimes.ts`, `useAmbientChimes.ts`)

Optional (off by default) and per device (`prefs.ts`, `tf.ambient` in localStorage, with the other ambient
settings). One synthesized chime per state an agent enters: needs you (rising triad), finished (falling pair),
back to work (one low note), marked done (a soft fifth); each can be switched on or off and previewed. Defaults:
needs you and finished.

- `stateChanges` compares state snapshots (agent → state); an agent seen for the first time only chimes when it
  arrives needing you, so opening the view or a host coming online doesn't ring for everything already running.
- `ChimeGate` throttles: at most one chime per 2.5 s (changes inside the gap play as one chime when it ends, with
  the most important kind among them), the same agent entering the same state again within 30 s stays quiet (a
  run of questions), and past 6 chimes a minute only "needs you" still sounds.
- Muted agents and the user's quiet hours (Settings › Notifications) stay silent. Notification sounds are separate:
  inside the browser the notification chime also plays for needs-you and finished notifications if it is on.
- Browsers start audio only after a user gesture: the switch that turns chimes on creates the audio context and
  plays a preview.

## Screen

- **Keep the screen on** (on by default, shown only where the Screen Wake Lock API exists: Chromium browsers and
  WebView2): a wake lock while the view is open and visible, asked for again whenever the page comes back.
  Android's WebView and WebKitGTK have no wake lock API, so the Android app needs the system's screen timeout
  (or a native keep-screen-on, not built).
- **Full screen** (browsers only; the desktop app's webviews don't turn the window full screen): the whole page,
  so the answer HUD and menus still show.

## Rendering budget (architecture §6.3)

No backdrop blur, no permanent loops: the glow is a radial gradient painted once; attention layers (`tf-loop`
`animate-breathe` / `animate-ping-soft`) play three cycles in Calm and again on each 20 s nudge, loop in Lively,
never in Reduced, and pause while the window is inactive; the tool ring stands after three turns in Calm; the
working sheen and the thinking pulse exist only in Lively. Times tick every 15 s; the summary and the orb list
re-render only when counts or the agent list change. No session is opened.
