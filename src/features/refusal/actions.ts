import { create } from "zustand";
import { core, toApiError } from "@/core";
import type { ModelInfo, RefusalRule, ThinkingLevel } from "@/core/gen";
import { toast } from "@/design";
import { ruleWords, sameRule, selectorName, withRule, without } from "./model";
import { changeRules } from "./store";

/** Calls in flight, by agent key (`<key>/<subagentId>` for a subagent): spinners, and no double sends. */
const usePending = create<{ keys: Record<string, true> }>(() => ({ keys: {} }));

function setPending(key: string, on: boolean): void {
  usePending.setState((s) => {
    if ((s.keys[key] === true) === on) return s;
    const { [key]: _, ...rest } = s.keys;
    return { keys: on ? { ...s.keys, [key]: true } : rest };
  });
}

/** A call for this agent is on its way. */
export const useActionPending = (key: string): boolean => usePending((s) => s.keys[key] === true);

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

/** The session a refusal row belongs to. */
export interface RefusedSession {
  hostId: string;
  agentId: string;
  /** `${hostId}::${agentId}` */
  key: string;
}

export interface RetryAim {
  /** `provider/id`. */
  model: string;
  /** Absent: the refused turn's level is kept. */
  thinking?: ThinkingLevel;
}

/**
 * The call behind both buttons: the agent switches to `aim.model` and goes on with the turn that ended on a refusal,
 * once (`agent.refusalRetry`; no rule is saved). Says what happened; resolves whether the turn went on.
 */
async function continueOn(session: RefusedSession, aim: RetryAim, models: readonly ModelInfo[], subagentId?: string): Promise<boolean> {
  const name = selectorName(models, aim.model);
  try {
    const r = await core.host(session.hostId).call("agent.refusalRetry", { agentId: session.agentId, subagentId, model: aim.model, thinking: aim.thinking });
    if (!r.started) {
      toast({ title: "Nothing to retry", description: "That turn doesn't end on a refusal any more, or the agent is busy.", status: "idle", duration: 3600 });
      return false;
    }
    toast({ title: `Continuing on ${name}`, description: "The same turn goes on; nothing is sent again.", status: "running", duration: 2600 });
    return true;
  } catch (e) {
    return failed(`Couldn't retry on ${name}`, e);
  }
}

/** "Retry with <model>": see `continueOn`. */
export function retryOnModel(session: RefusedSession, aim: RetryAim, models: readonly ModelInfo[], subagentId?: string): Promise<boolean> {
  return once(`${session.key}${subagentId ? `/${subagentId}` : ""}`, () => continueOn(session, aim, models, subagentId));
}

/** Takes `rule` out of the host's rules again (the undo of an added rule), after any change to them still on its way. */
export async function removeRule(hostId: string, rule: RefusalRule): Promise<boolean> {
  try {
    await changeRules(hostId, (now) => without(now, rule));
    return true;
  } catch (e) {
    return failed("Couldn't remove the rule", e);
  }
}

/**
 * "Always do this" on a refusal row: `rule` becomes the host's first rule, so it decides before the others (an Undo in
 * the toast takes it out again), and this turn goes on with it now, as "Retry with" would; the host only acts on
 * refusals that come after the rule. A rule the host already has is not added twice. The rule is added to the host's
 * rules as they are once any other change to them is saved (`changeRules`), so two at once both stay.
 */
export function alwaysDoThis(session: RefusedSession, rule: RefusalRule, models: readonly ModelInfo[]): Promise<boolean> {
  const { hostId } = session;
  return once(session.key, async () => {
    try {
      let added = false;
      await changeRules(hostId, (now) => {
        if (now.some((r) => sameRule(r, rule))) return undefined;
        added = true;
        return withRule(now, rule, null, "first");
      });
      if (added) {
        const words = ruleWords(rule, models);
        toast({
          title: `${words.when} now go to ${words.to}`,
          description: "On this host, for every agent: the turn goes on by itself, with no prompt. Settings → Refusal fallback changes it.",
          status: "done",
          duration: 9000,
          action: { label: "Undo", onClick: () => void removeRule(hostId, rule).then((ok) => ok && toast({ title: "Rule removed", status: "idle", duration: 2400 })) },
        });
      }
    } catch (e) {
      return failed("Couldn't save the rule", e);
    }
    return continueOn(session, { model: rule.to, thinking: rule.thinking }, models);
  });
}
