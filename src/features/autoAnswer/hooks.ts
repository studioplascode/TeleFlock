import { useCore } from "@/core";
import type { AutoAnswer, AutoAnswerCountdown } from "@/core/gen";
import { useNow } from "@/design";
import { type CountdownView, countdownState, currentCountdown, samePolicy } from "./format";

/**
 * The countdown on the question an agent shows now, with its words (`countdownState`). Re-renders
 * every second only while it counts down to a deadline; one that stands still (waiting for no app,
 * cancelled) or is being answered doesn't tick, and other agent updates don't reach it.
 */
export function useCountdown(agentKey: string): { countdown: AutoAnswerCountdown; view: CountdownView } | null {
  const cd = useCore(
    (s) => currentCountdown(s.agents[agentKey]),
    (a, b) =>
      a === b ||
      (!!a && !!b && a.requestId === b.requestId && a.status === b.status && a.deadline === b.deadline && a.remainingMs === b.remainingMs && a.picks.join("\n") === b.picks.join("\n")),
  );
  const now = useNow(cd?.status === "counting" && cd.deadline !== undefined ? 1000 : null);
  return cd ? { countdown: cd, view: countdownState(cd, now) } : null;
}

/** The host's decide-for-me default (`HostInfo.autoAnswer`); undefined for a tf-hostd without decide for me, or a host never seen. */
export function useHostAutoAnswer(hostId: string | undefined): AutoAnswer | undefined {
  return useCore((s) => (hostId ? s.hosts[hostId]?.state.info.autoAnswer : undefined), samePolicy);
}

/** "Decide for me…" applies to this agent: an omp agent on a host with decide for me. */
export function useCanDecide(agentKey: string): boolean {
  return useCore((s) => {
    const a = s.agents[agentKey];
    return a?.kind === "omp" && !!s.hosts[a.hostId]?.state.info.autoAnswer;
  });
}
