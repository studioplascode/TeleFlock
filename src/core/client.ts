import type { AppEvent, AppMethods, HostMethods, HostProfile, TunnelInfo } from "@/core/gen";
import { pulseBus, termBus } from "./buses";
import type { DemoClock } from "./demo/clock";
import { DemoEngine } from "./demo/engine";
import { toApiError } from "./errors";
import { agentKey, parseAgentKey } from "./keys";
import { navigate } from "./nav";
import { FrameBatcher } from "./store/batcher";
import { reduceEvents } from "./store/reduce";
import type { CoreEvent, Effect } from "./store/state";
import { coreStore } from "./store/store";
import { createDemoTransport } from "./transport/demo";
import { createTauriTransport, inTauri } from "./transport/tauri";
import type { Backend, CoreTransport } from "./transport/types";
import { createWsTransport } from "./transport/ws";
import { useUi } from "./ui";

export interface HostClient {
  call<M extends keyof HostMethods>(method: M, params: HostMethods[M]["params"]): Promise<HostMethods[M]["result"]>;
}

export interface CoreClient {
  app<M extends keyof AppMethods>(method: M, params: AppMethods[M]["params"]): Promise<AppMethods[M]["result"]>;
  host(hostId: string): HostClient;
  termInput(hostId: string, termId: string, data: string): void;
  readonly backend: Backend;
}

type Selection = { kind: "tauri" } | { kind: "demo"; empty: boolean; long: number } | { kind: "ws"; url: string; token?: string; fallback: boolean };

/**
 * Backend auto-selection (architecture §6.1). `metaToken` is the devserver's per-launch token from
 * `<meta name="tf-token">`; `?token=` covers a UI served from elsewhere (vite dev).
 */
export function selectBackend(
  loc: { search: string; protocol: string; host: string },
  opts: { tauri: boolean; prod: boolean; envUrl?: string; metaToken?: string },
): Selection {
  const q = new URLSearchParams(loc.search);
  // `?demo&long=2000`: seed forge::pool with N extra transcript rows (long-transcript perf testing).
  const long = Math.max(0, Math.min(50_000, Math.floor(Number(q.get("long")) || 0)));
  if (q.has("demo")) return { kind: "demo", empty: q.get("demo") === "empty", long };
  if (opts.tauri) return { kind: "tauri" };
  const token = opts.metaToken || q.get("token") || undefined;
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  let queryCore = q.get("core");
  // Production: a crafted `?core=` link must not point the served UI at someone else's socket.
  if (queryCore && opts.prod) {
    try {
      const u = new URL(queryCore);
      if (u.protocol !== scheme || u.host !== loc.host) queryCore = null;
    } catch {
      queryCore = null;
    }
  }
  const explicit = queryCore ?? opts.envUrl;
  if (explicit) return { kind: "ws", url: explicit, token, fallback: false };
  if (opts.prod && (loc.protocol === "http:" || loc.protocol === "https:")) {
    // Served by tf-devserver: same-origin `/ws`. Unreachable → demo.
    return { kind: "ws", url: `${scheme}//${loc.host}/ws`, token, fallback: true };
  }
  return { kind: "demo", empty: false, long };
}

// ---------------------------------------------------------------- runtime state

let transport: CoreTransport | null = null;
let demo: DemoEngine | null = null;
let demoEmpty = false;
let demoLong = 0;
let demoClock: DemoClock | undefined;
let unsubTransport: (() => void) | null = null;
/** Demo-kind profiles inside a real backend: routed to the in-process demo engine. */
const demoHostIds = new Set<string>();
let realTunnels: TunnelInfo[] = [];
let demoTunnels: TunnelInfo[] = [];
const rawListeners = new Set<(e: AppEvent) => void>();

const batcher = new FrameBatcher<CoreEvent>((events) => {
  const { state, effects } = reduceEvents(coreStore.getState(), events);
  if (state !== coreStore.getState()) coreStore.setState(state, true);
  for (const fx of effects) runEffect(fx);
});

function ensureDemo(mode: "backend" | "embedded" = "embedded"): DemoEngine {
  if (!demo) {
    demo = new DemoEngine({ mode, empty: demoEmpty, longTranscript: demoLong, clock: demoClock });
    // Embedded: the engine only owns demo-kind hosts; its events join the real stream.
    if (mode === "embedded") demo.subscribe((e) => ingest(e, "demo"));
  }
  return demo;
}

function isDemoHost(hostId: string | null | undefined): boolean {
  return hostId != null && (transport?.kind === "demo" || demoHostIds.has(hostId));
}

