/**
 * Spend history (`host.usage`: omp's own stats index on each host, kept current by hostd):
 *
 * - the local calendar: hosts report UTC hour buckets and this device groups them into its own
 *   days (DST-safe, any host time zone), so hosts in different zones add up correctly;
 * - a shared per-host poller that keeps every host's last good report, marked stale, never
 *   dropped, while the host is offline or a request fails, and across restarts (localStorage);
 * - today's spend across hosts: the index's hours since local midnight, plus what each host's
 *   live ledger saw after its last sync (`UsageLive`) and the ledger's growth since that answer
 *   (`HostState.usage`). The board's Today tile and the Usage page both use it.
 */
import { useEffect, useSyncExternalStore } from "react";
import { core } from "./client";
import { toApiError } from "./errors";
import type { UsageIndex, UsageInsights, UsageLive, UsageReport, UsageTotals, UsageView } from "./gen";
import type { CoreState } from "./store/state";
import { useCore } from "./hooks";
import { coreStore } from "./store/store";

const MIN = 60_000;
const HOUR = 60 * MIN;

// ───────────────────────────── calendar ─────────────────────────────

/** Local calendar math for this device (or a named IANA zone in tests). */
export interface Calendar {
  readonly tz: string | undefined;
  /** `YYYY-MM-DD` of the local day holding `ms`. */
  day(ms: number): string;
  /** Local hour of day (0–23). */
  hour(ms: number): number;
  /** Local weekday (0 = Sunday). */
  weekday(ms: number): number;
  /** First instant of the local day holding `ms` (a DST day is 23 or 25 hours long). */
  startOfDay(ms: number): number;
  /** First instant of the local day `n` days after the one holding `ms` (negative: before). */
  addDays(ms: number, n: number): number;
  /** Local UTC offset in minutes at `ms` (east positive). */
  offset(ms: number): number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const deviceCalendar: Calendar = {
  tz: undefined,
  day(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  },
  hour: (ms) => new Date(ms).getHours(),
  weekday: (ms) => new Date(ms).getDay(),
  startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  },
  addDays(ms, n) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
  },
  offset: (ms) => -new Date(ms).getTimezoneOffset(),
};

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  wd: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formats = new Map<string, Intl.DateTimeFormat>();

function zoneParts(tz: string, ms: number): Parts {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formats.set(tz, f);
  }
  const p: Parts = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0, wd: 0 };
  for (const { type, value } of f.formatToParts(ms)) {
    if (type === "year") p.y = Number(value);
    else if (type === "month") p.m = Number(value);
    else if (type === "day") p.d = Number(value);
    else if (type === "hour") p.h = Number(value) % 24;
    else if (type === "minute") p.mi = Number(value);
    else if (type === "second") p.s = Number(value);
    else if (type === "weekday") p.wd = WEEKDAYS.indexOf(value);
  }
  return p;
}

function zoneCalendar(tz: string): Calendar {
  const offset = (ms: number) => {
    const p = zoneParts(tz, ms);
    return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / MIN);
  };
  /** First instant of the local date y-m-d: midnight under the offset in force then (or the DST jump when midnight is skipped). */
  const midnight = (y: number, m: number, d: number) => {
    const utc = Date.UTC(y, m - 1, d);
    let best = Number.POSITIVE_INFINITY;
    // Probes on both sides of midnight: one of them shares midnight's offset.
    for (const probe of [utc - 14 * HOUR, utc, utc + 14 * HOUR]) {
      const t = utc - offset(probe) * MIN;
      const p = zoneParts(tz, t);
      if (p.y === y && p.m === m && p.d === d && t < best) best = t;
    }
    return best;
  };
  const day = (ms: number) => {
    const p = zoneParts(tz, ms);
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  };
  return {
    tz,
    day,
    hour: (ms) => zoneParts(tz, ms).h,
    weekday: (ms) => zoneParts(tz, ms).wd,
    startOfDay(ms) {
      const p = zoneParts(tz, ms);
      return midnight(p.y, p.m, p.d);
    },
    addDays(ms, n) {
      const p = zoneParts(tz, ms);
      const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
      return midnight(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    },
    offset,
  };
}

