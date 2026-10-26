import type { AutomationRunStatus, AutomationTrigger } from "@/core/gen";
import type { Status } from "@/design";

const ABSOLUTE: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

/** "Mon, Oct 26, 09:00" in this device's zone, or in `timeZone` (an IANA name; null when the runtime can't use it). */
export function formatWhen(t: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { ...ABSOLUTE, timeZone }).format(t);
}

/** `formatWhen` in the host's zone, or null when it is this device's zone (or not an IANA name). */
export function hostWhen(t: number, timeZone: string): string | null {
  if (timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone) return null;
  try {
    return formatWhen(t, timeZone);
  } catch {
    return null;
  }
}

/** "in 45s", "in 12m", "in 3h 20m", "in 2d 4h" (past: "due now"). */
export function formatIn(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s <= 0) return "due now";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `in ${d}d ${h % 24}h` : `in ${d}d`;
}

export const RUN_STATUS: Record<AutomationRunStatus, { label: string; tone: Status }> = {
  started: { label: "Started", tone: "done" },
  failed: { label: "Failed", tone: "error" },
  skipped: { label: "Skipped", tone: "idle" },
};

export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  schedule: "Scheduled",
  manual: "Run now",
  catchUp: "Catch-up",
};
