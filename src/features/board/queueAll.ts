import { type CoreState, selectAgentKeys } from "@/core";
import type { Delivery, OmpInfo } from "@/core/gen";
import { herdrDown, herdrNotRunning } from "@/features/hosts/herdrHealth";
import { PHASE_TEXT } from "@/features/shell/status";

/*
 * "Queue a message for all running agents" (QueueAllDialog): who gets it, and why some can't.
 * The rules are the session composer's (`disabledReason`) with what the board knows without an
 * open session: the host, its herdr, the agent's kind and its link to omp. An open session's
 * capabilities add what only they tell (a read-only link).
 */

/** The board filters that pick the recipients: a host id or `"all"`, and a repo (null: every repo). */
export interface QueueScope {
  hostId: string;
  repo: string | null;
}

/** Running agents in scope, in the Running lane's order (longest running first). */
export function runningKeys(s: CoreState, scope: QueueScope): string[] {
  return selectAgentKeys(s, { column: "running", hostId: scope.hostId, repo: scope.repo ?? undefined });
}

/** The link to omp isn't live: what stands in the way, in the words of the session's link gate. */
function linkBlock(omp: OmpInfo | undefined, host: string): string {
  switch (omp?.link) {
    case "notShared":
      if (omp.linkReason === "sharedElsewhere") return "Shared on another relay: Connect it first";
      if (omp.linkReason === "viewOnly") return "Shared read-only: Connect it again with control";
      return "Not connected to TeleFlock: Connect it first";
    case "connecting":
      return "Connecting to its session…";
    case "unsupported":
      return "This omp can't be driven natively";
    case "error":
      return omp.linkReason === "relayDown" ? `TeleFlock's relay isn't running on ${host}` : "Lost the link to its session";
    default:
      return "Not connected to this session";
  }
}

/**
 * Why the agent can't take the message now, in a few words for its row; null when it can. Also for
 * agents no longer running (their row stays while the dialog is open): one whose turn ended takes it
 * at once, one waiting on a question or closed meanwhile does not (a prompt would resume a closed one).
 */
export function queueBlock(s: CoreState, key: string): string | null {
  const a = s.agents[key];
  if (!a) return "It closed";
  const host = s.profiles.find((p) => p.id === a.hostId)?.name ?? a.hostId;
  const phase = s.status[a.hostId]?.phase ?? "idle";
  if (phase !== "online") return `${host} ${PHASE_TEXT[phase]}`;
  const herdr = s.hosts[a.hostId]?.state.info.herdrHealth;
  if (herdrDown(herdr)) return herdrNotRunning(host, herdr);
  if (a.parked) return "Closed: a message would resume it";
  if (a.kind !== "omp") return `${a.kind} agent: only its terminal takes input`;
  if (a.column === "needs") return "Waiting for your answer";
  if (a.omp?.link !== "live") return linkBlock(a.omp, host);
  const caps = s.sessions[key]?.meta?.caps;
  if (caps && !caps.prompt && !caps.steer && !caps.followUp) return "Read-only session: it takes no messages";
  return null;
}

/** One agent's outcome after Send. */
export interface QueueResult {
  key: string;
  name: string;
  /** The host's message (and hint) when it failed; absent when it went through. */
  error?: string;
}

/**
 * The toast's title after Send: "Queued for 5 agents", "Queued for 3 of 5 agents" (the failed ones
 * listed under it), "Couldn't queue the message"; a steer says "Sent to …".
 */
export function queueSummary(results: readonly QueueResult[], delivery: Delivery): { title: string; failed: QueueResult[] } {
  const failed = results.filter((r) => r.error !== undefined);
  const ok = results.length - failed.length;
  const queued = delivery === "followUp";
  if (ok === 0) return { title: queued ? "Couldn't queue the message" : "Couldn't send the message", failed };
  const who = failed.length > 0 ? `${ok} of ${results.length} agents` : results.length === 1 ? (results[0]?.name ?? "1 agent") : `${results.length} agents`;
  return { title: `${queued ? "Queued for" : "Sent to"} ${who}`, failed };
}

/** The dialog as a send sees it: which opening it is (`gen`, bumped on every open) and its draft's text. */
export interface SendState {
  gen: number;
  draft: string;
}

/**
 * What a finished send may still do to the dialog, judged against the dialog as it is now (`now`)
 * rather than as it was when the send started (`sent`); its toast shows in every case.
 * - `elsewhere`: the dialog was opened again meanwhile, a new one with its own draft and picks: leave it alone.
 * - `done`: every agent got it and the box still holds what was sent: clear it and close.
 * - `retry`: some failed and the box still holds what was sent: stay open, untick the agents it reached.
 * - `keep`: the text changed while it was sending: stay open over the new text, showing who got the
 *   earlier one, picks as they are.
 */
export type SendSettle = "elsewhere" | "done" | "retry" | "keep";

export function settleSend(sent: SendState, now: SendState, failed: number): SendSettle {
  if (now.gen !== sent.gen) return "elsewhere";
  if (now.draft !== sent.draft) return "keep";
  return failed === 0 ? "done" : "retry";
}
