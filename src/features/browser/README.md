# TeleFlock Browser (`src/features/browser`)

The device's own browser inside the app: a Chromium the app core runs with a persistent profile
(`browser.*`, `AppEvent::Browser`, wire types `tf_proto::browser`), shown and driven by this feature
over CDP. Full description: docs/architecture.md §6.13 (UI), §5.2 (app core), §3.33 (host side).

| File | What it does |
|---|---|
| `controller.ts` | One CDP connection per window (`BrowserStatus.wsUrl`), a session per tab, the tab list, the shown tab's screencast, input, dialogs, file choosers, downloads, favicons; the demo's search address and scripted agent steps. |
| `cdp/` | `connection.ts` (request/answer, flat sessions, a socket factory for the demo), `protocol.ts` (the CDP subset used), `scripts.ts` (page scripts in the panel's isolated world). |
| `tabs.ts`, `owners.ts`, `input.ts`, `frames.ts`, `requests.ts` | Pure models: tab order and history, ownership groups and colours, key/pointer mapping and the address bar, frame bytes, request cards. Tests: `model.test.ts`. |
| `BrowserPanel.tsx`, `TabStrip.tsx`, `Toolbar.tsx`, `AgentBar.tsx`, `Viewport.tsx`, `PageOverlays.tsx`, `Downloads.tsx` | The panel: tabs grouped by owner, the toolbar (Take over / Hand back), who can control the browser and who asks, the page, dialogs and file choosers, downloads. |
| `BrowserView.tsx`, `BrowserSplit.tsx` | `#/browser`, the split beside a session, fullscreen. |
| `RequestCard.tsx` | An agent's request as a card (session, panel); Deny only where this device can't allow it (`useHostsBrowser`). |
| `agentMenu.ts` | "Let <agent> use my browser" / "Stop letting <agent> use my browser" for the session header and sidebar menus. |
| `BrowserSettings.tsx` | Settings → Browser: state, engine, Chrome for Testing download, profile, own window, agents at once, clearing data. |
| `actions.ts` | `browser.*` calls with error toasts (attach asks to go over the cap on `browser_busy`). |
| `observe.ts` | What other features observe (session recording: input, navigations, errors, frames, a toolbar slot). |
| `demo/` | The `?demo` fake Chromium (`fakeBrowser.ts`, canned pages in `pages.ts`); the demo backend's side is `src/core/demo/browser.ts` and `browserAgents.ts`. |

Android has no browser: the page, the split and Settings → Browser are hidden, and a request is
answered with Deny only (allowing happens on a computer).
