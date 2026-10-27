# features/dispatch (owner: Dispatch)

Fire tasks at a repository like chat messages: every message creates a fresh worktree with an omp
agent whose first prompt is the message. Route `#/dispatch` (`{ name: "dispatch" }`); desktop
sidebar item next to Board, phone bottom-nav tab, palette view "Dispatch", global key `D`.

## Public API

```ts
// src/features/dispatch/DispatchView.tsx — route screen (desktop + phone, full-bleed)
export function DispatchView(): JSX.Element;

// src/features/dispatch/store.ts — persisted threads (zustand persist, localStorage "tf.dispatch", v2)
export const useDispatch: UseBoundStore<…>;      // { threads, lastHost (target), lastRepo, bases, legacyBases, trusted, options, remotes, select, setBase, setOptions, trust, learnRemotes, add, patch, remove, clear }
export function threadKey(target: string, repo: string): string;  // target = host id or "auto:<group>"; repo = root (host) or repo id (Auto)
export function entryHost(key, entry): string;                    // the host an entry went to (entry.hostId, else the thread's host)
export function entryRepo(key, entry): string;                    // that host's checkout root (entry.repo, else the thread's repo)
export function dispatchTask(args: { key?; hostId; repo; prompt; images?; base?; baseLabel?; placed?; options: DispatchOptions; taken: Iterable<string>; resolveBase?: BaseChoice; suggest?: BranchSuggester | null }): DispatchEntry; // suggest: default = tiny model when AI naming is on and there is text; resolveBase { stored?, legacy }: fetch the host's branches, dedupe the name against them and resolve the base there (threadBase)
export function pendingByHost(threads, runningAgentIds, now): Record<string, number>; // dispatches on their way to each host (Auto's workload)
export function suggestDispatchName(hostId, repo, prompt): Promise<string | null>; // the send's suggestBranch call (the composer prefetches through it)
export function resumeInterruptedNaming(): void; // every `naming` entry cut short by a reload (any thread) goes ahead under the fallback name once its host answers; runs after hydration, call at startup
export function retryDispatch(args: { key; id; trust?: boolean; taken: Iterable<string>; host: { agents; workspaces } }): Promise<void>; // on the entry's own host; checks before re-creating
export function isInFlight(entryId: string): boolean;               // request queued / in flight in this tab
export function onDispatchSettled(cb: () => void): () => void;      // after each worktree.create settles
export function pruneAgents(hostId: string, agentIds: readonly string[], sessionIds?: readonly string[]): void; // drop entries (any thread, Auto included) of agents whose omp session was deleted (HostInfo.pruned), and their images
export interface DispatchEntry { id; prompt; createdAt; branch; name; aiNamed?; base?; baseLabel?; options; phase; startedAt?; workspaceId?; agentId?; paneId?; path?; error?; last?; sessionId?; images?; hostId?; repo?; placed? } // phase: naming | queued | creating | started | failed | unknown; sessionId: omp session captured while live
export interface DispatchOptions { templateId: string | null; model: string; thinking: ThinkingLevel | "default"; plan: boolean }

// src/features/dispatch/images.ts — images of sent tasks (IndexedDB "tf.dispatch"/"images", keyed by entry id; memory fallback)
export const MAX_TASK_IMAGES = 8; // their total: MAX_PROMPT_IMAGE_CHARS (@/core/clipboardImages, 12 MiB base64; relay messages cap at 16 MiB)
export function saveEntryImages(id, images): Promise<void>; export function loadEntryImages(id): Promise<ImageInput[] | null>;
export function useEntryImages(id, count): DraftImage[] | null | undefined; // undefined while loading, null = not on this device
export function deleteEntryImages(ids): void; export function sweepEntryImages(liveIds): Promise<void>;

// src/features/dispatch/auto.ts — host groups as one target (auto.test.ts)
export function autoTarget(group): string; export function groupOf(target): string | null; export function groupHosts(profiles, group): HostProfile[];
export function canonicalRemote(url): string | null;              // git@github.com:O/r.git, https://github.com/o/r, ssh://git@github.com:22/o/r → "github.com/o/r"
export function repoIdOf(hostId, root, remotes): string;           // canonical remote, else "local:<host>:<root>"
export function groupRepos(hosts: { hostId; recents }[], remotes): GroupRepo[]; // { id, name, roots: { [hostId]: root }, at }
export function localRepoIds(repo): string[];                      // the "local:<host>:<root>" ids it had before its remote was known
export function findGroupRepo(repos, id): GroupRepo | undefined;   // by id, else by one of those local ids (threads keep the id they started under)

// src/features/dispatch/thread.ts — pure helpers (thread.test.ts)
export const BRANCH_PREFIX = "dispatch/";
export function baseSlug(prompt: string): string;                  // slugFromPrompt or "task": "Add offline caching to the client" → "offline-caching-client"; "Fix the following points and release 0.5.0 when you are done. - … - …" → "release-0-5-0-fixes"
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string; // -2, -3… vs names and dispatch/<name> branches; result ≤ 32 chars (herdr's agent-name limit)
export function cleanSuggestion(s): string | null;                 // an AI slug as a dispatch name (≤ 28 chars, whole words), or null (unusable)
export function nameDispatch(prompt, suggest?): Promise<{ slug; ai }>; // AI slug else prompt slug; the caller dedupes synchronously after the await
export function prefetchKey(draft: string): string | null;         // trimmed draft once it has 3+ words
export function threadBase(list, stored, legacy): { shown; param?; untouched }; // see Behaviour → Base
export function recentRepos(state, dispatched): RecentRepo[];       // workspace repo roots (+ remoteUrl) + dispatched repos, most recent first
export function resolveAgent(entry, agents, scope: { repo; workspaces }): Agent | undefined; // agentId → pane (same name) → name; always inside the entry's worktree
export function slimThreads(threads, maxEntries, maxPrompt): Record<string, DispatchEntry[]>; // persisted copy
```

