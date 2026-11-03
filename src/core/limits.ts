/**
 * Subscription / account limits (`host.limits`): pace projection math, a shared per-host poller
 * and hooks. Pure helpers (`projectWindow`, `tightestWindow`, `windowsForModel`, …) are exported
 * for tests and the demo host.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { AccountLimits, LimitAccount, LimitSample, LimitWindow } from "./gen";
import { core } from "./client";
import { toApiError } from "./errors";
import type { CoreState } from "./store/state";
import { coreStore } from "./store/store";

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
/** The pace compares the newest reading with the newest one at least this much older. */
export const PACE_SPAN_MS = 5 * MIN;
/** omp reports quota windows in whole percent: one step of the used fraction. */
const STEP = 0.01;
/** Rounding slack when comparing used fractions. */
const EPS = 1e-9;
/** A snapshot older than this is flagged stale (omp refreshes the windows about once a minute while agents work). */
export const STALE_MS = 15 * MIN;
/** Pace below this (fraction per hour, i.e. 0.01 %/h) counts as no consumption. */
const IDLE_RATE = 1e-4;

export type PaceOutcome =
  /** Already at (or past) 100 %. */
  | "exhausted"
  /** At the current pace the window fills before it resets. */
  | "runsOut"
  /** The window resets before the current pace would fill it. */
  | "resetsFirst"
  /** No consumption over the pace's basis. */
  | "idle"
  /** The reset time has passed since omp's last reading. */
  | "reset"
  /** Not enough readings yet (or no amount). */
  | "unknown";

export interface WindowPace {
  /** Used fraction at the last reading (0..1; >1 = overage). */
  used?: number;
  /** 1 − used, floored at 0. */
  remaining?: number;
  /** Fraction per hour over `basisMs`. */
  ratePerHour?: number;
  /** Span of the readings the pace was measured over. */
  basisMs: number;
  /** The pace looked further back than the last 5 minutes, or a level held since capped it ({@link paceFromSamples}). */
  widened?: boolean;
  /** Until the window resets (absent = provider gave no reset time). */
  resetsInMs?: number;
  outcome: PaceOutcome;
  /** `runsOut`: time until 100 % at the current pace. */
  etaMs?: number;
  /** `resetsFirst` / `idle`: projected used fraction when the window resets. */
  atReset?: number;
  /** The reading is older than {@link STALE_MS}. */
  stale: boolean;
}

/**
 * How far back the pace may look when the last 5 minutes moved less than two steps: a fifth of
 * the window, 30 min … 24 h.
 */
export function paceLookbackMs(durationMs: number | undefined): number {
  const d = durationMs ?? 24 * HOUR;
  return Math.min(24 * HOUR, Math.max(30 * MIN, d / 5));
}

/**
 * Pace from readings (oldest first): used fraction per hour and the span it was measured over.
 * Readings step by whole percent, so one step is ambiguous and a short span needs two:
 * 1. the newest reading against the newest one at least {@link PACE_SPAN_MS} older (or the
 *    nearest older one, however far back), when that moved two steps or more;
 * 2. else back to the most recent reading two steps below the newest, within `lookbackMs`; else
 *    the change over `lookbackMs` itself (none: idle);
 * 3. a level held for t ≥ 5 min caps the pace at one step per t, so a burst that stopped fades.
 * Drops (a reset slipped through) count as zero; no reading 5 min older yet gives no pace.
 */
export function paceFromSamples(samples: LimitSample[], lookbackMs: number): { ratePerHour?: number; basisMs: number; widened: boolean } {
  const last = samples[samples.length - 1];
  if (!last) return { basisMs: 0, widened: false };
  const at = (i: number) => (samples[i] as LimitSample).at;
  const used = (i: number) => (samples[i] as LimitSample).used;
  let i = samples.length - 2;
  while (i >= 0 && last.at - at(i) < PACE_SPAN_MS) i--;
  if (i < 0) return { basisMs: last.at - at(0), widened: false };
  let from = i;
  let widened = false;
  if (last.used - used(i) < 2 * STEP - EPS) {
    widened = true;
    const floor = last.at - lookbackMs;
    let j = i;
    while (j >= 0 && at(j) >= floor && used(j) > last.used - 2 * STEP + EPS) j--;
    if (j >= 0 && at(j) >= floor) from = j;
    else {
      // The look-back's own change, from its oldest reading (or from `i` when even that is older).
      while (from > 0 && at(from - 1) >= floor) from--;
    }
  }
  let basisMs = last.at - at(from);
  let ratePerHour = (Math.max(0, last.used - used(from)) / basisMs) * HOUR;
  let level = samples.length - 1;
  while (level > 0 && Math.abs(used(level - 1) - last.used) < STEP / 2) level--;
  const held = last.at - at(level);
  if (held >= PACE_SPAN_MS && ratePerHour > (STEP / held) * HOUR) {
    ratePerHour = (STEP / held) * HOUR;
    basisMs = held;
    widened = true;
  }
  return { ratePerHour, basisMs, widened };
}

