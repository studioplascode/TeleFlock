import type { Subagent, SubagentStatus } from "@/core/gen";

/**
 * What a subagent's status means to the user. The wire's `parked` (omp parking an idle agent; sent by
 * hostds before the replica kept the outcome, and still in session caches) says "finished" and
 * nothing else, so it reads as done instead of its own colour.
 */
export type SubagentOutcome = "running" | "done" | "failed" | "aborted";

export function outcomeOf(status: SubagentStatus): SubagentOutcome {
  return status === "parked" ? "done" : status;
}

/** How many subagents run, failed, finished, or were stopped (killed, or cut off when omp's process died). */
export interface SubagentTally {
  running: number;
  failed: number;
  done: number;
  aborted: number;
}

export const tallyTotal = (t: SubagentTally): number => t.running + t.failed + t.done + t.aborted;

function count(t: SubagentTally, status: SubagentStatus): void {
  t[outcomeOf(status)]++;
}

function addTally(t: SubagentTally, more: SubagentTally): void {
  t.running += more.running;
  t.failed += more.failed;
  t.done += more.done;
  t.aborted += more.aborted;
}

const noTally = (): SubagentTally => ({ running: 0, failed: 0, done: 0, aborted: 0 });

/** The roster's counts at every depth (the card's header and collapsed summary). */
export function tallySubagents(subs: Iterable<Subagent>): SubagentTally {
  const t = noTally();
  for (const s of subs) count(t, s.status);
  return t;
}

/** One subagent in the Subagents panel's tree. */
export interface SubagentNode {
  sub: Subagent;
  /** The name its row shows: without the parent's name omp nests it under (`Lab.Ui.Shots` under `Lab.Ui` reads `Shots`). */
  label: string;
  /** The subagent it runs under, when the roster lists it. */
  parent?: SubagentNode;
  /** Its own subagents, ordered like the top level. */
  children: SubagentNode[];
  /** Everything below it, at any depth. */
  below: SubagentTally;
  /** The parent its id names when the roster lacks it: it shows at the top level, "from <id>". */
  orphanOf?: string;
}

export interface SubagentGroups extends SubagentTally {
  /**
   * Always visible: top-level subagents with anything running (first) or failed, themselves or
   * anywhere below them, in roster order. A finished parent of a failed grandchild stays here.
   */
  active: SubagentNode[];
  /** Collapsed by default: top-level subagents whose whole branch finished, the most recently finished first. */
  completed: SubagentNode[];
  /** The agents the completed group holds, at every depth (its header). */
  completedTally: SubagentTally;
  /** Every subagent's node, by id. */
  nodes: Map<string, SubagentNode>;
}

/** omp nests a subagent's own subagents under its id: `A.B.C` runs under `A.B`. */
function idParent(id: string): string | undefined {
  const dot = id.lastIndexOf(".");
  return dot > 0 ? id.slice(0, dot) : undefined;
}

/** Cuts parent links that close a loop (only malformed data has one), so every chain ends at the top. */
function breakLoops(parent: Map<string, string>, ids: Iterable<string>): void {
  // The walk (one per id) that first reached each subagent: meeting the current walk again is a loop.
  const reached = new Map<string, number>();
  let walk = 0;
  for (const id of ids) {
    walk++;
    let child: string | undefined;
    for (let cur: string | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const seen = reached.get(cur);
      if (seen === walk && child !== undefined) parent.delete(child);
      if (seen !== undefined) break;
      reached.set(cur, walk);
      child = cur;
    }
  }
}

/** 0: running (itself or below), 1: failed (itself or below), 2: finished, with everything below it. */
function rank(n: SubagentNode): 0 | 1 | 2 {
  const o = outcomeOf(n.sub.status);
  if (o === "running" || n.below.running > 0) return 0;
  return o === "failed" || n.below.failed > 0 ? 1 : 2;
}

/**
 * Whether a branch shows its subagents until the user says otherwise: while anything below it runs
 * or failed. A finished branch folds into its roll-up line, as finished agents fold into the
 * completed group at the top.
 */
export function opensByDefault(n: SubagentNode): boolean {
  return n.below.running + n.below.failed > 0;
}

/**
 * The session's subagents as a tree for the Subagents panel (desktop sidebar and the phone's Agents
 * tab) and the viewer's navigation. A subagent hangs under the one its `parentId` names, else under
 * the one its id names (omp: `A.B` under `A`; hosts before 0.9.0 sent `Main` or a tool call id in
 * `parentId`), when the roster lists that one; otherwise it is top level, with `orphanOf` when its
 * id names a parent the roster lacks. Every level is ordered alike: running first, then failed (a
 * branch counts as running or failed when anything in it is; roster order within), then the
 * finished ones, the branch that ended last first.
 */
