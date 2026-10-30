import { type CountdownPhase, formatWait } from "./format";

/** "+10 min" and "+1 h": more time on a countdown that counts or stands (`agent.autoAnswerPostpone`). */
export const POSTPONE_SECS: readonly number[] = [600, 3_600];

/**
 * A button of the ask card's decide-for-me strip. `cancel`: `agent.autoAnswerCancel`; `postpone` and
 * `restart`: `agent.autoAnswerPostpone` by `secs` (a cancelled countdown starts again with `secs` left).
 */
export type CountdownAction = { kind: "cancel"; label: string; title: string } | { kind: "postpone" | "restart"; secs: number; label: string; title: string };

/**
 * The strip's buttons for a countdown phase: Cancel, +10 min, +1 h while it counts or stands; Restart
 * with the policy's whole wait (`afterSecs`) once cancelled; none while it picks, or with no policy to
 * restart.
 */
export function countdownActions(phase: CountdownPhase, afterSecs: number | undefined): CountdownAction[] {
  if (phase === "counting" || phase === "waiting") {
    return [
      { kind: "cancel", label: "Cancel", title: "Don't auto-pick: this question waits for you" },
      ...POSTPONE_SECS.map((secs) => ({ kind: "postpone" as const, secs, label: `+${formatWait(secs)}`, title: `Wait ${formatWait(secs)} longer` })),
    ];
  }
  if (phase === "cancelled" && afterSecs !== undefined) {
    return [{ kind: "restart", secs: afterSecs, label: "Restart", title: `Count down again from ${formatWait(afterSecs)}` }];
  }
  return [];
}