/** Readings of a window, with the window's current value appended when it's newer. */
function readings(w: LimitWindow, fetchedAt: number | undefined): LimitSample[] {
  const s = [...w.samples].sort((a, b) => a.at - b.at);
  const last = s[s.length - 1];
  if (w.used != null && fetchedAt != null && (!last || fetchedAt > last.at)) s.push({ at: fetchedAt, used: w.used });
  return s;
}

/** Remaining quota, reset countdown and where the current pace lands relative to the reset. */
export function projectWindow(w: LimitWindow, fetchedAt: number | undefined, now: number): WindowPace {
  const stale = fetchedAt == null || now - fetchedAt > STALE_MS;
  const resetsInMs = w.resetsAt != null ? w.resetsAt - now : undefined;
  const used = w.used ?? undefined;
  if (used == null) return { basisMs: 0, resetsInMs, outcome: "unknown", stale };
  const remaining = Math.max(0, 1 - used);
  const base = { used, remaining, resetsInMs, stale };
  if (resetsInMs != null && resetsInMs <= 0) return { ...base, basisMs: 0, outcome: "reset" };
  if (used >= 1) return { ...base, basisMs: 0, outcome: "exhausted" };
  const { ratePerHour, basisMs, widened } = paceFromSamples(readings(w, fetchedAt), paceLookbackMs(w.durationMs));
  if (ratePerHour == null) return { ...base, basisMs, outcome: "unknown" };
  const pace = { ...base, ratePerHour, basisMs, widened };
  if (ratePerHour < IDLE_RATE) return { ...pace, outcome: "idle", atReset: resetsInMs != null ? used : undefined };
  // The reading is `now - fetchedAt` old: the pace has kept eating quota since.
  const since = fetchedAt != null ? Math.max(0, now - fetchedAt) : 0;
  const etaMs = Math.max(0, (remaining / ratePerHour) * HOUR - since);
  if (resetsInMs != null && etaMs >= resetsInMs) {
    return { ...pace, outcome: "resetsFirst", atReset: Math.min(1, used + (ratePerHour * (resetsInMs + since)) / HOUR) };
  }
  return { ...pace, outcome: "runsOut", etaMs };
}

/** Windows that meter a model: shared windows plus tier-scoped ones whose tier the model names. */
export function windowsForModel(account: LimitAccount, model: { id: string; label?: string } | undefined): LimitWindow[] {
  const name = `${model?.id ?? ""} ${model?.label ?? ""}`.toLowerCase();
  return account.windows.filter((w) => !w.tier || name.includes(w.tier.toLowerCase()));
}

const OUTCOME_RANK: Record<PaceOutcome, number> = { exhausted: 0, runsOut: 1, resetsFirst: 2, idle: 2, unknown: 2, reset: 3 };

/** The window that binds first: exhausted, then soonest run-out, then least remaining. */
export function tightestWindow(windows: LimitWindow[], fetchedAt: number | undefined, now: number): { window: LimitWindow; pace: WindowPace } | undefined {
  let best: { window: LimitWindow; pace: WindowPace } | undefined;
  for (const window of windows) {
    const pace = projectWindow(window, fetchedAt, now);
    if (pace.used == null) continue;
    if (!best) {
      best = { window, pace };
      continue;
    }
    const a = OUTCOME_RANK[pace.outcome];
    const b = OUTCOME_RANK[best.pace.outcome];
    const tighter =
      a !== b ? a < b : pace.outcome === "runsOut" ? (pace.etaMs ?? Infinity) < (best.pace.etaMs ?? Infinity) : (pace.remaining ?? 1) < (best.pace.remaining ?? 1);
    if (tighter) best = { window, pace };
  }
  return best;
}

