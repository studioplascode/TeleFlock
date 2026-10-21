import type { ActivityTier, Status } from "@/design";
import type { Agent, Column, ConnPhase, ConnStatus } from "@/core/gen";

/** Board column → design status (orb/pill colour). */
export const COLUMN_STATUS: Record<Column, Status> = {
  running: "running",
  needs: "needs-you",
  review: "review",
  done: "done",
};

export const COLUMN_SHORT: Record<Column, string> = {
  running: "Run",
  needs: "You",
  review: "Review",
  done: "Done",
};

/** Connection phase → orb status: healthy is lime, in-flight is animated purple, auth needs you. */
export const PHASE_STATUS: Record<ConnPhase, Status> = {
  idle: "idle",
  connecting: "running",
  authenticating: "running",
  authRequired: "needs-you",
  hostKey: "needs-you",
  deploying: "running",
  starting: "running",
  online: "done",
  reconnecting: "running",
  offline: "idle",
  error: "error",
};

export const PHASE_LABEL: Record<ConnPhase, string> = {
  idle: "Not connected",
  connecting: "Connecting",
  authenticating: "Authenticating",
  authRequired: "Sign-in required",
  hostKey: "Verify host key",
  deploying: "Deploying tf-hostd",
  starting: "Starting",
  online: "Online",
  reconnecting: "Reconnecting",
  offline: "Offline",
  error: "Error",
};

/** Phases where a connection attempt is in flight (show progress). */
export function phaseBusy(phase: ConnPhase | undefined): boolean {
  return phase === "connecting" || phase === "authenticating" || phase === "deploying" || phase === "starting" || phase === "reconnecting";
}

/** Short latency/phase text for pills: "14 ms" online, otherwise the phase label. */
export function connSummary(status: ConnStatus | undefined): string {
  if (!status) return PHASE_LABEL.idle;
  if (status.phase === "online") return status.latencyMs !== undefined ? `${Math.round(status.latencyMs)} ms` : "Online";
  return PHASE_LABEL[status.phase];
}

/** Breath speed for an agent orb from its liveness (cheap, state-derived; no pulse subscription). */
export function agentTier(agent: Agent): ActivityTier {
  if (agent.column !== "running") return "calm";
  const tps = agent.live.tps ?? 0;
  if (tps > 45) return "frantic";
  if (tps > 15 || agent.live.streaming) return "busy";
  if (agent.live.tool || agent.live.thinking) return "steady";
  return "calm";
}
