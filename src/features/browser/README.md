# TeleFlock Browser (`src/features/browser`)

The device's own browser inside the app: a Chromium the app core runs with a persistent profile
(`browser.*`, `AppEvent::Browser`, wire types `tf_proto::browser`), shown and driven by this feature
over CDP. Full description: docs/architecture.md §6.13 (UI), §5.2 (app core), §3.33 (host side).

| File | What it does |
|---|---|
| `controller.ts` | One CDP connection per window (`BrowserStatus.wsUrl`), a session per tab, the tab list, the shown tab's screencast, input, dialogs, file choosers, downloads, favicons; the demo's search address and scripted agent steps. |
| `cdp/` | `connection.ts` (request/answer, flat sessions, a socket factory for the demo), `protocol.ts` (the CDP subset used), `scripts.ts` (page scripts in the panel's isolated world). |
| `tabs.ts`, `owners.ts`, `input.ts`, `frames.ts`, `requests.ts` | Pure models: tab order and history, ownership groups and colours, where the lock for agents is offered (`lockToggle`), key/pointer mapping and the address bar, frame bytes, request cards. Tests: `model.test.ts`. |
| `BrowserPanel.tsx`, `TabStrip.tsx`, `Toolbar.tsx`, `AgentBar.tsx`, `Viewport.tsx`, `PageOverlays.tsx`, `Downloads.tsx` | The panel: tabs grouped by owner (a lock on the ones locked for agents, `BrowserStatus.lockedTabs`), the toolbar ("Lock for agents" / "Unlock for agents" on a tab no agent opened that agents may use, `browser.lockTab`; Take over / Hand back; lending a tab, "to one agent" while tabs are shared), who can control the browser and which tabs ("can use your tabs" or "only the tabs it opens or you lend it", `BrowserStatus.shareTabs`) and who asks, the page, dialogs and file choosers, downloads; when the organization's policy blocks the engine (`BrowserStatus.blocked`), "Use TeleFlock's browser" (download with progress and Cancel, then it starts), what IT can allow when nothing is left, and once after a switch to it, why. |
| `BrowserView.tsx`, `BrowserSplit.tsx` | `#/browser`, the split beside a session, fullscreen. |
| `RequestCard.tsx` | An agent's request as a card (session, panel) saying what allowing gives it (the user's tabs too while shared); Deny only where this device can't allow it (`useHostsBrowser`). |
| `agentMenu.ts` | "Let <agent> use my browser" / "Stop letting <agent> use my browser" for the session header and sidebar menus. |
| `BrowserSettings.tsx` | Settings → Browser: state (and a block with the same button), engine (TeleFlock's browser named so, engines found blocked marked "Blocked by your organization"), TeleFlock's browser's download with Cancel, profile, own window, "Agents can use your tabs" (`shareTabs`, default on; agents browse in them but don't close them, and a tab can be locked for agents), agents at once, on Windows "Sign in to Microsoft with your Windows account" (`microsoftSignIn`, off by default; disabled with "Turned off/on by your organization" when the organization's policy decides, or with why when the browser can't use it: Edge has its own sign-in), clearing data. |
| `actions.ts` | `browser.*` calls with error toasts (attach asks to go over the cap on `browser_busy`; `browser_blocked` toasts carry "Use TeleFlock's browser", `blockedAction`, also used by the board's and the notifications' answer toasts). |
| `observe.ts` | What other features observe (session recording: input, navigations, errors, frames, a toolbar slot). |
| `demo/` | The `?demo` fake Chromium (`fakeBrowser.ts`, canned pages in `pages.ts`); the demo backend's side is `src/core/demo/browser.ts` and `browserAgents.ts`. |

The core decides what a block means (`tf_proto::BrowserFallback`: `switched`, `offer`, `unavailable`);
the UI renders it. `?demo&browser=blocked` opens on Google Chrome blocked with the offer.

Agents see the user's tabs while `shareTabs` is on (after their own; never each other's) and browse
in them, but never close them; a tab the user locks for agents stays on its page (agents read it
and click and type in it, but the proxy refuses their navigating, reloading or closing it; a click
or script in the page that navigates it is not stopped) until it is unlocked or closed. Every tab,
the user's and the agents', is in the one persistent profile's default context, so a sign-in in
any tab is every tab's; the profile continues where it left off, so tabs and session sign-ins
survive the browser restarting (locks do not; docs/architecture.md §5.2).

On Windows the user can let the browser sign in to Microsoft's sites with their Windows account
(Chrome's `CloudAPAuthEnabled` integration): agents they let in then sign in as them too, so it is
off until turned on, the organization's policy goes first, and only Google Chrome, Chromium and
Chrome for Testing have it (Microsoft Edge has its own sign-in; TeleFlock writes nothing for it).
`?demo&signin=windows|org-off|org-on|profile|edge|other` shows the row and its states.

Android has no browser: the page, the split and Settings → Browser are hidden, and a request is
answered with Deny only (allowing happens on a computer).
