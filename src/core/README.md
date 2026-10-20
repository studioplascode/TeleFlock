# `@/core` — TeleFlock frontend core

Transports, typed client, zustand stores with per-frame batching, imperative pulse/terminal
buses, hash navigation, UI state, and the demo host. Wire types come from `@/core/gen`
(generated from `crates/tf-proto`; never edit).

```ts
import { core, startCore, useAgentKeys, useAgent, navigate } from "@/core";
```

## Boot & backend selection

`startCore()` is idempotent. `main.tsx` calls it before rendering; importing the hooks in a
browser also starts it.

| Backend | Chosen when |
|---|---|
| `tauri` | inside the Tauri webview (`window.__TAURI_INTERNALS__`) — `core_call` / `core_term_input` / `core_events(Channel)` |
| `ws` | `?core=ws://127.0.0.1:7420/ws`, `VITE_TF_CORE`, or a production build served over http(s) (same-origin `/ws`, i.e. tf-devserver). Unreachable same-origin devserver → demo |
| `demo` | `?demo` (or `?demo=empty` for zero profiles / onboarding), or the fallback (e.g. `vite dev`) |

Host profiles with `kind: "demo"` always route to the in-process demo engine, even with a real
backend (offline “Try the demo”). Events the real core emits about demo hosts are ignored.

## Client

```ts
core.backend;                                             // "tauri" | "ws" | "demo"
await core.app("hosts.list", {});                         // AppMethods, typed
await core.host(hostId).call("agent.answer", { agentId, requestId, answer }); // HostMethods, typed
core.termInput(hostId, termId, data);                      // fast path, no response
```

Rejections are `CoreError` (`extends Error implements ApiError`: `code`, `message`, `hint?`,
`retryable`). Helpers: `isApiError(e)`, `toApiError(e)`, `apiError(code, msg, {hint, retryable})`.

Other entry points: `onAppEvent(cb)` (raw AppEvents as they arrive, before the store flush —
toasts, `openAgent`), `refreshHost(hostId)` / `refreshAll()` (`state.get`, applied in order),
`flushCoreEvents()` (test seam).

## Stores & hooks

One zustand data store, written once per animation frame (events are queued and reduced in
order; rAF with a 100 ms timer fallback for hidden tabs). Untouched agents, sessions and
transcript rows keep identity, so selectors re-render only what changed.

| Hook | Returns |
|---|---|
| `useHosts(sel?)` / `.getState()` | `{ profiles, status, filter, setFilter(id), loaded }` (filter persisted; `"all"`) |
| `useHostIds()` | host ids in profile order |
| `useHostState(hostId)` | `HostState \| undefined` (cached snapshot when offline) |
| `useHostStale(hostId)` | `true` when showing a cached snapshot (status ≠ online) |
| `useHostStates()` | `Record<hostId, HostState>` (stable between changes) |
| `useWorkspaces(hostId)` | `Workspace[]` |
| `useAgent(key)` | `AgentView \| undefined` (`Agent & { hostId, key }`) |
| `useAgentKeys(filter?)` / `useColumnKeys(column, filter?)` | ordered keys. Filter `{ column?, hostId? ("all" ok), workspaceId?, repo?, kind?, q? }`. Order: needs → oldest request first; running → longest running first; review/done → newest first; no column → host, workspace, name |
| `useInbox()` | Needs-you keys across hosts, oldest first |
| `useSession(key)` | `{ status, meta?, itemIds, ui?, hasMore, error?, endedReason? }` — `ui` is `UiRequest \| null` once loaded |
| `useSessionItem(key, itemId)` | one `TranscriptItem` (per-row subscription) |
| `useBtw(key)` | `Record<btwId, { text, done }>` (deltas accumulated) |
| `useNotifications(sel?)` / `.getState()` | `{ items (Notification & {hostId, read}), unread, markRead(), clear() }` |
| `useActivity(hostId?)` | `(ActivityEvent & {hostId})[]` newest first; loads `host.activity`, refreshes on lane changes/notifications while mounted. `loadOlderActivity(hostId)` pages |
| `useSettings(sel?)` / `.getState()` | `Settings & { update(patch), loaded }` (optimistic, rolls back on error) |
| `useTunnels()` | `TunnelInfo[]` |
| `useBackend()` | current backend |
| `useCore(selector, equal?)` | raw `CoreState` access for aggregates (pass `shallow` for derived arrays/objects) |

Non-reactive: `getAgentViews()`, `getWorkspacesSnapshot()`, `selectAgentKeys(state, filter)`.

Sessions are ref-counted:

