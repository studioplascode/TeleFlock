import type { AccountLimits, HostHealth } from "./gen";
import { formatPct, tightestWindow, windowsForModel } from "./limits";

/*
 * Host workload for Dispatch's Auto mode: how busy a host is right now, from its last health
 * sample (CPU, load average, memory), its agents (running, waiting on the user), the dispatches
 * already on their way to it, and how much of the chosen model's subscription quota it has left
 * (`host.limits`: each host has its own accounts). Lower is better. Offline hosts are never picked.
 */

/** The window of a provider's subscription that binds first on a host (omp's `UsageLimit`). */
export interface QuotaReading {
  /** omp's window label, e.g. "Claude 5 Hour". */
  label: string;
  /** Used fraction at the last reading (0..1; above 1 = overage). */
  used: number;
  /** At or past its limit: a task sent there waits for the reset. */
  exhausted: boolean;
}

export interface WorkloadInput {
  hostId: string;
  /** Connection is live (a cached snapshot of an offline host does not count). */
  online: boolean;
  health?: HostHealth;
  /** Agents working a turn. */
  running: number;
  /** Agents waiting on the user (they resume work once answered). */
  needs: number;
  /** Dispatches naming / queued / creating / just started on this host, not yet a running agent. */
  pending: number;
  /**
   * The chosen model's provider on this host: its binding quota window; null when the host reports
   * no metered window for it (API key, no subscription), undefined when that isn't known (limits not
   * read yet, model unknown). Both count as half used.
   */
  quota?: QuotaReading | null;
}

export interface HostLoad {
  hostId: string;
  available: boolean;
  /** Lower = less busy; only comparable between available hosts. */
  score: number;
  running: number;
  needs: number;
  pending: number;
  /** CPU pressure 0–1+: the larger of CPU% and load average per core; undefined without health. */
  cpu?: number;
  /** Memory used 0–1; undefined without health. */
  mem?: number;
  /** The quota window the score counted (absent: not known, or none). */
  quota?: QuotaReading;
  /** What the quota added to `score`. */
  quotaScore: number;
}

/** A running agent or a dispatch about to become one. */
const AGENT_WEIGHT = 1;
/** An agent waiting on the user: idle now, busy again once answered. */
const NEEDS_WEIGHT = 0.3;
/** A fully busy CPU weighs like this many running agents. */
const CPU_WEIGHT = 2;
/** Memory use above this share is penalised steeply (swapping and OOM kills hurt every agent). */
const MEM_SOFT_LIMIT = 0.85;
const MEM_WEIGHT = 20;
/** Pressure assumed for a host that has not reported health yet. */
const UNKNOWN_CPU = 0.5;
/** A used-up quota window weighs like this many running agents: 70 % left vs 15 % left ≈ 1.6 agents. */
const QUOTA_WEIGHT = 3;
/** Used share assumed where the window isn't known, or the provider has none here. */
const UNKNOWN_QUOTA = 0.5;
/** An exhausted window: its task would stall until the reset, so any host with room goes first. */
const QUOTA_EXHAUSTED = 50;

export function hostLoad(i: WorkloadInput): HostLoad {
  const h = i.health;
  const cpu = h ? Math.max(h.cpuPct / 100, h.cores > 0 ? h.load1 / h.cores : 0) : undefined;
  const mem = h && h.memTotal > 0 ? h.memUsed / h.memTotal : undefined;
  const q = i.quota ?? undefined;
  const quotaScore = (q ? Math.min(Math.max(q.used, 0), 1) : UNKNOWN_QUOTA) * QUOTA_WEIGHT + (q?.exhausted ? QUOTA_EXHAUSTED : 0);
  const score =
    (i.running + i.pending) * AGENT_WEIGHT +
    i.needs * NEEDS_WEIGHT +
    (cpu ?? UNKNOWN_CPU) * CPU_WEIGHT +
    (mem !== undefined && mem > MEM_SOFT_LIMIT ? (mem - MEM_SOFT_LIMIT) * MEM_WEIGHT : 0) +
    quotaScore;
  return { hostId: i.hostId, available: i.online, score, running: i.running, needs: i.needs, pending: i.pending, cpu, mem, quota: q, quotaScore };
}