function syncDemoProfiles(profiles: HostProfile[]): void {
  if (transport?.kind === "demo") return;
  const next = new Set(profiles.filter((p) => p.kind === "demo").map((p) => p.id));
  for (const id of demoHostIds) {
    if (!next.has(id)) {
      demoHostIds.delete(id);
      demo?.detachHost(id);
    }
  }
  for (const p of profiles) {
    if (p.kind !== "demo") continue;
    demoHostIds.add(p.id);
    ensureDemo().attachHost(p);
  }
}

const HOST_SCOPED = new Set(["hostStatus", "hostSnapshot", "hostPatch", "pulse", "session", "term", "notify", "openAgent"]);

function ingest(e: AppEvent, source: "transport" | "demo"): void {
  if (source === "transport" && transport?.kind !== "demo") {
    // Demo-kind hosts are owned by the in-process engine; ignore whatever the real core says about them.
    if (HOST_SCOPED.has(e.type) && "hostId" in e && demoHostIds.has(e.hostId) && e.type !== "openAgent") return;
    if (e.type === "profiles") syncDemoProfiles(e.profiles);
    if (e.type === "tunnels") {
      realTunnels = e.tunnels;
      e = { type: "tunnels", tunnels: [...realTunnels, ...demoTunnels] };
    }
  } else if (source === "demo" && transport?.kind !== "demo" && e.type === "tunnels") {
    demoTunnels = e.tunnels;
    e = { type: "tunnels", tunnels: [...realTunnels, ...demoTunnels] };
  }
  for (const l of rawListeners) l(e);
  if (e.type === "pulse") pulseBus.emit(e.hostId, e.at, e.pulses);
  else if (e.type === "term") termBus.emit(e.hostId, e.termId, e.ev);
  else batcher.push(e);
}

/** Feeds a synthetic event through the ordered pipeline. */
export function pushInternal(e: CoreEvent): void {
  batcher.push(e);
}

// ---------------------------------------------------------------- effects

const resyncing = new Set<string>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Hosts whose activity feed is mounted somewhere (ref-counted by hooks). */
export const activityWatchers = new Map<string, number>();

function runEffect(fx: Effect): void {
  switch (fx.kind) {
    case "resync":
      void resync(fx.hostId);
      break;
    case "hostOnline":
      reopenSessions(fx.hostId);
      void loadActivity(fx.hostId, false).catch(() => {});
      break;
    case "lanes":
      scheduleActivityRefresh(fx.hostId);
      break;
    case "openAgent":
      navigate({ name: "agent", hostId: fx.hostId, agentId: fx.agentId });
      break;
    case "answerNext":
      useUi.getState().setAnswerNext(true);
      break;
    case "relink": {
      const key = agentKey(fx.hostId, fx.agentId);
      if ((sessionRefs.get(key) ?? 0) > 0) void loadSession(key);
      break;
    }
  }
}

async function resync(hostId: string): Promise<void> {
  if (resyncing.has(hostId)) return;
  resyncing.add(hostId);
  try {
    await refreshHost(hostId);
  } catch (err) {
    console.warn(`[core] resync ${hostId} failed`, err);
  } finally {
    resyncing.delete(hostId);
  }
}

function scheduleActivityRefresh(hostId: string): void {
  if (!activityWatchers.get(hostId) && !activityWatchers.get("*")) return;
  clearTimeout(activityTimers.get(hostId));
  activityTimers.set(
    hostId,
    setTimeout(() => {
      activityTimers.delete(hostId);
      void loadActivity(hostId, false).catch(() => {});
    }, 1200),
  );
}

// ---------------------------------------------------------------- public client

function callHost(hostId: string, method: string, params: unknown): Promise<unknown> {
  if (isDemoHost(hostId)) return ensureDemo().callHost(hostId, method, params);
  return requireTransport().call(hostId, method, params);
}

/** Does this app call address a demo-kind host (embedded demo inside a real backend)? */
function appCallTargetsDemo(method: string, params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  if ("hostId" in params && typeof params.hostId === "string" && method !== "hosts.remove") return demoHostIds.has(params.hostId);
  if (method === "hosts.test" && "kind" in params) return params.kind === "demo";
  if (method === "tunnel.close" && "tunnelId" in params) return demoTunnels.some((t) => t.tunnelId === params.tunnelId);
  if (method === "app.openExternal" && "url" in params && typeof params.url === "string") return demo?.ownsAuthUrl(params.url) ?? false;
  return false;
}

function callApp(method: string, params: unknown): Promise<unknown> {
  const t = requireTransport();
  if (t.kind !== "demo" && appCallTargetsDemo(method, params)) return ensureDemo().callApp(method, params);
  return t.call(null, method, params);
}

