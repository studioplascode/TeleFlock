import type { Agent, HostState, SessionEvent, StatePatch, TranscriptItem } from "@/core/gen";
import { agentKey } from "../keys";
import { agentGone, agentSeen, dropPruned, newlyPruned, noteSuccessor } from "./lifecycle";
import {
  type AgentView,
  type CoreEvent,
  type CoreState,
  type Effect,
  emptySession,
  type HostNotification,
  type SessionEntry,
} from "./state";
import { Tx } from "./tx";

const MAX_NOTIFICATIONS = 200;
const MAX_ACTIVITY = 500;

export interface ReduceResult {
  state: CoreState;
  effects: Effect[];
}

/**
 * Applies a batch of events in order and returns the next state with structural sharing:
 * untouched hosts, agents, sessions and transcript rows keep their identity, so fine-grained
 * selectors only re-render what changed. `now` dates parked agents leaving (resume following).
 */
export function reduceEvents(prev: CoreState, events: readonly CoreEvent[], now = Date.now()): ReduceResult {
  const tx = new Tx();
  const effects: Effect[] = [];
  let s = prev;
  const draft = (): CoreState => {
    s = tx.own(s);
    return s;
  };

  for (const e of events) {
    switch (e.type) {
      case "profiles": {
        const d = draft();
        d.profiles = e.profiles;
        d.profilesLoaded = true;
        break;
      }
      case "$hostsList": {
        const d = draft();
        d.profiles = e.result.profiles;
        d.profilesLoaded = true;
        d.status = tx.own(d.status);
        for (const st of e.result.statuses) d.status[st.hostId] = st.status;
        break;
      }
      case "hostStatus": {
        const was = s.status[e.hostId]?.phase;
        const d = draft();
        d.status = tx.own(d.status);
        d.status[e.hostId] = e.status;
        if (e.status.phase === "online" && was !== undefined && was !== "online") {
          effects.push({ kind: "hostOnline", hostId: e.hostId });
        }
        break;
      }
      case "hostSnapshot":
        replaceHost(tx, draft(), e.hostId, e.state, e.rev, effects, now);
        break;
      case "$stateGet": {
        const rev = s.hosts[e.hostId]?.rev ?? null;
        replaceHost(tx, draft(), e.hostId, e.state, rev, effects, now);
        break;
      }
      case "hostPatch": {
        const host = s.hosts[e.hostId];
        if (!host) {
          // Patch for a host we have no snapshot of: we can't apply it.
          effects.push({ kind: "resync", hostId: e.hostId });
          break;
        }
        if (host.rev !== null && e.rev <= host.rev) break; // duplicate / stale
        const gap = host.rev !== null && e.rev !== host.rev + 1;
        if (gap) effects.push({ kind: "resync", hostId: e.hostId });
        applyPatch(tx, draft(), e.hostId, e.rev, e.ops, effects, now);
        break;
      }
      case "session":
        applySession(tx, draft, e.hostId, e.agentId, e.ev);
        break;
      case "$sessionLoading": {
        const key = agentKey(e.hostId, e.agentId);
        const d = draft();
        d.sessions = tx.own(d.sessions);
        const cur = d.sessions[key];
        if (cur) {
          const next = tx.own(cur);
          next.status = "loading";
          next.error = undefined;
          d.sessions[key] = next;
        } else {
          d.sessions[key] = tx.fresh(emptySession("loading"));
        }
        break;
      }
      case "$sessionError": {
        const key = agentKey(e.hostId, e.agentId);
        const d = draft();
        d.sessions = tx.own(d.sessions);
        const cur = d.sessions[key] ?? emptySession("error");
        const next = tx.own(cur);
        next.status = "error";
        next.error = e.error;
        d.sessions[key] = next;
        break;
      }
      case "$sessionDrop": {
        const key = agentKey(e.hostId, e.agentId);
        if (!(key in s.sessions)) break;
        const d = draft();
        d.sessions = tx.own(d.sessions);
        delete d.sessions[key];
        break;
      }
      case "$history": {
        const key = agentKey(e.hostId, e.agentId);
        const cur = s.sessions[key];
        if (!cur) break;
        const d = draft();
        d.sessions = tx.own(d.sessions);
        const sess = tx.own(cur);
        sess.items = tx.own(sess.items);
        const older: string[] = [];
        for (const item of e.page.items) {
          if (item.id in sess.items) continue;
          sess.items[item.id] = item;
          older.push(item.id);
        }
        sess.itemIds = older.concat(sess.itemIds);
        sess.hasMore = e.page.hasMore;
        sess.cursor = e.page.cursor;
        d.sessions[key] = sess;
        break;
      }
      case "notify": {
        if (s.notifications.some((n) => n.id === e.notification.id && n.hostId === e.hostId)) break;
        // a late notification about an agent whose session was deleted
        if (s.hosts[e.hostId]?.state.info.pruned?.some((p) => p.agentId === e.notification.agentId)) break;
        const d = draft();
        const n: HostNotification = { ...e.notification, hostId: e.hostId, read: false };
        d.notifications = [n, ...d.notifications].slice(0, MAX_NOTIFICATIONS);
        effects.push({ kind: "lanes", hostId: e.hostId });
        break;
      }
      case "notifyDone": {
        const ids = new Set(e.ids);
        const hit = (n: HostNotification) => n.hostId === e.hostId && ids.has(n.id) && (!n.read || (e.resolved && !n.resolved));
        if (s.notifications.some(hit)) {
          const d = draft();
          d.notifications = d.notifications.map((n) => (hit(n) ? { ...n, read: true, resolved: n.resolved || e.resolved } : n));
        }
        break;
      }
      case "$activity": {
        const d = draft();
        d.activity = tx.own(d.activity);
        const cur = d.activity[e.hostId];
        const incoming = e.page.events.map((ev) => ({ ...ev, hostId: e.hostId }));
        let events = incoming;
        if (cur && e.append) {
          const seen = new Set(cur.events.map((ev) => ev.id));
          events = cur.events.concat(incoming.filter((ev) => !seen.has(ev.id)));
        }
        events.sort((a, b) => b.at - a.at);
        d.activity[e.hostId] = {
          events: events.slice(0, MAX_ACTIVITY),
          hasMore: e.page.hasMore,
          loaded: true,
        };
        break;
      }
      case "settings":
        draft().settings = e.settings;
        break;
      case "tunnels":
        draft().tunnels = e.tunnels;
        break;
      case "openAgent":
        effects.push({ kind: "openAgent", hostId: e.hostId, agentId: e.agentId });
        break;
      case "$successor":
        noteSuccessor(tx, draft(), e.hostId, e.from, e.to);
        break;
      case "answerNext":
        effects.push({ kind: "answerNext" });
        break;
      case "pulse":
      case "term":
        // Imperative buses; never reach the store.
        break;
    }
  }
  return { state: s, effects };
}

