import type { AppEvent } from "@/core/gen";

export type Backend = "tauri" | "ws" | "demo";

/** Architecture §6.1: the one interface every backend implements. */
export interface CoreTransport {
  readonly kind: Backend;
  /** `hostId: null` for app methods. Rejects with `CoreError`. */
  call(hostId: string | null, method: string, params: unknown): Promise<unknown>;
  /** Terminal keyboard fast path (no response). */
  termInput(hostId: string, termId: string, data: string): void;
  /** Subscribe to the event stream. */
  subscribe(onEvent: (e: AppEvent) => void): () => void;
  /** Connection lifecycle of the transport itself (ws reconnects). Optional. */
  onLink?(cb: (up: boolean) => void): () => void;
  close?(): void;
}