/** "45m", "3h 20m", "2d 4h". */
export function formatSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "62%" with one decimal under 10 %. */
export function formatPct(fraction: number): string {
  const p = fraction * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

/**
 * What a pace speaks for, in words: "5 minutes" for the usual comparison (the newest reading
 * against one 5–10 min older), else its real basis: "18 minutes", "hour", "3 hours", "2 days".
 */
export function paceBasis(p: Pick<WindowPace, "basisMs" | "widened">): string {
  const ms = !p.widened && p.basisMs < 2 * PACE_SPAN_MS ? PACE_SPAN_MS : p.basisMs;
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return m === 1 ? "minute" : `${m} minutes`;
  const h = Math.round(ms / HOUR);
  if (h < 48) return h === 1 ? "hour" : `${h} hours`;
  const d = Math.round(ms / DAY);
  return d === 1 ? "day" : `${d} days`;
}

/**
 * One-line verdict of a pace: "At the last 5 minutes' pace you run out in ~40m (2h before it
 * resets)", "At the last 2 hours' pace it resets before you run out (~64% used at reset)", …
 */
export function describePace(p: WindowPace): string {
  const basis = paceBasis(p);
  const atPace = `At the last ${basis}${basis.endsWith("s") ? "'" : "'s"} pace`;
  switch (p.outcome) {
    case "exhausted":
      return p.resetsInMs != null ? `Limit reached · resets in ${formatSpan(p.resetsInMs)}` : "Limit reached";
    case "runsOut":
      return `${atPace} you run out in ~${formatSpan(p.etaMs ?? 0)}${p.resetsInMs != null ? ` (${formatSpan(p.resetsInMs - (p.etaMs ?? 0))} before it resets)` : ""}`;
    case "resetsFirst":
      return `${atPace} it resets before you run out (~${formatPct(p.atReset ?? 0)} used at reset)`;
    case "idle":
      return `No consumption in the last ${basis}${p.resetsInMs != null ? " · resets before you run out" : ""}`;
    case "reset":
      return "Window reset since the last reading";
    case "unknown":
      return p.used == null ? "No amount reported" : "Measuring pace…";
  }
}

// ───────────────────────────── poller ─────────────────────────────

/** The board and a session's inspector re-ask this often (every answer carries each account's readings). */
export const LIMITS_EVERY_MS = 5 * MIN;
/**
 * The Usage page, where the limits are the point, re-asks every minute: hostd answers with omp's
 * cached reports, which omp refreshes about once a minute while agents work.
 */
export const LIMITS_USAGE_EVERY_MS = MIN;

export interface HostLimits {
  data?: AccountLimits;
  error?: string;
  loading: boolean;
  /** When this client last received `data`. */
  receivedAt?: number;
}

type Entry = HostLimits & {
  /** Each subscriber's cadence; null subscribes without polling (e.g. while the window is inactive). */
  wants: (number | null)[];
  timer?: ReturnType<typeof setTimeout>;
  /** When the host was last asked (undefined: never, or it has just come online). */
  askedAt?: number;
};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * Delay until a host is asked again: the shortest cadence among its subscribers, counted from the
 * last ask (0 when overdue or never asked); null while no subscriber polls.
 */
export function nextAskIn(wants: readonly (number | null)[], askedAt: number | undefined, now: number): number | null {
  let every = Infinity;
  for (const w of wants) if (w !== null && w < every) every = w;
  if (every === Infinity) return null;
  return askedAt === undefined ? 0 : Math.max(0, askedAt + every - now);
}

async function load(hostId: string, refresh = false): Promise<void> {
  const e = entries.get(hostId);
  if (!e) return;
  e.askedAt = Date.now();
  if (coreStore.getState().status[hostId]?.phase !== "online") return;
  e.loading = true;
  emit();
  try {
    const data = await core.host(hostId).call("host.limits", refresh ? { refresh: true } : {});
    const cur = entries.get(hostId);
    if (cur) Object.assign(cur, { data, error: undefined, loading: false, receivedAt: Date.now() });
  } catch (err) {
    const cur = entries.get(hostId);
    if (cur) Object.assign(cur, { error: toApiError(err).message, loading: false });
  }
  emit();
}

function schedule(hostId: string): void {
  const e = entries.get(hostId);
  if (!e) return;
  clearTimeout(e.timer);
  const wait = nextAskIn(e.wants, e.askedAt, Date.now());
  e.timer =
    wait === null
      ? undefined
      : setTimeout(() => {
          void load(hostId);
          schedule(hostId);
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
    for (const id of online) {
      const e = entries.get(id);
      if (onlineSeen.has(id) || !e) continue;
      e.askedAt = undefined;
      schedule(id);
    }
    onlineSeen = online;
  });
}

function retain(hostId: string, everyMs: number | null): () => void {
  watchOnline();
  let e = entries.get(hostId);
  if (!e) {
    e = { wants: [], loading: false };
    entries.set(hostId, e);
  }
  e.wants.push(everyMs);
  schedule(hostId);
  return () => {
    const cur = entries.get(hostId);
    if (!cur) return;
    cur.wants.splice(cur.wants.indexOf(everyMs), 1);
    schedule(hostId);
  };
}

/** Asks the host again now (hostd re-runs `omp usage`, at most every 10 s). */
export function refreshLimits(hostId: string): Promise<void> {
  const done = load(hostId, true);
  schedule(hostId);
  return done;
}

const EMPTY: HostLimits = { loading: false };
let snapCache: { version: number; key: string; value: Record<string, HostLimits> } | undefined;

function snapshot(hostIds: string[]): Record<string, HostLimits> {
  const key = hostIds.join("|");
  if (snapCache && snapCache.version === version && snapCache.key === key) return snapCache.value;
  const value: Record<string, HostLimits> = {};
  for (const id of hostIds) {
    const e = entries.get(id);
    value[id] = e ? { data: e.data, error: e.error, loading: e.loading, receivedAt: e.receivedAt } : EMPTY;
  }
  snapCache = { version, key, value };
  return value;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * `host.limits` for each host (shared across components), asked again every `everyMs` while mounted:
 * the shortest cadence among the subscribers of a host wins, and `null` subscribes without polling
 * (pass it while the window is inactive). A host whose last answer is older than a subscriber's
 * cadence is asked as soon as that subscriber polls; a remount within the cadence reuses the answer.
 */
export function useAccountLimits(hostIds: string[], everyMs: number | null): Record<string, HostLimits> {
  const key = hostIds.join("|");
  useEffect(() => {
    const releases = key ? key.split("|").map((id) => retain(id, everyMs)) : [];
    return () => {
      for (const r of releases) r();
    };
  }, [key, everyMs]);
  // Different `hostIds` arrays with the same ids share one cached snapshot.
  return useSyncExternalStore(subscribe, () => snapshot(key ? key.split("|") : []));
}

export interface SessionLimits {
  account: LimitAccount;
  windows: LimitWindow[];
  /** omp pinned the session to this account (vs. the provider's only account). */
  pinned: boolean;
  fetchedAt?: number;
  stale: boolean;
}

/** The account (and its windows for this model) an omp session draws from, if omp reports limits for it. */
export function sessionLimits(
  data: AccountLimits | undefined,
  sessionId: string | undefined,
  model: { provider: string; id: string; label?: string } | undefined,
  now: number,
): SessionLimits | undefined {
  if (!data || !model) return undefined;
  const pin = sessionId ? data.sessions.find((s) => s.sessionId === sessionId) : undefined;
  const ofProvider = data.accounts.filter((a) => a.provider === model.provider && a.windows.length > 0);
  const account = pin?.accountKey ? data.accounts.find((a) => a.key === pin.accountKey) : ofProvider.length === 1 ? ofProvider[0] : undefined;
  if (!account || account.windows.length === 0) return undefined;
  const fetchedAt = account.fetchedAt ?? undefined;
  return {
    account,
    windows: windowsForModel(account, model),
    pinned: !!pin?.accountKey,
    fetchedAt,
    stale: fetchedAt == null || now - fetchedAt > STALE_MS,
  };
}