Shared helpers used here: `@/core/clipboardImages` (`imageFiles(clipboardData | dataTransfer)` reads
`items` *and* `files`, deduplicated — WebKitGTK puts pasted screenshots only in `items`;
`dragHasFiles`; `attachImages` scales images > 3 MB to ≤ 2560 px and adds them within the caps,
as the session composer does), `@/core/workload` (`hostLoad`, `rankHosts`, `pickHost`, `describeLoad`).

## Behaviour
- Top bar: target chip (more than one host, or any host group): single hosts and every host group
  as "Auto · <group>" with each member's current load; repo chip (recent repos of the host:
  workspace repo roots, linked worktrees folded into their repo, plus repos dispatched to before;
  "Browse…" opens the FolderBrowser in repo mode — single hosts only), base-branch chip. The last
  target and the last repo per target are remembered. Picking a repo (chip menu, empty-state chips,
  Browse…) puts focus in the task box. With no recent repos the empty state offers "Browse for a
  repository…". Under the composer: "New worktree" / "Fan out" open those dialogs prefilled with the
  host, repo (and the current draft for Fan out).
- Base: the host's default base, `BranchList.defaultBase` (`origin/<default>` when that
  remote-tracking branch exists), shown on the chip, in the composer hint and on each entry
  (`← origin/main`). Untouched, the send carries no `base`, so a 0.5 hostd fetches and forks from
  `defaultBase`; an older hostd (no `defaultBase`) gets its default branch spelled out. A pick
  (another branch, HEAD) is remembered per thread and sent as is. A base remembered before 0.5 that
  equals the local default branch counts as untouched (`legacyBases`, store v2 migration; without
  a branch list it can't be told apart, so it counts as untouched too). Auto sends (and a send
  before the branch list is in) resolve the base on the host the task goes to (`resolveBase`): a
  remembered branch that host lacks falls back to its default.