export function groupSubagents(subs: readonly Subagent[]): SubagentGroups {
  const byId = new Map<string, Subagent>();
  for (const s of subs) if (!byId.has(s.id)) byId.set(s.id, s);
  const parentOf = new Map<string, string>();
  const orphans = new Map<string, string>();
  for (const s of byId.values()) {
    const named = idParent(s.id);
    const up = [s.parentId, named].find((p) => p !== undefined && p !== s.id && byId.has(p));
    if (up !== undefined) parentOf.set(s.id, up);
    else if (named !== undefined) orphans.set(s.id, named);
  }
  breakLoops(parentOf, byId.keys());

  const nodes = new Map<string, SubagentNode>();
  for (const s of byId.values()) nodes.set(s.id, { sub: s, label: s.name, children: [], below: noTally(), orphanOf: orphans.get(s.id) });
  const roots: SubagentNode[] = [];
  for (const [id, node] of nodes) {
    const p = parentOf.get(id);
    const up = p === undefined ? undefined : nodes.get(p);
    if (!up) {
      roots.push(node);
      continue;
    }
    node.parent = up;
    up.children.push(node);
    if (node.sub.name.startsWith(`${up.sub.name}.`)) node.label = node.sub.name.slice(up.sub.name.length + 1);
  }

  // Breadth-first from the top, then backwards: every child before its parent, without recursion.
  const order: SubagentNode[] = [...roots];
  for (let i = 0; i < order.length; i++) for (const c of (order[i] as SubagentNode).children) order.push(c);
  const lastEnd = new Map<SubagentNode, number>();
  // Array.prototype.sort is stable: the same rank (and, finished, the same end) keeps roster order.
  const sortLevel = (level: SubagentNode[]) =>
    level.sort((a, b) => {
      const ra = rank(a);
      return ra - rank(b) || (ra === 2 ? (lastEnd.get(b) ?? 0) - (lastEnd.get(a) ?? 0) : 0);
    });
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i] as SubagentNode;
    let end = n.sub.endedAt ?? n.sub.startedAt ?? 0;
    for (const c of n.children) {
      count(n.below, c.sub.status);
      addTally(n.below, c.below);
      end = Math.max(end, lastEnd.get(c) ?? 0);
    }
    lastEnd.set(n, end);
    sortLevel(n.children);
  }
  sortLevel(roots);

  const active: SubagentNode[] = [];
  const completed: SubagentNode[] = [];
  const completedTally = noTally();
  for (const n of roots) {
    if (rank(n) < 2) {
      active.push(n);
      continue;
    }
    completed.push(n);
    count(completedTally, n.sub.status);
    addTally(completedTally, n.below);
  }
  return { ...tallySubagents(byId.values()), active, completed, completedTally, nodes };
}

/** Every subagent in the order the panel lists them (each one's subagents right after it), folded or not: the viewer's `[` / `]`. */
export function treeOrder(g: Pick<SubagentGroups, "active" | "completed">): Subagent[] {
  const out: Subagent[] = [];
  const stack = [...g.active, ...g.completed].reverse();
  for (let n = stack.pop(); n; n = stack.pop()) {
    out.push(n.sub);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as SubagentNode);
  }
  return out;
}

/** One part of a branch's roll-up line; `tone` tints the counts that need a look. */
export interface RollupPart {
  text: string;
  tone?: "running" | "failed";
}

/** A branch's roll-up line, "3 subagents · 2 running · 1 failed", in parts. */
export function rollupParts(t: SubagentTally): RollupPart[] {
  const n = tallyTotal(t);
  const parts: RollupPart[] = [{ text: `${n} subagent${n === 1 ? "" : "s"}` }];
  if (t.running > 0) parts.push({ text: `${t.running} running`, tone: "running" });
  if (t.failed > 0) parts.push({ text: `${t.failed} failed`, tone: "failed" });
  return parts;
}

/** Header detail of the collapsed group: "3 done · 1 stopped" (killed, or cut off when omp's process died). */
export function completedSummary(g: Pick<SubagentTally, "done" | "aborted">): string {
  return [g.done > 0 && `${g.done} done`, g.aborted > 0 && `${g.aborted} stopped`].filter(Boolean).join(" · ");
}
