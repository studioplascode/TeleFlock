import { Channel, invoke } from "@tauri-apps/api/core";
import { toApiError } from "../errors";
import type { AppEvent } from "@/core/gen";
import type { CoreTransport } from "./types";

/** True inside the Tauri webview (desktop or Android). */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Tauri bridge (TauriShell): `core_call`, `core_term_input`, `core_events(channel)`.
 * One `core_events` subscription per page load; the shell replays current state to each new subscriber.
 */
export function createTauriTransport(): CoreTransport {
  const listeners = new Set<(e: AppEvent) => void>();
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    const channel = new Channel<AppEvent>();
    channel.onmessage = (e) => {
      for (const l of listeners) l(e);
    };
    invoke("core_events", { channel }).catch((err: unknown) => {
      started = false;
      console.error("[core] core_events failed", err);
    });
  };

  return {
    kind: "tauri",
    async call(hostId, method, params) {
      try {
        return await invoke("core_call", { hostId, method, params: params ?? {} });
      } catch (e) {
        throw toApiError(e);
      }
    },
    termInput(hostId, termId, data) {
      invoke("core_term_input", { hostId, termId, data }).catch((err: unknown) => {
        console.warn("[core] core_term_input failed", err);
      });
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      start();
      return () => listeners.delete(onEvent);
    },
  };
}