/** This device's calendar, or a named IANA zone's (tests, previews). */
export function calendar(tz?: string): Calendar {
  return tz ? zoneCalendar(tz) : deviceCalendar;
}

/** Minutes past each UTC hour at which local hours start here (India: 30): hosts bucket on them. */
export function hourOffsetAt(cal: Calendar, ms: number): number {
  return ((cal.offset(ms) % 60) + 60) % 60;
}

/** Start of hour bucket `hour` of a report bucketed at `offsetMin`. */
export function bucketStart(hour: number, offsetMin: number): number {
  return hour * HOUR + offsetMin * MIN;
}

// ───────────────────────────── ranges ─────────────────────────────

/** `today` is the board's summary; the others are the Usage page's insight ranges. */
export type UsageRange = "today" | "7d" | "30d" | "90d" | "all";
export const USAGE_RANGES: readonly Exclude<UsageRange, "today">[] = ["7d", "30d", "90d", "all"];
const RANGE_DAYS: Record<Exclude<UsageRange, "all">, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

/** First instant of a range: local midnight `days - 1` days ago (undefined: all time). */
export function rangeSince(range: UsageRange, now: number, cal: Calendar = deviceCalendar): number | undefined {
  return range === "all" ? undefined : cal.addDays(now, 1 - RANGE_DAYS[range]);
}

// ───────────────────────────── poller ─────────────────────────────

/** The board re-asks for today this often: the index only moves when hostd syncs (≥ 10 min apart), live spend ticks in between. */
export const USAGE_BOARD_EVERY_MS = 5 * MIN;
/** The Usage page re-asks every minute. */
export const USAGE_PAGE_EVERY_MS = MIN;
/** A host that is syncing its index is asked again this soon (while someone polls it). */
export const USAGE_SYNCING_EVERY_MS = 6_000;

/** One host's last good answer for one range, and how the latest request went. */
export interface HostUsage {
  insights?: UsageInsights;
  index?: UsageIndex;
  live?: UsageLive;
  /** When this device received the answer above. */
  receivedAt?: number;
  /** The latest request failed: the answer above is the previous good one. */
  error?: string;
  loading: boolean;
}

