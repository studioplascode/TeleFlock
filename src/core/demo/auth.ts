/**
 * Demo `auth.*`: scripted sign-in flows (account links, MCP server OAuth) with the states a real
 * host produces (tf-hostd `authflow.rs`): starting → waiting (URL / device code / paste / question)
 * → done | failed | cancelled | expired, long-polled through `auth.wait`.
 *
 * - browser: finishes ~2.5 s after the app opened its URL while a same-port tunnel to the callback
 *   port is open (the redirect reaches the "host"); without one the browser "lands on an error page"
 *   and the flow waits for the pasted address. Like omp's callback server, it gives up after 5 min
 *   (`expiresAt` counts that down, as a real host's does).
 * - device: finishes ~5 s after the app opened the device page.
 * - paste / prompt: finish on a submission the script's `check` accepts.
 */
import type { AuthFlow, AuthFlowState, AuthPrompt } from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

export interface DemoAuthScript {
  kind: "account" | "mcp";
  title: string;
  subject?: string;
  method: "browser" | "device" | "paste" | "prompt";
  /**
   * The page the user opens. Browser flows: an authorization URL with
   * `redirect_uri=http://localhost:<port>/…`; key prompts may have none.
   */
  url?: string;
  userCode?: string;
  instructions?: string;
  prompt?: AuthPrompt;
  /** Refuses a pasted code / answer by returning the reason. */
  check?(text: string): string | undefined;
  /** Who signed in, once done. */
  account?: string;
  onDone?(flow: AuthFlow): void;
}

interface Entry {
  flow: AuthFlow;
  script: DemoAuthScript;
  waiters: Set<() => void>;
  cancelTimers: (() => void)[];
  finishedAt?: number;
}

const START_MS = 600;
const BROWSER_MS = 2500;
const DEVICE_MS = 5000;
const TTL_MS = 10 * 60_000;
/** omp's loopback callback server waits this long (`omp login`, MCP sign-ins), then the sign-in fails. */
const CALLBACK_WAIT_MS = 5 * 60_000;
const KEEP_MS = 10 * 60_000;
const MAX_WAIT_MS = 20_000;