function requireTransport(): CoreTransport {
  startCore();
  if (!transport) throw toApiError({ code: "not_connected", message: "Core not started", retryable: true });
  return transport;
}

export const core: CoreClient = {
  app(method, params) {
    return callApp(method, params) as never;
  },
  host(hostId) {
    return {
      call(method, params) {
        return callHost(hostId, method, params) as never;
      },
    };
  },
  termInput(hostId, termId, data) {
    if (isDemoHost(hostId)) ensureDemo().termInput(hostId, termId, data);
    else requireTransport().termInput(hostId, termId, data);
  },
  get backend() {
    return transport?.kind ?? "demo";
  },
};

/** Raw AppEvents as they arrive (before the per-frame store flush). */
export function onAppEvent(cb: (e: AppEvent) => void): () => void {
  rawListeners.add(cb);
  return () => rawListeners.delete(cb);
}

/** `state.get` for one host, applied in order with the event stream. */
export async function refreshHost(hostId: string): Promise<void> {
  const state = await core.host(hostId).call("state.get", {});
  pushInternal({ type: "$stateGet", hostId, state });
}

/** Refreshes every host that is online. */
export async function refreshAll(): Promise<void> {
  const { status } = coreStore.getState();
  const online = Object.keys(status).filter((id) => status[id]?.phase === "online");
  await Promise.allSettled(online.map((id) => refreshHost(id)));
}

// ---------------------------------------------------------------- sessions

const sessionRefs = new Map<string, number>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SESSION_LINGER_MS = 8000;

async function loadSession(key: string): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  if (!coreStore.getState().sessions[key]) pushInternal({ type: "$sessionLoading", hostId, agentId });
  try {
    const snapshot = await core.host(hostId).call("session.open", { agentId, limit: 200 });
    if (!sessionRefs.has(key)) return;
    pushInternal({ type: "session", hostId, agentId, ev: { k: "reset", snapshot } });
  } catch (err) {
    if (!sessionRefs.has(key)) return;
    pushInternal({ type: "$sessionError", hostId, agentId, error: toApiError(err).toJSON() });
  }
}

/** Ref-counted session subscription; returns `release`. Closing lingers 8 s to absorb quick re-opens. */
export function openSession(key: string): () => void {
  startCore();
  clearTimeout(releaseTimers.get(key));
  releaseTimers.delete(key);
  const n = sessionRefs.get(key) ?? 0;
  sessionRefs.set(key, n + 1);
  if (n === 0 && coreStore.getState().sessions[key]?.status !== "live") void loadSession(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (sessionRefs.get(key) ?? 1) - 1;
    if (left > 0) {
      sessionRefs.set(key, left);
      return;
    }
    sessionRefs.set(key, 0);
    releaseTimers.set(
      key,
      setTimeout(() => {
        releaseTimers.delete(key);
        if ((sessionRefs.get(key) ?? 0) > 0) return;
        sessionRefs.delete(key);
        const { hostId, agentId } = parseAgentKey(key);
        pushInternal({ type: "$sessionDrop", hostId, agentId });
        core.host(hostId).call("session.close", { agentId }).catch(() => {});
      }, SESSION_LINGER_MS),
    );
  };
}

/** Explicit close (architecture §6.1 `closeSession`): releases nothing, just drops immediately. */
export function closeSession(key: string): void {
  const { hostId, agentId } = parseAgentKey(key);
  clearTimeout(releaseTimers.get(key));
  releaseTimers.delete(key);
  sessionRefs.delete(key);
  pushInternal({ type: "$sessionDrop", hostId, agentId });
  core.host(hostId).call("session.close", { agentId }).catch(() => {});
}

function reopenSessions(hostId: string | null): void {
  for (const [key, n] of sessionRefs) {
    if (n <= 0) continue;
    if (hostId !== null && parseAgentKey(key).hostId !== hostId) continue;
    void loadSession(key);
  }
}

const loadingOlder = new Set<string>();

/** Pages older transcript rows into the session. */
export async function loadOlder(key: string): Promise<void> {
  const sess = coreStore.getState().sessions[key];
  if (!sess?.hasMore || !sess.cursor || loadingOlder.has(key)) return;
  loadingOlder.add(key);
  const { hostId, agentId } = parseAgentKey(key);
  try {
    const page = await core.host(hostId).call("session.history", { agentId, cursor: sess.cursor, limit: 100 });
    pushInternal({ type: "$history", hostId, agentId, page });
  } finally {
    loadingOlder.delete(key);
  }
}