/**
 * The binding window of `model`'s provider in one host's `host.limits` (shared windows plus the
 * model's tier): per account its tightest window (exhausted, then soonest run-out, then least left;
 * a window whose reset has passed counts as fresh), then the account with the most room, since omp
 * routes new sessions away from spent accounts. null: no metered window for the provider (or only
 * disabled logins); undefined: the host's limits aren't known.
 */
export function providerQuota(data: AccountLimits | undefined, model: { provider: string; id: string; label?: string }, now: number): QuotaReading | null | undefined {
  if (!data) return undefined;
  let best: QuotaReading | null = null;
  for (const account of data.accounts) {
    if (account.provider !== model.provider || account.disabled) continue;
    const tight = tightestWindow(windowsForModel(account, model), account.fetchedAt ?? undefined, now);
    if (!tight || tight.pace.used == null) continue;
    const reset = tight.pace.outcome === "reset";
    const reading = { label: tight.window.label, used: reset ? 0 : tight.pace.used, exhausted: tight.pace.outcome === "exhausted" };
    if (!best || (best.exhausted && !reading.exhausted) || (best.exhausted === reading.exhausted && reading.used < best.used)) best = reading;
  }
  return best;
}

/**
 * Hosts from least to most busy, unavailable ones last. Ties (scores within 0.05) go to the
 * host with fewer agents on the way, then lower CPU, then the given order (profile order).
 */
export function rankHosts(loads: readonly HostLoad[]): HostLoad[] {
  return loads
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) =>
        Number(b.l.available) - Number(a.l.available) ||
        (Math.abs(a.l.score - b.l.score) > 0.05 ? a.l.score - b.l.score : 0) ||
        a.l.running + a.l.pending - (b.l.running + b.l.pending) ||
        (a.l.cpu ?? UNKNOWN_CPU) - (b.l.cpu ?? UNKNOWN_CPU) ||
        a.i - b.i,
    )
    .map((x) => x.l);
}

/** The least busy available host, or null when none is online. */
export function pickHost(loads: readonly HostLoad[]): HostLoad | null {
  const best = rankHosts(loads)[0];
  return best?.available ? best : null;
}

/** "2 running · 1 starting · CPU 34% · mem 61% · Claude 5 Hour 70% left" (what the pick was based on). */
export function describeLoad(l: HostLoad): string {
  const parts: string[] = [];
  parts.push(l.running ? `${l.running} running` : "idle");
  if (l.pending) parts.push(`${l.pending} starting`);
  if (l.needs) parts.push(`${l.needs} need you`);
  if (l.cpu !== undefined) parts.push(`CPU ${Math.round(Math.min(l.cpu, 9.99) * 100)}%`);
  if (l.mem !== undefined) parts.push(`mem ${Math.round(l.mem * 100)}%`);
  if (l.quota) parts.push(`${l.quota.label} ${l.quota.exhausted ? "used up" : `${formatPct(Math.max(0, 1 - l.quota.used))} left`}`);
  return parts.join(" · ");
}

/**
 * Why Auto sent a task to `pick` (`ranked`: every candidate host, best first), as the card shows it:
 * "least busy of 2: idle · CPU 12% · Claude 5 Hour 70% left (studio-pc: 1 running · …)", led by
 * "most Claude 5 Hour left" instead when the quota changed the pick.
 */
export function explainPick(pick: HostLoad, ranked: readonly HostLoad[], nameOf: (hostId: string) => string): string {
  const others = ranked.filter((l) => l !== pick && l.available).map((l) => `${nameOf(l.hostId)}: ${describeLoad(l)}`);
  const byLoad = pickHost(ranked.map((l) => ({ ...l, score: l.score - l.quotaScore })));
  const lead = pick.quota && byLoad && byLoad.hostId !== pick.hostId ? `most ${pick.quota.label} left` : "least busy";
  return `${lead} of ${ranked.length}: ${describeLoad(pick)}${others.length ? ` (${others.join("; ")})` : ""}`;
}
