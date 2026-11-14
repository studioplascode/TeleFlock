/**
 * Each agent's share of its host (`HostHealth.agents`, hosts ≥ 0.9.5): its process and everything
 * it started, CPU on the host's scale (100 % = every core busy), resident memory summed over those
 * processes. One sample per host health tick (5 s); agents without a running process are absent.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { onAppEvent, parseAgentKey, useCore, useHostStale } from "@/core";
import type { AgentLoad, HostHealth } from "@/core/gen";
import { formatBytes } from "@/core/upload";

/** CPU history kept per agent: 3 minutes of 5 s samples. */
const KEEP = 36;
/** A card shows an agent's load from a quarter of the host's CPU, if that is at least a core… */
export const NOTABLE_CPU_PCT = 25;
export const NOTABLE_CORES = 1;
/** …or from 2 GB of memory (a quarter of a host with less than 8 GB). */
export const NOTABLE_MEM = 2 * 1024 ** 3;
export const NOTABLE_MEM_SHARE = 0.25;
/** Once shown, until the load falls below this fraction of those thresholds: no flicker at the edge. */
export const NOTABLE_KEEP = 0.7;

type HostScale = Pick<HostHealth, "cores" | "memTotal">;

/** Cores busy at `cpuPct` of a host with `cores` cores. */
export function coresUsed(cpuPct: number, cores: number): number {
  return (cpuPct / 100) * Math.max(1, cores);
}

/** How far over the card thresholds the load is (≥ 1: over), per resource. */
export function loadLevel(load: AgentLoad, host: HostScale): { cpu: number; mem: number } {
  const cpu = Math.min(load.cpuPct / NOTABLE_CPU_PCT, coresUsed(load.cpuPct, host.cores) / NOTABLE_CORES);
  const memLimit = host.memTotal > 0 ? Math.min(NOTABLE_MEM, host.memTotal * NOTABLE_MEM_SHARE) : NOTABLE_MEM;
  return { cpu, mem: load.mem / memLimit };
}

interface AgentSeries {
  /** CPU % of the host, oldest first. */
  cpu: number[];
  notable: boolean;
}

export interface HostSeries {
  at: number;
  agents: Record<string, AgentSeries>;
}

/** `prev` with the health sample `h` added: CPU history and card notability per agent. Agents absent from `h` drop out. */
export function nextSeries(prev: HostSeries | undefined, h: HostHealth): HostSeries {
  const agents: Record<string, AgentSeries> = {};
  for (const a of h.agents ?? []) {
    const before = prev?.agents[a.agentId];
    const level = loadLevel(a, h);
    agents[a.agentId] = { cpu: [...(before?.cpu ?? []), a.cpuPct].slice(-KEEP), notable: Math.max(level.cpu, level.mem) >= (before?.notable ? NOTABLE_KEEP : 1) };
  }
  return { at: h.at, agents };
}

const useSeries = create<{ byHost: Record<string, HostSeries> }>()(() => ({ byHost: {} }));

function record(hostId: string, h: HostHealth): void {
  const prev = useSeries.getState().byHost[hostId];
  if (prev && prev.at >= h.at) return;
  useSeries.setState((s) => ({ byHost: { ...s.byHost, [hostId]: nextSeries(prev, h) } }));
}

let recording = false;

/** Records every host's health samples from the first agent-load view on (idempotent): cards learn they are notable without each following the host's health. */
function startRecording(): void {
  if (recording) return;
  recording = true;
  onAppEvent((e) => {
    if (e.type === "hostSnapshot" && e.state.health) record(e.hostId, e.state.health);
    else if (e.type === "hostPatch") for (const op of e.ops) if (op.op === "health") record(e.hostId, op.health);
  });
}

const EMPTY: number[] = [];

export interface AgentLoadView {
  /** The latest sample; absent while the agent runs no process, the host is offline, or its daemon is older than 0.9.5. */
  load?: AgentLoad;
  health?: HostHealth;
  /** CPU % of the host over the last minutes, oldest first. */
  cpu: readonly number[];
}

/** One agent's share of its host, as of the host's latest health tick. */
export function useAgentLoad(agentKey: string): AgentLoadView {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const health = useCore((s) => s.hosts[hostId]?.state.health);
  const stale = useHostStale(hostId);
  useEffect(() => {
    startRecording();
    if (health && !stale) record(hostId, health);
  }, [hostId, health, stale]);
  const series = useSeries((s) => s.byHost[hostId]?.agents[agentId]?.cpu);
  if (!health || stale) return { cpu: EMPTY };
  return { load: health.agents?.find((a) => a.agentId === agentId), health, cpu: series ?? EMPTY };
}

/** The agent's load is worth a chip on its card (thresholds above, with hysteresis). Re-renders only when that flips. */
export function useNotableLoad(agentKey: string): boolean {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const stale = useHostStale(hostId);
  useEffect(startRecording, []);
  const notable = useSeries((s) => s.byHost[hostId]?.agents[agentId]?.notable === true);
  return notable && !stale;
}

/** "38%" of the host; "<1%" for a trace. */
export function formatShare(pct: number): string {
  return pct > 0 && pct < 0.5 ? "<1%" : `${Math.round(pct)}%`;
}

/** "0.4", "6.1", "12" cores. */
export function formatCores(cores: number): string {
  return cores >= 10 ? String(Math.round(cores)) : cores.toFixed(1);
}

/** "38% of forge's CPU (6.1 of 16 cores) and 2.4 GB of memory (4% of 64 GB), in 12 processes". */
export function describeLoad(load: AgentLoad, host: HostScale, hostName: string): string {
  const cores = coresUsed(load.cpuPct, host.cores);
  const memShare = host.memTotal > 0 ? ` (${formatShare((load.mem / host.memTotal) * 100)} of ${formatBytes(host.memTotal)})` : "";
  return `${formatShare(load.cpuPct)} of ${hostName}'s CPU (${formatCores(cores)} of ${host.cores} cores) and ${formatBytes(load.mem)} of memory${memShare}, in ${load.procs} process${load.procs === 1 ? "" : "es"}`;
}
