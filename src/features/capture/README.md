# features/capture (owner: Capture)

Tasks that start outside the app's own composers, and the one entry point that puts them in
Dispatch: **Quick capture** (desktop: a small always-on-top box a system-wide shortcut or the tray
opens) and **Share to TeleFlock** (Android share sheet).

## Public API

```ts
// prefill.ts — the prefilled-task entry point
export function openPrefilledTask(task: PrefilledTask, place?: Place): Promise<void>; // Dispatch opens on `place` (or prefillPlace) with the task in its composer draft
export function prefillPlace(i: PlaceInputs, about?: string): { target; repo: string | null }; // a task about github.com/o/r → a clone of it (current target, the Auto group, else the first host with one); else Dispatch's current target + last repo; repo null = none picked yet
export function applyWaiting(target, repo): Promise<void>;  // a task that came in before any repo was picked lands in the first thread picked
export function moveToAgent(agentKey): void;                // "Send to agent…": what the task added to the Dispatch draft (as edited since) moves to that agent's composer
export function dismissPrefill(): void; export function revealMain(): void;

// task.ts — pure (capture.test.ts)
export interface PrefilledTask { text; images: TaskImage[]; source: "share" | "capture"; repo? }
export function githubRef(text): { repo: "github.com/o/r"; kind: "issue" | "pull"; number } | null;
export function composeShared({ text?, subject? }): { text; repo? }; // subject leads (without " · GitHub"), never twice; a bare issue/PR link gets "GitHub issue o/r#12"
export function mergeDraftText(existing, incoming): string;           // appended after a blank line, never twice
export function imageFilesOf(images): File[];                          // base64 → File, so shares are scaled like pastes (attachImages)

// snapshot.ts — what the capture window shows (capture.test.ts)
export function buildSnapshot(i: CaptureInputs): CaptureSnapshot; // { ready, target, blocked, recents (≤ 8), questions (≤ 9), needs }

// shortcut.ts — accelerators (capture.test.ts)
export function chordToAccelerator(e, platform); parseAccelerator; sameAccelerator; acceleratorCaps; appClash(acc, SHORTCUTS items, platform); systemClash(acc, platform);

// link.ts — capture window ⇄ main window messages
export type ToMain = hello | bye | send | edit | answer | open; export type ToCapture = state | done | ready;
export function mainPort(): Port<ToMain, ToCapture> | null; export function capturePort(): Port<ToCapture, ToMain> | null;

// components
export function QuickCaptureBridge(); // mounted once in App: does what the capture window asks, posts it the snapshot while it shows; starts the Android share inbox
export function CaptureWindow();      // the page of capture.html (src/capture/main.tsx); never starts the core. It imports the Dispatch store for its planning code, whose startup work (resume naming, fail cut-short uploads, image sweep) only the main window runs (`isCaptureWebview`)
export function PrefillBanner({ target, repo, mobile }); // above Dispatch's composer
export function QuickCaptureSettings({ index });         // Settings → Quick capture (desktop app only)
```

## Quick capture (desktop)

- Opened by the system-wide shortcut (`Settings.captureShortcut`; absent or empty = off until the user
  turns it on in Settings, which suggests `Ctrl+Alt+Space`, macOS `Cmd+Shift+Space`), the tray's **Quick capture…**, `teleflock://capture`, or
  Settings → Quick capture → **Open Quick capture**. The shortcut again while the box has focus
  hides it. The window is created on first use (`src-tauri/src/capture.rs`): 640 px wide,
  undecorated, always on top, on all workspaces, not in the taskbar, placed top-centre of the
  monitor under the pointer; its height follows the content (`capture_resize`, 150–640 px).
