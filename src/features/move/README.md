# features/move: move an agent to another host

"My laptop is going to sleep: move this agent to the build server." The agent's branch, uncommitted
changes and omp session (with its subagent transcripts and artifacts) travel to another connected host,
which resumes it there. Hosts never talk to each other: the app relays (`src/core/move.ts`, architecture §3.28).

## Entry points

- Card menu (`board/CardMenu.tsx`) and the session header's actions menu (`session/header/Controls.tsx`):
  "Move to host…" (`ACTIONS.moveHost`) for omp agents once a second host is connected (`useCanMove`).
- `openMoveDialog(agentKey)` (`store.ts`) opens the dialog from anywhere. `MoveDialog` is mounted once in
  `app/App.tsx`.
- Parked cards: `ParkedChip` shows `MovedChip` when `agent.parked.moved` is set (see below), and
  `board/agentActions.ts` (`resumeParked`, Reopen in `setArchived`) asks `confirmResumeMoved` first.

## Files

| File | What |
|---|---|
| `store.ts` | zustand `useMoves`: moves keyed by the source agent key (`progress`, `outcome`, abort controller), the dialog state, `startMove` / `cancelMove` / `dismissMove` / `showMove`, and the reconcile trigger |
| `MoveDialog.tsx` | the dialog (`ResponsiveDialog`: Dialog on desktop, BottomSheet on phones): target, preflight, progress, result |
| `usePreflight.ts` | `move.check` (source, once) and `move.probe` (target, per target and picked folder) with the user's `choice` |
| `Preflight.tsx` | target picker, the checklist (agent, session size, branch + commits to push, uncommitted files, target checkout, omp versions, free space), issues (blockers red with hints, warnings amber), repo radio (blocked clones disabled with their reason, "Clone into …", "Choose another folder…" via `FolderBrowser` on the target), folder picker for agents without git |
| `Progress.tsx` | the step list (hosts' own labels and states; the copy step with a bytes bar), the running and result views |
| `MovedChip.tsx` | `moving to <host>…` (shimmer) / `move interrupted` (amber) / `moved → <host>` (opens the agent there when the host and agent id are known) |
| `resumeGuard.ts` | `confirmResumeMoved(key)`: confirm before resuming a `moved` / `interrupted` card; refuse a `moving` one |
| `hosts.ts` | `useMoveTargets`, `useCanMove`, `movedTarget` (host by `hostId`, else by name) |

## The flow

1. Preflight: `move.check` on the source, `move.probe` on the chosen target. "Move to <host>" stays
   disabled while a blocker remains (the source's, the target's or the chosen repository's) or no
   repository / folder is chosen.
2. `runMove` (`core/move.ts`): `move.start` on A (the agent's pane closes, its card turns `moving`),
   copy the parts (`session`, `changes`) A → B, `move.receive` on B, `move.finish` on A.
3. Progress shows A's steps, the copy, B's steps and the final mark. Closing the dialog does not stop the
   move; a toast announces the end.
4. Success: toast with "Open"; if you were viewing A's agent you are taken to B's. "Open on <host>" in the
   result. Failure: the step, the host's message and hint, whether the agent is back on A, and the notes
   (what a rollback could not undo); "Try again" returns to the preflight.

## Failure and rollback

- A fails while preparing: it has rolled itself back; nothing was copied.
- Copy fails: begun uploads are cancelled on B, `move.abort` on A (the agent resumes where it was).
- B fails: B rolled itself back; `move.abort` on A.
- B `confirming` (its launch cannot be confirmed yet; the agent may run there): the stage is `confirming`,
  nothing is aborted — not even by Cancel, which leaves the move `unsettled` with `failure.confirming` —
  the source stays parked and the record stays until B says `done` or `failed`. The receive owns its
  uploads meanwhile (the client never cancels them while B may run it: a rollback needs the patch), and
  the client touches the source's move (`move.status`, every 5 min) so its 30-minute idle sweep does not
  end it; `move.finish` also works on a job that sweep ended (card `interrupted`, agent parked). A refused
  `move.finish` (anything but `not_found`) keeps the record for the next pass.
- Cancel: before the receive, abort A; during it, abort B first (and poll it), then A. A B that finished
  before the abort landed makes the move succeed.
- `move.finish` failing is not a failure of the move: the result carries a note that A's copy isn't marked
  (resuming it there would fork an older copy).
- A host answering `unknown_method` is "too old to move agents"; reconnect it with this app to update it.
- A pushed branch stays pushed.

## Reconcile

Every in-flight move is saved (`localStorage` `tf.moves`: move id, both hosts, agent, stage). On start and
whenever a host comes online, `reconcileMoves` settles records left by a closed app or an unreachable host:
B `done` → `move.finish` on A; B `confirming` → left `unsettled`, asked again next pass; B failed or unaware → `move.abort` on A; then the record is dropped. A move
whose host stayed unreachable is `unsettled`: nothing is rolled back blindly and the record is kept.

## Parked cards

`Parked.moved`: `moving` (the card of the agent being moved), `interrupted` (stopped before the target
confirmed: the target may or may not run it), `moved` (continues on the target; resuming the old card forks
it). Resuming a `moved` / `interrupted` card asks first; a `moving` one is refused with a toast.
