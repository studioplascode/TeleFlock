/**
 * Time left from an agent's own completion estimate: the main agent's (`OmpInfo.progress`, TeleFlock's
 * bridge ≥ 2.6.0) and each running subagent's (`Subagent.completionPct` with `completionAt`, omp's
 * completion probe). Pure, so the board card, the session view, task cards and subagent rows all read an
 * estimate the same way.
 *
 * An estimate says `pct` of a task that started at `since` was done at `at`. At the pace so far the rest
 * takes `(at − since) × (100 − pct) / pct`, counted down from `at`. Under 5 % done, or with less than a
 * minute behind it, an estimate says too little to extrapolate from: no time left then. Past the end it
 * says so ("any minute", then "over estimate"), never a negative time.
 */
import type { Subagent } from "./gen";
import { formatSpan } from "./limits";

const MIN = 60_000;

/** One completion estimate (host times, ms). `AgentProgress` is one; `subagentEstimate` makes one of a subagent. */
export interface Estimate {
  /** How far along, 0..100. */
  pct: number;
  /** When it was made. */
  at: number;
  /** When the task it estimates started. */
  since: number;
}

/** Under this much done the pace says nothing yet. */
export const MIN_PCT = 5;
/** Nor with less than this of the task behind the estimate. */
export const MIN_ELAPSED_MS = MIN;
/** How often surfaces recompute time left: it is shown in whole minutes. */
export const TIME_LEFT_TICK_MS = 15_000;

export type TimeLeft =
  /** `ms` until the estimated end. */
  | { kind: "left"; ms: number }
  /** The estimated end has just passed: done any minute. */
  | { kind: "due" }
  /** Past the estimated end by `ms`, longer than "any minute" covers. */
  | { kind: "over"; ms: number };

/** The estimate's percentage as shown: whole, 0..100. */
export function roundPct(pct: number): number {
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/** When `e` says the task ends; undefined while it is too early to say (under `MIN_PCT`, or `MIN_ELAPSED_MS` behind it). */
export function estimatedEnd(e: Estimate): number | undefined {
  const elapsed = e.at - e.since;
  if (!(e.pct >= MIN_PCT) || !(elapsed >= MIN_ELAPSED_MS)) return undefined;
  const pct = Math.min(100, e.pct);
  return e.at + (elapsed * (100 - pct)) / pct;
}

/** "Any minute" lasts a fifth of the estimated whole past its end: at least a minute, at most five. */
function dueFor(e: Estimate, end: number): number {
  return Math.min(5 * MIN, Math.max(MIN, (end - e.since) / 5));
}

/** Time left at `now` by estimate `e`; undefined while it is too early to say. */
export function timeLeft(e: Estimate, now: number): TimeLeft | undefined {
  const end = estimatedEnd(e);
  if (end === undefined) return undefined;
  if (now < end) return { kind: "left", ms: end - now };
  return now - end < dueFor(e, end) ? { kind: "due" } : { kind: "over", ms: now - end };
}

/**
 * Time left until the last of several tasks ends (a `task` call's running subagents): by the estimate
 * that ends latest. Undefined while any of them has no time left to tell, as that one could take longest.
 */
export function timeLeftOfAll(estimates: readonly (Estimate | undefined)[], now: number): TimeLeft | undefined {
  let last: Estimate | undefined;
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const e of estimates) {
    const end = e && estimatedEnd(e);
    if (end === undefined) return undefined;
    if (end > lastEnd) {
      last = e;
      lastEnd = end;
    }
  }
  return last && timeLeft(last, now);
}

/** A running subagent's own estimate; undefined until omp's probe answered, and from hosts before 0.9.5 (no `completionAt`). */
export function subagentEstimate(sub: Subagent): Estimate | undefined {
  if (sub.status !== "running" || sub.completionPct == null || sub.completionAt == null || sub.startedAt == null) return undefined;
  return { pct: sub.completionPct, at: sub.completionAt, since: sub.startedAt };
}

/** "~7m left", "any minute", "over estimate". */
export function timeLeftText(t: TimeLeft): string {
  switch (t.kind) {
    case "left":
      return `~${formatSpan(Math.max(MIN, t.ms))} left`;
    case "due":
      return "any minute";
    case "over":
      return "over estimate";
  }
}

/** The pace an estimate implies, in a sentence for tooltips: "64% after 12m: at that pace about 7m more." */
export function paceText(e: Estimate, now: number): string {
  const elapsed = e.at - e.since;
  if (!(elapsed >= MIN_ELAPSED_MS)) return "Too early to tell how long it takes: less than a minute in.";
  const end = estimatedEnd(e);
  const t = timeLeft(e, now);
  if (end === undefined || !t) return `Too early to tell how long it takes: under ${MIN_PCT}% done.`;
  const after = `${roundPct(e.pct)}% after ${formatSpan(elapsed)}`;
  switch (t.kind) {
    case "left":
      return `${after}: at that pace about ${formatSpan(Math.max(MIN, t.ms))} more.`;
    case "due":
      return `${after}: at that pace it should be done about now.`;
    case "over":
      return `${after} pointed to about ${formatSpan(end - e.since)} in all; it has taken ${formatSpan(t.ms)} longer so far.`;
  }
}
