/**
 * Background jobs of an omp agent (`jobs.*`, architecture §3.18): pure helpers shared by the
 * inspector's Jobs panel and the board card. Hosts without `caps.jobs` bridges send no summary.
 */
import type { Job, JobGlance, JobsSummary, JobsView } from "@/core/gen";

/** An open Jobs panel re-reads the jobs every second while one runs. */
export const JOBS_POLL_MS = 1_000;

/** Poll cadence of an open panel: while a job runs; else nothing (the card summary tells when that changes). */
export function jobsPollMs(summary: JobsSummary | undefined, open: boolean): number | null {
  return open && summary !== undefined && summary.running > 0 ? JOBS_POLL_MS : null;
}

/** What changes the card summary: a new snapshot is due (a job started, settled or left). */
export function summaryKey(s: JobsSummary | undefined): string {
  return s ? `${s.running}/${s.recent}/${s.waiting ? 1 : 0}` : "";
}

export function glanceText(g: JobGlance | undefined): string | undefined {
  if (!g) return undefined;
  return [g.text, g.label].filter(Boolean).join(" ");
}

/** "Waiting for background job `bun test`" / "Waiting for 3 background jobs" (omp's own words). */
export function waitingText(s: JobsSummary): string {
  if (s.running === 1 && s.glanceJob) return `Waiting for background job ${s.glanceJob}`;
  if (s.running <= 1) return "Waiting for background work";
  return `Waiting for ${s.running} background jobs`;
}

/** The card meter: `jobs 2 · 140/190 tests`. */
export function meterText(s: JobsSummary): string {
  const g = glanceText(s.glance);
  return g ? `${s.running} · ${g}` : String(s.running);
}

/** A job's one-line title: a subagent's name and task, else the command. */
export function jobTitle(job: Job): string {
  if (job.kind === "task") return job.agentName && job.agentName !== job.label ? `${job.agentName}: ${job.label}` : job.label;
  return (job.command ?? job.label).replace(/\s+/g, " ").trim();
}

export const KIND_LABEL: Record<string, string> = { bash: "bash", eval: "eval", task: "subagent" };

export const STATUS_WORD: Record<Job["status"], string> = { running: "Running", completed: "Done", failed: "Failed", cancelled: "Cancelled" };

/** Expanded rows that still exist in a fresh view. */
export function keepExpanded(expanded: ReadonlySet<string>, view: JobsView): Set<string> {
  const ids = new Set(view.jobs.map((j) => j.id));
  return new Set([...expanded].filter((id) => ids.has(id)));
}

/** Rows to inspect: the expanded ones, else the first running one (its output is what you came for). */
export function inspectIds(expanded: ReadonlySet<string>, view: JobsView | undefined): string[] {
  if (expanded.size > 0) return [...expanded];
  const first = view?.jobs.find((j) => j.status === "running");
  return first ? [first.id] : [];
}
