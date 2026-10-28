/**
 * Sign-ins that run on a host and are completed from this device (`auth.*`, architecture §3.14):
 * linking an omp account (`accounts.link`), MCP server OAuth (`mcp.authStart`). One controller
 * drives a flow end to end:
 *
 * - long-polls `auth.wait` until the flow is final (a host that drops off is retried; the flow
 *   keeps running there);
 * - while the flow waits on a loopback callback (`callbackPort`), forwards exactly that port of
 *   this device to the host (`tunnel.open { localPort }`), so the provider's redirect to
 *   `http://localhost:<port>/…` in this device's browser reaches the callback server on the host.
 *   A port that can't be bound here (`port_in_use` / `port_unavailable`) makes pasting the address
 *   the browser landed on the primary path. Hosts on this machine need no tunnel;
 * - opens the authorization page in this device's browser (`app.openExternal` in Tauri, desktop and
 *   Android, and for demo hosts; `window.open` inside the click in a plain browser);
 * - submits pasted codes / addresses and prompt answers (`auth.submit`), reporting a refusal where
 *   it was made;
 * - on cancel, unmount or a final state: closes the tunnel it opened and cancels a running flow.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiError, core, toApiError, useHosts } from "@/core";
import type { ApiError, AuthFlow, AuthFlowState, AuthPaste, HostKind, TunnelInfo, TunnelListResult } from "@/core/gen";
import { inTauri } from "@/core/transport/tauri";

/**
 * What the user is asked to do now.
 * * `starting`: the host is launching the sign-in.
 * * `browser`: sign in on the opened page; the answer comes back by itself (tunnel, or the provider
 *   finishes on its side). Pasting the landed address is the fallback when `paste` is `fallback`.
 * * `device`: enter `flow.userCode` on the opened page.
 * * `paste`: paste the code the page shows, or the address the browser landed on.
 * * `prompt`: answer `flow.prompt` (an API key, an enterprise domain, …).
 * * `working`: the host is finishing (checking a pasted code, exchanging tokens).
 * * final: `done` | `failed` | `cancelled` | `expired`.
 */
export type RemoteAuthStage = "starting" | "browser" | "device" | "paste" | "prompt" | "working" | "done" | "failed" | "cancelled" | "expired";

/**
 * The same-port tunnel of the flow's callback port.
 * * `none`: the flow has no loopback callback (or doesn't wait on it now).
 * * `local`: the host is this machine; the browser reaches its callback directly.
 * * `opening` / `open`: forwarding `localhost:<port>` of this device to the host.
 * * `busy`: the port can't be bound on this device (another program, another tunnel).
 * * `failed`: no tunnel (an error, or this browser isn't on the machine that runs TeleFlock).
 */
export type RemoteAuthTunnelState = "none" | "local" | "opening" | "open" | "busy" | "failed";

export interface RemoteAuthTunnel {
  state: RemoteAuthTunnelState;
  port?: number;
  /** Why it is busy / failed. */
  message?: string;
  hint?: string;
}

export interface RemoteAuthSnapshot {
  stage: RemoteAuthStage;
  flow: AuthFlow | null;
  /** Why the sign-in couldn't start or be followed (stage `failed` without a host verdict). */
  error: ApiError | null;
  tunnel: RemoteAuthTunnel;
  /** `flow.paste`, raised to `primary` when the callback can't come back through the tunnel. */
  paste: AuthPaste;
  /** The user opened the page (at least once). */
  opened: boolean;
  /** `app.openExternal` refused the page (copy the link instead). */
  openError: string | null;
  /** The host can't be reached right now; the flow keeps running there. */
  reconnecting: boolean;
  submitting: boolean;
  /** The host's verdict on the last submission (shown under the field). */
  submitError: ApiError | null;
  /** A later attempt can be started (`retry`). */
  canRetry: boolean;
}

