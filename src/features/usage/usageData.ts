/**
 * Usage analytics over the hosts' `host.usage` insights (pure; `usageData.test.ts`): merging hosts
 * (additive sums, hour buckets by their absolute start), local days and bars, streaks, the
 * activity calendar, the hour-of-day profile and derived rates.
 */
import { bucketStart, type Calendar } from "@/core";
import type { UsageInsights, UsageKeyStat, UsageModelStat, UsageProjectStat, UsageRequestRecord, UsageSessionStat, UsageSpan, UsageStat, UsageToolStat } from "@/core/gen";

const WORK_PAUSE_MS = 10 * 60_000;

export function zeroStat(): UsageStat {
  return {
    requests: 0,
    errors: 0,
    costUsd: 0,
    unpriced: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    premium: 0,
    uncachedUsd: 0,
    cachedUsd: 0,
    durationMs: 0,
    durationN: 0,
    ttftMs: 0,
    ttftN: 0,
    tps: 0,
    tpsN: 0,
  };
}

/** Adds `b` into `a` (hostd's `add_stat`); returns `a`. */
export function addStat(a: UsageStat, b: UsageStat): UsageStat {
  a.requests += b.requests;
  a.errors += b.errors;
  a.costUsd += b.costUsd;
  a.unpriced += b.unpriced;
  a.tokens += b.tokens;
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.premium += b.premium;
  a.uncachedUsd += b.uncachedUsd;
  a.cachedUsd += b.cachedUsd;
  a.durationMs += b.durationMs;
  a.durationN += b.durationN;
  a.ttftMs += b.ttftMs;
  a.ttftN += b.ttftN;
  a.tps += b.tps;
  a.tpsN += b.tpsN;
  if (b.firstAt != null) a.firstAt = a.firstAt == null ? b.firstAt : Math.min(a.firstAt, b.firstAt);
  if (b.lastAt != null) a.lastAt = a.lastAt == null ? b.lastAt : Math.max(a.lastAt, b.lastAt);
  return a;
}

/** Rates of a stat (null when there is nothing to divide). */
export function derive(s: UsageStat) {
  return {
    avgMs: s.durationN > 0 ? s.durationMs / s.durationN : null,
    ttftMs: s.ttftN > 0 ? s.ttftMs / s.ttftN : null,
    tps: s.tpsN > 0 ? s.tps / s.tpsN : null,
    /** omp's cache rate: cache reads over all prompt tokens read. */
    cacheRate: s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : null,
    /** What caching saved on the prompts (API-equivalent). */
    savedUsd: Math.max(0, s.uncachedUsd - s.cachedUsd),
    savings: s.uncachedUsd > 0 ? Math.max(0, s.uncachedUsd - s.cachedUsd) / s.uncachedUsd : null,
    errorRate: s.requests > 0 ? s.errors / s.requests : null,
  };
}

export interface HourAgg {
  start: number;
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  requests: number;
  errors: number;
  unpriced: number;
}

export interface HostInsights {
  hostId: string;
  insights: UsageInsights;
}

type Hosted<T> = T & { hostId: string };

export interface MergedUsage {
  totals: UsageStat;
  /** Ascending by start. */
  hours: HourAgg[];
  models: (UsageModelStat & { hosts: string[] })[];
  providers: UsageKeyStat[];
  agents: UsageKeyStat[];
  subagents: UsageKeyStat[];
  tiers: UsageKeyStat[];
  projects: Hosted<UsageProjectStat>[];
  tools: UsageToolStat[];
  sessions: Hosted<UsageSessionStat>[];
  priciest?: Hosted<UsageRequestRecord>;
  biggest?: Hosted<UsageRequestRecord>;
  longest?: Hosted<UsageSessionStat>;
  /** All-time requests per bucket start. */
  activity: Map<number, number>;
  workMs: number;
  stretches: UsageSpan[];
  sessionCount: number;
  subagentCount: number;
}

const byCost = <T extends { stat: UsageStat }>(a: T, b: T) => b.stat.costUsd - a.stat.costUsd || b.stat.tokens - a.stat.tokens;

function mergeKeys(lists: UsageKeyStat[][]): UsageKeyStat[] {
  const m = new Map<string, UsageKeyStat>();
  for (const list of lists)
    for (const k of list) {
      const cur = m.get(k.key);
      if (cur) addStat(cur.stat, k.stat);
      else m.set(k.key, { key: k.key, stat: addStat(zeroStat(), k.stat) });
    }
  return [...m.values()].sort(byCost);
}