function sameAgent(a: Agent, b: AgentView): boolean {
  // Agents are small; a JSON comparison keeps identity across full snapshots.
  const { hostId: _h, key: _k, ...rest } = b;
  return JSON.stringify(a) === JSON.stringify(rest);
}

function viewOf(hostId: string, a: Agent): AgentView {
  return { ...a, hostId, key: agentKey(hostId, a.id) };
}

function replaceHost(
  tx: Tx,
  d: CoreState,
  hostId: string,
  state: HostState,
  rev: number | null,
  effects: Effect[],
  now: number,
): void {
  d.hosts = tx.own(d.hosts);
  const pruned = newlyPruned(d.hosts[hostId]?.state.info.pruned, state.info.pruned);
  d.hosts[hostId] = { rev, state };
  d.agents = tx.own(d.agents);
  const prefix = `${hostId}::`;
  const keep = new Set<string>();
  let lanesChanged = false;
  for (const a of state.agents) {
    const key = agentKey(hostId, a.id);
    keep.add(key);
    const old = d.agents[key];
    if (old && sameAgent(a, old)) continue;
    if (!old || old.column !== a.column) lanesChanged = true;
    relinkIfLive(d, hostId, old, a, effects);
    d.agents[key] = viewOf(hostId, a);
    agentSeen(tx, d, hostId, a, now);
  }
  for (const key of Object.keys(d.agents)) {
    const old = d.agents[key];
    if (old && key.startsWith(prefix) && !keep.has(key)) {
      delete d.agents[key];
      agentGone(tx, d, old, now);
      lanesChanged = true;
    }
  }
  dropPruned(tx, d, hostId, pruned);
  if (lanesChanged) effects.push({ kind: "lanes", hostId });
}

/** An open session that failed (e.g. hostd restarted before it rejoined the room) reopens once the link is live. */
function relinkIfLive(d: CoreState, hostId: string, old: AgentView | undefined, next: Agent, effects: Effect[]): void {
  if (next.omp?.link !== "live" || old?.omp?.link === "live") return;
  if (d.sessions[agentKey(hostId, next.id)]?.status === "error") effects.push({ kind: "relink", hostId, agentId: next.id });
}

function upsertById<T extends { id: string }>(list: T[], id: string, value: T | null): T[] {
  const i = list.findIndex((x) => x.id === id);
  if (value === null) return i < 0 ? list : list.filter((_, j) => j !== i);
  if (i < 0) return [...list, value];
  const next = list.slice();
  next[i] = value;
  return next;
}