```tsx
useEffect(() => openSession(key), [key]);   // returns release; closes 8 s after the last release
const { itemIds, ui, meta, hasMore } = useSession(key);
// rows: <Row key={id} k={key} id={id} /> → useSessionItem(key, id)
if (hasMore) await loadOlder(key);
```

Live sessions are reopened automatically when a host comes back online or the devserver
socket reconnects. A host patch with a revision gap triggers `state.get`.

## Imperative buses (no React state)

```ts
const off = pulseBus.subscribe(agentKey(hostId, agentId), (p, at) => orbRef.current?.beat(p.n));
pulseBus.subscribeAll((key, p, at) => heartbeat.beat(p));
termBus.subscribe(hostId, termId, (ev) => ev.k === "frame" && term.write(base64ToBytes(ev.data)));
```

`termBus` buffers events for terminals nobody listens to yet (from the last full frame, ≤ 256
events / 15 s) and replays them on the first subscribe, so the initial frame is never lost.

## Navigation & UI

```ts
type Route = { name: "board" } | { name: "agent"; hostId; agentId } | { name: "terminal"; hostId; paneId?; agentId? }
  | { name: "review"; hostId; workspaceId } | { name: "inbox" | "activity" | "usage" | "hosts" | "settings" | "more" | "design" };
navigate(route, { replace? }); useRoute(); getRoute(); routeToHash(route); parseHash(hash);
```

Hashes: `#/board`, `#/agent/:h/:a`, `#/terminal/:h`, `#/terminal/:h/p/:paneId`,
`#/terminal/:h/a/:agentId`, `#/review/:h/:ws`, `#/inbox`, `#/activity`, `#/usage`, `#/hosts`,
`#/settings`, `#/more`, `#/design`.

`useUi(sel?)` (zustand; `.getState()`): `dialog: UiDialog | null`, `openDialog`, `closeDialog`,
`paletteOpen`/`setPalette`, `answerNextOpen`/`setAnswerNext` (AppEvent `answerNext` opens it),
`split`/`setSplit`, `sidebarCollapsed`/`toggleSidebar` (persisted), `selectedKey`/`select`.
AppEvent `openAgent` navigates to the session.

## Demo host (`src/core/demo`)

Deterministic seed, time-based progression (`DemoClock`; `ManualClock` in tests).

- **forge** (online): repos teleflock, api-gateway, marketing-site, infra. Agents (ids = names):
  `kanban`, `pool`, `ci` running · `push` (select ask) and `limits` (bash approval) need you ·
  `reconnect`, `hero` in review · `docs`, `flaky` (omp, `notShared` → `agent.connect`), `deps`
  (caps read-only) done · `copy` (kind `claude`, herdr-only, flips working/done).
- Streaming ≈ 40 tok/s with thinking, tools with live output/elapsed, diffs, todos, subagents
  (pool's task), cost/usage ticking, health jitter every 2 s, pulses at 10 Hz, patches at 5 Hz.
  `ci` goes quiet (> 90 s without events while working) shortly after start, and CI-themed
  follow-ups do it again.
- A director keeps every lane alive: idle agents get prompted from “Pixel 9”, a new question
  arrives 40 s after the Needs-you lane empties (rotating planReview → editor → approval →
  select → confirm), unanswered questions get answered from “Pixel 9” after 4 min, review > 3
  archives the oldest.
- **studio-pc**: stale cached snapshot; cycles offline → reconnecting (attempt, `nextRetryAt`)
  → connecting → authenticating → authRequired (fake `login.tailscale.com` URL) → error.
  `app.openExternal(authUrl)` or `hosts.connect` brings it online for 90 s.
- Every HostMethod answers: prompts (steer / follow-up queue), answers, model/thinking/fast/plan/
  goal, compact, fork, btw (streamed), slash, keys, subagents, archive, connect, start/stop,
  workspaces/worktrees (with realistic herdr/git errors), fs (`/home/demo`, git badges), git/gh
  (hero has a ~4.7k-line diff; PR checks pending → passed in 10 s), terminals (fake shell with
  echo + commands; agent panes mirror the omp stream and Enter prompts the agent; takeover
  closes the previous lease), usage (14 days), models, past sessions, resume, setup/setupApply,
  activity paging. App methods: hosts.*, wsl.distros, settings, tunnels (blob: preview page).

## Tests

`bun test src/core` — reducers (patch, rev gap, sessions), per-frame batching, demo invariants.
`src/core/test/bun-test.d.ts` types `bun:test` for the app tsconfig without `@types/bun` globals.
