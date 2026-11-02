import { create } from "zustand";
import { core, getAgentViews, parseAgentKey, toApiError, useHosts } from "@/core";
import type { AutoAnswer } from "@/core/gen";
import { toast } from "@/design";
import { clampPolicy, policySummary } from "./format";
import { type AnswerChoice, changeAnswerMessage, decisionKey, type HostDecision } from "./review";

/*
 * Decide for me's calls (architecture §3.23): cancel or postpone one question's countdown, set a
 * running agent's own policy, set a host's default, mark its decisions reviewed or change one.
 * Failures become error toasts with the host's words; what changed shows on the agent itself
 * (`Agent.autoAnswer`) or leaves the Inbox, so successes stay quiet except for the policy changes
 * made in a dialog and a changed answer.
 */

/** Calls in flight, by agent key (`host:<hostId>`, `decision:<hostId>/<id>`): spinners, and no double sends. */
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

/** Decisions marked reviewed here (`decisionKey`): hidden at once, before the host's state drops them. */
export const useReviewedHere = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

const pendingKey = (d: Pick<HostDecision, "hostId" | "id">) => `decision:${decisionKey(d)}`;

/** Looks good, Change answer or Mark all reviewed is on its way for this decision. */
export function useDecisionPending(d: Pick<HostDecision, "hostId" | "id">): boolean {
  return usePending((s) => s.keys[pendingKey(d)] === true);
}

/** `host.autoAnswerReview {ids}` (never `all`: only what the user saw), then hides them here. */
async function markReviewed(hostId: string, list: readonly HostDecision[]): Promise<void> {
  await core.host(hostId).call("host.autoAnswerReview", { ids: list.map((d) => d.id) });
  useReviewedHere.setState((s) => ({ keys: { ...s.keys, ...Object.fromEntries(list.map((d) => [decisionKey(d), true as const])) } }));
}

/**
 * Marks decisions reviewed for every device of their hosts' sessions: one call per host with the
 * ids shown (ids reviewed elsewhere meanwhile are skipped by the host). Decisions with a call on
 * its way are left out. True when every host took them.
 */
export async function reviewDecisions(list: readonly HostDecision[]): Promise<boolean> {
  const byHost = new Map<string, HostDecision[]>();
  for (const d of list) {
    if (usePending.getState().keys[pendingKey(d)]) continue;
    byHost.set(d.hostId, [...(byHost.get(d.hostId) ?? []), d]);
  }
  const done = await Promise.all(
    [...byHost].map(async ([hostId, ds]) => {
      for (const d of ds) setPending(pendingKey(d), true);
      try {
        await markReviewed(hostId, ds);
        return true;
      } catch (e) {
        const host = useHosts.getState().profiles.find((p) => p.id === hostId)?.name ?? hostId;
        return failed(ds.length === 1 ? `Couldn't mark ${ds[0]?.agentName}'s decision reviewed` : `Couldn't mark ${ds.length} decisions on ${host} reviewed`, e);
      } finally {
        for (const d of ds) setPending(pendingKey(d), false);
      }
    }),
  );
  return done.every(Boolean);
}

/**
 * Changes an answer decide for me sent: the question is gone, so the agent gets a message
 * (`agent.prompt`, `changeAnswerMessage`), then the decision is marked reviewed. `agent` is the
 * one on the board now (it may run under a newer id than the decision's).
 */
export async function changeDecisionAnswer(d: HostDecision, agent: { id: string; name: string }, choice: AnswerChoice): Promise<boolean> {
  const text = changeAnswerMessage(d, choice);
  const key = pendingKey(d);
  if (!text || usePending.getState().keys[key]) return false;
  setPending(key, true);
  try {
    try {
      await core.host(d.hostId).call("agent.prompt", { agentId: agent.id, text, images: [], delivery: "auto" });
    } catch (e) {
      return failed(`Couldn't tell ${agent.name}`, e);
    }
    toast({ title: `Told ${agent.name}`, description: text, status: "done", duration: 4000 });
    try {
      await markReviewed(d.hostId, [d]);
    } catch (e) {
      failed(`Told ${agent.name}, but couldn't mark the decision reviewed`, e);
    }
    return true;
  } finally {
    setPending(key, false);
  }
}
