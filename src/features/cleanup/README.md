# features/cleanup (owner: Janitor)

The Cleanup page: one host's linked git worktrees with what deciding whether to delete them takes, bulk
"Delete merged/closed" and "Prune stale", and omp's own storage cleanup limited to what is not a session.
Route `#/cleanup[/:hostId]` (`{ name: "cleanup", hostId? }`); phone More, palette view "Cleanup", the host
card's Disk tile ("Clean up ›") and ⋯ menu, and the board's low-disk notice. Host side: architecture §3.17.

## Files

```ts
// CleanupView.tsx — route screen (desktop + phone): disk tile, the two bulk tiles, agent groups (or repos) with their rows, omp storage
// AgentSection.tsx — one main agent's worktrees: header (state, count, size, used, Open, Delete N), paged rows
// groups.ts — groupByOwner / ownerLabel / OWNER_STATE (classify.test.ts)
export function CleanupView(props: { hostId?: string }): JSX.Element;
// WorktreeRow.tsx — one worktree: kind chip, branch, path, last agent, PR, created/used, changes, size, Delete / Forget
// StorageSection.tsx — omp storage: sessions kept (measured only), Check (dry run), per-category picks, Apply, last apply
// LowDiskNotice.tsx — board notice row (Notices.tsx, kind "disk"): host low on disk → Clean up…; hidden for a day or until worse
// actions.tsx — removeOne (confirm → cleanup.remove; force / trust asked separately), removeMany (confirm the exact list, one at a time, never force)
// classify.ts — classify / holdOf / bulkSet / totals / sortForPage (classify.test.ts)
// disk.ts — diskLevel / showDiskNotice (classify.test.ts)
// useCleanup.ts — useCleanupReport (this device's last report at once, then follows the host's scan with waitMs), useCleanupStorage (check / apply, follows a run)
// cache.ts — each host's last report and storage status on this device (memory + localStorage "tf.cleanup.cache", 1 MB, newest hosts first): settleReport, keepReport, keepStorage, useKept (cache.test.ts)
// store.ts — useCleanupPrefs: last host, stale days, hidden low-disk notices (zustand persist, localStorage "tf.cleanup")
```

## Host methods

`cleanup.worktrees` (CleanupScanParams → CleanupReport), `cleanup.remove` (CleanupRemoveParams → Empty),
`cleanup.storage` (CleanupStorageParams → CleanupStorage), `cleanup.storageRun` (CleanupStorageRunParams →
CleanupStorage). Types in `@/core/gen` (`crates/tf-proto/src/cleanup.rs`). An `unknown_method` answer means
the host's tf-hostd predates the page ("Update TeleFlock on <host>").

## Behaviour

