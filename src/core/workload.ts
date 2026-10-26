import type { HostHealth } from "./gen";

/*
 * Host workload for Dispatch's Auto mode: how busy a host is right now, from its last health
 * sample (CPU, load average, memory), its agents (running, waiting on the user) and the
 * dispatches already on their way to it. Lower is less busy. Offline hosts are never picked.
 */

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

export function hostLoad(i: WorkloadInput): HostLoad {
  const h = i.health;
  const cpu = h ? Math.max(h.cpuPct / 100, h.cores > 0 ? h.load1 / h.cores : 0) : undefined;
  const mem = h && h.memTotal > 0 ? h.memUsed / h.memTotal : undefined;
  const score =
    (i.running + i.pending) * AGENT_WEIGHT +
    i.needs * NEEDS_WEIGHT +
    (cpu ?? UNKNOWN_CPU) * CPU_WEIGHT +
    (mem !== undefined && mem > MEM_SOFT_LIMIT ? (mem - MEM_SOFT_LIMIT) * MEM_WEIGHT : 0);
  return { hostId: i.hostId, available: i.online, score, running: i.running, needs: i.needs, pending: i.pending, cpu, mem };
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

/** "2 running · 1 starting · CPU 34% · mem 61%" (what the pick was based on). */
export function describeLoad(l: HostLoad): string {
  const parts: string[] = [];
  parts.push(l.running ? `${l.running} running` : "idle");
  if (l.pending) parts.push(`${l.pending} starting`);
  if (l.needs) parts.push(`${l.needs} need you`);
  if (l.cpu !== undefined) parts.push(`CPU ${Math.round(Math.min(l.cpu, 9.99) * 100)}%`);
  if (l.mem !== undefined) parts.push(`mem ${Math.round(l.mem * 100)}%`);
  return parts.join(" · ");
}