// ---------------------------------------------------------------- activity

/** Loads (or pages, with `older`) the activity feed of one host into the store. */
export async function loadActivity(hostId: string, older: boolean): Promise<void> {
  const cur = coreStore.getState().activity[hostId];
  const before = older ? cur?.events[cur.events.length - 1]?.at : undefined;
  if (older && (!cur?.hasMore || before === undefined)) return;
  const page = await core.host(hostId).call("host.activity", { limit: 100, ...(before !== undefined ? { before } : {}) });
  pushInternal({ type: "$activity", hostId, page, append: older || Boolean(cur) });
}

// ---------------------------------------------------------------- boot

let started = false;

async function bootstrap(t: CoreTransport): Promise<void> {
  // Transport results are untyped JSON; AppMethods is the contract the backend implements.
  const appCall = <M extends keyof AppMethods>(m: M, p: AppMethods[M]["params"]) => t.call(null, m, p) as Promise<AppMethods[M]["result"]>;
  const tasks: Promise<void>[] = [
    appCall("hosts.list", {}).then((result) => {
      syncDemoProfiles(result.profiles);
      // Demo-kind hosts report their own status through the demo engine.
      pushInternal({ type: "$hostsList", result: { ...result, statuses: result.statuses.filter((s) => !demoHostIds.has(s.hostId)) } });
      // Fallback when the backend doesn't replay snapshots to new subscribers.
      setTimeout(() => {
        const st = coreStore.getState();
        for (const s of result.statuses) {
          if (s.status.phase === "online" && !st.hosts[s.hostId]) void resync(s.hostId);
        }
      }, 1500);
    }),
    appCall("settings.get", {}).then((settings) => pushInternal({ type: "settings", settings })),
    appCall("tunnel.list", {}).then((r) => {
      realTunnels = r.tunnels;
      pushInternal({ type: "tunnels", tunnels: t.kind === "demo" ? realTunnels : [...realTunnels, ...demoTunnels] });
    }),
  ];
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") console.warn("[core] bootstrap call failed", r.reason);
}

function install(t: CoreTransport): void {
  unsubTransport?.();
  transport?.close?.();
  transport = t;
  coreStore.setState({ backend: t.kind });
  const unsubEvents = t.subscribe((e) => ingest(e, "transport"));
  let firstLink = true;
  const unsubLink = t.onLink?.((up) => {
    if (!up) return;
    if (firstLink) {
      firstLink = false;
      return;
    }
    // Reconnected to the devserver: resync everything and re-subscribe live sessions.
    void bootstrap(t);
    reopenSessions(null);
  });
  unsubTransport = () => {
    unsubEvents();
    unsubLink?.();
  };
  void bootstrap(t);
}

/** DI/test seam: start the core on a given transport (and demo clock) instead of auto-selecting. */
export function startCoreWith(t: CoreTransport, opts: { demoClock?: DemoClock } = {}): void {
  started = true;
  demoClock = opts.demoClock;
  install(t);
}

/** Starts the core once (idempotent). Hooks call it lazily; the app calls it before render. */
export function startCore(): void {
  if (started) return;
  started = true;
  const loc = typeof window === "undefined" ? { search: "", protocol: "", host: "" } : window.location;
  const sel = selectBackend(loc, {
    tauri: inTauri(),
    prod: import.meta.env?.PROD ?? false,
    envUrl: import.meta.env?.VITE_TF_CORE as string | undefined,
    metaToken: typeof document === "undefined" ? undefined : (document.querySelector<HTMLMetaElement>('meta[name="tf-token"]')?.content ?? undefined),
  });
  if (sel.kind === "tauri") install(createTauriTransport());
  else if (sel.kind === "ws") {
    install(
      createWsTransport({
        url: sel.url,
        token: sel.token,
        onFirstFailure: sel.fallback
          ? () => {
              console.info("[core] devserver unreachable; using the demo backend");
              startDemoBackend(false, 0);
            }
          : undefined,
      }),
    );
  } else startDemoBackend(sel.empty, sel.long);
}

function startDemoBackend(empty: boolean, long: number): void {
  demoEmpty = empty;
  demoLong = long;
  demo?.dispose();
  demo = null;
  const engine = ensureDemo("backend");
  install(createDemoTransport(engine));
}

/** Test seam: flush queued events synchronously. */
export function flushCoreEvents(): void {
  batcher.flushNow();
}

// Dev only: a hot-reloaded core must not leave the previous demo engine ticking.
import.meta.hot?.dispose(() => {
  demo?.dispose();
  transport?.close?.();
});
