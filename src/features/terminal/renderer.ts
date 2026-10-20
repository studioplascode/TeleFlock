import { useSyncExternalStore } from "react";

/**
 * Terminal renderer preference (per device): the WebGL renderer by default, or xterm's DOM renderer
 * as an escape hatch for GPUs/drivers where WebGL draws nothing or glitches.
 */
export type TermRenderer = "webgl" | "dom";

const KEY = "tf.terminal.renderer";
const listeners = new Set<() => void>();

function load(): TermRenderer {
  try {
    return globalThis.localStorage?.getItem(KEY) === "dom" ? "dom" : "webgl";
  } catch {
    return "webgl";
  }
}

let current: TermRenderer = load();

export function setTermRenderer(r: TermRenderer): void {
  current = r;
  try {
    globalThis.localStorage?.setItem(KEY, r);
  } catch {
    // storage unavailable: applies for this session only
  }
  for (const l of listeners) l();
}

export function useTermRenderer(): TermRenderer {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => "webgl",
  );
}
