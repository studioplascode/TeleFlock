import { onAgentMoved, onAgentsPruned } from "./agentLifecycle";
import { draftImageKeys, getDraftImages, hydrateDraftImages, setDraftImages } from "./draftImages";
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

/** Is one of the draft key's context parts (after the scope) in `agents`? */
function mentions(key: string, agents: ReadonlySet<string>): boolean {
  return draftKeyParts(key).slice(1).some((p) => agents.has(p));
}

/** The same draft key for the agent's new key (a resumed parked agent). */
function moved(key: string, from: string, to: string): string {
  const [scope = "", ...parts] = draftKeyParts(key);
  return draftKey(scope, ...parts.map((p) => (p === from ? to : p)));
}

/** A resumed agent keeps its unsent drafts (text and images) under its new key. */
function moveDrafts(from: string, to: string): void {
  const one = new Set([from]);
  for (const key of drafts.keys()) {
    if (!mentions(key, one)) continue;
    const next = moved(key, from, to);
    if (!drafts.get(next)) drafts.set(next, drafts.get(key));
    drafts.clear(key);
  }
  void draftImageKeys().then((keys) => {
    for (const key of keys) {
      if (!mentions(key, one)) continue;
      const next = moved(key, from, to);
      void Promise.all([hydrateDraftImages(key), hydrateDraftImages(next)]).then(() => {
        const images = getDraftImages(key);
        if (images.length && !getDraftImages(next).length) setDraftImages(next, images);
        setDraftImages(key, []);
      });
    }
  });
}

/** Forget the drafts (text and images) of agents whose omp session was deleted. */
function dropDrafts(agents: ReadonlySet<string>): void {
  drafts.clearWhere((key) => mentions(key, agents));
  void draftImageKeys().then((keys) => {
    for (const key of keys) if (mentions(key, agents)) setDraftImages(key, []);
  });
}

let started = false;

/**
 * Prune answer drafts whenever host state changes, drop the drafts of pruned agents, and move a
 * resumed agent's drafts to its new key. Idempotent.
 */
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
  onAgentsPruned((gone) => dropDrafts(new Set(gone.flatMap((g) => g.keys))));
  onAgentMoved(moveDrafts);
}
