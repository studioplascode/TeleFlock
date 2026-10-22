# features/dispatch (owner: Dispatch)

Fire tasks at a repository like chat messages: every message creates a fresh worktree with an omp
agent whose first prompt is the message. Route `#/dispatch` (`{ name: "dispatch" }`); desktop
sidebar item next to Board, phone bottom-nav tab, palette view "Dispatch", global key `D`.

## Public API

```ts
// src/features/dispatch/DispatchView.tsx — route screen (desktop + phone, full-bleed)
export function DispatchView(): JSX.Element;

// src/features/dispatch/store.ts — persisted threads (zustand persist, localStorage "tf.dispatch")
export const useDispatch: UseBoundStore<…>;      // { threads, lastHost, lastRepo, bases, trusted, options, select, setBase, setOptions, trust, add, patch, remove, clear }
export function threadKey(hostId: string, repo: string): string;   // one thread per host + repo root
export function dispatchTask(args: { hostId; repo; prompt; base?; options: DispatchOptions; taken: Iterable<string>; suggest?: BranchSuggester | null }): DispatchEntry; // suggest: default = tiny model when AI naming is on
export function suggestDispatchName(hostId, repo, prompt): Promise<string | null>; // the send's suggestBranch call (the composer prefetches through it)
export function resumeInterruptedNaming(): void; // every `naming` entry cut short by a reload (any thread) goes ahead under the fallback name once its host answers; runs after hydration, call at startup
export function retryDispatch(args: { hostId; repo; id; trust?: boolean; taken: Iterable<string>; host: { agents; workspaces } }): Promise<void>; // checks before re-creating
export function isInFlight(entryId: string): boolean;               // request queued / in flight in this tab
export function onDispatchSettled(cb: () => void): () => void;      // after each worktree.create settles
export interface DispatchEntry { id; prompt; createdAt; branch; name; aiNamed?; base?; options; phase; startedAt?; workspaceId?; agentId?; paneId?; path?; error?; last? } // phase: naming | queued | creating | started | failed | unknown
export interface DispatchOptions { templateId: string | null; model: string; thinking: ThinkingLevel | "default"; plan: boolean }

// src/features/dispatch/thread.ts — pure helpers (thread.test.ts)
export const BRANCH_PREFIX = "dispatch/";
export function baseSlug(prompt: string): string;                  // "Add offline caching to the client" → "offline-caching-client"
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string; // -2, -3… vs names and dispatch/<name> branches; result ≤ 32 chars (herdr's agent-name limit)
export function cleanSuggestion(s): string | null;                 // an AI slug as a dispatch name (≤ 28 chars, whole words), or null (unusable)
export function nameDispatch(prompt, suggest?): Promise<{ slug; ai }>; // AI slug else prompt slug; the caller dedupes synchronously after the await
export function prefetchKey(draft: string): string | null;         // trimmed draft once it has 3+ words
export function recentRepos(state, dispatched): RecentRepo[];       // workspace repo roots + dispatched repos, most recent first
export function resolveAgent(entry, agents, scope: { repo; workspaces }): Agent | undefined; // agentId → pane (same name) → name; always inside the entry's worktree
export function slimThreads(threads, maxEntries, maxPrompt): Record<string, DispatchEntry[]>; // persisted copy
```

## Behaviour
- Top bar: host chip (more than one host), repo chip (recent repos of the host: workspace repo roots,
  linked worktrees folded into their repo, plus repos dispatched to before; "Browse…" opens the
  FolderBrowser in repo mode), base-branch chip (default branch from `git.branches`, remembered per
  thread). The last host and the last repo per host are remembered. Picking a repo (chip menu,
  empty-state chips, Browse…) puts focus in the task box. With no recent repos the empty state
  offers "Browse for a repository…". Under the composer: "New worktree" / "Fan out" open those
  dialogs prefilled with the host, repo (and the current draft for Fan out).
- A dispatch is one `worktree.create { cwd: repo, branch: "dispatch/<slug>", base, label: slug,
  existing: false, trust, agent: { kind: "omp", name: slug, model, thinking, plan, prompt } }`. A
  template's prompt frames the message (as in Fan out). With Settings → AI naming on (and the host's
  omp able to answer), the entry first goes through `naming`: omp's tiny model suggests the slug
  (`suggestBranch`, 10 s cap, "Naming…" on the card, ✨ beside the result); otherwise, on no answer,
  or after a reload mid-naming, the slug comes from the prompt (whole words, starts with a letter).
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
