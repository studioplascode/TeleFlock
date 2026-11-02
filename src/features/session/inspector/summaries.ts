/** One-line summaries a collapsed inspector card shows in place of its body (pure; the cards add the markup). */
import type { ChangedFile, Subagent, TodoPhase } from "@/core/gen";
import { completedSummary, tallySubagents } from "../subagents/grouping";
import { todoCounts } from "../tools/TodoList";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Session card: context, subscription left, spend and live output, whichever are known. */
export function overviewSummary(v: { ctxPct?: number; limitLeft?: number; usd?: number; tps?: number }): string {
  const parts: string[] = [];
  if (v.ctxPct != null) parts.push(`ctx ${Math.round(v.ctxPct)}%`);
  if (v.limitLeft != null) parts.push(`limit ${Math.round(v.limitLeft * 100)}% left`);
  if (v.usd != null) parts.push(`$${v.usd.toFixed(2)}`);
  if (v.tps != null && v.tps > 0) parts.push(`${Math.round(v.tps)} tok/s`);
  return parts.join(" · ");
}

/** Todos card: done/total, then the task being worked on. */
export function todosSummary(todos: readonly TodoPhase[]): string {
  const c = todoCounts(todos);
  const active = todos.flatMap((p) => p.tasks).find((t) => t.status === "inProgress");
  const counts = `${c.done}/${c.total}${c.blocked > 0 ? ` · ${c.blocked} blocked` : ""}`;
  return active ? `${counts} · ${active.content}` : counts;
}

/** Subagents card: "2 running · 1 failed" at every depth, else how many finished and were stopped ("3 done · 1 stopped"). */
export function subagentsSummary(subs: readonly Subagent[]): string {
  const tally = tallySubagents(subs);
  const parts: string[] = [];
  if (tally.running > 0) parts.push(`${tally.running} running`);
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : completedSummary(tally);
}

/** Changed files card: the file count and the line totals. */
export function filesSummary(files: readonly ChangedFile[]): { count: number; added: number; removed: number; text: string } {
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  return { count: files.length, added, removed, text: `${plural(files.length, "file")} +${added} −${removed}` };
}

/** Session tree card. */
export function treeSummary(nodes: number, branches: number): string {
  return branches > 0 ? `${plural(nodes, "node")} · ${plural(branches, "branch", "branches")}` : plural(nodes, "node");
}

/** btw card: how many side questions are listed, and whether one is answering. */
export function btwSummary(shown: number, answering: boolean): string {
  if (shown === 0) return "no side questions";
  return `${plural(shown, "question")}${answering ? " · answering" : ""}`;
}
