import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useCore } from "@/core";
import type { QueueInfo, TranscriptItem } from "@/core/gen";

export type QueueKind = "steer" | "follow";

/**
 * A message this client sent into a working agent's queue: shown as queued at once, until the
 * host's queue lists it (its chip takes over) or its user row lands in the transcript. A landed
 * one stays, unseen, while the host still lists its text: the host's queue can lag the
 * transcript, and a message that reached the agent must not stand in the strip meanwhile.
 */
export interface PendingSend {
  id: number;
  text: string;
  kind: QueueKind;
  /** Client clock (ms) when sent. */
  at: number;
  /** Ids of the user rows with this text at send time: any other such row is its echo. */
  before: string[];
  /** The `agent.prompt` call is still in flight. */
  sending: boolean;
  /** The host's queue listed it: once it no longer does, it was delivered or pulled back. */
  seen: boolean;
  /** Id of its user row once that landed: it hides one host listing of its text from then on. */
  landed?: string;
}

/** One chip of the "Queued" strip. `id` is stable (kind + text + occurrence) so a pending chip
 * hands over to the host's chip for the same message without re-animating. */
export interface QueueChip {
  id: string;
  text: string;
  kind: QueueKind;
  /** Not listed by the host (yet): this client's own echo. */
  pending: boolean;
  sending: boolean;
}

/** Idle agent and the host never listed it: nothing is going to deliver it any more. */
export const IDLE_GRACE_MS = 6_000;
/** Safety net for an echo neither the host nor the transcript ever resolves. */
export const MAX_PENDING_MS = 10 * 60_000;

/** Comparison key: omp's queue chips flatten line breaks (` ↵ `), so whitespace and `↵` don't count. */
export function queueKey(text: string): string {
  return text
    .split(/[\s↵]+/)
    .filter(Boolean)
    .join(" ");
}

export interface UserRow {
  id: string;
  text: string;
}

/**
 * Merges the host's queue with this client's pending sends and decides which pending sends are
 * resolved: listed by the host (`seen`, hidden behind the host's chip), gone from the host's queue
 * after being listed, stale (agent idle), or landed (a new user row with its text). A landed send
 * hides one host listing of its text for as long as the host has one: the host's queue (omp's,
 * read by the bridge, and the prompts hostd listed itself) can lag the transcript, and a chip of a
 * message that already reached the agent could not be pulled back. Delivered messages leave the
 * strip with their rows, together when they land together.
 */
export function reconcileQueue(
  pending: readonly PendingSend[],
  host: QueueInfo | undefined,
  rows: readonly UserRow[],
  working: boolean,
  now: number,
): { chips: QueueChip[]; keep: PendingSend[] } {
  const hostLeft = new Map<string, number>();
  for (const t of [...(host?.steering ?? []), ...(host?.followUp ?? [])]) hostLeft.set(queueKey(t), (hostLeft.get(queueKey(t)) ?? 0) + 1);
  /** Claims one host listing of `key`; whether there was one left. */
  const claim = (key: string): boolean => {
    const n = hostLeft.get(key) ?? 0;
    if (n > 0) hostLeft.set(key, n - 1);
    return n > 0;
  };
  // Rows the sends that landed earlier stand for.
  const used = new Set(pending.flatMap((p) => (p.landed === undefined ? [] : [p.landed])));
  const next: (PendingSend | undefined)[] = [];
  const shown: PendingSend[] = [];
  const landed: number[] = [];
  for (const [i, p] of pending.entries()) {
    const key = queueKey(p.text);
    const row = p.landed === undefined ? rows.find((r) => !used.has(r.id) && !p.before.includes(r.id) && queueKey(r.text) === key) : undefined;
    if (row) used.add(row.id);
    if (p.landed !== undefined || row) {
      landed.push(i);
      next.push(row ? { ...p, landed: row.id } : p);
      continue;
    }
    if (claim(key)) {
      next.push(p.seen ? p : { ...p, seen: true });
      continue;
    }
    const age = now - p.at;
    if (p.seen || age > MAX_PENDING_MS || (!p.sending && !working && age > IDLE_GRACE_MS)) {
      next.push(undefined);
      continue;
    }
    next.push(p);
    shown.push(p);
  }
  // After the sends still queued took theirs: a landed send hides a listing of its text that is
  // left, else it is done.
  const hidden = new Map<string, number>();
  for (const i of landed) {
    const key = queueKey(pending[i]!.text);
    if (claim(key)) hidden.set(key, (hidden.get(key) ?? 0) + 1);
    else next[i] = undefined;
  }
  const occurrences = new Map<string, number>();
  const chip = (text: string, kind: QueueKind, p?: PendingSend): QueueChip => {
    const base = `${kind}:${queueKey(text)}`;
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return { id: `${base}#${n}`, text, kind, pending: p !== undefined, sending: p?.sending ?? false };
  };
  /** The host's listings of one kind, less the oldest ones landed sends hide. */
  const listed = (texts: readonly string[], kind: QueueKind): QueueChip[] =>
    texts
      .filter((t) => {
        const key = queueKey(t);
        const n = hidden.get(key) ?? 0;
        if (n > 0) hidden.set(key, n - 1);
        return n === 0;
      })
      .map((t) => chip(t, kind));
  const chips = [
    ...listed(host?.steering ?? [], "steer"),
    ...shown.filter((p) => p.kind === "steer").map((p) => chip(p.text, "steer", p)),
    ...listed(host?.followUp ?? [], "follow"),
    ...shown.filter((p) => p.kind === "follow").map((p) => chip(p.text, "follow", p)),
  ];
  return { chips, keep: next.filter((p): p is PendingSend => p !== undefined) };
}