/** Hosts merged: sums by key, hour buckets by their absolute start (never by a host-local label). */
export function mergeInsights(list: HostInsights[]): MergedUsage {
  const totals = zeroStat();
  const hours = new Map<number, HourAgg>();
  const models = new Map<string, UsageModelStat & { hosts: string[] }>();
  const tools = new Map<string, UsageToolStat>();
  const activity = new Map<number, number>();
  const out: MergedUsage = {
    totals,
    hours: [],
    models: [],
    providers: mergeKeys(list.map((h) => h.insights.providers)),
    agents: mergeKeys(list.map((h) => h.insights.agents)),
    subagents: mergeKeys(list.map((h) => h.insights.subagents)).sort((a, b) => Number(a.key === "") - Number(b.key === "") || byCost(a, b)),
    tiers: mergeKeys(list.map((h) => h.insights.tiers)),
    projects: [],
    tools: [],
    sessions: [],
    activity,
    workMs: 0,
    stretches: [],
    sessionCount: 0,
    subagentCount: 0,
  };
  const spans: UsageSpan[] = [];
  for (const { hostId, insights: ins } of list) {
    addStat(totals, ins.totals);
    const h = ins.hours;
    for (let i = 0; i < h.hour.length; i++) {
      const start = bucketStart(h.hour[i] ?? 0, ins.hourOffset);
      const cur = hours.get(start) ?? { start, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, requests: 0, errors: 0, unpriced: 0 };
      cur.cost += h.costUsd[i] ?? 0;
      cur.tokens += h.tokens[i] ?? 0;
      cur.input += h.input[i] ?? 0;
      cur.output += h.output[i] ?? 0;
      cur.cacheRead += h.cacheRead[i] ?? 0;
      cur.requests += h.requests[i] ?? 0;
      cur.errors += h.errors[i] ?? 0;
      cur.unpriced += h.unpriced[i] ?? 0;
      hours.set(start, cur);
    }
    for (let i = 0; i < ins.activity.hour.length; i++) {
      const start = bucketStart(ins.activity.hour[i] ?? 0, ins.hourOffset);
      activity.set(start, (activity.get(start) ?? 0) + (ins.activity.requests[i] ?? 0));
    }
    for (const m of ins.models) {
      const key = `${m.provider}/${m.model}`;
      const cur = models.get(key);
      if (cur) {
        addStat(cur.stat, m.stat);
        cur.hosts.push(hostId);
      } else models.set(key, { provider: m.provider, model: m.model, stat: addStat(zeroStat(), m.stat), hosts: [hostId] });
    }
    for (const t of ins.tools) {
      const cur = tools.get(t.name);
      if (cur) {
        cur.calls += t.calls;
        cur.errors += t.errors;
        cur.costUsd += t.costUsd;
      } else tools.set(t.name, { ...t });
    }
    for (const p of ins.projects) out.projects.push({ ...p, hostId });
    for (const s of ins.sessions) out.sessions.push({ ...s, hostId });
    const r = ins.records;
    if (r.priciest && (!out.priciest || r.priciest.costUsd > out.priciest.costUsd)) out.priciest = { ...r.priciest, hostId };
    if (r.biggest && (!out.biggest || r.biggest.tokens > out.biggest.tokens)) out.biggest = { ...r.biggest, hostId };
    const l = r.longestSession;
    if (l && (!out.longest || l.endedAt - l.startedAt > out.longest.endedAt - out.longest.startedAt)) out.longest = { ...l, hostId };
    out.workMs += ins.work.agentMs;
    spans.push(...ins.work.stretches);
    out.sessionCount += ins.sessionCount;
    out.subagentCount += ins.subagentCount;
  }
  out.hours = [...hours.values()].sort((a, b) => a.start - b.start);
  out.models = [...models.values()].sort(byCost);
  out.tools = [...tools.values()].sort((a, b) => b.calls - a.calls || b.costUsd - a.costUsd);
  out.projects.sort((a, b) => Number(a.folder === "") - Number(b.folder === "") || byCost(a, b));
  out.sessions = out.sessions.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens).slice(0, 10);
  spans.sort((a, b) => a.start - b.start);
  for (const s of spans) {
    const last = out.stretches[out.stretches.length - 1];
    if (last && s.start - last.end <= WORK_PAUSE_MS) last.end = Math.max(last.end, s.end);
    else out.stretches.push({ ...s });
  }
  return out;
}

export interface DayPoint {
  /** `YYYY-MM-DD` on this device. */
  key: string;
  start: number;
  cost: number;
  tokens: number;
  requests: number;
  errors: number;
  unpriced: number;
}

