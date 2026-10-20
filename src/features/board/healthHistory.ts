import { useEffect } from "react";
import { create } from "zustand";
import type { HostHealth } from "@/core/gen";

export interface HealthSample {
  at: number;
  cpuPct: number;
  memPct: number;
}

const MAX_SAMPLES = 48;

interface HealthHistoryState {
  byHost: Record<string, HealthSample[]>;
  push(hostId: string, h: HostHealth): void;
}

/** CPU/RAM samples per host, accumulated from health patches for the sparklines. */
export const useHealthHistory = create<HealthHistoryState>()((set) => ({
  byHost: {},
  push: (hostId, h) =>
    set((s) => {
      const prev = s.byHost[hostId] ?? [];
      if (prev.length > 0 && prev[prev.length - 1]?.at === h.at) return s;
      const sample = { at: h.at, cpuPct: h.cpuPct, memPct: h.memTotal > 0 ? (h.memUsed / h.memTotal) * 100 : 0 };
      const next = prev.length >= MAX_SAMPLES ? [...prev.slice(prev.length - MAX_SAMPLES + 1), sample] : [...prev, sample];
      return { byHost: { ...s.byHost, [hostId]: next } };
    }),
}));

/** Record every new health reading for `hostId` while mounted. */
export function useRecordHealth(hostId: string | undefined, health: HostHealth | undefined): void {
  const push = useHealthHistory((s) => s.push);
  useEffect(() => {
    if (hostId && health) push(hostId, health);
  }, [hostId, health, push]);
}
