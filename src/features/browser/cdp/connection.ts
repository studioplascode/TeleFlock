import type { CdpCommands, CdpEvents, CdpMethod, CdpEvent } from "./protocol";

/**
 * A Chrome DevTools Protocol client over one WebSocket to the browser target
 * (`ws://127.0.0.1:<cdpPort>/devtools/browser/<id>`). Page targets are reached through flat
 * sessions (`Target.attachToTarget {flatten: true}`): every command and event of a tab carries its
 * `sessionId` on the same socket.
 */

/** The part of `WebSocket` the client uses (tests pass a fake). */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** A failed command (`error` answer), a timeout, or the socket/session going away. */
export class CdpError extends Error {
  readonly code: number | "timeout" | "closed" | "detached";
  readonly method: string;
  constructor(method: string, code: CdpError["code"], message: string) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
    this.code = code;
    this.method = method;
  }
}

type Handler = (params: unknown, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  sessionId?: string;
  resolve: (v: unknown) => void;
  reject: (e: CdpError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Incoming {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
  sessionId?: string;
}

const OPEN = 1;
/** Commands answer in milliseconds; a page that hangs its renderer must not hang the panel. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private closedReason: string | null = null;

  private constructor(private readonly ws: SocketLike) {
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = (ev) => this.shutdown(ev.reason || `socket closed (${ev.code ?? "?"})`);
    ws.onerror = () => this.shutdown("socket error");
  }

  /** Opens the socket; rejects when it does not open within `timeoutMs` (a refused origin answers 403). */
  static open(url: string, opts: { timeoutMs?: number; socket?: SocketFactory } = {}): Promise<CdpConnection> {
    // WebSocket's handlers take DOM events; the client reads only `code`, `reason` and `data` of them.
    const make: SocketFactory = opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    return new Promise((resolve, reject) => {
      let ws: SocketLike;
      try {
        ws = make(url);
      } catch (e) {
        reject(new CdpError("connect", "closed", e instanceof Error ? e.message : String(e)));
        return;
      }
      const forget = () => {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
      };
      const timer = setTimeout(() => {
        forget();
        ws.close();
        reject(new CdpError("connect", "timeout", "the browser did not answer"));
      }, opts.timeoutMs ?? 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = ws.onclose = () => {
        clearTimeout(timer);
        forget();
        reject(new CdpError("connect", "closed", "could not connect to the browser"));
      };
    });
  }

  get closed(): boolean {
    return this.closedReason != null;
  }

  /** Sends a command (to the browser target, or to a tab's flat session) and resolves with its result. */
  send<M extends CdpMethod>(method: M, params: CdpCommands[M]["params"], sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpCommands[M]["result"]> {
    if (this.closedReason != null || this.ws.readyState !== OPEN) {
      return Promise.reject(new CdpError(method, "closed", this.closedReason ?? "not connected"));
    }
    const id = this.nextId++;
    const msg: { id: number; method: string; params: unknown; sessionId?: string } = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    return new Promise<CdpCommands[M]["result"]>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new CdpError(method, "timeout", `no answer in ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs)
          : undefined;
      // The browser answers with the command's result shape; the protocol table is the contract.
      const typed = resolve as (v: unknown) => void;
      this.pending.set(id, { method, sessionId, resolve: typed, reject, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.settle(id)?.reject(new CdpError(method, "closed", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Subscribes to an event of every session (the handler gets the session id; undefined = browser target). */
  on<E extends CdpEvent>(method: E, handler: (params: CdpEvents[E], sessionId: string | undefined) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    // Events of `method` carry `CdpEvents[E]`: the protocol table is the contract.
    const h = handler as Handler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this.closedReason != null) {
      handler(this.closedReason);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.closedReason != null) return;
    try {
      this.ws.close();
    } catch {
      // already closing
    }
    this.shutdown("closed");
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: Incoming;
    try {
      msg = JSON.parse(data) as Incoming;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.settle(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    // A tab that went away never answers what was sent to its session.
    if (msg.method === "Target.detachedFromTarget") {
      const gone = (msg.params as { sessionId?: string } | undefined)?.sessionId;
      if (gone) {
        for (const [id, p] of [...this.pending]) {
          if (p.sessionId === gone) this.settle(id)?.reject(new CdpError(p.method, "detached", "the tab closed"));
        }
      }
    }
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(msg.params ?? {}, msg.sessionId);
      } catch (e) {
        console.error(`[browser] ${msg.method} handler failed`, e);
      }
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason != null) return;
    this.closedReason = reason;
    this.ws.onopen = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    for (const id of [...this.pending.keys()]) {
      const p = this.settle(id);
      p?.reject(new CdpError(p.method, "closed", reason));
    }
    for (const h of [...this.closeHandlers]) {
      try {
        h(reason);
      } catch (e) {
        console.error("[browser] close handler failed", e);
      }
    }
    this.closeHandlers.clear();
    this.handlers.clear();
  }
}
