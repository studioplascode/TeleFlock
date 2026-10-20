import { useEffect } from "react";
import { create } from "zustand";
import { useHostState } from "@/core";
import type { HostHealth } from "@/core/gen";

const KEEP = 30;

interface Series {
  at: number;
  cpu: number[];
  mem: number[];
}

interface HealthHistory {
  byHost: Record<string, Series>;
}

const useHistory = create<HealthHistory>()(() => ({ byHost: {} }));

function record(hostId: string, h: HostHealth): void {
  const prev = useHistory.getState().byHost[hostId];
  if (prev && prev.at === h.at) return;
  const mem = h.memTotal > 0 ? (h.memUsed / h.memTotal) * 100 : 0;
  const next: Series = {
    at: h.at,
    cpu: [...(prev?.cpu ?? []), h.cpuPct].slice(-KEEP),
    mem: [...(prev?.mem ?? []), mem].slice(-KEEP),
  };
  useHistory.setState((s) => ({ byHost: { ...s.byHost, [hostId]: next } }));
}

export interface HealthView {
  health: HostHealth | undefined;
  /** Recent CPU % samples, oldest first. */
  cpu: number[];
  /** Recent memory-used % samples, oldest first. */
  mem: number[];
}

const EMPTY: number[] = [];

/** A host's latest health plus a short rolling history for sparklines. */
export function useHealthHistory(hostId: string): HealthView {
  const health = useHostState(hostId)?.health;
  useEffect(() => {
    if (health) record(hostId, health);
  }, [hostId, health]);
  const series = useHistory((s) => s.byHost[hostId]);
  return { health, cpu: series?.cpu ?? EMPTY, mem: series?.mem ?? EMPTY };
}