interface PendingQueueState {
  byAgent: Record<string, PendingSend[]>;
  add(agentKey: string, send: Pick<PendingSend, "text" | "kind" | "before">): number;
  /** The `agent.prompt` call succeeded. */
  sent(agentKey: string, id: number): void;
  remove(agentKey: string, id: number): void;
  /** Drops the newest pending send with this text that did not land (pulled back out of the queue). */
  forget(agentKey: string, text: string): void;
  /** omp had nothing left to pull back: drops the sends that are neither in flight nor landed. */
  settle(agentKey: string): void;
  replace(agentKey: string, list: PendingSend[]): void;
}

let nextId = 1;

/** Messages this client queued per agent key (reconciled by {@link useQueueChips}). */
export const usePendingQueue = create<PendingQueueState>()((set) => {
  const update = (agentKey: string, f: (list: PendingSend[]) => PendingSend[]) =>
    set((s) => {
      const list = f(s.byAgent[agentKey] ?? []);
      const byAgent = { ...s.byAgent };
      if (list.length) byAgent[agentKey] = list;
      else delete byAgent[agentKey];
      return { byAgent };
    });
  return {
    byAgent: {},
    add: (agentKey, send) => {
      const id = nextId++;
      update(agentKey, (l) => [...l, { ...send, id, at: Date.now(), sending: true, seen: false }]);
      return id;
    },
    sent: (agentKey, id) => update(agentKey, (l) => l.map((p) => (p.id === id ? { ...p, sending: false, at: Date.now() } : p))),
    remove: (agentKey, id) => update(agentKey, (l) => l.filter((p) => p.id !== id)),
    forget: (agentKey, text) =>
      update(agentKey, (l) => {
        const key = queueKey(text);
        const i = l.findLastIndex((p) => p.landed === undefined && queueKey(p.text) === key);
        return i < 0 ? l : l.filter((_, j) => j !== i);
      }),
    settle: (agentKey) => update(agentKey, (l) => l.filter((p) => p.sending || p.landed !== undefined)),
    replace: (agentKey, list) => update(agentKey, () => list),
  };
});

const NO_PENDING: PendingSend[] = [];

/**
 * The "Queued" strip of one agent: the host's queue plus this client's pending sends, reconciled
 * against the transcript (re-checked every second while anything is pending).
 */
export function useQueueChips(agentKey: string, host: QueueInfo | undefined, working: boolean): QueueChip[] {
  const pending = usePendingQueue((s) => s.byAgent[agentKey] ?? NO_PENDING);
  const keys = useMemo(() => new Set(pending.map((p) => queueKey(p.text))), [pending]);
  // Only user rows that could be an echo: "id\0text", so the shallow compare stays cheap.
  const rowKeys = useCore(
    useShallow((s) => {
      if (keys.size === 0) return [];
      const e = s.sessions[agentKey];
      if (!e) return [];
      const out: string[] = [];
      for (const id of e.itemIds) {
        const it = e.items[id];
        if (it?.kind === "user" && !it.synthetic && keys.has(queueKey(it.text))) out.push(`${id}\0${it.text}`);
      }
      return out;
    }),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);
  const { chips, keep } = useMemo(() => {
    const rows = rowKeys.map((k) => {
      const i = k.indexOf("\0");
      return { id: k.slice(0, i), text: k.slice(i + 1) };
    });
    return reconcileQueue(pending, host, rows, working, Math.max(now, Date.now()));
  }, [pending, host, rowKeys, working, now]);
  useEffect(() => {
    const changed = keep.length !== pending.length || keep.some((p, i) => p !== pending[i]);
    if (changed) usePendingQueue.getState().replace(agentKey, keep);
  }, [agentKey, keep, pending]);
  return chips;
}

/** Ids of the loaded user rows with this text (the baseline a later echo is told apart from). */
export function userRowsWithText(items: readonly TranscriptItem[], text: string): string[] {
  const key = queueKey(text);
  return items.flatMap((it) => (it.kind === "user" && queueKey(it.text) === key ? [it.id] : []));
}