- Videos: the same attach button (`image/*,video/*`), paste or drop; chips with name, size, upload
  progress, retry and remove (`@/core/draftVideos`, memory only). A single-host thread uploads each
  video as soon as it is attached; Auto uploads to the host each task goes to, when it is sent.
  `dispatchTask({ videos })` stores `videos: { name, size, path?, upload? }[]` on the entry, which
  waits in `uploading` ("Uploading the video · 45%") before `queued`; the first prompt then carries
  one `Attached video "<name>" (<size>): <host path> (read it to see it)` line per video (after the
  task, inside a template's framing). A failed upload fails the entry (Retry uploads it again); a
  reload mid-upload fails it ("send the task again"); dismissing it drops unsent uploads on the host.
  A video-only task is named `video-task`.
- Images: attach button, paste (clipboard `items` + `files`) or drop into the composer; thumbnails
  with remove and a lightbox; persisted with the draft (`useDraftImages` on the target + repo draft
  key). At most 8 per task and ~9 MB in total (base64 ≤ 12 MiB, under the relay's 16 MiB message
  cap), checked against the images attached by the time each paste is read and again at send;
  images over 3 MB are scaled down first; a clear toast says what was left out. Image-only
  tasks are fine (named `image-task`, no AI naming). The images go to the host as
  `worktree.create { agent: { images } }` and hostd delivers them with the agent's first prompt.
  Each entry keeps its images in IndexedDB (`images.ts`) for the thread's thumbnails and for
  retries; they are deleted when the entry leaves the threads (dismiss, clear, cap, pruned) and
  swept at startup. A host daemon older than 0.5 (or whose version isn't known yet) would ignore
  `agent.images`: Auto leaves such hosts out of an image task's pick, and a send with images to a
  single such host is refused with an "update the host" toast. Images no longer on this device (another
  device's thread, cleared storage) show as "N images (not on this device)" and a retry fails
  with a clear error instead of sending without them.
- Auto (host groups, `HostProfile.group`, set in the host editor): the repo chip lists the union of
  the group hosts' repositories, matched by canonical `origin` URL (scp/https/ssh, `.git`, case
  and ports normalised; learned from workspaces into `remotes`) — each host keeps its own checkout
  root. Every send picks the least busy online host that has the repo (`@/core/workload`: running
  agents and dispatches on their way count 1 each, needs-you 0.3, CPU pressure — max of CPU% and
  load/cores — ×2, memory above 85 % steeply; ties → fewer agents on the way, lower CPU, profile
  order), so consecutive sends alternate between equal hosts. The entry records `hostId`, that
  host's `repo` root and `placed` ("least busy of 2: 1 running · CPU 34% (studio-pc: …)"), shown on
  the card as "on <host> · why". Items, retries, trust (`trusted[host + root]`) and naming use the
  entry's host. The composer hint names the group's hosts and the next pick. No host with the
  repo, or none online → the composer says so and sends nothing. A thread started while the repo
  had no known remote (`local:<host>:<root>`) stays reachable once its remote is learned: it is
  matched by its local id (`findGroupRepo`), and picking the repo goes back to it.
- A dispatch is one `worktree.create { cwd: root, branch: "dispatch/<slug>", base?, label: slug,
  existing: false, trust, agent: { kind: "omp", name: slug, model, thinking, plan, prompt, images? } }`.
  A template's prompt frames the message (as in Fan out). With Settings → AI naming on (and the
  host's omp able to answer), the entry first goes through `naming`: omp's tiny model suggests the
  slug (`suggestBranch`, 10 s cap, "Naming…" on the card, ✨ beside the result); otherwise, on no
  answer, an agent-like answer ("I need to inspect the repository" is rejected by the sanitizer),
  or after a reload mid-naming, the slug comes from the prompt's lead sentence (`slugFromPrompt`).
  The composer asks for the name ahead of time (after ~1.2 s idle with 3+ words; ai.ts caches it),
  so most sends skip the wait. Either way the slug is deduped against existing branches, live agent
  names and every live dispatch on the host (herdr agent names are unique per host, so other repos'
  pending dispatches count).
- Sends never wait for each other: up to 3 creates per thread run at once, more wait as "Queued".
  The composer clears and keeps focus. Enter dispatches on desktop (Shift+Enter newline); on phones
  Enter is a newline and the send button dispatches.
- Reply card: (Naming…) → Queued → Creating worktree → Starting agent (agent present, no turn yet)
  → live status from host state (orb, state pill from `vocab.agentStateWord`, streaming line / tool
  chip, elapsed, quiet chip), Needs-you answered inline with the board's `QuickAnswer`, To review /
  Waiting for prompt / Done; "sent with:" options line; Open session, Terminal, Review.
  Failures show `describeError` with "Trust repository & retry" (untrusted) and "Retry".
  A timeout / lost connection (`timeout`, `not_connected`, `disconnected`) or a reload mid-request
  leaves the entry "Unconfirmed" (amber notice, not a failure): the host may still be creating it,
  so the entry keeps looking for its agent. Every Retry checks first: a matching agent is linked;
  an existing `dispatch/<name>` worktree gets the agent started in it (`agent.start`; "name taken"
  means it is still starting, so it waits); only otherwise is the worktree created again, under a
  fresh name if a leftover branch is in the way.
- Agents are linked only inside the entry's own worktree (same repo root and branch, or the
  checkout path herdr reported), never to a same-named agent of another repo.
  Entries whose agent is gone show the last seen lane ("Finished · closed"), no error.
- Threads keep the newest 200 entries; the view renders the last 60 with "Show earlier" and scrolls
  to each new message (keyed on the newest entry). The thread menu removes failed entries or clears
  the thread (agents and worktrees are untouched).
- Persistence is budgeted: at most 600 entries across all threads, prompts up to 4000 characters.
  A full localStorage retries with a slimmer copy, then stops persisting; the in-memory thread keeps working.
