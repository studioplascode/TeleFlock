import { create } from "zustand";

/** What Review last learned about a worktree's ship pipeline (git status + `gh.prStatus`). */
export interface ShipMemo {
  /** Index into the ship stages (commit, push, PR, merge, wrap up) of the first step not yet done. */
  stage: number;
  blocked: boolean;
  /** One-line next step ("Merge #142"). */
  next: string;
  /** Pull request number, when one exists. */
  pr?: number;
}

/**
 * Last known ship state per worktree (`hostId/workspaceId`), fed by the Review view while it polls.
 * Board review cards read it to show the PR stepper and the next ship step without polling `gh` per card.
 * In memory only: a restart forgets it until Review is opened again.
 */
export const useShipMemo = create<{ byWorkspace: Record<string, ShipMemo> }>()(() => ({ byWorkspace: {} }));

/** Called by Review whenever its ship state changes. */
export function rememberShip(hostId: string, workspaceId: string, memo: ShipMemo): void {
  const key = `${hostId}/${workspaceId}`;
  const prev = useShipMemo.getState().byWorkspace[key];
  if (prev && prev.stage === memo.stage && prev.blocked === memo.blocked && prev.next === memo.next && prev.pr === memo.pr) return;
  useShipMemo.setState((s) => ({ byWorkspace: { ...s.byWorkspace, [key]: memo } }));
}
