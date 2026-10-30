import { create } from "zustand";
import { core, getAgentViews, parseAgentKey, toApiError } from "@/core";
import type { RetryResult } from "@/core/gen";
import { toast } from "@/design";
import { dontToast, nothingReason, retryToast } from "./words";

/** Resumes in flight, by agent key (`<key>/<subagentId>` for a subagent): spinners, and no double sends. */
const usePending = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

function setPending(key: string, on: boolean): void {
  usePending.setState((s) => {
    const keys = { ...s.keys };
    if (on) keys[key] = true;
    else delete keys[key];
    return { keys };
  });
}

/** A resume of this agent (or `<key>/<subagentId>`) is on its way. */
export function useResumePending(key: string): boolean {
  return usePending((s) => s.keys[key] === true);
}

async function once(key: string, run: () => Promise<boolean>): Promise<boolean> {
  if (usePending.getState().keys[key]) return false;
  setPending(key, true);
  try {
    return await run();
  } finally {
    setPending(key, false);
  }
}

function failed(title: string, e: unknown): false {
  const err = toApiError(e);
  toast({ title, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error" });
  return false;
}

function answered(r: RetryResult, why: string): true {
  const t = retryToast(r, why);
  if (t) toast({ ...t, duration: 3200 });
  return true;
}

const agentOf = (key: string) => getAgentViews().find((a) => a.key === key);

/**
 * omp's F5 for an agent (the Resume button, F5 / Alt+R in its session, `/retry`): `agent.retry`.
 * hostd resumes a waiting or manual auto-resume ticket whole (subagents first) when there is one.
 * A tf-hostd before 0.7.0 (`unknown_method`) gets omp's own `/retry` typed into its TUI instead.
 */
export function retryTurn(key: string): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(key);
  return once(key, async () => {
    try {
      return answered(await core.host(hostId).call("agent.retry", { agentId }), nothingReason(agentOf(key)));
    } catch (e) {
      if (toApiError(e).code !== "unknown_method") return failed("Couldn't resume", e);
    }
    try {
      await core.host(hostId).call("agent.slash", { agentId, command: "/retry" });
      return answered({ started: true, via: "command" }, "");
    } catch (e) {
      return failed("Couldn't send /retry", e);
    }
  });
}

/** Resume now / Continue: the agent's auto-resume ticket (its stopped subagents first; an ended agent is brought back), now. */
export function resumeNow(key: string): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(key);
  const restart = agentOf(key)?.autoResume?.kind === "restart";
  return once(key, async () => {
    try {
      const r = await core.host(hostId).call("agent.autoResumeNow", { agentId });
      return answered(r, agentOf(key)?.column === "running" ? "It's working right now." : restart ? "It's back already." : "Nothing is waiting on a limit anymore.");
    } catch (e) {
      return failed(restart ? "Couldn't continue" : "Couldn't resume", e);
    }
  });
}

/** Don't auto-resume (`dismiss`: the ticket already won't resume by itself): drops the ticket; the agent stays as it is. */
export function cancelAutoResume(key: string, dismiss: boolean): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(key);
  const agent = agentOf(key);
  return once(`${key}~cancel`, async () => {
    try {
      await core.host(hostId).call("agent.autoResumeCancel", { agentId });
      if (!dismiss) toast({ ...dontToast(agent?.name ?? agentId, agent?.autoResume, agent?.parked?.ended), status: "idle", duration: 3200 });
      return true;
    } catch (e) {
      return failed("Couldn't cancel auto-resume", e);
    }
  });
}

/** Retry a subagent that failed or was stopped: omp revives it, and its result reaches its parent. */
export function retrySubagent(key: string, sub: { id: string; name: string }): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(key);
  return once(`${key}/${sub.id}`, async () => {
    try {
      const r = await core.host(hostId).call("agent.retry", { agentId, subagentId: sub.id });
      if (r.started && r.via === "retry") toast({ title: `Retrying ${sub.name}`, description: "Its result reaches the parent when it finishes.", status: "running", duration: 2600 });
      else answered(r, `${sub.name} has no failed or stopped turn to retry.`);
      return r.started;
    } catch (e) {
      return failed(`Couldn't retry ${sub.name}`, e);
    }
  });
}