export interface RemoteAuthDeps {
  /** A request to the flow's host. */
  host(method: string, params: unknown): Promise<unknown>;
  /** An app request (tunnels, `app.openExternal`). */
  app(method: string, params: unknown): Promise<unknown>;
  hostId: string;
  /** Pages open through `app.openExternal` without a user gesture (Tauri, demo hosts). */
  externalOpen(): boolean;
  /** Opens a page in a plain browser; must run inside the click. */
  windowOpen(url: string): void;
  /** How the device's browser reaches the host's loopback callback. */
  reach(): "tunnel" | "local" | "unreachable";
  /** Open the page by itself once it is known (no click needed in this build). */
  autoOpen: boolean;
  copy(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface RemoteAuthHandlers {
  /** Starts the flow on the host (`accounts.link`, `mcp.authStart`). */
  start?: () => Promise<AuthFlow>;
  /** Follows a flow that already runs on the host instead of starting one. */
  flowId?: string;
  onDone?(flow: AuthFlow): void;
  onFinal?(flow: AuthFlow): void;
}

const WAIT_MS = 20_000;
/** A page published without a callback, code or question may be followed by a question at once
 * (an API-key login prints its page, then asks): show it only once the host has been quiet this long. */
const SETTLE_MS = 400;
const FINAL: Record<AuthFlowState, boolean> = { starting: false, waiting: false, done: true, failed: true, cancelled: true, expired: true };

export function isFinalFlow(flow: AuthFlow | null | undefined): boolean {
  return !!flow && FINAL[flow.state];
}

/** `flow.paste`, raised to `primary` when the redirect can't come back on its own. */
export function effectivePaste(flow: AuthFlow | null, tunnel: RemoteAuthTunnel): AuthPaste {
  if (!flow) return "none";
  if (flow.paste === "fallback" && (tunnel.state === "busy" || tunnel.state === "failed")) return "primary";
  return flow.paste;
}

/** The step a flow asks for (see {@link RemoteAuthStage}). */
export function stageOf(flow: AuthFlow | null, paste: AuthPaste): RemoteAuthStage {
  if (!flow || flow.state === "starting") return "starting";
  if (flow.state !== "waiting") return flow.state;
  if (flow.prompt) return "prompt";
  if (flow.userCode) return "device";
  if (paste === "primary") return "paste";
  // A loopback flow whose paste was taken (`paste` back to none) is being finished on the host.
  if (flow.url && (paste === "fallback" || flow.callbackPort == null)) return "browser";
  return "working";
}

/** A published page with nothing else to do yet: a question may follow right away. */
function ambiguous(flow: AuthFlow): boolean {
  return flow.state === "waiting" && !!flow.url && flow.callbackPort == null && flow.paste === "none" && !flow.userCode && !flow.prompt;
}

const INITIAL: RemoteAuthSnapshot = {
  stage: "starting",
  flow: null,
  error: null,
  tunnel: { state: "none" },
  paste: "none",
  opened: false,
  openError: null,
  reconnecting: false,
  submitting: false,
  submitError: null,
  canRetry: false,
};

/** Errors after which following the flow is pointless (it is gone, or the host can't do this). */
function fatal(e: ApiError): boolean {
  return e.code === "auth_flow_gone" || e.code === "unknown_method" || e.code === "invalid_params" || e.code === "not_found" || e.code === "unsupported";
}

export class RemoteAuthController {
  private snap: RemoteAuthSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Bumped by retry / cancel / dispose: async work of an older generation drops its result. */
  private gen = 0;
  private started = false;
  private disposed = false;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Port the tunnel is (being) opened for; null: none wanted. */
  private tunnelPort: number | null = null;
  /** The tunnel this controller opened (a tunnel that existed before is never closed). */
  private tunnelId: string | null = null;
  private autoOpened = false;
  private doneReported = false;
  private settling = false;

  constructor(
    private readonly deps: RemoteAuthDeps,
    private readonly handlers: RemoteAuthHandlers,
  ) {
    this.snap = { ...INITIAL, canRetry: !!handlers.start };
  }

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  readonly getSnapshot = (): RemoteAuthSnapshot => this.snap;

  /** A component uses it: starts once; cancels a pending {@link release}. */
  retain(): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (this.disposed || this.started) return;
    this.started = true;
    void this.run();
  }

  /** The component is gone: dispose on the next task unless it is retained again (React StrictMode
   * unmounts and remounts every effect once). */
  release(): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.dispose(), 0);
  }

  /** Stops following the flow: cancels it when it still runs and closes the tunnel it opened. */
  dispose(): void {
    if (this.disposed) return;
    clearTimeout(this.releaseTimer);
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  // ───────────────────────────── actions ─────────────────────────────

  /** Opens the page in this device's browser. In a plain browser call it inside the click. */
  readonly openUrl = (): void => {
    const url = this.snap.flow?.url;
    if (!url || this.disposed) return;
    this.set({ opened: true, openError: null });
    if (this.deps.externalOpen()) {
      this.deps.app("app.openExternal", { url }).catch((e: unknown) => {
        if (!this.disposed) this.set({ openError: toApiError(e).message });
      });
    } else {
      this.deps.windowOpen(url);
    }
  };

  /** Copies the device code; resolves false when the clipboard refused. */
  readonly copyCode = (): Promise<boolean> => this.copy(this.snap.flow?.userCode);

  /** Copies the page's address (to open it on another device). */
  readonly copyUrl = (): Promise<boolean> => this.copy(this.snap.flow?.url);

  /** Hands a pasted code / address or a prompt answer to the host. Resolves false when refused
   * (`submitError` says why). */
  readonly submit = async (text: string): Promise<boolean> => {
    const flow = this.snap.flow;
    if (!flow || isFinalFlow(flow) || this.disposed || this.snap.submitting) return false;
    const gen = this.gen;
    this.set({ submitting: true, submitError: null });
    try {
      const next = (await this.deps.host("auth.submit", { flowId: flow.flowId, text })) as AuthFlow;
      if (gen !== this.gen) return false;
      this.set({ submitting: false });
      this.apply(next);
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      this.set({ submitting: false, submitError: toApiError(e) });
      return false;
    }
  };

  /** Forgets the last refusal (the user edits the field). */
  readonly clearSubmitError = (): void => {
    if (this.snap.submitError) this.set({ submitError: null });
  };

  /** Cancels the sign-in (stage `cancelled`). */
  readonly cancel = (): void => {
    if (this.disposed || isFinalFlow(this.snap.flow) || (this.snap.stage === "failed" && !this.snap.flow)) return;
    const flow = this.snap.flow;
    this.stop();
    const now = Date.now();
    const cancelled: AuthFlow | null = flow ? { ...flow, state: "cancelled", message: "Cancelled.", prompt: undefined, rev: flow.rev + 1, updatedAt: now } : null;
    this.set({ stage: "cancelled", flow: cancelled, tunnel: { state: "none" }, submitting: false, reconnecting: false });
    if (cancelled) this.handlers.onFinal?.(cancelled);
  };

  /** Starts a new attempt (after a failure, a cancel or an expired code). */
  readonly retry = (): void => {
    if (this.disposed || !this.handlers.start) return;
    this.stop();
    this.autoOpened = false;
    this.doneReported = false;
    this.snap = { ...INITIAL, canRetry: true };
    this.emit();
    void this.run(true);
  };

  // ───────────────────────────── flow ─────────────────────────────

  private async run(fresh = false): Promise<void> {
    const gen = ++this.gen;
    let flow: AuthFlow;
    try {
      if (this.handlers.flowId && !fresh) flow = (await this.deps.host("auth.wait", { flowId: this.handlers.flowId })) as AuthFlow;
      else if (this.handlers.start) flow = await this.handlers.start();
      else throw apiError("invalid_params", "There is no sign-in to follow.");
    } catch (e) {
      if (gen === this.gen) this.fail(toApiError(e));
      return;
    }
    if (gen !== this.gen) {
      // Cancelled or closed while the host was starting it: nobody follows this flow.
      if (!isFinalFlow(flow)) this.deps.host("auth.cancel", { flowId: flow.flowId }).catch(() => {});
      return;
    }
    this.apply(flow);
    await this.poll(gen, flow.flowId);
  }

  private async poll(gen: number, flowId: string): Promise<void> {
    let failures = 0;
    while (gen === this.gen && !isFinalFlow(this.snap.flow)) {
      const rev = this.snap.flow?.rev ?? 0;
      try {
        const next = (await this.deps.host("auth.wait", { flowId, afterRev: rev, waitMs: WAIT_MS })) as AuthFlow;
        if (gen !== this.gen) return;
        failures = 0;
        if (this.snap.reconnecting) this.set({ reconnecting: false });
        this.apply(next);
      } catch (e) {
        if (gen !== this.gen) return;
        const err = toApiError(e);
        if (fatal(err)) {
          this.fail(err);
          return;
        }
        // Host offline or slow: the flow keeps running there; follow it again shortly.
        this.set({ reconnecting: true });
        await this.deps.sleep(Math.min(10_000, 1000 * 2 ** failures));
        failures += 1;
      }
    }
  }

  /** Takes a newer state of the flow (a poll and a submission may answer out of order). */
  private apply(flow: AuthFlow): void {
    if (this.disposed) return;
    const cur = this.snap.flow;
    if (cur && cur.flowId === flow.flowId && flow.rev < cur.rev) return;
    const final = isFinalFlow(flow);
    if (final) this.closeTunnel();
    const tunnel = final ? this.snap.tunnel : this.tunnelFor(flow);
    const paste = effectivePaste(flow, tunnel);
    let stage = stageOf(flow, paste);
    // Hold "starting" a moment on a bare page: an API-key login asks its question right after.
    if (stage === "browser" && ambiguous(flow) && (this.snap.stage === "starting" || this.settling)) {
      stage = "starting";
      if (!this.settling) {
        this.settling = true;
        const gen = this.gen;
        void this.deps.sleep(SETTLE_MS).then(() => {
          if (gen !== this.gen || !this.settling) return;
          this.settling = false;
          const f = this.snap.flow;
          if (f) this.set({ stage: stageOf(f, this.snap.paste) });
          this.maybeAutoOpen();
        });
      }
    } else this.settling = false;
    this.set({ flow, stage, tunnel, paste, submitError: final ? null : this.snap.submitError, reconnecting: final ? false : this.snap.reconnecting });
    if (final) {
      if (flow.state === "done" && !this.doneReported) {
        this.doneReported = true;
        this.handlers.onDone?.(flow);
      }
      this.handlers.onFinal?.(flow);
      return;
    }
    this.maybeAutoOpen();
  }

  private fail(error: ApiError): void {
    this.closeTunnel();
    const flow = this.snap.flow;
    this.set({ stage: "failed", error, reconnecting: false, submitting: false, tunnel: { state: "none" } });
    if (flow) this.handlers.onFinal?.({ ...flow, state: "failed", message: error.message });
  }

  /** Stops following the current flow (cancelling it on the host when it still runs). */
  private stop(): void {
    this.gen += 1;
    this.settling = false;
    this.closeTunnel();
    const flow = this.snap.flow;
    if (flow && !isFinalFlow(flow)) this.deps.host("auth.cancel", { flowId: flow.flowId }).catch(() => {});
  }

  // ───────────────────────────── tunnel ─────────────────────────────

  /** The tunnel state `flow` needs; starts or moves the tunnel when its port changed. */
  private tunnelFor(flow: AuthFlow): RemoteAuthTunnel {
    const want = flow.state === "waiting" && flow.callbackPort != null ? flow.callbackPort : null;
    if (want === null) {
      if (this.tunnelPort !== null) this.closeTunnel();
      return { state: "none" };
    }
    const reach = this.deps.reach();
    if (reach === "local") return { state: "local", port: want };
    if (reach === "unreachable")
      return {
        state: "failed",
        port: want,
        message: "This browser runs on another machine than TeleFlock, so the sign-in can't come back by itself.",
        hint: "Paste the address the browser lands on after you approve.",
      };
    if (this.tunnelPort === want) return this.snap.tunnel.port === want ? this.snap.tunnel : { state: "opening", port: want };
    if (this.tunnelPort !== null) this.closeTunnel();
    this.tunnelPort = want;
    void this.openTunnel(want);
    return { state: "opening", port: want };
  }

  private async openTunnel(port: number): Promise<void> {
    const gen = this.gen;
    const wanted = () => gen === this.gen && this.tunnelPort === port && !this.disposed;
    // Tunnels that exist already (a preview of the same port) are reused, never closed by us.
    let before = new Set<string>();
    try {
      const list = (await this.deps.app("tunnel.list", {})) as TunnelListResult;
      before = new Set(list.tunnels.map((t) => t.tunnelId));
    } catch {
      /* unknown: treat the tunnel we get as ours */
    }
    try {
      const t = (await this.deps.app("tunnel.open", { hostId: this.deps.hostId, port, localPort: port })) as TunnelInfo;
      const ours = !before.has(t.tunnelId);
      if (!wanted()) {
        if (ours) this.deps.app("tunnel.close", { tunnelId: t.tunnelId }).catch(() => {});
        return;
      }
      this.tunnelId = ours ? t.tunnelId : null;
      this.setTunnel({ state: "open", port });
    } catch (e) {
      if (!wanted()) return;
      const err = toApiError(e);
      const busy = err.code === "port_in_use" || err.code === "port_unavailable";
      this.setTunnel({ state: busy ? "busy" : "failed", port, message: err.message, hint: err.hint });
    }
    this.maybeAutoOpen();
  }

  private setTunnel(tunnel: RemoteAuthTunnel): void {
    const flow = this.snap.flow;
    const paste = effectivePaste(flow, tunnel);
    const stage = this.settling ? this.snap.stage : stageOf(flow, paste);
    this.set({ tunnel, paste, stage });
  }

  private closeTunnel(): void {
    const id = this.tunnelId;
    this.tunnelId = null;
    this.tunnelPort = null;
    if (id) this.deps.app("tunnel.close", { tunnelId: id }).catch(() => {});
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Opens the page by itself once, when nothing has to be read first and the tunnel is ready. */
  private maybeAutoOpen(): void {
    if (!this.deps.autoOpen || this.autoOpened || this.disposed) return;
    const { flow, stage, tunnel } = this.snap;
    if (!flow?.url || (stage !== "browser" && stage !== "paste")) return;
    if (tunnel.state === "opening") return;
    this.autoOpened = true;
    this.openUrl();
  }

  private async copy(text: string | undefined): Promise<boolean> {
    if (!text) return false;
    try {
      await this.deps.copy(text);
      return true;
    } catch {
      return false;
    }
  }

  private set(patch: Partial<RemoteAuthSnapshot>): void {
    if (this.disposed) return;
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

// ───────────────────────────── React ─────────────────────────────

export interface RemoteAuthOptions extends RemoteAuthHandlers {
  hostId: string;
  /**
   * Open the page by itself as soon as it is known (after the tunnel is up), except for device
   * codes and questions, which have to be read first. Only where no click is needed (the Tauri
   * app); a plain browser always shows the button (popup blockers).
   */
  autoOpen?: boolean;
}

export interface RemoteAuth extends RemoteAuthSnapshot {
  hostId: string;
  openUrl(): void;
  copyCode(): Promise<boolean>;
  copyUrl(): Promise<boolean>;
  submit(text: string): Promise<boolean>;
  clearSubmitError(): void;
  cancel(): void;
  retry(): void;
}

const LOOPBACK_NAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "::1": true };

/** Live controller dependencies for `hostId` (host kind and backend read when needed). */
export function remoteAuthDeps(hostId: string, autoOpen: boolean): RemoteAuthDeps {
  const kind = (): HostKind | undefined => useHosts.getState().profiles.find((p) => p.id === hostId)?.kind;
  const demo = () => kind() === "demo" || core.backend === "demo";
  return {
    hostId,
    host: (method, params) => core.host(hostId).call(method as never, params as never),
    app: (method, params) => core.app(method as never, params as never),
    externalOpen: () => inTauri() || demo(),
    windowOpen: (url) => {
      window.open(url, "_blank", "noopener");
    },
    reach: () => {
      if (kind() === "local") return "local";
      if (demo() || inTauri()) return "tunnel";
      // A plain browser on a devserver: its tunnels listen on the devserver's machine.
      return LOOPBACK_NAMES[window.location.hostname] ? "tunnel" : "unreachable";
    },
    autoOpen: autoOpen && inTauri() && kind() !== "demo",
    copy: (text) => navigator.clipboard.writeText(text),
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Drives one sign-in (see the module comment). `start` runs once on mount (StrictMode-safe), or
 * `flowId` follows a flow already running on the host. Unmounting cancels a running flow and
 * closes its tunnel: mount one per sign-in, keyed by what it signs in to.
 */
export function useRemoteAuth(opts: RemoteAuthOptions): RemoteAuth {
  const latest = useRef(opts);
  latest.current = opts;
  const [ctl] = useState(
    () =>
      new RemoteAuthController(remoteAuthDeps(opts.hostId, !!opts.autoOpen), {
        start: opts.start ? () => (latest.current.start as () => Promise<AuthFlow>)() : undefined,
        flowId: opts.flowId,
        onDone: (f) => latest.current.onDone?.(f),
        onFinal: (f) => latest.current.onFinal?.(f),
      }),
  );
  useEffect(() => {
    ctl.retain();
    return () => ctl.release();
  }, [ctl]);
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  return useMemo(
    () => ({
      ...snap,
      hostId: opts.hostId,
      openUrl: ctl.openUrl,
      copyCode: ctl.copyCode,
      copyUrl: ctl.copyUrl,
      submit: ctl.submit,
      clearSubmitError: ctl.clearSubmitError,
      cancel: ctl.cancel,
      retry: ctl.retry,
    }),
    [snap, ctl, opts.hostId],
  );
}