- **Kinds** (`classify`), most telling first: `busy` (an agent works or waits for you in it), `missing` (folder
  gone, only git's record is left), `merged` / `closed` (its pull request), `open` (open PR: never stale),
  `stale` (no known PR, no herdr workspace, no agent, untouched for the chosen days: 3/7/14/30/60/90, default
  14; "untouched" is `activeAt`, else `createdAt`), `active`. A worktree without a known PR (gh missing or
  signed out, no GitHub remote) is judged by age alone; the page says why PRs are unknown.
- **Holds**: bulk actions leave out `busy`, `locked`, `orphan` (detached HEAD on a commit no ref contains) and
  `dirty` (uncommitted changes) worktrees and list them as left alone. One at a time, a dirty or orphan one
  goes after a second, explicit "Force remove"; busy and locked ones have no Delete. hostd checks all of it
  again at removal (the report may be minutes old), git refuses dirty ones without force, and the branch is
  always kept.
- **Delete merged/closed** takes merged and closed ones; **Prune stale** takes stale ones (never the `missing`
  folders: one may sit on a disk that is not mounted, so only the row's "Forget" drops its record). Both
  confirm with the exact list (branch, path, size, what stays and why; files git ignores are deleted with the
  folder), then remove one at a
  time without force or trust and toast what went and what didn't. Worktrees open in herdr close their
  workspace (an idle agent there closes with it; its omp session stays in Past sessions). Both are disabled
  while a scan runs.
- **By agent** (default; hosts ≥ 0.9.0 send `owners`, older ones list by repository only): one collapsible group per
  main agent (`groups.ts` `groupByOwner`, `AgentSection.tsx`): its name and title as the board shows it, its state
  (the card's status pill, or "No card" for a session whose card is gone), worktree count, size, last use, its
  repositories and kinds, Open (the card) or Past sessions (its folder), and "Delete N" for its merged, closed and
  stale worktrees (`bulkSetIn(…, "cleanable")`, the same holds and confirm as the tiles). A subagent's worktree sits
  under its top-level agent and names the subagents ("via subagent PR1494"); rows carry a repository chip when
  several repositories are listed; "No agent" comes last. Groups agents without a card first, then ended, done and
  live ones; open while the page lists ≤ 24 worktrees, collapsed beyond (each open group shows 20 rows, then
  "Show more"). "By repository" (`store.ts` `groupBy`) keeps the old list, rows naming their agent and its state.
- **Report**: a scan runs on the host in the background; the page asks with `waitMs` (1.5 s first, then 15 s
  while `scanning`), so sizes and pull requests fill in; Rescan (`refresh`) asks for everything again; the
  page asks again every 2 min while visible. Rows sort removable kinds first, longest idle first.
- **Last report at once** (`cache.ts`): each host's last report and omp storage status stay on the device,
  in memory across visits and in localStorage across restarts of the app (another format or a damaged copy
  is ignored). The page shows them at once with their age ("scanned 3h ago") and "Updating…" until the
  host answers. While a scan runs, sizes and pull requests it has not filled in yet keep their earlier
  values (`settleReport`; a pull request only for the same branch and HEAD), and the host's first scan
  after a start, still at git, replaces nothing. Nothing acts on a report from before the visit: Delete,
  the bulk tiles and Apply wait for the host's answer (as they wait for a running scan). A host that is
  offline shows its last report read-only ("<host> is offline: its last report, scanned 3h ago"); a failed
  ask keeps the report and says "Couldn't update". hostd keeps its own costly facts across restarts too
  (`<home>/cache/cleanup.json`: omp's session index, sizes with a fingerprint of their folders, pull
  requests), so the first scan after an update has owners, sizes and pull requests at once.
- **Chats** (`ChatCleanup`, features/chats, between the repositories and omp storage): the host's chat folders
  (`chat.list`, without the chats of its other herdr sessions) with their card's state, size, age and what keeps
  them; Delete goes through the chat's own confirm (`chat.delete` dry run first); a folder no card uses that holds
  someone's files has no Delete. A host whose daemon predates chats gets one line about updating it; the section
  is gone while no host has chats.
- **omp storage**: Check runs `omp gc` as a dry run (nothing changes) of blobs, WAL and compression and
  measures the session store (shown as kept). Apply runs only the ticked categories that have something to
  do, after a confirm naming them. Sessions are never archived or deleted here (omp's own `gc.archive` and
  `--stale` are never run: TeleFlock prefers removing worktrees to removing sessions).
- **Low disk** (`diskLevel` of `HostHealth`, home file system): critical under 2 GiB free; low under 10 GiB that
  is also under 15 % of the disk. The board notice (online hosts only) links to the page; hiding it lasts a
  day unless the level gets worse. The page's disk tile uses the same tones.

## Demo (`src/core/demo/cleanup.ts`)

forge lists its workspaces' worktrees, the parked agents' merged ones (gobump), and seeded ones only git
knows: stale, gone, locked (external SSD), closed with 3 changes, a detached HEAD with unsaved commits, an
automation's merged worktree, a merged docs fix. A scan takes 1.8 s; `cleanup.remove` keeps hostd's
checks; the omp storage check finds 23 blobs and 6 MB of WAL (compression unsupported, as on Linux) and an
apply empties what it was given. studio-pc's tf-hostd predates the page and its disk is nearly full, so
the board's low-disk notice shows once it is online. Reloading the page shows the last report at once
with "Updating…" while the demo host (a new one after each reload) scans again.
