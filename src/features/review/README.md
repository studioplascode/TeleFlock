# features/review (owner: FrontOps)

Review and ship a worktree: route `#/review/:hostId/:workspaceId` (`ReviewView`), the diff viewer
(`diff/`), the file tree and the ship panel (commit → push → PR → merge → done, `ShipPanel.tsx`).

## Public API (ship panel parts)

```ts
// src/features/review/ShipPanel.tsx
export function shipState(status: GitStatusResult, pr: PrInfo | undefined): ShipState; // stage, dirty, unpushed, merged, blocked?, next
export function usePrStatus(hostId, cwd): HostQuery<PrStatusResult>;                    // gh.prStatus, polled 4 s while checks run / mergeability is computed, else 15 s
export function ShipPanel(props: ShipPanelProps): JSX.Element; export function ShipStepper(…); export function ShipStrip(…);

// src/features/review/fix.ts — Make it green / rebase and resolve (pure parts tested in fix.test.ts)
export function fixOffer(pr): { green: boolean; rebase?: "conflicts" | "behind" }; // failing checks; mergeable false / mergeState DIRTY, or BEHIND
export function prNext(pr): string;                    // "PR #7 closed" | "#7 checks running" | "Make #7 green" | "Rebase #7" | "Merge #7" (stepper, board cards)
export function rebaseOnto(pr, defaultBranch): string; // origin/<pr.baseRef ?? default ?? main>
export function rebasePrompt(onto, why): string;       // fetch, rebase, resolve keeping both sides' intent, test, push --force-with-lease, ask on product decisions
export function worktreeAgent(agents, ws): Agent | undefined; // live omp agent of the workspace (idle first), else the latest parked one in its checkout
export function fixBlocker(agent, kind): string | undefined;  // why the button is disabled (busy, needs you, not connected, no bridge for /green)
export function startFix(hostId, cwd, kind, agent: AgentView, rebase?): Promise<void>;
export function fixPhase(run, agent, pr, now): FixPhase;      // resuming | sending | failed | starting | working | needsYou | checksRunning | recheck | done | stopped
export const useFixRuns; export function fixKey(hostId, cwd); export function dismissFix(key); export function noteWorking(key);

// src/features/review/FixPanel.tsx
export function FixActions(props: { hostId; cwd; workspace; pr; defaultBranch? }): JSX.Element | null; // inside the PR card
```

## Make it green, rebase and resolve

- Failing checks on the open pull request: **Make it green** next to "merge anyway". The worktree's
  agent runs omp's bundled `/green` through `agent.slash` (omp's composer runs the command: it
  watches the CI runs of HEAD, reads the failing logs, fixes, pushes and repeats until they pass).
  `agent.prompt` is not used: it would send the text `/green` to the model. Needs TeleFlock's bridge
  in that omp (it lists `green` among the session's commands).
- GitHub reports conflicts (`mergeable: false`, `mergeState: DIRTY`) or the branch behind its base
  (`BEHIND`, where the repo requires up-to-date branches; hosts ≥ 0.7.0 send `mergeState`/`baseRef`):
  **Rebase onto origin/<base> and resolve** sends `rebasePrompt` with `agent.prompt`.
- The agent: a live omp agent of the workspace, an idle one first; else the most recently parked omp
  agent whose worktree (or cwd) is this checkout. A parked agent is resumed first (`resumeAgent`),
  then asked once it is connected, idle and (for `/green`) has its bridge (`whenAgent`, 2 min).
- Progress (one strip in the PR card, per worktree, in memory on this device): Resuming… → Sending… →
  starting → working (with its live line, Watch) / asking you (Answer) → checks running after its push
  / GitHub re-checking after a rebase → All checks pass / up to date (✓, dismiss), or stopped with
  checks still failing / still not mergeable, or the error. A sent request whose turn never shows up
  counts as stopped after 30 s. Buttons come back once a run is done, stopped or failed.
- Demo host: the hero branch's first CI run fails after its PR is created (Make it green runs a
  scripted `/green` turn, then CI passes), and reconnect's draft PR #142 conflicts with main (the
  rebase prompt runs a scripted rebase turn, then it is mergeable).