- Box: Enter dispatches the task to Dispatch's current target + repo (the chip switches to a recent
  one for this capture; it becomes Dispatch's current one after a send), Shift+Enter is a newline,
  Ctrl/⌘+Enter opens it in Dispatch prefilled instead (the main window comes forward), Esc hides.
  Pasted or dropped screenshots come along (scaled > 3 MB, ≤ 8 images, the prompt cap). The typed
  text survives hiding and restarts (`localStorage tf.capture.text`, this page only); images last
  while the window does, so the page tells the shell (`capture_draft`) what it holds and the
  updater doesn't restart the app while the box is focused, has text typed in it, or holds images
  or a send in flight. "Dispatched to <repo>" shows, then the window hides itself after ~1 s
  unless you typed again.
- Next question: the oldest needs-you agent (Tab cycles, "n of N"). Single-choice asks, approvals
  and bare confirms answer with 1–9 while the box is empty (Alt+1–9 while it has text); multi-select,
  typed answers and terminal-only dialogs offer **Answer in TeleFlock** (the Answer-next HUD on that
  agent, main window in front).
- Sends go through Dispatch's own logic (`features/dispatch/send.ts`: Auto placement, the images
  check against hostd 0.5, base and name resolved on the host), with the last Dispatch options. A
  refusal shows in the box (e.g. "H2 is offline"); nothing is sent then.
- Messages: Tauri webview events addressed to one window (`emitTo`), `tf-capture://to-main` /
  `tf-capture://to-capture`; in a browser tab (dev, headless checks) a same-origin BroadcastChannel
  (`tf-capture`). The main window posts the snapshot only while the box shows (hello / bye), and
  only when it changed. A request unanswered for 12 s reads "TeleFlock didn't answer".

### Shortcut clashes and platforms

- Settings → Quick capture shows the state the shell reports (`capture_status` / `capture-status`):
  works, off, taken by another app (the OS refused: `already registered`), not a valid shortcut,
  unsupported, or refused. **Change…** records a key press (needs Ctrl, Alt or Super/⌘; F1–F24 may
  stand alone; Esc cancels); the default comes back with one click. It warns when the combination
  is one of TeleFlock's own (`?` sheet: inside the app the system-wide grab wins) or one the desktop
  usually owns (Alt+Space on Windows, ⌘Space on macOS, Ctrl+Alt+T on Ubuntu…).
- Linux: X11 only (global-hotkey grabs keys on the X root window). On Wayland
  (`WAYLAND_DISPLAY` / `XDG_SESSION_TYPE=wayland`) no app can listen system-wide, so the shortcut
  is not registered and Settings says so and offers the command to bind in the desktop's own
  keyboard settings (`<exe> teleflock://capture`; single-instance forwards it to the running app).
  The tray item works everywhere.

## Share to TeleFlock (Android)

- The app's manifest takes `ACTION_SEND` (`text/plain`, `image/*`) and `ACTION_SEND_MULTIPLE`
  (`image/*`), labelled "New task in TeleFlock". The plugin's `Share.kt` reads text, subject and up to
  8 images (≤ 20 MB each, 32 MB together; only other apps' `content://` URIs whose provider says
  `image/*`: never `file://` paths or the app's own providers) off the main thread while the
  sender's grant lasts, keeps up to 4 shares,
  and fires a `share` plugin event; `androidShare.ts` takes them (`take_shares`, also at start: a
  share can launch the app cold) and calls `openPrefilledTask` with `composeShared`'s text.
  Anything else shared is counted and named in a toast.
- A shared GitHub issue or pull request link prefers a clone of its repository (learned remotes and
  live workspaces, as Auto matches them); otherwise Dispatch's last repo. With no repo picked yet,
  Dispatch asks and the task waits for the first pick.
- The banner above the composer says where the task came from and offers **Send to agent…**: a
  picker over every agent (this repository's first, Needs you first) moves what the task added
  (text as edited, its images) into that agent's composer and opens the session, focused.

## Tests

`bun test src/features/capture` — share text composition, GitHub refs, draft merging, placement
(current target, clones, Auto groups, learned remotes), the capture snapshot (targets, offline,
recents, which questions number keys answer), accelerator recording/parsing/caps and clashes.