type Entry = HostUsage & {
  hostId: string;
  range: UsageRange;
  wants: (number | null)[];
  timer?: ReturnType<typeof setTimeout>;
  askedAt?: number;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (hostId: string, range: UsageRange) => `${hostId}|${range}`;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * The request for one entry right now (local midnight moves, so `since` is computed per ask). `days` is
 * for a tf-hostd from before 0.7, whose params have only that (and it needs it): it answers the legacy
 * shape (`applyUsageAnswer` says so), a current one goes by `view`.
 */
export function usageParams(range: UsageRange, now: number, have: string | undefined, refresh: boolean, cal: Calendar = deviceCalendar) {
  const view: UsageView = range === "today" ? "summary" : "insights";
  return { view, days: range === "all" ? 366 : RANGE_DAYS[range], since: rangeSince(range, now, cal), hourOffset: hourOffsetAt(cal, now), refresh: refresh || undefined, have };
}

/** A tf-hostd from before 0.7 answers `days`/`models` and has no `index`: this app's reports need the new one. */
export const OLD_HOSTD_USAGE = "This host's tf-hostd is older than 0.7 and can't build this report. Update it from Hosts (the app also redeploys it when it connects).";

/** Applies an answer to an entry: a new report replaces the old one, `unchanged` keeps it, a not-ready index clears it. */
export function applyUsageAnswer(e: HostUsage, r: UsageReport, at: number): void {
  e.index = r.index;
  e.live = r.live;
  e.receivedAt = at;
  e.error = r.index === undefined && (r.days !== undefined || r.models !== undefined || r.today !== undefined) ? OLD_HOSTD_USAGE : undefined;
  if (r.insights) e.insights = r.insights;
  else if (!r.unchanged && r.index && !r.index.ready) e.insights = undefined;
}

async function load(key: string, refresh = false): Promise<void> {
  const e = entries.get(key);
  if (!e) return;
  e.askedAt = Date.now();
  if (coreStore.getState().status[e.hostId]?.phase !== "online") {
    // A Refresh that does nothing looks broken: say why (the numbers shown stay the last good ones).
    if (refresh) {
      e.error = "The host is offline; these are the last numbers it gave";
      emit();
    }
    return;
  }
  e.loading = true;
  emit();
  try {
    const r = await core.host(e.hostId).call("host.usage", usageParams(e.range, Date.now(), e.insights?.version, refresh));
    const cur = entries.get(key);
    if (cur) {
      applyUsageAnswer(cur, r, Date.now());
      cur.loading = false;
      persistSoon();
    }
  } catch (err) {
    const cur = entries.get(key);
    if (cur) Object.assign(cur, { error: toApiError(err).message, loading: false });
  }
  emit();
}

/** Delay until the next ask: the shortest subscriber cadence (6 s while the host syncs); null while nobody polls. */
export function nextUsageAskIn(wants: readonly (number | null)[], askedAt: number | undefined, syncing: boolean, now: number): number | null {
  let every = Number.POSITIVE_INFINITY;
  for (const w of wants) if (w !== null && w < every) every = w;
  if (every === Number.POSITIVE_INFINITY) return null;
  if (syncing) every = Math.min(every, USAGE_SYNCING_EVERY_MS);
  return askedAt === undefined ? 0 : Math.max(0, askedAt + every - now);
}

function schedule(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  clearTimeout(e.timer);
  const wait = nextUsageAskIn(e.wants, e.askedAt, !!e.index?.syncing, Date.now());
  e.timer =
    wait === null
      ? undefined
      : setTimeout(() => {
          void load(key).then(() => schedule(key));
        }, wait);
}

// A host coming online is asked as soon as a subscriber polls, instead of a full cadence later.
let onlineSeen = new Set<string>();
let watching = false;
function watchOnline(): void {
  if (watching) return;
  watching = true;
  const onlineIn = (s: CoreState) => new Set(Object.keys(s.status).filter((id) => s.status[id]?.phase === "online"));
  onlineSeen = onlineIn(coreStore.getState());
  coreStore.subscribe((s) => {
    const online = onlineIn(s);
    for (const e of entries.values()) {
      if (!online.has(e.hostId) || onlineSeen.has(e.hostId)) continue;
      e.askedAt = undefined;
      schedule(keyOf(e.hostId, e.range));
    }
    onlineSeen = online;
  });
}

function entry(hostId: string, range: UsageRange): Entry {
  const key = keyOf(hostId, range);
  let e = entries.get(key);
  if (!e) {
    e = { hostId, range, wants: [], loading: false };
    entries.set(key, e);
  }
  return e;
}

function retain(hostId: string, range: UsageRange, everyMs: number | null): () => void {
  watchOnline();
  const e = entry(hostId, range);
  e.wants.push(everyMs);
  schedule(keyOf(hostId, range));
  return () => {
    e.wants.splice(e.wants.indexOf(everyMs), 1);
    schedule(keyOf(hostId, range));
  };
}

/** Asks the hosts again now and has each sync its index (unless it synced within 30 s). */
export function refreshUsage(hostIds: string[], range: UsageRange): Promise<void> {
  return Promise.allSettled(
    hostIds.map((id) => {
      entry(id, range);
      const key = keyOf(id, range);
      return load(key, true).then(() => schedule(key));
    }),
  ).then(() => undefined);
}

const EMPTY: HostUsage = { loading: false };
/** One cached snapshot per (range, hosts): a component reads several at once (the page's range and today). */
const snapCache = new Map<string, { version: number; value: Record<string, HostUsage> }>();

export function snapshot(hostIds: string[], range: UsageRange): Record<string, HostUsage> {
  const key = `${range}:${hostIds.join("|")}`;
  const cached = snapCache.get(key);
  if (cached && cached.version === version) return cached.value;
  const value: Record<string, HostUsage> = {};
  for (const id of hostIds) {
    const e = entries.get(keyOf(id, range));
    value[id] = e ? { insights: e.insights, index: e.index, live: e.live, receivedAt: e.receivedAt, error: e.error, loading: e.loading } : EMPTY;
  }
  snapCache.set(key, { version, value });
  return value;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * `host.usage` for each host and range (shared across components), asked again every `everyMs`
 * while mounted (`null` subscribes without polling, e.g. while the window is inactive). Answers
 * stay until a newer good one replaces them.
 */
export function useHostUsage(hostIds: string[], range: UsageRange, everyMs: number | null): Record<string, HostUsage> {
  const key = hostIds.join("|");
  useEffect(() => {
    const releases = key ? key.split("|").map((id) => retain(id, range, everyMs)) : [];
    return () => {
      for (const r of releases) r();
    };
  }, [key, range, everyMs]);
  return useSyncExternalStore(subscribe, () => snapshot(key ? key.split("|") : [], range));
}

// ───────────────────────────── persistence ─────────────────────────────

const STORE_KEY = "tf.usage";
/** Characters kept in localStorage at most (~5 MB per origin, shared with the app). */
const STORE_BUDGET = 1_500_000;

interface Stored {
  v: 1;
  entries: Record<string, Pick<HostUsage, "insights" | "index" | "live" | "receivedAt">>;
}

/** The entries to keep, largest first dropped until they fit (today's summaries go last). */
export function usageToStore(list: { key: string; usage: HostUsage }[], budget = STORE_BUDGET): Stored {
  const sized = list
    .filter((x) => x.usage.receivedAt !== undefined)
    .map((x) => {
      const value = { insights: x.usage.insights, index: x.usage.index, live: x.usage.live, receivedAt: x.usage.receivedAt };
      return { key: x.key, value, size: JSON.stringify(value).length, today: x.key.endsWith("|today") };
    })
    .sort((a, b) => Number(b.today) - Number(a.today) || a.size - b.size);
  const out: Stored = { v: 1, entries: {} };
  let used = 0;
  for (const s of sized) {
    if (used + s.size > budget) continue;
    used += s.size;
    out.entries[s.key] = s.value;
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
  if (typeof localStorage === "undefined") return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const stored = usageToStore([...entries.entries()].map(([key, usage]) => ({ key, usage })));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(stored));
    } catch {
      // Storage full or unavailable: the reports stay in memory for this run.
    }
  }, 2_000);
}

