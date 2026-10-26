/**
 * 5-field cron (`min hour dom month dow`) exactly as tf-hostd's automation scheduler reads it
 * (`crates/tf-hostd/src/automations/cron.rs`): parse and validate (same messages), the next run
 * times in the local zone, and the same plain-English reading (`At 09:00, Monday through Friday`).
 * The editor's live preview comes from the host (`automation.preview`, the host's zone); this copy
 * describes schedules in lists and backs the demo.
 */

export interface CronSpec {
  minutes: readonly number[];
  hours: readonly number[];
  doms: readonly number[];
  months: readonly number[];
  /** 0 = Sunday … 6 = Saturday (7 folds into 0). */
  dows: readonly number[];
  /** The day field starts with `*` (see `dayMatches`). */
  domStar: boolean;
  dowStar: boolean;
  /** Source fields after macro expansion (the description reads steps from them). */
  fields: readonly string[];
}

export class CronError extends Error {
  override name = "CronError";
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names: readonly string[];
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59, names: [] },
  { name: "hour", min: 0, max: 23, names: [] },
  { name: "day of month", min: 1, max: 31, names: [] },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

function value(f: FieldDef, s: string): number {
  const i = f.names.indexOf(s.toLowerCase());
  if (i >= 0) return i + (f.min === 1 ? 1 : 0);
  if (!/^\d+$/.test(s)) throw new CronError(`\`${s}\` is not a valid ${f.name}`);
  const v = Number(s);
  if (v < f.min || v > f.max) throw new CronError(`${f.name} ${v} is out of range (${f.min}–${f.max})`);
  return v;
}

