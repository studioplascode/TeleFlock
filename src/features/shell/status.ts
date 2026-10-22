import type { ActivityTier, Status } from "@/design";
import type { Agent, Column, ConnPhase, ConnStatus } from "@/core/gen";

/** Board column → design status (orb/pill colour). */
export const COLUMN_STATUS: Record<Column, Status> = {
  running: "running",
  needs: "needs-you",
  review: "review",
  done: "done",
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

/**
 * Hosts in view → one orb: the worst phase wins (sign-in/key > error > connecting > degraded > online).
 * Degraded = some host offline/idle while another is online, so it is never green over a dead host.
 */
export function hostsHealth(phases: readonly ConnPhase[]): { orb: Status; degraded: boolean; online: number; total: number } {
  const online = phases.filter((p) => p === "online").length;
  const degraded = online > 0 && phases.some((p) => p === "offline" || p === "idle");
  const orb: Status =
    phases.includes("authRequired") || phases.includes("hostKey")
      ? "needs-you"
      : phases.includes("error")
        ? "error"
        : phases.some(phaseBusy)
          ? "running"
          : online > 0 && !degraded
            ? "done"
            : "idle";
  return { orb, degraded, online, total: phases.length };
}

/** Two-word reasons for the stable connection error codes ("Error · unreachable"). */
const ERROR_REASON: Record<string, string> = {
  not_connected: "unreachable",
  timeout: "timed out",
  auth_required: "sign-in needed",
  permission_denied: "login refused",
  version_mismatch: "version mismatch",
  herdr_error: "herdr not answering",
  io_error: "I/O error",
};

/** Short latency/phase text for pills: "14 ms" online, "Error · unreachable", otherwise the phase label. */
export function connSummary(status: ConnStatus | undefined): string {
  if (!status) return PHASE_LABEL.idle;
  if (status.phase === "online") return status.latencyMs !== undefined ? `${Math.round(status.latencyMs)} ms` : "Online";
  const reason = status.phase === "error" && status.error ? ERROR_REASON[status.error.code] : undefined;
  return reason ? `${PHASE_LABEL.error} · ${reason}` : PHASE_LABEL[status.phase];
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
