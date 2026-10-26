/**
 * The editor's schedule presets: each generates a cron string, and an existing cron reads back
 * into the preset that generates exactly it (anything else is "custom").
 */

export type PresetKind = "minutes" | "hours" | "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleDraft {
  kind: PresetKind;
  /** Every N minutes / hours. */
  every: number;
  /** Minute past the hour (hours, daily, weekdays, weekly). */
  minute: number;
  /** Hour of day (daily, weekdays, weekly). */
  hour: number;
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Custom cron text (also kept as the last generated cron when switching to custom). */
  cron: string;
}

export const PRESET_LABELS: Record<PresetKind, string> = {
  minutes: "Every N minutes",
  hours: "Every N hours",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  custom: "Custom cron",
};

export const DEFAULT_SCHEDULE: ScheduleDraft = { kind: "weekdays", every: 30, minute: 0, hour: 9, days: [1], cron: "0 9 * * 1-5" };

/**
 * The N of "every N minutes / hours": divisors of the hour / day only, so the gap stays N across
 * the wrap (`*\/45` fires at :00 and :45; `*\/5` hours leaves 4 h at midnight).
 */
export const EVERY_MINUTES: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
export const EVERY_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

/** `every` as one of the kind's choices: the largest not above it (else the smallest). */
export function fitEvery(kind: "minutes" | "hours", every: number): number {
  const choices = kind === "minutes" ? EVERY_MINUTES : EVERY_HOURS;
  return choices.findLast((n) => n <= every) ?? choices[0] ?? 1;
}

/** The cron expression a schedule draft stands for. */
export function scheduleToCron(d: ScheduleDraft): string {
  switch (d.kind) {
    case "minutes":
      return d.every <= 1 ? "* * * * *" : `*/${d.every} * * * *`;
    case "hours":
      return d.every <= 1 ? `${d.minute} * * * *` : `${d.minute} */${d.every} * * *`;
    case "daily":
      return `${d.minute} ${d.hour} * * *`;
    case "weekdays":
      return `${d.minute} ${d.hour} * * 1-5`;
    case "weekly":
      return `${d.minute} ${d.hour} * * ${[...d.days].sort((a, b) => a - b).join(",") || "1"}`;
    case "custom":
      return d.cron.trim();
  }
}

/** Read a cron back into its preset (custom when no preset generates exactly this text). */
export function cronToSchedule(cron: string): ScheduleDraft {
  const text = cron.trim().replace(/\s+/g, " ");
  const base: ScheduleDraft = { ...DEFAULT_SCHEDULE, cron: text };
  const [mi = "", h = "", dom, mon, dow] = text.split(" ");
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const stepOf = (s: string) => (s === "*" ? 1 : /^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);
  const candidates: ScheduleDraft[] = [];
  if (text.split(" ").length === 5 && dom === "*" && mon === "*") {
    const minute = num(mi);
    const hour = num(h);
    if (h === "*" && dow === "*") {
      const every = stepOf(mi);
      if (every !== null && EVERY_MINUTES.includes(every)) candidates.push({ ...base, kind: "minutes", every });
    }
    if (minute !== null && dow === "*") {
      const every = stepOf(h);
      if (every !== null && EVERY_HOURS.includes(every)) candidates.push({ ...base, kind: "hours", every, minute });
    }
    if (minute !== null && hour !== null) {
      if (dow === "*") candidates.push({ ...base, kind: "daily", minute, hour });
      else if (dow === "1-5") candidates.push({ ...base, kind: "weekdays", minute, hour });
      else if (dow && /^[0-6](,[0-6])*$/.test(dow)) candidates.push({ ...base, kind: "weekly", minute, hour, days: dow.split(",").map(Number) });
    }
  }
  return candidates.find((c) => scheduleToCron(c) === text) ?? { ...base, kind: "custom" };
}
