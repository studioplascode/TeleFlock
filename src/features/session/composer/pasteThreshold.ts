import { useEffect } from "react";
import { create } from "zustand";
import { core, useHosts } from "@/core";
import { DEFAULT_PASTE_MENU_THRESHOLD, parseThreshold } from "@/core/pastes";

/*
 * omp's `paste.largeMenuThreshold` per host (`omp.settingValues`, hosts ≥ 0.7.0). Asked when a
 * composer for the host mounts and again at a large paste once the answer is older than
 * `MAX_AGE_MS`, so a change on the omp settings page applies within minutes. Older hosts, failures
 * and hosts not asked yet: omp's default (100 lines).
 */

export const PASTE_MENU_SETTING = "paste.largeMenuThreshold";
const MAX_AGE_MS = 2 * 60_000;

const useThresholds = create<{ byHost: Record<string, { value: number; at: number }> }>()(() => ({ byHost: {} }));
const asking = new Map<string, Promise<number>>();

/**
 * The host's threshold in lines (`0`: omp never asks): the known answer while it is fresh, else
 * the host's (one request per host at a time; any failure reads as omp's default).
 */
export function pasteThreshold(hostId: string): Promise<number> {
  const known = useThresholds.getState().byHost[hostId];
  if (known && Date.now() - known.at < MAX_AGE_MS) return Promise.resolve(known.value);
  const running = asking.get(hostId);
  if (running) return running;
  const ask = core
    .host(hostId)
    .call("omp.settingValues", { keys: [PASTE_MENU_SETTING] })
    .then(
      (r) => parseThreshold(r.values[PASTE_MENU_SETTING]),
      () => DEFAULT_PASTE_MENU_THRESHOLD,
    )
    .then((value) => {
      asking.delete(hostId);
      useThresholds.setState((s) => ({ byHost: { ...s.byHost, [hostId]: { value, at: Date.now() } } }));
      return value;
    });
  asking.set(hostId, ask);
  return ask;
}

/** Asks the host once it is online, so the first large paste needs no round trip. */
export function usePrefetchPasteThreshold(hostId: string | undefined): void {
  const online = useHosts((s) => (hostId ? s.status[hostId]?.phase === "online" : false));
  useEffect(() => {
    if (hostId && online) void pasteThreshold(hostId);
  }, [hostId, online]);
}
