import { apiError, toApiError } from "../errors";
import type { ApiError, AppEvent } from "@/core/gen";
import type { CoreTransport } from "./types";

/** Devserver frames (architecture §5.3). */
type ServerFrame = { id: number; result?: unknown; error?: ApiError | null } | { event: AppEvent };

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> };

export interface WsTransportOptions {
  url: string;
  /** Per-request timeout (ms). Default 35 s (the core itself times out host calls at 30 s). */
  timeoutMs?: number;
  /** Called once if the very first connection attempt fails (used for the demo fallback). */
  onFirstFailure?: () => void;
}

const TERM_OPEN_TIMEOUT = 20_000;

/**
 * WebSocket transport to `tf-devserver` `/ws`. Reconnects with backoff (0.5 s → 8 s); requests
 * issued while disconnected wait for the next connection, and in-flight requests reject with
 * `not_connected` (retryable) when the socket drops.
 */
export function createWsTransport(opts: WsTransportOptions): CoreTransport {
  const listeners = new Set<(e: AppEvent) => void>();
  const linkListeners = new Set<(up: boolean) => void>();
  const pending = new Map<number, Pending>();
  const outbox: string[] = [];
  let ws: WebSocket | null = null;
  let nextId = 1;
  let attempt = 0;
  let everOpened = false;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (frame: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
    else outbox.push(frame);
  };

  const connect = () => {
    if (closed) return;
    const sock = new WebSocket(opts.url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      everOpened = true;
      for (const f of outbox.splice(0)) sock.send(f);
      for (const l of linkListeners) l(true);
    };
    sock.onmessage = (msg) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(typeof msg.data === "string" ? msg.data : "") as ServerFrame;
      } catch {
        console.warn("[core/ws] bad frame", msg.data);
        return;
      }
      if ("event" in frame) {
        for (const l of listeners) l(frame.event);
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) p.reject(toApiError(frame.error));
      else p.resolve(frame.result ?? {});
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      // Requests already sent can't be answered by a new connection.
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(apiError("not_connected", "Lost connection to the TeleFlock devserver", { retryable: true }));
        pending.delete(id);
      }
      for (const l of linkListeners) l(false);
      if (!everOpened && attempt === 0) opts.onFirstFailure?.();
      if (closed) return;
      const delay = Math.min(8000, 500 * 2 ** attempt) * (0.85 + Math.random() * 0.3);
      attempt++;
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    kind: "ws",
    call(hostId, method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = method === "term.open" ? TERM_OPEN_TIMEOUT : (opts.timeoutMs ?? 35_000);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(apiError("timeout", `${method} timed out`, { retryable: true }));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        const frame: Record<string, unknown> = { id, method, params: params ?? {} };
        if (hostId !== null) frame.hostId = hostId;
        send(JSON.stringify(frame));
      });
    },
    termInput(hostId, termId, data) {
      send(JSON.stringify({ termIn: { hostId, termId, data } }));
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    onLink(cb) {
      linkListeners.add(cb);
      return () => linkListeners.delete(cb);
    },
    close() {
      closed = true;
      clearTimeout(retryTimer ?? undefined);
      ws?.close();
    },
  };
}
