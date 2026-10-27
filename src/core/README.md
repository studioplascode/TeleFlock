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
| `ws` | `?core=ws://127.0.0.1:7420/ws`, `VITE_TF_CORE`, or a production build served over http(s) (same-origin `/ws`, i.e. tf-devserver). Production builds ignore a cross-origin `?core=`. The devserver token comes from `<meta name="tf-token">` (injected by tf-devserver for loopback or token-bearing page loads) or the page's `?token=` (keep it in the URL for remote access) and is sent as `/ws?token=…`; a token already in the `?core=` URL is kept when the page has none. `vite dev` against a devserver needs `tf-devserver --allow-origin http://localhost:<port>`. Unreachable same-origin devserver → demo |
| `demo` | `?demo` (or `?demo=empty` for zero profiles / onboarding), or the fallback (e.g. `vite dev`). `?demo&long=2000` seeds `forge::pool` with N extra history rows cycling every item kind and ToolView type (long-transcript perf testing; pages via `session.history`) |

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
`flushCoreEvents()` (test seam), and `startCoreWith(transport, { demoClock? })` (DI/test seam,
import from `@/core/client`).

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
| `useBtw(key)` | `Record<btwId, { turns: ({ question?, text, done } \| undefined)[] }>`: live `/btw` conversations (asked here or in omp's TUI), deltas accumulated per turn; turns never seen live are holes (fill them from `agent.btwHistory`) |
| `useNotifications(sel?)` / `.getState()` | `{ items (Notification & {hostId, read, resolved?}), unread, markRead(), clear() }`; `markRead`/`clear` and `markAgentNotificationsRead(hostId, agentId)` also call `app.notifyRead` so the core retracts OS notifications; `markNotificationRead(hostId, id)` marks one item read on this surface only (the wire has no per-item read); `notifyDone` events mark items read / resolved |
| `useActivity(hostId?)` | `(ActivityEvent & {hostId})[]` newest first; loads `host.activity`, refreshes on lane changes/notifications while mounted. `loadOlderActivity(hostId)` pages |
| `useAccountLimits(hostIds)` | `Record<hostId, { data?: AccountLimits, error?, loading, receivedAt? }>`; one shared `host.limits` poll per host (60 s) while anything is mounted; `refreshLimits(hostId)` forces one. Pure helpers in `limits.ts`: `projectWindow` (pace + `runsOut`/`resetsFirst`/`idle`/`exhausted`/`reset`/`unknown`), `tightestWindow`, `windowsForModel` (tier windows only for models naming the tier), `sessionLimits(data, sessionId, model, now)`, `describePace`, `formatSpan`, `formatPct` |
| `useSettings(sel?)` / `.getState()` | `Settings & { update(patch), setMuted(key, muted), saveTemplate(t), removeTemplate(id), loaded }` (optimistic, rolls back on error; `mutedAgents`/`templates` always present) |
| `isMuted(key)` / `useIsMuted(key)` | agent muted in `settings.mutedAgents` → suppress needs-you toasts, sounds, OS notifications |
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

## Drafts (`drafts.ts`, `draftImages.ts`, `draftSweep.ts`)

Every user-typed field persists so it survives unmounts (switching agent or view), reloads and
restarts. Keys come from `draftKey(scope, ...parts)` with every context identity the value
belongs to (host, agent key, repo, request id, edited item id or `"new"`).

```ts
const [text, setText, clear] = useDraft(draftKey("review.commit", hostId, cwd));      // useState("") drop-in
const [title, setTitle] = useDraft(draftKey("dialog.rename", agentKey), meta.title);  // prefilled field
const [form, setForm, clearForm] = useDraftState(draftKey("hosts.edit", id ?? "new"), profile); // JSON object
drafts.get(key, initial?) / drafts.set(key, value, initial?) / drafts.clear(key) / drafts.clearWhere(pred)
const [images, setImages, clearImages] = useDraftImages(key);                         // composer attachments; setImages(cur => …) edits
```

- A value equal to the field's default (`initial`, `""` by default) deletes the entry; clear form
  drafts only after a successful submit (cancel/close keeps them). Filters are never auto-cleared.
- Text: zustand `persist` to localStorage `tf.drafts`, writes debounced (300 ms, flushed on page
  hide/unload), never throws (quota → smaller budget → memory only). Persisted copies are pruned by
  `pruneDrafts` (`DRAFT_LIMITS`: 400 entries, 30 days, 1 M chars; newest first).
- Images: `DraftImage { mime, data (base64), preview }`, ≤ `MAX_DRAFT_IMAGES` (8) per key, in memory
  and written through to IndexedDB `tf.drafts`/`images` (`{ images: {mime,data}[], at }`; preview is
  rebuilt). Hydrated on first `useDraftImages(key)`; IndexedDB missing or failing → memory only.
  Edits made before the stored images are read show at once and are replayed in order on top of
  them (an added image lands after them, a clear stays a clear); nothing is written before that.
  Edit with updaters (`setImages(cur => …)`, remove by identity), not lists built from a stale render.
  At open, entries older than 30 days and all but the newest 40 are swept.
- Videos (`draftVideos.ts`, through `upload.ts`): memory only (the browser reads a picked file only
  while that page lives; switching agents or views keeps the upload going). `attachVideos(key, hostId
  | null, files)` (≤ 4 per prompt, ≤ 2 GiB each, video mime or extension) starts the upload at once
  when the host is known, one upload per host at a time; `uploadDraftVideos(ids, hostId)` starts
  waiting ones (Dispatch Auto), `whenUploaded(ids)` resolves with `{name, size, path}` once all are
  up (rejects `upload_failed`), `withVideoRefs(text, refs)` appends one `Attached video "<name>"
  (<size>): <host path> (read it to see it)` line each. Removing a chip (`removeDraftVideo`) drops
  the upload on the host, finished or not; a sent one is `detachDraftVideos` + `releaseVideos`.
  `uploadFile(hostId, file, {onProgress, signal, mime})` → `{path, size, sha256, uploadId}` is the
  reusable uploader (terminal pastes use it too; architecture §3.13).
- Answers: `answerDraftKey(agentKey, requestId, field)` (`"other"` is shared by the ask card, board
  quick answer and answer-next HUD). `startDraftSweep()` (called at boot) drops them once the
  agent's online host no longer lists that pending request (30 s grace for fresh typing).
- Agents: drafts whose key holds an agent key move to the new key when a parked agent resumes under a new id
  (`onAgentMoved`), and are deleted (text and images) when the agent is pruned (`onAgentsPruned`); both wired in
  `startDraftSweep()`. Parked/pruned agents themselves: architecture §6.1 and `agentLifecycle.ts`.

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
  | { name: "review"; hostId; workspaceId } | { name: "dispatch" | "inbox" | "activity" | "usage" | "hosts" | "settings" | "more" | "design" };
navigate(route, { replace? }); useRoute(); getRoute(); routeToHash(route); parseHash(hash);
```

Hashes: `#/board`, `#/dispatch`, `#/agent/:h/:a`, `#/terminal/:h`, `#/terminal/:h/p/:paneId`,
`#/terminal/:h/a/:agentId`, `#/review/:h/:ws`, `#/inbox`, `#/activity`, `#/usage`, `#/hosts`,
`#/settings`, `#/more`, `#/design`.

`useUi(sel?)` (zustand; `.getState()`): `dialog: UiDialog | null`, `openDialog`, `closeDialog`,
`paletteOpen`/`setPalette`, `answerNextOpen`/`setAnswerNext` (AppEvent `answerNext` opens it),
`split`/`setSplit`, `sidebarCollapsed`/`toggleSidebar` (persisted), `selectedKey`/`select`, `focusMode`/`setFocusMode`. Dialog kinds include `fanOut { hostId?, cwd?, prompt? }`.
AppEvent `openAgent` navigates to the session.

## AI naming & drafting (`ai.ts`)

The only API UI code uses for AI. Every helper calls `ai.complete` on the host (omp's `tiny` model
role; see `docs/architecture.md` §3.8) and resolves to `null` whenever the caller should use its
deterministic fallback: Settings → AI naming off (`usePrefs().aiNaming`), host unavailable, offline,
timeout, error or junk output. Show AI-made values with a small ✨ and "Named by omp's tiny model".

| Function | Result |
|---|---|
| `useAiNaming(hostId)` / `aiNamingEnabled(hostId)` | `prefs.aiNaming` && host not marked unavailable (hook / non-hook) |
| `suggestBranch(hostId, task, opts?)` | kebab slug, 2–5 words, ≤ 40 chars, starts with a letter, no prefix |
| `suggestAgentName(hostId, task, taken, opts?)` | kebab, 1–3 words, ≤ 24 chars, unique vs `taken` (`-2`, `-3`, …) |
| `suggestTitle(hostId, text, opts?)` | ≤ 6 words, sentence case, no quotes / trailing period |
| `suggestCommitMessage(hostId, { files, patch?, hint? }, opts?)` | `{ subject (≤ 72 chars), body? }` |
| `suggestPullRequest(hostId, { branch, base, commits, files, patch? }, opts?)` | `{ title (≤ 72 chars), body (markdown) }` |
| `suggestTemplateName(hostId, { model?, thinking?, plan?, prompt? }, opts?)` | ≤ 4 words, sentence case |
| `useAiSuggestion(hostId, key, run, { debounceMs? = 900 })` | `{ value, loading }` for the current `key` (null = nothing to suggest); `loading` from the first keystroke until the debounced run settles; results for an older key are dropped |

`opts`: `{ timeoutMs?, cwd? }` (host budget; defaults 12 s for names, 25 s for commit/PR drafts, capped
at 28 s to stay inside the app core's 30 s request timeout; the client gives up 5 s after it). Inputs are clipped (task text 2 000 chars, file list 4 000, patch
12 000, 30 commits). Results are cached 10 min per host + task + input (memory only); identical
in-flight calls share one request; `unknown_method` (older hostd) or `ai_unavailable` marks the host
unavailable for 10 min. Model output is sanitized (labels like `branch:`, `dispatch/`/`feat/`
prefixes, quotes, backticks, chatter lines, Title Case, trailing periods); the sanitizers and
parsers are exported for tests, and `aiTesting` swaps the transport and clock.

## Demo host (`src/core/demo`)

Deterministic seed, time-based progression (`DemoClock`; `ManualClock` in tests).

- **forge** (online): repos teleflock, api-gateway, marketing-site, infra. Agents (ids = names):
  `kanban`, `pool`, `ci` running · `push` (select ask) and `limits` (bash approval) need you ·
  `reconnect`, `hero` in review · `docs`, `flaky` (omp, `notShared` → `agent.connect`), `deps`
  (caps read-only) done · `copy` (kind `claude`, herdr-only, flips working/done) · `scratch` (fresh: idle, `turns: 0`, title "", `~/scratch` not a repo; the director leaves it alone).
- Streaming ≈ 40 tok/s with thinking, tools with live output/elapsed, diffs, todos, subagents
  (pool's task), cost/usage ticking, health jitter every 2 s, pulses at 10 Hz, patches at 5 Hz.
  `ci` goes quiet (> 90 s without events while working) shortly after start, and CI-themed
  follow-ups do it again.
- A director keeps every lane alive: idle agents get prompted from “Pixel 9”, a new question
  arrives 40 s after the Needs-you lane empties (rotating planReview → editor → approval →
  select → confirm), unanswered questions get answered from “Pixel 9” after 4 min, review > 3
  archives the oldest.
- **studio-pc**: stale cached snapshot; cycles offline → reconnecting (attempt, `nextRetryAt`)
  → connecting → then, on odd cycles until trusted, hostKey (`ConnStatus.hostKey`: address,
  `ssh-ed25519`, `SHA256:` fingerprint; unconfirmed for 20 s → error), otherwise authenticating
  → authRequired (fake `login.tailscale.com` URL) → error. `hosts.trustKey` (matching
  fingerprint), `app.openExternal(authUrl)` or `hosts.connect` brings it online for 90 s;
  `hosts.connect` while the key is untrusted asks for it again.
- Every HostMethod answers: prompts (steer / follow-up queue), answers, model/thinking/fast/plan/
  goal, compact, fork, btw (streamed), slash, keys, subagents, archive, connect, start/stop,
  workspaces/worktrees (with realistic herdr/git errors), fs (`/home/demo`, git badges), git/gh
  (hero has a ~4.7k-line diff; PR checks pending → passed in 10 s), terminals (fake shell with
  echo + commands; agent panes mirror the omp stream and Enter prompts the agent; takeover
  closes the previous lease), usage (14 days), models, past sessions, resume, setup/setupApply,
  activity paging, tab.rename/tab.close/pane.close (last pane closes the workspace; refused for a primary with linked worktrees), `ai.complete` (`demo/ai.ts`: deterministic answers per task derived from the prompt after 600–1400 ms; works offline). Settings seed 3 templates. App methods: hosts.*, wsl.distros, settings, tunnels (blob: preview page).
- Agents started with a spec (`worktree.create{agent}`, `agent.start`) begin fresh (idle, `turns: 0`, link
  `connecting`); ~1.4 s later the link goes live and the spec's prompt starts a streamed turn, after which
  they move through the lanes like the seeded agents. `worktree.create` answers after ~350 ms.

## Tests

`bun test src/core` — reducers (patch, rev gap, sessions), per-frame batching, demo invariants, AI sanitizers / cache / dedupe / demo answers.
`src/core/test/bun-test.d.ts` types `bun:test` for the app tsconfig without `@types/bun` globals.