function applyPatch(tx: Tx, d: CoreState, hostId: string, rev: number, ops: StatePatch[], effects: Effect[], now: number): void {
  d.hosts = tx.own(d.hosts);
  const prevEntry = d.hosts[hostId];
  if (!prevEntry) return;
  const entry = tx.own(prevEntry);
  d.hosts[hostId] = entry;
  entry.rev = rev;
  const st = tx.own(entry.state);
  entry.state = st;
  for (const op of ops) {
    switch (op.op) {
      case "info":
        dropPruned(tx, d, hostId, newlyPruned(st.info.pruned, op.info.pruned));
        st.info = op.info;
        break;
      case "health":
        st.health = op.health;
        break;
      case "usage":
        st.usage = op.usage;
        break;
      case "workspace":
        st.workspaces = upsertById(st.workspaces, op.id, op.value);
        break;
      case "agent": {
        st.agents = upsertById(st.agents, op.id, op.value);
        d.agents = tx.own(d.agents);
        const key = agentKey(hostId, op.id);
        const old = d.agents[key];
        if (op.value === null) {
          if (old) {
            delete d.agents[key];
            agentGone(tx, d, old, now);
            effects.push({ kind: "lanes", hostId });
          }
        } else {
          if (!old || old.column !== op.value.column) effects.push({ kind: "lanes", hostId });
          relinkIfLive(d, hostId, old, op.value, effects);
          d.agents[key] = viewOf(hostId, op.value);
          agentSeen(tx, d, hostId, op.value, now);
        }
        break;
      }
    }
  }
}

function applySession(
  tx: Tx,
  draft: () => CoreState,
  hostId: string,
  agentId: string,
  ev: SessionEvent,
): void {
  const key = agentKey(hostId, agentId);
  const d0 = draft();
  const cur = d0.sessions[key];
  if (ev.k === "reset") {
    const items: Record<string, TranscriptItem> = {};
    const itemIds: string[] = [];
    for (const item of ev.snapshot.items) {
      if (!(item.id in items)) itemIds.push(item.id);
      items[item.id] = item;
    }
    d0.sessions = tx.own(d0.sessions);
    d0.sessions[key] = tx.fresh<SessionEntry>({
      status: "live",
      meta: ev.snapshot.meta,
      itemIds,
      items,
      ui: ev.snapshot.ui ?? null,
      hasMore: ev.snapshot.hasMore,
      cursor: ev.snapshot.cursor,
      // Side conversations belong to one omp session: a rotation (/new, /resume, /fork) drops them.
      btw: cur && cur.meta?.sessionId === ev.snapshot.meta.sessionId ? cur.btw : {},
    });
    return;
  }
  // Events for sessions we don't track (not opened, or already dropped) are ignored.
  if (!cur) return;
  d0.sessions = tx.own(d0.sessions);
  const sess = tx.own(cur);
  d0.sessions[key] = sess;
  switch (ev.k) {
    case "upsert": {
      const exists = ev.item.id in sess.items;
      sess.items = tx.own(sess.items);
      sess.items[ev.item.id] = ev.item;
      if (!exists) {
        sess.itemIds = tx.own(sess.itemIds);
        sess.itemIds.push(ev.item.id);
      }
      break;
    }
    case "append": {
      const item = sess.items[ev.id];
      if (!item) break;
      sess.items = tx.own(sess.items);
      const next = tx.own(item) as TranscriptItem & { text?: string; output?: string };
      if (ev.field === "text" && "text" in next) next.text = (next.text ?? "") + ev.text;
      else if (ev.field === "output" && next.kind === "tool") next.output = (next.output ?? "") + ev.text;
      sess.items[ev.id] = next;
      break;
    }
    case "remove": {
      if (!(ev.id in sess.items)) break;
      sess.items = tx.own(sess.items);
      delete sess.items[ev.id];
      sess.itemIds = sess.itemIds.filter((id) => id !== ev.id);
      break;
    }
    case "meta":
      // tf-hostd ≥ 0.5.1 sends the session tree only when it changed: keep the one we have.
      sess.meta = ev.meta.tree === undefined && sess.meta?.tree ? { ...ev.meta, tree: sess.meta.tree } : ev.meta;
      break;
    case "ui":
      sess.ui = ev.request;
      break;
    case "btw": {
      sess.btw = tx.own(sess.btw);
      const turns = [...(sess.btw[ev.btwId]?.turns ?? [])];
      const i = ev.turn ?? 0; // hosts before follow-ups send no turn
      while (turns.length <= i) turns.push(undefined);
      const prev = turns[i];
      // A finished turn stays finished: hostd's question announcement may trail the answer.
      turns[i] = { question: ev.question ?? prev?.question, text: (prev?.text ?? "") + ev.text, done: ev.done || prev?.done === true };
      sess.btw[ev.btwId] = { turns };
      break;
    }
    case "ended":
      sess.status = "ended";
      sess.endedReason = ev.reason;
      break;
  }
}
