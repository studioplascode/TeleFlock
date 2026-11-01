import { Channel, invoke } from "@tauri-apps/api/core";
import { toApiError } from "../errors";
import { failureReporter } from "../failures";
import type { AppEvent } from "@/core/gen";
import type { CoreTransport } from "./types";

const listenerFailed = failureReporter("core event listener (tauri)");

/** True inside the Tauri webview (desktop or Android). */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Tauri bridge (TauriShell): `core_call`, `core_term_input`, `core_events(channel)`.
 * One `core_events` subscription per page load; the shell replays current state to each new subscriber.
 * Events arrive in order as batches (one webview eval per batch, not per event). Each listener call
 * is isolated: one that throws is reported, and every other listener and later event of the batch
 * is still delivered.
 */
export function createTauriTransport(): CoreTransport {
  const listeners = new Set<(e: AppEvent) => void>();
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    const channel = new Channel<AppEvent[]>();
    channel.onmessage = (batch) => {
      for (const e of batch) {
        for (const l of listeners) {
          try {
            l(e);
          } catch (err) {
            listenerFailed(err);
          }
        }
      }
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