/** The callback port of a loopback `redirect_uri` in `url`, if any. */
export function redirectPort(url: string): number | undefined {
  try {
    const r = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    const loopback = r.hostname === "localhost" || r.hostname === "127.0.0.1" || r.hostname === "[::1]";
    const port = Number(r.port);
    return r.protocol === "http:" && loopback && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export class DemoAuthFlows {
  private readonly flows = new Map<string, Entry>();
  private seq = 0;

  constructor(
    private readonly clock: DemoClock,
    /** Is a same-port tunnel to this callback port open on the "device"? */
    private readonly tunnelOpen: (port: number) => boolean,
  ) {}

  /** Registers a scripted flow (`starting`; `waiting` a moment later). */
  start(script: DemoAuthScript): AuthFlow {
    this.sweep();
    const now = this.clock.now();
    const flowId = `auth_demo_${++this.seq}`;
    const flow: AuthFlow = { flowId, kind: script.kind, title: script.title, subject: script.subject, state: "starting", rev: 1, paste: "none", message: "Starting omp…", startedAt: now, expiresAt: now + TTL_MS, updatedAt: now };
    const e: Entry = { flow, script, waiters: new Set(), cancelTimers: [] };
    this.flows.set(flowId, e);
    e.cancelTimers.push(this.clock.after(START_MS, () => this.publish(e)));
    e.cancelTimers.push(this.clock.after(TTL_MS, () => this.end(e, "expired", "The sign-in took too long and was stopped. Start it again.")));
    return { ...flow };
  }

  /** A flow's URL that the app opens (routes `app.openExternal` here). */
  ownsUrl(url: string): boolean {
    for (const e of this.flows.values()) if (e.flow.url === url && !final(e.flow.state)) return true;
    return false;
  }

  /** The app opened `url` in the device's browser. */
  opened(url: string): boolean {
    const e = [...this.flows.values()].find((x) => x.flow.url === url && x.flow.state === "waiting");
    if (!e) return false;
    const { method } = e.script;
    if (method === "device") {
      e.cancelTimers.push(this.clock.after(DEVICE_MS, () => this.done(e)));
    } else if (method === "browser") {
      const port = e.flow.callbackPort;
      e.cancelTimers.push(
        this.clock.after(BROWSER_MS, () => {
          if (port != null && this.tunnelOpen(port)) this.done(e);
          // No tunnel: the redirect hits nothing on the device; the user pastes the address.
          else this.change(e, (f) => (f.message = "The browser couldn't reach localhost. Paste the address it shows."));
        }),
      );
    }
    return true;
  }

  /** Running flows and those finished in the last minutes, newest first. */
  list(): AuthFlow[] {
    this.sweep();
    return [...this.flows.values()].map((e) => ({ ...e.flow })).sort((a, b) => b.startedAt - a.startedAt);
  }

  call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "auth.list":
        return { flows: this.list() };
      case "auth.wait":
        return this.wait(p);
      case "auth.submit":
        return this.submit(p);
      case "auth.cancel": {
        const e = this.entry(p.flowId);
        this.end(e, "cancelled", "Cancelled.");
        return {};
      }
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private entry(id: unknown): Entry {
    const e = typeof id === "string" ? this.flows.get(id) : undefined;
    if (!e) throw apiError("auth_flow_gone", `sign-in \`${String(id)}\` is not running on this host`, { hint: "It finished a while ago, or tf-hostd restarted. Start the sign-in again." });
    return e;
  }

  private wait(p: Record<string, unknown>): Promise<AuthFlow> | AuthFlow {
    const e = this.entry(p.flowId);
    const after = typeof p.afterRev === "number" ? p.afterRev : undefined;
    if (after === undefined || e.flow.rev > after) return { ...e.flow };
    const ms = Math.min(typeof p.waitMs === "number" ? p.waitMs : 15_000, MAX_WAIT_MS);
    // The app's TS lib predates `Promise.withResolvers` (es2024).
    return new Promise<AuthFlow>((resolve) => {
      let cancel: () => void = () => {};
      const wake = () => {
        e.waiters.delete(wake);
        cancel();
        resolve({ ...e.flow });
      };
      e.waiters.add(wake);
      cancel = this.clock.after(ms, wake);
    });
  }

  private submit(p: Record<string, unknown>): AuthFlow {
    const e = this.entry(p.flowId);
    const text = typeof p.text === "string" ? p.text.trim() : "";
    const f = e.flow;
    if (final(f.state)) throw apiError("invalid_params", "this sign-in has already finished", { hint: "Start it again." });
    if (!f.prompt && f.paste === "none") throw apiError("invalid_params", "this sign-in finishes in the browser; there is nothing to paste");
    if (!text && !f.prompt) throw apiError("invalid_params", "nothing to submit");
    if (f.paste !== "none" && f.callbackPort != null && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(text)) {
      const port = Number(new URL(text).port || 80);
      if (port !== f.callbackPort)
        throw apiError("invalid_params", `that address is for port ${port} — this sign-in waits on port ${f.callbackPort}`, { hint: "It belongs to another sign-in. Start this one again, or paste its own address." });
    }
    const refused = e.script.check?.(text);
    if (refused) throw apiError("invalid_params", refused);
    this.change(e, (x) => {
      x.prompt = undefined;
      x.paste = "none";
      x.message = f.prompt?.secret ? "Validating the key…" : "Checking the code…";
    });
    e.cancelTimers.push(this.clock.after(900, () => this.done(e)));
    return { ...e.flow };
  }

  private publish(e: Entry): void {
    const s = e.script;
    const port = s.method === "browser" && s.url ? redirectPort(s.url) : undefined;
    this.change(e, (f) => {
      f.state = "waiting";
      f.url = s.url;
      f.instructions = s.instructions;
      f.userCode = s.userCode;
      f.callbackPort = port;
      f.redirectUri = port != null && s.url ? (new URL(s.url).searchParams.get("redirect_uri") ?? undefined) : undefined;
      f.paste = s.method === "paste" ? "primary" : port != null ? "fallback" : "none";
      f.prompt = s.method === "prompt" ? s.prompt : undefined;
      f.message = s.method === "device" ? "Waiting for you to enter the code…" : s.method === "browser" ? "Waiting for browser authentication..." : undefined;
      if (port != null) f.expiresAt = Math.min(f.expiresAt ?? Number.POSITIVE_INFINITY, this.clock.now() + CALLBACK_WAIT_MS);
    });
    if (port != null) e.cancelTimers.push(this.clock.after(CALLBACK_WAIT_MS, () => this.end(e, "failed", "OAuth callback cancelled: TimeoutError: The operation timed out.")));
  }

  private done(e: Entry): void {
    if (final(e.flow.state)) return;
    const who = e.script.account;
    this.change(e, (f) => (f.account = who));
    this.end(e, "done", who ? `Linked ${who}.` : "Linked.");
    e.script.onDone?.({ ...e.flow });
  }

  private end(e: Entry, state: AuthFlowState, message: string): void {
    if (final(e.flow.state)) return;
    for (const c of e.cancelTimers) c();
    e.cancelTimers = [];
    e.finishedAt = this.clock.now();
    this.change(e, (f) => {
      f.state = state;
      f.message = message;
      f.prompt = undefined;
    });
  }

  private change(e: Entry, fn: (f: AuthFlow) => void): void {
    if (final(e.flow.state)) return;
    const next = { ...e.flow };
    fn(next);
    next.rev = e.flow.rev + 1;
    next.updatedAt = this.clock.now();
    e.flow = next;
    for (const w of [...e.waiters]) w();
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [id, e] of this.flows) if (e.finishedAt != null && now - e.finishedAt > KEEP_MS) this.flows.delete(id);
  }
}

function final(s: AuthFlowState): boolean {
  return s === "done" || s === "failed" || s === "cancelled" || s === "expired";
}