function restore(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Stored;
    if (stored.v !== 1) return;
    for (const [key, v] of Object.entries(stored.entries)) {
      const [hostId, range] = key.split("|") as [string, UsageRange];
      Object.assign(entry(hostId, range), v);
    }
  } catch {
    // A corrupt copy is ignored; the next answers replace it.
  }
}
restore();

// ───────────────────────────── today ─────────────────────────────

/** A host's inputs to today's figure. */
export interface TodayInput {
  hostId: string;
  /** Its `today` (or any range covering today) answer. */
  usage?: HostUsage;
  /** `HostState.usage`: the live ledger's host-local today (cached while offline). */
  ledger?: UsageTotals;
  online: boolean;
}

export interface TodaySpend {
  cost: number;
  tokens: number;
  input: number;
  output: number;
  requests: number;
  /** Requests without a price: a $0 then means unknown, not free. */
  unpriced: number;
  /** Spend per local hour of today (0–23). */
  byHour: number[];
  /** Of `cost`: what TeleFlock saw live since each host's last sync (not indexed yet). */
  live: number;
  /** Hosts without a report: their figure is the live ledger alone (host-local day, watched sessions only). */
  approx: string[];
  /** Hosts showing their last good report (offline, or the latest request failed). */
  stale: string[];
}

/**
 * Today (this device's day) across hosts: each host's indexed hours since local midnight, plus
 * what its live ledger saw after its last sync, plus the ledger's growth since that answer.
 */
