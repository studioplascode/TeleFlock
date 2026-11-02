import type { IdleShells, IdleShellsClosed } from "@/core/gen";

/*
 * Idle shells (`HostInfo.idleShells`, architecture §3.17): herdr panes whose shell waits at its prompt with
 * nothing running, in a workspace without an agent, shown in no terminal, with no input or output for the
 * host's threshold. tf-hostd lists them and, unless switched off, closes them by itself. The thresholds, the
 * words every surface uses, and when the board offers to close them.
 */

/** The threshold presets, in minutes: 1, 2, 4, 8, 12, 24, 48 and 72 h, 7 days. */
export const THRESHOLDS: readonly number[] = [60, 120, 240, 480, 720, 1440, 2880, 4320, 10_080];

const HOUR = 60;
const DAY = 24 * HOUR;

/** A threshold, exact: "45 min", "1 h 30 min", "24 h", "72 h", "7 days" (whole days beyond 72 h). */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < HOUR) return `${m} min`;
  if (m > 3 * DAY && m % DAY === 0) return `${m / DAY} days`;
  const h = Math.floor(m / HOUR);
  return m % HOUR === 0 ? `${h} h` : `${h} h ${m % HOUR} min`;
}

/** How long a shell has been idle, rounded down: "40 min", "26 h", "4 days" (days beyond 72 h). */
export function idleText(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < HOUR) return `${m} min`;
  const h = Math.floor(m / HOUR);
  return h > 72 ? `${Math.floor(h / 24)} days` : `${h} h`;
}

/** The threshold select's choices: the presets, plus the host's own value when it is none of them. */
export function thresholdChoices(minutes: number): number[] {
  return THRESHOLDS.includes(minutes) ? [...THRESHOLDS] : [...THRESHOLDS, minutes].sort((a, b) => a - b);
}

/** What makes a shell idle on a host: "No agent, nothing running and no input or output for 24 h". */
export function ruleText(minutes: number): string {
  return `No agent, nothing running and no input or output for ${spanText(minutes)}`;
}

/** "3 idle shells", "1 idle shell". */
export function shellsText(n: number): string {
  return `${n} idle shell${n === 1 ? "" : "s"}`;
}

/** "a", "a and b", "a, b and c"; past `max` items, "a, b, c and 4 more". */
export function andList(items: readonly string[], max = 4): string {
  if (items.length > max) return `${items.slice(0, max - 1).join(", ")} and ${items.length - max + 1} more`;
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "at 04:12" today, "yesterday at 04:12", else "on Oct 30 at 04:12" (local time). */
export function whenText(at: number, now: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return `at ${clock(at)}`;
  if (days === 1) return `yesterday at ${clock(at)}`;
  return `on ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${clock(at)}`;
}

/** The newest automatic close: "Closed 3 idle shells by itself at 04:12: dotfiles, ~ and notes." */
export function closedText(closed: IdleShellsClosed, now: number): string {
  const list = andList(closed.workspaces);
  return `Closed ${shellsText(closed.count)} by itself ${whenText(closed.at, now)}${list ? `: ${list}` : ""}.`;
}

/** How long a hidden idle-shells notice stays hidden (unless more shells go idle). */
export const SNOOZE_MS = 24 * 3600_000;

/** A hidden notice: how many shells it named, until when. */
export interface ShellsSnooze {
  count: number;
  until: number;
}

/**
 * Whether the board offers to close a host's idle shells: the host reports them (tf-hostd ≥ 0.9.0), doesn't
 * close them by itself, some are idle, and the notice wasn't hidden within a day at this count or more.
 */
export function showShellsNotice(idle: IdleShells | undefined, snooze: ShellsSnooze | undefined, now: number): boolean {
  if (!idle || idle.auto || idle.shells.length === 0) return false;
  if (!snooze || now >= snooze.until) return true;
  return idle.shells.length > snooze.count;
}
