import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useCore } from "@/core";
import type { Capabilities, TranscriptItem } from "@/core/gen";
import type { QuickCommand } from "@/core/quickCommand";

/** What the composer's cue says the command does. */
export function quickWhat(q: Pick<QuickCommand, "python" | "excluded">): { kind: string; output: string } {
  return { kind: q.python ? "Python" : "Shell command", output: q.excluded ? "output not added to the context" : "output goes to the agent" };
}

/** Why this session can't run quick commands (`cue`: the composer's words for it); null when it can. */
export function quickUnavailable(caps: Capabilities | undefined): { title: string; hint: string; cue: string } | null {
  if (caps?.shell) return null;
  const title = "This session can't run omp's ! and $ commands";
  return caps?.bridge
    ? { title, hint: "They need TeleFlock's bridge 2.5.0 in omp's terminal UI. Restart the agent to update its bridge.", cue: "needs a newer TeleFlock bridge: restart the agent" }
    : { title, hint: "They need TeleFlock's bridge in this omp session: start the agent from TeleFlock, or turn on the global bridge in host setup.", cue: "needs TeleFlock's bridge in this session" };
}

/** A quick command this client ran: shown as running until its row lands in the transcript. */
export interface PendingRun extends QuickCommand {
  id: number;
  /** Client clock (ms) when sent. */
  at: number;
  /** Ids of the loaded rows of the same command at send time: any other one is its row. */
  before: string[];
  /** The `agent.shell` call is still in flight. */
  sending: boolean;
}

/** Safety net for a run whose row never arrives (omp ended, the session switched). */
export const MAX_RUN_MS = 30 * 60_000;

/** Comparison key of a run and of the row omp recorded for it. */
function runKey(q: Pick<QuickCommand, "python" | "excluded" | "body">): string {
  return `${q.python ? "$" : "!"}${q.excluded ? "x" : "c"}\0${q.body}`;
}

/** The key of `item` when it is a quick command the user ran, else null. */
function rowKey(item: TranscriptItem | undefined): string | null {
  if (item?.kind !== "tool" || !item.userRun || item.view?.type !== "bash") return null;
  return runKey({ python: item.userRun.python, excluded: item.userRun.excluded, body: item.view.command });
}

/** Ids of the loaded rows of command `q` (the baseline its own row is told apart from). */
export function runRowsOf(items: readonly TranscriptItem[], q: Pick<QuickCommand, "python" | "excluded" | "body">): string[] {
  const key = runKey(q);
  return items.flatMap((it) => (rowKey(it) === key ? [it.id] : []));
}

/**
 * The runs still waiting for their row: a row of the same command that none of the run's
 * `before` holds is its own (claimed oldest run first, one row each). Runs older than
 * {@link MAX_RUN_MS} go.
 */
export function pendingRuns(pending: readonly PendingRun[], rows: readonly { id: string; key: string }[], now: number): PendingRun[] {
  const claimed = new Set<string>();
  return pending.filter((p) => {
    const key = runKey(p);
    const row = rows.find((r) => r.key === key && !claimed.has(r.id) && !p.before.includes(r.id));
    if (row) {
      claimed.add(row.id);
      return false;
    }
    return now - p.at < MAX_RUN_MS;
  });
}

interface PendingRunsState {
  byAgent: Record<string, PendingRun[]>;
  add(agentKey: string, run: QuickCommand & { before: string[] }): number;
  /** The `agent.shell` call succeeded. */
  sent(agentKey: string, id: number): void;
  remove(agentKey: string, id: number): void;
  replace(agentKey: string, list: PendingRun[]): void;
}

let nextId = 1;

/** Quick commands this client ran per agent key (reconciled by {@link useRuns}). */
export const usePendingRuns = create<PendingRunsState>()((set) => {
  const update = (agentKey: string, f: (list: PendingRun[]) => PendingRun[]) =>
    set((s) => {
      const list = f(s.byAgent[agentKey] ?? []);
      const byAgent = { ...s.byAgent };
      if (list.length) byAgent[agentKey] = list;
      else delete byAgent[agentKey];
      return { byAgent };
    });
  return {
    byAgent: {},
    add: (agentKey, run) => {
      const id = nextId++;
      const { prefix, python, excluded, body, before } = run;
      update(agentKey, (l) => [...l, { id, prefix, python, excluded, body, before, at: Date.now(), sending: true }]);
      return id;
    },
    sent: (agentKey, id) => update(agentKey, (l) => l.map((p) => (p.id === id ? { ...p, sending: false } : p))),
    remove: (agentKey, id) => update(agentKey, (l) => l.filter((p) => p.id !== id)),
    replace: (agentKey, list) => update(agentKey, () => list),
  };
});

const NO_RUNS: PendingRun[] = [];

/** The quick commands this client ran in the agent that are still waiting for their row. */
export function useRuns(agentKey: string): PendingRun[] {
  const pending = usePendingRuns((s) => s.byAgent[agentKey] ?? NO_RUNS);
  const keys = useMemo(() => new Set(pending.map(runKey)), [pending]);
  // Only rows of a pending command: "id\0key", so the shallow compare stays cheap.
  const rowKeys = useCore(
    useShallow((s) => {
      if (keys.size === 0) return [];
      const e = s.sessions[agentKey];
      if (!e) return [];
      const out: string[] = [];
      for (const id of e.itemIds) {
        const key = rowKey(e.items[id]);
        if (key !== null && keys.has(key)) out.push(`${id}\0${key}`);
      }
      return out;
    }),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [pending.length]);
  const keep = useMemo(() => {
    const rows = rowKeys.map((k) => {
      const i = k.indexOf("\0");
      return { id: k.slice(0, i), key: k.slice(i + 1) };
    });
    return pendingRuns(pending, rows, Math.max(now, Date.now()));
  }, [pending, rowKeys, now]);
  useEffect(() => {
    if (keep.length !== pending.length) usePendingRuns.getState().replace(agentKey, keep);
  }, [agentKey, keep, pending]);
  return keep;
}