export function todaySpend(hosts: TodayInput[], now: number, cal: Calendar = deviceCalendar): TodaySpend {
  const out: TodaySpend = { cost: 0, tokens: 0, input: 0, output: 0, requests: 0, unpriced: 0, byHour: new Array<number>(24).fill(0), live: 0, approx: [], stale: [] };
  const today = cal.day(now);
  const midnight = cal.startOfDay(now);
  for (const h of hosts) {
    const ins = h.usage?.insights;
    if (!ins || (ins.since ?? 0) > midnight) {
      // No report (yet): the ledger's own today.
      if (h.ledger && (h.ledger.costUsd > 0 || h.ledger.tokens > 0)) {
        out.cost += h.ledger.costUsd;
        out.tokens += h.ledger.tokens;
        out.input += h.ledger.input;
        out.output += h.ledger.output;
        out.byHour[cal.hour(now)] = (out.byHour[cal.hour(now)] ?? 0) + h.ledger.costUsd;
        out.approx.push(h.hostId);
      }
      continue;
    }
    const hrs = ins.hours;
    for (let i = 0; i < hrs.hour.length; i++) {
      const start = bucketStart(hrs.hour[i] ?? 0, ins.hourOffset);
      if (start < midnight || cal.day(start) !== today) continue;
      const cost = hrs.costUsd[i] ?? 0;
      out.cost += cost;
      out.tokens += hrs.tokens[i] ?? 0;
      out.input += hrs.input[i] ?? 0;
      out.output += hrs.output[i] ?? 0;
      out.requests += hrs.requests[i] ?? 0;
      out.unpriced += hrs.unpriced[i] ?? 0;
      const hr = cal.hour(start);
      out.byHour[hr] = (out.byHour[hr] ?? 0) + cost;
    }
    const fresh = h.online && !h.usage?.error && h.usage?.receivedAt !== undefined && h.usage.receivedAt >= midnight;
    if (!fresh) out.stale.push(h.hostId);
    const live = h.usage?.live;
    if (live && fresh) {
      // Spend after the last sync, and the ledger's growth since this answer (0 after the host's midnight reset).
      const growth = h.ledger ? Math.max(0, h.ledger.costUsd - live.ledgerToday.costUsd) : 0;
      const growthTokens = h.ledger ? Math.max(0, h.ledger.tokens - live.ledgerToday.tokens) : 0;
      const extra = live.costUsd + growth;
      out.cost += extra;
      out.live += extra;
      out.tokens += live.tokens + growthTokens;
      out.input += live.input + (h.ledger ? Math.max(0, h.ledger.input - live.ledgerToday.input) : 0);
      out.output += live.output + (h.ledger ? Math.max(0, h.ledger.output - live.ledgerToday.output) : 0);
      const hr = cal.hour(now);
      out.byHour[hr] = (out.byHour[hr] ?? 0) + extra;
    }
  }
  return out;
}

/** Whether a host's answer is a last-good one: offline, failing, or older than three cadences. */
export function usageIsStale(u: HostUsage | undefined, online: boolean, everyMs: number, now: number): boolean {
  if (!u?.receivedAt) return false;
  return !online || !!u.error || now - u.receivedAt > 3 * everyMs;
}

/**
 * Today's spend over `hostIds` (this device's day), shared by the board's Today tile and the Usage
 * page so both always show the same figure: `today` answers polled every `everyMs` (null: no
 * polling), each host's `HostState.usage` for the live part, `now` from the caller's clock.
 */
export function useTodaySpend(hostIds: string[], everyMs: number | null, now: number): TodaySpend {
  const usage = useHostUsage(hostIds, "today", everyMs);
  // One primitive per host (cost, tokens, input, output, online) so ledger ticks re-render only on change.
  const packed = useCore((s) =>
    hostIds
      .map((id) => {
        const u = s.hosts[id]?.state.usage;
        return u ? `${u.costUsd}:${u.tokens}:${u.input}:${u.output}:${s.status[id]?.phase === "online" ? 1 : 0}` : `::::${s.status[id]?.phase === "online" ? 1 : 0}`;
      })
      .join("|"),
  );
  const parts = packed ? packed.split("|") : [];
  const inputs: TodayInput[] = hostIds.map((hostId, i) => {
    const [cost = "", tokens = "", input = "", output = "", online = "0"] = (parts[i] ?? "").split(":");
    const ledger = cost === "" ? undefined : { costUsd: Number(cost), tokens: Number(tokens), input: Number(input), output: Number(output) };
    return { hostId, usage: usage[hostId], ledger, online: online === "1" };
  });
  return todaySpend(inputs, now);
}