/** Local days from the day of `from` through today, zero-filled (a DST day is one day of 23 or 25 hours). */
export function daySeries(hours: readonly HourAgg[], cal: Calendar, from: number, now: number): DayPoint[] {
  const days: DayPoint[] = [];
  const index = new Map<string, DayPoint>();
  for (let start = cal.startOfDay(from); start <= now && days.length < 3700; start = cal.addDays(start, 1)) {
    const d: DayPoint = { key: cal.day(start), start, cost: 0, tokens: 0, requests: 0, errors: 0, unpriced: 0 };
    days.push(d);
    index.set(d.key, d);
  }
  for (const h of hours) {
    const d = index.get(cal.day(h.start));
    if (!d) continue;
    d.cost += h.cost;
    d.tokens += h.tokens;
    d.requests += h.requests;
    d.errors += h.errors;
    d.unpriced += h.unpriced;
  }
  return days;
}

export interface Bar extends DayPoint {
  /** Days in this bar (1, or several for long ranges). */
  span: number;
}

/** At most `max` bars: consecutive days grouped evenly for long ranges (the newest bar ends today). */
export function bars(days: readonly DayPoint[], max: number): Bar[] {
  const per = Math.max(1, Math.ceil(days.length / Math.max(1, max)));
  const out: Bar[] = [];
  for (let end = days.length; end > 0; end -= per) {
    const chunk = days.slice(Math.max(0, end - per), end);
    const first = chunk[0];
    if (!first) continue;
    const b: Bar = { ...first, span: chunk.length, cost: 0, tokens: 0, requests: 0, errors: 0, unpriced: 0 };
    for (const d of chunk) {
      b.cost += d.cost;
      b.tokens += d.tokens;
      b.requests += d.requests;
      b.errors += d.errors;
      b.unpriced += d.unpriced;
    }
    out.unshift(b);
  }
  return out;
}

/** Requests per local day of an all-time activity series. */
export function activeDays(activity: Map<number, number>, cal: Calendar): Map<string, number> {
  const days = new Map<string, number>();
  for (const [start, n] of activity) if (n > 0) days.set(cal.day(start), (days.get(cal.day(start)) ?? 0) + n);
  return days;
}

export interface Streaks {
  /** Consecutive active days up to today (or yesterday, while today has nothing yet). */
  current: number;
  longest: number;
  activeDays: number;
  todayActive: boolean;
}

export function streaks(days: Map<string, number>, cal: Calendar, now: number): Streaks {
  const todayActive = days.has(cal.day(now));
  let current = 0;
  for (let t = todayActive ? now : cal.addDays(now, -1); days.has(cal.day(t)); t = cal.addDays(t, -1)) current++;
  let longest = 0;
  let run = 0;
  let prev: string | undefined;
  for (const key of [...days.keys()].sort()) {
    run = prev !== undefined && nextDayKey(prev) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = key;
  }
  return { current, longest, activeDays: days.size, todayActive };
}

/** The calendar day after `YYYY-MM-DD` (date arithmetic, no time zone involved). */
export function nextDayKey(key: string): string {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export interface HeatCell {
  key: string;
  requests: number;
  /** 0 = none, 1–4 = quartiles of the active days shown. */
  level: number;
  future: boolean;
}

/** `weeks` columns of Monday…Sunday ending with this week. */
export function heatmap(days: Map<string, number>, cal: Calendar, now: number, weeks: number): HeatCell[][] {
  const monday = cal.addDays(now, -((cal.weekday(now) + 6) % 7) - 7 * (weeks - 1));
  const shown: number[] = [];
  const cols: HeatCell[][] = [];
  const todayKey = cal.day(now);
  let future = false;
  for (let w = 0, t = monday; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++, t = cal.addDays(t, 1)) {
      const key = cal.day(t);
      const requests = future ? 0 : (days.get(key) ?? 0);
      if (requests > 0) shown.push(requests);
      col.push({ key, requests, level: 0, future });
      if (key === todayKey) future = true;
    }
    cols.push(col);
  }
  const sorted = shown.sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  for (const col of cols) for (const c of col) c.level = c.requests === 0 ? 0 : c.requests <= q1 ? 1 : c.requests <= q2 ? 2 : c.requests <= q3 ? 3 : 4;
  return cols;
}

/** Requests per local hour of day (0–23). */
export function hourProfile(hours: readonly HourAgg[], cal: Calendar): number[] {
  const out = new Array<number>(24).fill(0);
  for (const h of hours) {
    const i = cal.hour(h.start);
    out[i] = (out[i] ?? 0) + h.requests;
  }
  return out;
}

/** "1h 20m", "45m", "2d 3h". */
export function formatSpanMs(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A project's display name: the last folder of its directory, else omp's folder slug. */
export function projectName(p: { folder: string; cwd?: string }): string {
  if (p.folder === "") return "Other projects";
  const path = p.cwd?.replace(/[\\/]+$/, "");
  return path ? (path.split(/[\\/]/).pop() ?? path) : p.folder.replace(/^-+/, "") || p.folder;
}
