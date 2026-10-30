import { create } from "zustand";
import { core, getAgentViews, parseAgentKey, toApiError } from "@/core";
import type { AutoAnswer } from "@/core/gen";
import { toast } from "@/design";
import { clampPolicy, policySummary } from "./format";

/*
 * Decide for me's calls (architecture §3.23): cancel or postpone one question's countdown, set a
 * running agent's own policy, set a host's default. Failures become error toasts with the host's
 * words; what changed shows on the agent itself (`Agent.autoAnswer`), so successes stay quiet
 * except for the policy changes made in a dialog.
 */

/** Calls in flight, by agent key (or `host:<hostId>`): spinners, and no double sends. */
const usePending = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

function setPending(key: string, on: boolean): void {
  usePending.setState((s) => {
    const keys = { ...s.keys };
    if (on) keys[key] = true;
    else delete keys[key];
    return { keys };
  });
}

/** A decide-for-me call for this agent (or `host:<hostId>`) is on its way. */
export function useAutoAnswerPending(key: string): boolean {
  return usePending((s) => s.keys[key] === true);
}

async function once<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  if (usePending.getState().keys[key]) return undefined;
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

/** This question waits for a person (`agent.autoAnswerCancel`). */
export async function cancelCountdown(agentKey: string, requestId: string): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const ok = await once(agentKey, async () => {
    try {
      await core.host(hostId).call("agent.autoAnswerCancel", { agentId, requestId });
      return true;
    } catch (e) {
      return failed("Couldn't cancel decide for me", e);
    }
  });
  return ok === true;
}

/** More time for this question (`agent.autoAnswerPostpone`); a cancelled countdown starts again with `secs` left. */
export async function postponeCountdown(agentKey: string, requestId: string, secs: number): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const ok = await once(agentKey, async () => {
    try {
      await core.host(hostId).call("agent.autoAnswerPostpone", { agentId, requestId, secs });
      return true;
    } catch (e) {
      return failed("Couldn't change decide for me", e);
    }
  });
  return ok === true;
}

/** A running (or parked) agent's own policy; `undefined`: the host default again (`agent.setAutoAnswer`). */
export async function setAgentAutoAnswer(agentKey: string, policy: AutoAnswer | undefined): Promise<boolean> {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const own = policy ? clampPolicy(policy) : undefined;
  const ok = await once(agentKey, async () => {
    try {
      await core.host(hostId).call("agent.setAutoAnswer", own ? { agentId, policy: own } : { agentId });
      const name = getAgentViews().find((a) => a.key === agentKey)?.name ?? agentId;
      toast({
        title: own ? (own.enabled ? `${name} decides for you ${policySummary(own)}` : `${name} waits for you`) : `${name} follows the host default`,
        description: own?.enabled ? "Only questions with a ★ recommended option." : undefined,
        status: "done",
        duration: 2600,
      });
      return true;
    } catch (e) {
      return failed("Couldn't change decide for me", e);
    }
  });
  return ok === true;
}

/** The host's default (`host.autoAnswerSet`): what it saved, or undefined when it failed. */
export async function setHostAutoAnswer(hostId: string, policy: AutoAnswer): Promise<AutoAnswer | undefined> {
  return once(`host:${hostId}`, async () => {
    try {
      return await core.host(hostId).call("host.autoAnswerSet", clampPolicy(policy));
    } catch (e) {
      failed("Couldn't change decide for me", e);
      return undefined;
    }
  });
}