function field(f: FieldDef, text: string): Set<number> {
  if (!text) throw new CronError(`${f.name} is empty`);
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const slash = part.indexOf("/");
    const range = slash >= 0 ? part.slice(0, slash) : part;
    let step = 1;
    if (slash >= 0) {
      const s = part.slice(slash + 1);
      if (!/^\d+$/.test(s)) throw new CronError(`\`${s}\` is not a valid step in the ${f.name} field`);
      step = Number(s);
      if (step === 0 || step > f.max) throw new CronError(`step ${step} is out of range in the ${f.name} field`);
    }
    let lo: number;
    let hi: number;
    const dash = range.indexOf("-");
    if (range === "*") {
      lo = f.min;
      hi = f.max;
    } else if (dash >= 0) {
      lo = value(f, range.slice(0, dash));
      hi = value(f, range.slice(dash + 1));
      if (lo > hi) throw new CronError(`range ${range} runs backwards in the ${f.name} field`);
    } else {
      lo = value(f, range);
      // `a/n`: from a to the end of the range
      hi = slash >= 0 ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** Parse a cron expression or macro; throws `CronError` with hostd's message. */
export function parseCron(expr: string): CronSpec {
  const trimmed = expr.trim();
  const lower = trimmed.toLowerCase();
  const expanded = MACROS[lower] ?? trimmed;
  if (!MACROS[lower] && lower.startsWith("@")) throw new CronError(`unknown schedule \`${trimmed}\``);
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError(`a schedule has 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [mi, h, dom, mon, dow] = parts.map((p, i) => field(FIELDS[i] as FieldDef, p)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (dow.delete(7)) dow.add(0);
  return {
    minutes: sorted(mi),
    hours: sorted(h),
    doms: sorted(dom),
    months: sorted(mon),
    dows: sorted(dow),
    domStar: (parts[2] as string).startsWith("*"),
    dowStar: (parts[4] as string).startsWith("*"),
    fields: parts,
  };
}

/** The parse error message, or null when the expression is valid. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** hostd's day rule: a `*` day field defers to the other one; both restricted match with OR. */
function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.months.includes(d.getMonth() + 1)) return false;
  const dom = spec.doms.includes(d.getDate());
  const dow = spec.dows.includes(d.getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dow;
  if (spec.dowStar) return dom;
  return dom || dow;
}

/** Days searched ahead before a schedule counts as never firing (Feb 29 on a given weekday recurs within 28 years). */
const MAX_SCAN_DAYS = 366 * 29;

/** The next `count` run times strictly after `from`, in the local time zone. */
export function nextRuns(expr: string | CronSpec, from: number, count: number): number[] {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const out: number[] = [];
  const start = new Date(from);
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_SCAN_DAYS && out.length < count; i++) {
    if (dayMatches(spec, day)) {
      for (const h of spec.hours) {
        for (const m of spec.minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // skip civil times a DST jump moved onto another hour, and repeats
          if (t.getHours() !== h || t.getMinutes() !== m) continue;
          const ms = t.getTime();
          if (ms > from && ms > (out[out.length - 1] ?? -Infinity)) out.push(ms);
          if (out.length === count) return out;
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------- description

function join(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Runs of 3+ consecutive values as `a through b`, others as is. */
function ranges(values: readonly number[], name: (v: number) => string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && (values[j + 1] as number) === (values[j] as number) + 1) j++;
    if (j - i >= 2) out.push(`${name(values[i] as number)} through ${name(values[j] as number)}`);
    else for (let k = i; k <= j; k++) out.push(name(values[k] as number));
    i = j + 1;
  }
  return out;
}

/** The `n` of a field written `*\/n`, `0/n` or `0-max/n` (n > 1). */
function stepOf(text: string, max: number): number | null {
  const slash = text.indexOf("/");
  if (slash < 0 || text.includes(",")) return null;
  const range = text.slice(0, slash);
  if (!(range === "*" || range === "0" || range === `0-${max}`)) return null;
  const n = Number(text.slice(slash + 1));
  return Number.isInteger(n) && n > 1 ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Plain-English reading of a parsed schedule, in tf-hostd's words. */
export function describeSpec(spec: CronSpec): string {
  const [minText = "", hourText = ""] = spec.fields;
  const allMin = spec.minutes.length === 60;
  const everyHour = spec.hours.length === 24;
  const singleMin = spec.minutes.length === 1;
  const m0 = spec.minutes[0] ?? 0;
  const minStep = stepOf(minText, 59);
  const hourStep = stepOf(hourText, 23);
  let time: string;
  if (allMin && everyHour) time = "Every minute";
  else if (everyHour && minStep) time = `Every ${minStep} minutes`;
  else if (singleMin && everyHour) time = `Every hour at :${pad(m0)}`;
  else if (singleMin && hourStep) time = `Every ${hourStep} hours at :${pad(m0)}`;
  else if (singleMin && spec.hours.length <= 6) time = `At ${join(spec.hours.map((h) => `${pad(h)}:${pad(m0)}`))}`;
  else {
    const mins = allMin ? "Every minute" : minStep ? `Every ${minStep} minutes` : `At minute ${join(ranges(spec.minutes, String))}`;
    const hrs = everyHour ? (mins.startsWith("At") ? " past every hour" : "") : hourStep ? `, every ${hourStep} hours` : `, past hour ${join(ranges(spec.hours, pad))}`;
    time = mins + hrs;
  }

  const dowText = () => {
    const key = spec.dows.join(",");
    if (key === "0,1,2,3,4,5,6") return "every day";
    if (key === "1,2,3,4,5") return "Monday through Friday";
    if (key === "0,6") return "on Saturday and Sunday";
    return `on ${join(ranges(spec.dows, (v) => DAY_NAMES[v] as string))}`;
  };
  const domText = () => `on day${spec.doms.length === 1 ? "" : "s"} ${join(ranges(spec.doms, String))} of the month`;
  let days: string;
  if (spec.domStar && spec.dowStar) days = spec.doms.length === 31 ? "every day" : domText();
  else if (spec.domStar) days = dowText();
  else if (spec.dowStar) days = domText();
  else days = `${domText()} or ${dowText()}`;
  const months = spec.months.length === 12 ? "" : `, in ${join(ranges(spec.months, (v) => MONTH_NAMES[v - 1] as string))}`;
  const daysPart = days === "every day" && (time.startsWith("Every") || everyHour) ? "" : `, ${days}`;
  return `${time}${daysPart}${months}`;
}

/** Plain-English reading of `expr`, or null when it doesn't parse. */
export function describeCron(expr: string): string | null {
  try {
    return describeSpec(parseCron(expr));
  } catch {
    return null;
  }
}
