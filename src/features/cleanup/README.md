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
// WorktreeRow.tsx — one worktree: kind chip, branch, path, last agent, PR, created/used, changes, size, Delete / Forget (Forget off on hosts before 0.9.6)
// StorageSection.tsx — omp storage: sessions kept (measured only), Check (dry run), per-category picks, Apply, last apply
// LowDiskNotice.tsx — board notice row (Notices.tsx, kind "disk"): host low on disk → Clean up…; hidden for a day or until worse
// actions.tsx — removeOne (confirm, naming the cards that leave the board with it (`cardsLeaving`) → cleanup.remove, with `expect` / `forget` on hosts ≥ 0.9.6: a worktree that changed is confirmed again with its current row, a folder back is offered for Delete; force / trust asked separately), removeMany (confirm the exact list, one at a time, never force; a changed worktree is listed as not removed)
// background.ts — revalidates / followsScan / expectOf / backgroundNote: hosts that keep their report fresh by themselves (background.test.ts)
// classify.ts — classify / holdOf / bulkSet / totals / sortForPage (classify.test.ts)
// disk.ts — diskLevel / showDiskNotice (classify.test.ts)
// useCleanup.ts — useCleanupReport (this device's last report at once, then the host's with `latest`; follows a scan it asked for with waitMs, never a background one; revalidates, reloadRow), useCleanupStorage (check / apply, follows a run)
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
  again on the worktree itself right before removing it, never on the report; git refuses dirty ones without
  force, and the branch is always kept. Hosts ≥ 0.9.6 also check that it is still what the page showed
  (`expect`: HEAD, branch, unpushed commits, agents, herdr workspace): one that changed gets its confirm again
  with its current facts ("<name> changed since the report", the host's words first, "Delete anyway"; at most
  3 times, never while an agent works in it or it is locked); in a bulk action it is listed as not removed
  ("changed since the report: …"). One the host no longer lists is simply gone.
- **Forget** (a `missing` row): only drops git's record of a folder that is gone, never a checkout (`forget`,
  hosts ≥ 0.9.6). The host refuses when anything is at the path (`not_missing`): a folder that is back (a disk
  mounted again, a restored folder) is offered for Delete instead ("The folder of <name> is back"); one still
  missing (an empty mount point, a folder on the way that can't be read) says why. On older hosts Forget is
  off ("Update TeleFlock on <host> to forget worktrees here"): their tf-hostd could delete a folder that came
  back instead of forgetting it.
- **Delete merged/closed** takes merged and closed ones; **Prune stale** takes stale ones (never the `missing`
  folders: one may sit on a disk that is not mounted, so only the row's "Forget" drops its record). Both
  confirm with the exact list (branch, path, size, what stays and why; files git ignores are deleted with the
  folder), then remove one at a
  time without force or trust and toast what went and what didn't. Worktrees open in herdr close their
  workspace (an idle agent there closes with it; its omp session stays in Past sessions). On hosts ≥ 0.9.6
  both act at once (hostd checks each worktree right before); older hosts' wait while a scan runs.
- **By agent** (default; hosts ≥ 0.9.0 send `owners`, older ones list by repository only): one collapsible group per
  main agent (`groups.ts` `groupByOwner`, `AgentSection.tsx`): its name and title as the board shows it, its state
  (the card's status pill, or "No card" for a session whose card is gone), worktree count, size, last use, its
  repositories and kinds, Open (the card) or Past sessions (its folder), and "Delete N" for its merged, closed and
  stale worktrees (`bulkSetIn(…, "cleanable")`, the same holds and confirm as the tiles). A subagent's worktree sits
  under its top-level agent and names the subagents ("via subagent PR1494"); rows carry a repository chip when
  several repositories are listed; "No agent" comes last. Groups agents without a card first, then ended, done and
  live ones; open while the page lists ≤ 24 worktrees, collapsed beyond (each open group shows 20 rows, then
  "Show more"). "By repository" (`store.ts` `groupBy`) keeps the old list, rows naming their agent and its state.
- **Report**: hosts ≥ 0.9.6 keep the report fresh by themselves (`CleanupReport.background`): a scan every
  30 min and a minute or two after a worktree, workspace or agent changed, below the agents' work, reusing what
  did not change. The page asks with `latest` and is answered from that report at once; a scan starts only
  when it is older than the interval, or on Rescan (`refresh`). A scan the page asked for is followed with
  `waitMs` (1.5 s first, then 15 s while it runs, `followsScan`), so sizes and pull requests fill in; the
  host's own background scan is not followed (the page asks again every 2 min while visible and picks its
  result up). The status line says "Updated in the background · scanned 12m ago" (its tooltip: how often the
  host checks), "Updating in the background · …" with a spinner while the host's own scan runs, and "sizes
  and pull requests are filling in…" while one the page asked for runs (Rescan shows "Scanning…" then, and
  only then). Older hosts ignore `latest`: a report over a minute old starts a scan, every scan is followed,
  and the status line says "scanned …" as before. Rows sort removable kinds first, longest idle first.
- **Last report at once** (`cache.ts`): each host's last report and omp storage status stay on the device,
  in memory across visits and in localStorage across restarts of the app (another format or a damaged copy
  is ignored). The page shows them at once with their age ("scanned 3h ago") and "Updating…" until the
  host answers. While a scan runs, sizes and pull requests it has not filled in yet keep their earlier
  values (`settleReport`; a pull request only for the same branch and HEAD), and the host's first scan
  after a start, still at git, replaces nothing. Nothing acts on a report from before the visit: Delete,
  the bulk tiles and Apply wait for the host's answer (at once on hosts ≥ 0.9.6). A host that is
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

forge plays a 0.9.6 host. It lists its workspaces' worktrees, the parked agents' merged ones (gobump), and
seeded ones only git knows: stale, gone, locked (external SSD), closed with 3 changes, a detached HEAD with
unsaved commits, an automation's merged worktree, a merged docs fix. It starts with the report of a
background pass 12 minutes ago (sizes and pull requests filled in, quiet `stats`), so the page is answered
at once ("Updated in the background · scanned 12m ago"); a short background pass runs every 30 minutes of
demo time and 90 s after a removal. Rescan, a report older than 30 minutes, or an ask without `latest` and
a report over a minute old runs the 1.8 s scan. `cleanup.remove` keeps hostd's checks, refuses a stale
`expect` (`worktree_changed`) and Forget of a folder that is there (`not_missing`; only try-yjs is gone). The
omp storage check finds 23 blobs and 6 MB of WAL (compression unsupported, as on Linux) and an apply empties
what it was given. studio-pc's tf-hostd predates the page and its disk is nearly full, so the board's
low-disk notice shows once it is online. Reloading the page shows the last report at once with
"Updating…" until the demo host (a new one after each reload) answers from its own report.
