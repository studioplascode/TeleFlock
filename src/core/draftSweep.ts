import { draftKey, draftKeyParts, drafts, useDrafts } from "./drafts";
import { parseAgentKey } from "./keys";
import type { CoreState } from "./store/state";
import { coreStore } from "./store/store";

/** Draft scope of free-text answers: `answerDraftKey(agentKey, requestId, field)`. */
export const ANSWER_SCOPE = "answer";

/** Key of a free-text answer to one pending request (`field`: `other`, `text`…). */
export function answerDraftKey(agentKey: string, requestId: string, field: string): string {
  return draftKey(ANSWER_SCOPE, agentKey, requestId, field);
}

/** Recently typed answers are kept even if the host has not reported their request yet. */
const GRACE_MS = 30_000;

/**
 * Answer drafts whose request is gone: the agent's online host lists the agent without that
 * pending request (answered elsewhere, cancelled) or no longer lists the agent at all.
 */
export function staleAnswerDrafts(s: Pick<CoreState, "agents" | "hosts" | "status">, entries: Record<string, { at: number }>, now: number): string[] {
  const stale: string[] = [];
  for (const [key, e] of Object.entries(entries)) {
    const [scope, agentKey, requestId] = draftKeyParts(key);
    if (scope !== ANSWER_SCOPE || !agentKey || now - e.at < GRACE_MS) continue;
    const { hostId } = parseAgentKey(agentKey);
    if (s.status[hostId]?.phase !== "online" || !s.hosts[hostId]) continue;
    if (s.agents[agentKey]?.needs?.requestId !== requestId) stale.push(key);
  }
  return stale;
}

let started = false;

/** Prune answer drafts whenever host state changes. Idempotent. */
export function startDraftSweep(): void {
  if (started) return;
  started = true;
  let agents: CoreState["agents"] | null = null;
  coreStore.subscribe((s) => {
    if (s.agents === agents) return;
    agents = s.agents;
    const stale = staleAnswerDrafts(s, useDrafts.getState().drafts, Date.now());
    if (stale.length > 0) drafts.clearWhere((k) => stale.includes(k));
  });
}
