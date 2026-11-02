/**
 * The demo's fake Chromium (`?demo`): the browser panel's `CdpConnection` talks to it through
 * `demoSocket` instead of a WebSocket. It speaks the CDP subset of `../cdp/protocol.ts`: targets in
 * windows, flat sessions per client, history, screencast frames with acks, input that drives the
 * canned pages of `./pages.ts`, JS dialogs, the file chooser, downloads and the panel's scripts.
 * `demoAgentStep` moves an agent's tab one scripted step through the same input paths.
 */
import { DEMO_BROWSER_TABS, type DemoBrowserTab, demoAgentTabs } from "@/core/demo/browserTabs";
import { type DemoClock, realClock } from "@/core/demo/clock";
import { Rng, hash } from "@/core/demo/rng";
import type { SocketLike } from "../cdp/connection";
import type { CdpEvents, DialogType, KeyEventParams, MouseButtonName, MouseEventParams, MouseType, TargetInfo } from "../cdp/protocol";
import { scriptName } from "../cdp/scripts";
import {
  type Action,
  CI_RUN_IDS,
  type FrameRequest,
  type Hit,
  type Measure,
  type Page,
  type PageState,
  type Scene,
  type Site,
  defaultMeasure,
  defaultMemory,
  findHit,
  focusables,
  freshState,
  hitAt,
  iconSite,
  iconUrlOf,
  layoutPage,
  pageFor,
  paintFrame,
  paintIcon,
} from "./pages";

// ---------------------------------------------------------------- configuration

export interface DemoBrowserConfig {
  /** Paints a screencast frame or screenshot: base64 without the `data:` prefix (Canvas 2D by default). */
  paint: (req: FrameRequest) => Promise<string>;
  /** A site's 32×32 PNG icon, base64. */
  icon: (site: Site) => Promise<string>;
  /** Text widths for layout (a canvas when there is one). */
  measure?: Measure;
  clock: DemoClock;
}

const DEFAULTS: DemoBrowserConfig = { paint: paintFrame, icon: paintIcon, clock: realClock };
let config: DemoBrowserConfig = { ...DEFAULTS };
let singleton: FakeBrowser | null = null;

/** Tests: a stub painter, a manual clock. Applies to the running fake too. */
export function configureDemoBrowser(c: Partial<DemoBrowserConfig>): void {
  config = { ...config, ...c };
}

function browser(): FakeBrowser {
  singleton ??= new FakeBrowser();
  return singleton;
}

/** A new client connection to the one fake browser (created on first use). */
export function demoSocket(url: string): SocketLike {
  return new DemoSocket(browser(), url);
}

/** Performs the next scripted "agent" step in a tab; false: unknown tab or nothing to do. */
export function demoAgentStep(targetId: string): boolean {
  return browser().agentStep(targetId);
}

/** Tests: drops the fake (its timers, its clients) and the configuration. */
export function resetDemoBrowser(): void {
  singleton?.dispose();
  singleton = null;
  config = { ...DEFAULTS };
}

// ---------------------------------------------------------------- socket

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class DemoSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(
    private readonly fake: FakeBrowser,
    readonly url: string,
  ) {
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      fake.connect(this);
      this.onopen?.({ type: "open" });
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("WebSocket is not open");
    this.fake.receive(this, data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    const wasOpen = this.readyState === OPEN;
    this.readyState = CLOSED;
    if (wasOpen) this.fake.disconnect(this);
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
  }

  /** The fake went away (tests): closed without events. */
  kill(): void {
    this.readyState = CLOSED;
  }

  deliver(msg: object): void {
    if (this.readyState !== OPEN) return;
    // A socket's handler failing is the page's problem, not the sender's (a WebSocket dispatches in its own task).
    try {
      this.onmessage?.({ data: JSON.stringify(msg) });
    } catch (e) {
      console.error("[demo browser] message handler failed", e);
    }
  }
}

// ---------------------------------------------------------------- model

const DEFAULT_VIEWPORT = { width: 1280, height: 800, scale: 1, mobile: false };
const LOAD_MS = 350;
const DOWNLOAD_TICK_MS = 250;
const DOWNLOAD_TICKS = 10;
const DOWNLOADS_DIR = "/home/demo/Downloads";
const CONTEXT_ID = "demo-context";
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;
const PRODUCT = "Chrome/156.0.0.0";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 TeleFlockDemo";
const MOUSE_TYPES: readonly MouseType[] = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
const BUTTONS: readonly MouseButtonName[] = ["none", "left", "middle", "right", "back", "forward"];
const KEY_TYPES: readonly KeyEventParams["type"][] = ["keyDown", "keyUp", "rawKeyDown", "char"];

class Fail extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  id: number;
  url: string;
  title: string;
  transitionType: string;
}

interface Cast {
  format: "jpeg" | "png";
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  unacked: number | null;
  dirty: boolean;
  painting: boolean;
}

interface Session {
  id: string;
  target: Target;
  client: Client;
  cast: Cast | null;
  /** Screencast frame numbers keep counting across restarts, so a late ack never matches a new frame. */
  frames: number;
  intercept: boolean;
  runtime: boolean;
  network: boolean;
  log: boolean;
}

type DialogAction = Extract<Action, { kind: "dialog" }>;

interface Target {
  id: string;
  window: number;
  openerId?: string;
  /** The document's address, fragment included. */
  url: string;
  page: Page;
  state: PageState;
  scene: Scene | null;
  entries: Entry[];
  index: number;
  viewport: { width: number; height: number; scale: number; mobile: boolean };
  sessions: Set<Session>;
  /** Cancels the pending navigation. */
  loading: (() => void) | null;
  dialog: { type: DialogType; action: DialogAction } | null;
  /** The url and title discovery clients last heard. */
  announced: { url: string; title: string };
  agent: { cycle: number; step: number };
}

interface Client {
  socket: DemoSocket;
  discover: boolean;
  sessions: Map<string, Session>;
}

interface Load {
  url: string;
  transition: string;
  /** A history entry (back/forward): no new entry. */
  entryIndex?: number;
  reload?: boolean;
}

interface Incoming {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Step = { do: "scroll"; by: number } | { do: "hover" | "click"; id: string } | { do: "type"; id: string; text: string } | { do: "back" };

/** The quota agent exports October's usage: table, filter, export, invoices, back. */
const QUOTA_SCRIPT: readonly Step[] = [
  { do: "scroll", by: 420 },
  { do: "scroll", by: 360 },
  { do: "type", id: "tenant-filter", text: "acme" },
  { do: "hover", id: "export-csv" },
  { do: "click", id: "export-csv" },
  { do: "click", id: "view-invoices" },
  { do: "scroll", by: 320 },
  { do: "back" },
];

function agentScript(targetId: string, cycle: number): readonly Step[] | undefined {
  // It exports once; later rounds only look (a download per round would pile up in the panel).
  if (targetId === "demo-tab-quota") return cycle === 0 ? QUOTA_SCRIPT : QUOTA_SCRIPT.filter((s) => !(s.do === "click" && s.id === "export-csv"));
  if (targetId === "demo-tab-ci") {
    const run = CI_RUN_IDS[cycle % CI_RUN_IDS.length] ?? "run-1842";
    return [{ do: "click", id: run }, { do: "scroll", by: 560 }, { do: "scroll", by: 560 }, { do: "back" }];
  }
  return undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  return typeof v === "string" ? v : undefined;
}

function num(q: Record<string, unknown>, key: string): number | undefined {
  const v = q[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return list.find((x) => x === v);
}

function invalid(what: string): Fail {
  return new Fail(-32602, `Invalid parameters: ${what}`);
}

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

/** A navigation that only changes the fragment of the shown document. */
function sameDocument(from: string, to: string): boolean {
  return to.includes("#") && withoutHash(from) === withoutHash(to);
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function sensitiveField(hit: Hit): boolean {
  return hit.input?.type === "password" || /^cc-|one-time-code|current-password|new-password/.test(hit.input?.autocomplete ?? "");
}

// ---------------------------------------------------------------- browser

class FakeBrowser {
  private readonly clients = new Map<DemoSocket, Client>();
  private readonly targets = new Map<string, Target>();
  /** Each window's shown tab. */
  private readonly windows = new Map<number, string>();
  private readonly memory = defaultMemory();
  private readonly rng = new Rng(hash("teleflock-demo-browser"));
  private readonly timers = new Set<() => void>();
  private readonly downloads = new Map<string, () => void>();
  private readonly streams = new Map<string, { data: string; read: boolean }>();
  private readonly bodies = new Map<string, string>();
  private readonly icons = new Map<string, Promise<string>>();
  private downloadBehavior: { behavior: string; path?: string; events: boolean; client: Client } | null = null;
  private entrySeq = 0;
  private contextSeq = 0;
  private requestSeq = 0;
  private streamSeq = 0;
  private disposed = false;
  /** A number per loaded document (its state): what its elements' refs start with. */
  private readonly documents = new WeakMap<PageState, number>();
  private documentSeq = 0;
  private defaultMeasure: Measure | undefined;

  constructor() {
    for (const tab of DEMO_BROWSER_TABS) {
      const t = this.makeTarget(tab.targetId, tab.url, tab.window, undefined, "typed");
      if (!this.windows.has(tab.window)) this.windows.set(tab.window, t.id);
    }
    for (const tab of demoAgentTabs((t) => this.agentOpened(t))) this.agentOpened(tab);
  }

  /** An agent opened a tab (the demo backend's `openDemoAgentTab`): shown in its own window. */
  private agentOpened(tab: DemoBrowserTab): void {
    if (this.disposed || this.targets.has(tab.targetId)) return;
    const t = this.makeTarget(tab.targetId, tab.url, tab.window, undefined, "typed");
    this.broadcast("Target.targetCreated", { targetInfo: this.info(t) });
    this.show(t);
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.timers]) cancel();
    this.timers.clear();
    for (const c of this.clients.values()) c.socket.kill();
    this.clients.clear();
  }

  // ------------------------------------------------ clients

  connect(socket: DemoSocket): void {
    if (this.disposed) return socket.kill();
    this.clients.set(socket, { socket, discover: false, sessions: new Map() });
  }

  disconnect(socket: DemoSocket): void {
    const c = this.clients.get(socket);
    if (!c) return;
    this.clients.delete(socket);
    for (const s of c.sessions.values()) s.target.sessions.delete(s);
    c.sessions.clear();
    if (this.downloadBehavior?.client === c) this.downloadBehavior = { ...this.downloadBehavior, events: false };
  }

  receive(socket: DemoSocket, data: string): void {
    const client = this.clients.get(socket);
    if (!client) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const m = rec(raw);
    const id = num(m, "id");
    const method = str(m, "method");
    if (id === undefined || !method) return;
    const msg: Incoming = { id, method, params: rec(m.params), sessionId: str(m, "sessionId") };
    queueMicrotask(() => void this.dispatch(client, msg));
  }

  private async dispatch(client: Client, msg: Incoming): Promise<void> {
    const post: (() => void)[] = [];
    let reply: object;
    try {
      const result = await this.command(client, msg, post);
      reply = { id: msg.id, result };
    } catch (e) {
      const error = e instanceof Fail ? { code: e.code, message: e.message } : { code: -32000, message: e instanceof Error ? e.message : String(e) };
      reply = { id: msg.id, error };
      post.length = 0;
    }
    if (this.disposed || !this.clients.has(client.socket)) return;
    client.socket.deliver(msg.sessionId ? { ...reply, sessionId: msg.sessionId } : reply);
    for (const fn of post) fn();
  }

  private emit<E extends keyof CdpEvents>(client: Client, method: E, params: CdpEvents[E], sessionId?: string): void {
    if (this.disposed || !this.clients.has(client.socket)) return;
    client.socket.deliver(sessionId ? { method, params, sessionId } : { method, params });
  }

  /** An event of a tab, to every session attached to it (each client gets its own copy). */
  private toSessions<E extends keyof CdpEvents>(t: Target, method: E, params: CdpEvents[E], only?: (s: Session) => boolean): void {
    for (const s of [...t.sessions]) if (!only || only(s)) this.emit(s.client, method, params, s.id);
  }

  private broadcast<E extends keyof CdpEvents>(method: E, params: CdpEvents[E]): void {
    for (const c of [...this.clients.values()]) if (c.discover) this.emit(c, method, params);
  }

  private info(t: Target): TargetInfo {
    const info: TargetInfo = { targetId: t.id, type: "page", title: t.page.title, url: t.url, attached: t.sessions.size > 0, browserContextId: CONTEXT_ID };
    if (t.openerId) info.openerId = t.openerId;
    return info;
  }

  /** `Target.targetInfoChanged` when the url or title changed since discovery clients last heard. */
  private announce(t: Target): void {
    if (t.announced.url === t.url && t.announced.title === t.page.title) return;
    t.announced = { url: t.url, title: t.page.title };
    if (this.targets.has(t.id)) this.broadcast("Target.targetInfoChanged", { targetInfo: this.info(t) });
  }

  private after(ms: number, fn: () => void): () => void {
    const cancel = config.clock.after(ms, () => {
      this.timers.delete(cancel);
      if (!this.disposed) fn();
    });
    this.timers.add(cancel);
    return () => {
      cancel();
      this.timers.delete(cancel);
    };
  }

  private id32(): string {
    return this.rng.hex(32).toUpperCase();
  }

  // ------------------------------------------------ commands

  private async command(client: Client, msg: Incoming, post: (() => void)[]): Promise<unknown> {
    const { method, params: q } = msg;
    if (msg.sessionId !== undefined) {
      const s = client.sessions.get(msg.sessionId);
      if (!s) throw new Fail(-32000, `Session with given id not found.`);
      if (!method.startsWith("Target.") && !method.startsWith("Browser.")) return this.sessionCommand(s, method, q, post);
    }
    switch (method) {
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: PRODUCT, userAgent: USER_AGENT, jsVersion: "15.6.112" };
      case "Browser.setDownloadBehavior": {
        const behavior = oneOf(["deny", "allow", "allowAndName", "default"], q.behavior);
        if (!behavior) throw invalid("behavior");
        this.downloadBehavior = { behavior, path: str(q, "downloadPath"), events: q.eventsEnabled === true, client };
        return {};
      }
      case "Browser.cancelDownload":
        this.downloads.get(str(q, "guid") ?? "")?.();
        return {};
      case "Target.setDiscoverTargets": {
        const was = client.discover;
        client.discover = q.discover === true;
        if (client.discover && !was) for (const t of this.targets.values()) this.emit(client, "Target.targetCreated", { targetInfo: this.info(t) });
        return {};
      }
      case "Target.getTargets":
        return { targetInfos: [...this.targets.values()].map((t) => this.info(t)) };
      case "Target.attachToTarget": {
        const t = this.target(q);
        const s: Session = { id: this.id32(), target: t, client, cast: null, frames: 0, intercept: false, runtime: false, network: false, log: false };
        client.sessions.set(s.id, s);
        t.sessions.add(s);
        return { sessionId: s.id };
      }
      case "Target.detachFromTarget": {
        const s = client.sessions.get(str(q, "sessionId") ?? "");
        if (!s) throw new Fail(-32000, "No session with given id");
        this.dropSession(s);
        post.push(() => this.emit(client, "Target.detachedFromTarget", { sessionId: s.id, targetId: s.target.id }));
        return {};
      }
      case "Target.createTarget": {
        const url = str(q, "url");
        if (url === undefined) throw invalid("url");
        const window = q.newWindow === true ? Math.max(0, ...this.windows.keys(), ...[...this.targets.values()].map((t) => t.window)) + 1 : 1;
        const t = this.open(url || "about:blank", { window, background: q.background === true, transition: "typed" });
        return { targetId: t.id };
      }
      case "Target.closeTarget": {
        const t = this.target(q);
        post.push(() => this.close(t));
        return { success: true };
      }
      case "Target.activateTarget":
        this.show(this.target(q));
        return {};
    }
    throw new Fail(-32601, `'${method}' wasn't found`);
  }

  private target(q: Record<string, unknown>): Target {
    const t = this.targets.get(str(q, "targetId") ?? "");
    if (!t) throw new Fail(-32000, "No target with given id found");
    return t;
  }

  private async sessionCommand(s: Session, method: string, q: Record<string, unknown>, post: (() => void)[]): Promise<unknown> {
    const t = s.target;
    switch (method) {
      case "Page.enable":
      case "Emulation.setFocusEmulationEnabled":
        return {};
      case "Runtime.enable":
      case "Runtime.disable":
        s.runtime = method === "Runtime.enable";
        return {};
      case "Network.enable":
      case "Network.disable":
        s.network = method === "Network.enable";
        return {};
      case "Log.enable":
      case "Log.disable":
        s.log = method === "Log.enable";
        return {};
      case "Page.setInterceptFileChooserDialog":
        s.intercept = q.enabled === true;
        return {};
      case "Page.navigate": {
        const url = str(q, "url");
        if (!url) throw invalid("url");
        if (url !== "about:blank" && !URL.canParse(url)) throw new Fail(-32000, "Cannot navigate to invalid URL");
        post.push(() => this.navigate(t, url, "typed"));
        return { frameId: t.id };
      }
      case "Page.reload":
        post.push(() => this.startLoad(t, { url: t.url, transition: "reload", reload: true }));
        return {};
      case "Page.stopLoading":
        if (t.loading) {
          t.loading();
          t.loading = null;
          post.push(() => this.toSessions(t, "Page.frameStoppedLoading", { frameId: t.id }));
        }
        return {};
      case "Page.getNavigationHistory":
        return { currentIndex: t.index, entries: t.entries.map((e) => ({ ...e })) };
      case "Page.navigateToHistoryEntry": {
        const index = t.entries.findIndex((e) => e.id === num(q, "entryId"));
        if (index < 0) throw new Fail(-32000, "No entry with passed id");
        post.push(() => this.history(t, index));
        return {};
      }
      case "Page.startScreencast": {
        const format = oneOf(["jpeg", "png"], q.format) ?? "png";
        s.cast = { format, quality: num(q, "quality") ?? 80, maxWidth: num(q, "maxWidth"), maxHeight: num(q, "maxHeight"), unacked: null, dirty: true, painting: false };
        post.push(() => void this.pump(s));
        return {};
      }
      case "Page.stopScreencast":
        s.cast = null;
        return {};
      case "Page.screencastFrameAck": {
        const c = s.cast;
        if (c && c.unacked === num(q, "sessionId")) {
          c.unacked = null;
          post.push(() => void this.pump(s));
        }
        return {};
      }
      case "Page.captureScreenshot": {
        const format = oneOf(["jpeg", "png"], q.format) ?? "png";
        return { data: await config.paint(this.frameRequest(t, format, num(q, "quality") ?? 80)) };
      }
      case "Page.createIsolatedWorld":
        return { executionContextId: ++this.contextSeq + 100 };
      case "Page.handleJavaScriptDialog": {
        if (!t.dialog) throw new Fail(-32000, "No dialog is showing");
        const accept = q.accept === true;
        const input = str(q, "promptText");
        post.push(() => this.closeDialog(t, accept, input));
        return {};
      }
      case "Emulation.setDeviceMetricsOverride":
        t.viewport = { width: num(q, "width") || DEFAULT_VIEWPORT.width, height: num(q, "height") || DEFAULT_VIEWPORT.height, scale: num(q, "deviceScaleFactor") || 1, mobile: q.mobile === true };
        this.relayout(t);
        return {};
      case "Emulation.clearDeviceMetricsOverride":
        t.viewport = { ...DEFAULT_VIEWPORT };
        this.relayout(t);
        return {};
      case "Input.dispatchMouseEvent": {
        const type = oneOf(MOUSE_TYPES, q.type);
        if (!type) throw invalid("type");
        this.mouse(t, { type, x: num(q, "x") ?? 0, y: num(q, "y") ?? 0, modifiers: num(q, "modifiers") ?? 0, button: oneOf(BUTTONS, q.button) ?? "none", buttons: num(q, "buttons") ?? 0, clickCount: num(q, "clickCount") ?? 0, deltaX: num(q, "deltaX"), deltaY: num(q, "deltaY") });
        return {};
      }
      case "Input.dispatchKeyEvent": {
        const type = oneOf(KEY_TYPES, q.type);
        if (!type) throw invalid("type");
        const commands = Array.isArray(q.commands) ? q.commands.filter((c): c is string => typeof c === "string") : undefined;
        this.key(t, { type, modifiers: num(q, "modifiers") ?? 0, key: str(q, "key") ?? "", code: str(q, "code") ?? "", windowsVirtualKeyCode: num(q, "windowsVirtualKeyCode") ?? 0, text: str(q, "text"), commands });
        return {};
      }
      case "Input.insertText":
        if (!t.dialog) this.insert(t, str(q, "text") ?? "");
        return {};
      case "Input.imeSetComposition":
        if (!t.dialog) this.compose(t, str(q, "text") ?? "");
        return {};
      case "Runtime.evaluate":
        return { result: this.evaluate(t, str(q, "expression") ?? "") };
      case "Network.loadNetworkResource": {
        const site = iconSite(str(q, "url") ?? "");
        if (!site) return { resource: { success: false, httpStatusCode: 404 } };
        let icon = this.icons.get(site.host);
        if (!icon) this.icons.set(site.host, (icon = config.icon(site)));
        const handle = `demo-stream-${++this.streamSeq}`;
        this.streams.set(handle, { data: await icon, read: false });
        return { resource: { success: true, httpStatusCode: 200, stream: handle, headers: { "Content-Type": "image/png" } } };
      }
      case "IO.read": {
        const stream = this.streams.get(str(q, "handle") ?? "");
        if (!stream) throw new Fail(-32000, "Invalid stream handle");
        const data = stream.read ? "" : stream.data;
        stream.read = true;
        return { base64Encoded: true, data, eof: true };
      }
      case "IO.close":
        this.streams.delete(str(q, "handle") ?? "");
        return {};
      case "Network.getResponseBody": {
        const body = this.bodies.get(str(q, "requestId") ?? "");
        if (body === undefined) throw new Fail(-32000, "No resource with given identifier found");
        return { body, base64Encoded: false };
      }
      case "DOM.setFileInputFiles": {
        const files = Array.isArray(q.files) ? q.files.filter((f): f is string => typeof f === "string") : [];
        const field = this.scene(t).hits.find((h) => h.role === "file" && h.backendNodeId === num(q, "backendNodeId"));
        if (!field) throw new Fail(-32000, "No node with given id found");
        t.state.files[field.id] = (field.multiple ? files : files.slice(0, 1)).map((f) => f.split(/[\\/]/).pop() ?? f);
        this.repaint(t);
        return {};
      }
    }
    throw new Fail(-32601, `'${method}' wasn't found`);
  }

  // ------------------------------------------------ targets and windows

  private makeTarget(id: string, url: string, window: number, openerId: string | undefined, transition: string): Target {
    const page = pageFor(url, this.memory);
    const t: Target = {
      id,
      window,
      openerId,
      url: page.frame === "blank" ? "about:blank" : url,
      page,
      state: freshState(page),
      scene: null,
      entries: [],
      index: 0,
      viewport: { ...DEFAULT_VIEWPORT },
      sessions: new Set(),
      loading: null,
      dialog: null,
      announced: { url, title: page.title },
      agent: { cycle: 0, step: 0 },
    };
    t.entries.push({ id: ++this.entrySeq, url: t.url, title: page.title, transitionType: transition });
    t.announced = { url: t.url, title: page.title };
    this.targets.set(id, t);
    return t;
  }

  private open(url: string, o: { window: number; background: boolean; openerId?: string; transition: string }): Target {
    const t = this.makeTarget(this.id32(), url, o.window, o.openerId, o.transition);
    this.broadcast("Target.targetCreated", { targetInfo: this.info(t) });
    if (!o.background || !this.windows.has(o.window)) this.show(t);
    return t;
  }

  /** Makes a tab its window's shown one: its screencasts get a fresh frame, the old one's pause. */
  private show(t: Target): void {
    if (this.windows.get(t.window) === t.id) return;
    this.windows.set(t.window, t.id);
    for (const s of t.sessions) {
      if (!s.cast) continue;
      s.cast.dirty = true;
      void this.pump(s);
    }
  }

  private visible(t: Target): boolean {
    return this.windows.get(t.window) === t.id && this.targets.has(t.id);
  }

  private dropSession(s: Session): void {
    s.client.sessions.delete(s.id);
    s.target.sessions.delete(s);
    s.cast = null;
  }

  private close(t: Target): void {
    if (!this.targets.has(t.id)) return;
    const order = [...this.targets.values()].filter((x) => x.window === t.window);
    const at = order.indexOf(t);
    t.loading?.();
    t.loading = null;
    this.targets.delete(t.id);
    this.broadcast("Target.targetDestroyed", { targetId: t.id });
    for (const s of [...t.sessions]) {
      this.dropSession(s);
      this.emit(s.client, "Target.detachedFromTarget", { sessionId: s.id, targetId: t.id });
    }
    if (this.windows.get(t.window) !== t.id) return;
    this.windows.delete(t.window);
    const opener = t.openerId ? this.targets.get(t.openerId) : undefined;
    const next = opener && opener.window === t.window ? opener : (order[at + 1] ?? order[at - 1]);
    if (next && next !== t) this.show(next);
  }

  // ------------------------------------------------ navigation

  private navigate(t: Target, url: string, transition: string): void {
    if (sameDocument(t.url, url)) {
      t.entries = t.entries.slice(0, t.index + 1);
      t.entries.push({ id: ++this.entrySeq, url, title: t.page.title, transitionType: transition });
      t.index = t.entries.length - 1;
      this.withinDocument(t, url);
      return;
    }
    this.startLoad(t, { url, transition });
  }

  private history(t: Target, index: number): void {
    const e = t.entries[index];
    if (!e) return;
    if (sameDocument(t.url, e.url) || (withoutHash(t.url) === withoutHash(e.url) && t.url.includes("#"))) {
      t.index = index;
      this.withinDocument(t, e.url);
      return;
    }
    this.startLoad(t, { url: e.url, transition: e.transitionType, entryIndex: index });
  }

  private withinDocument(t: Target, url: string): void {
    t.url = url;
    this.scrollToFragment(t);
    this.toSessions(t, "Page.navigatedWithinDocument", { frameId: t.id, url });
    this.announce(t);
    this.repaint(t);
  }

  private startLoad(t: Target, load: Load): void {
    t.loading?.();
    this.toSessions(t, "Page.frameStartedLoading", { frameId: t.id });
    t.loading = this.after(LOAD_MS, () => this.commit(t, load));
  }

  private commit(t: Target, load: Load): void {
    t.loading = null;
    if (!this.targets.has(t.id)) return;
    const page = pageFor(load.url, this.memory);
    const url = page.frame === "blank" ? "about:blank" : load.url;
    // A navigation dismisses the dialog its page had open.
    if (t.dialog) this.toSessions(t, "Page.javascriptDialogClosed", { result: false, userInput: "" });
    t.page = page;
    t.state = freshState(page);
    t.scene = null;
    t.dialog = null;
    t.url = url;
    if (load.entryIndex !== undefined) t.index = load.entryIndex;
    else if (!load.reload) {
      t.entries = t.entries.slice(0, t.index + 1);
      t.entries.push({ id: ++this.entrySeq, url, title: page.title, transitionType: load.transition });
      t.index = t.entries.length - 1;
    }
    const entry = t.entries[t.index];
    if (entry) {
      entry.url = url;
      entry.title = page.title;
      if (load.reload) entry.transitionType = "reload";
    }
    this.documentRequest(t, page, url);
    this.scrollToFragment(t);
    const hashAt = url.indexOf("#");
    const frame: CdpEvents["Page.frameNavigated"]["frame"] = { id: t.id, url: withoutHash(url) };
    if (hashAt >= 0) frame.urlFragment = url.slice(hashAt);
    this.toSessions(t, "Page.frameNavigated", { frame, type: "Navigation" });
    this.announce(t);
    this.toSessions(t, "Page.loadEventFired", { timestamp: config.clock.now() / 1000 });
    this.toSessions(t, "Page.frameStoppedLoading", { frameId: t.id });
    this.repaint(t);
  }

  /**
   * The Document request of a navigation as sessions with `Network.enable` see it: answered (200,
   * or the error status of a missing page) or failed with Chrome's network error. Both kinds of
   * error reach the console too ("Failed to load resource"), as in Chrome.
   */
  private documentRequest(t: Target, page: Page, url: string): void {
    if (page.frame === "blank") return;
    const requestId = `demo-req-${++this.requestSeq}`;
    const request = withoutHash(url);
    const net = (s: Session) => s.network;
    const failed = (what: string) => this.toSessions(t, "Log.entryAdded", { entry: { source: "network", level: "error", text: `Failed to load resource: ${what}`, url: request } }, (s) => s.log);
    this.toSessions(t, "Network.requestWillBeSent", { requestId, request: { url: request, method: "GET" }, type: "Document" }, net);
    if (page.netError) {
      const errorText = `net::${page.netError}`;
      this.toSessions(t, "Network.loadingFailed", { requestId, errorText, type: "Document" }, net);
      failed(errorText);
      return;
    }
    const status = page.status ?? 200;
    const statusText = status === 404 ? "Not Found" : "OK";
    if (status >= 400) this.bodies.set(requestId, `<!doctype html><title>${page.title}</title><h1>${status} · Page not found</h1>`);
    this.toSessions(t, "Network.responseReceived", { requestId, type: "Document", response: { url: request, status, statusText } }, net);
    this.toSessions(t, "Network.loadingFinished", { requestId }, net);
    if (status >= 400) failed(`the server responded with a status of ${status} (${statusText})`);
  }

  private scrollToFragment(t: Target): void {
    const hashAt = t.url.indexOf("#");
    const y = hashAt >= 0 ? this.scene(t).anchors[decodeURIComponent(t.url.slice(hashAt + 1))] : undefined;
    if (y !== undefined) this.scrollTo(t, y - 16);
  }

  // ------------------------------------------------ layout and frames

  private scene(t: Target): Scene {
    if (!t.scene) {
      const measure = config.measure ?? (this.defaultMeasure ??= defaultMeasure());
      t.scene = layoutPage(t.page, t.state, t.viewport, measure);
      const max = Math.max(0, t.scene.height - t.viewport.height);
      if (t.state.scrollY > max) t.state.scrollY = max;
    }
    return t.scene;
  }

  private relayout(t: Target): void {
    t.scene = null;
    this.scene(t);
    this.repaint(t);
  }

  /** The page changed: lay it out again and send its screencasts a frame (coalesced, one unacknowledged at a time). */
  private repaint(t: Target): void {
    t.scene = null;
    for (const s of t.sessions) {
      if (!s.cast) continue;
      s.cast.dirty = true;
      void this.pump(s);
    }
  }

  private frameRequest(t: Target, format: "jpeg" | "png", quality: number, maxWidth?: number, maxHeight?: number): FrameRequest {
    const scene = this.scene(t);
    const { width, height, scale } = t.viewport;
    const k = Math.min(scale, maxWidth ? maxWidth / width : Infinity, maxHeight ? maxHeight / height : Infinity);
    return { scene, scrollY: t.state.scrollY, viewport: { width, height }, pixelWidth: Math.max(1, Math.round(width * k)), pixelHeight: Math.max(1, Math.round(height * k)), format, quality };
  }

  private async pump(s: Session): Promise<void> {
    const c = s.cast;
    if (!c || !c.dirty || c.painting || c.unacked !== null || this.disposed || !this.visible(s.target)) return;
    c.dirty = false;
    c.painting = true;
    const req = this.frameRequest(s.target, c.format, c.quality, c.maxWidth, c.maxHeight);
    let data: string;
    try {
      data = await config.paint(req);
    } catch (e) {
      console.error("[demo browser] painting a frame failed", e);
      return;
    } finally {
      c.painting = false;
    }
    if (s.cast !== c || !s.client.sessions.has(s.id)) return;
    if (!this.visible(s.target)) {
      c.dirty = true;
      return;
    }
    c.unacked = ++s.frames;
    const metadata = { offsetTop: 0, pageScaleFactor: 1, deviceWidth: req.viewport.width, deviceHeight: req.viewport.height, scrollOffsetX: 0, scrollOffsetY: req.scrollY, timestamp: config.clock.now() / 1000 };
    this.emit(s.client, "Page.screencastFrame", { data, metadata, sessionId: s.frames }, s.id);
  }

  // ------------------------------------------------ input

  private scrollTo(t: Target, y: number): boolean {
    const max = Math.max(0, this.scene(t).height - t.viewport.height);
    const next = Math.round(Math.min(max, Math.max(0, y)));
    if (next === t.state.scrollY) return false;
    t.state.scrollY = next;
    return true;
  }

  private scrollBy(t: Target, dy: number): boolean {
    const moved = this.scrollTo(t, t.state.scrollY + dy);
    if (moved) this.repaint(t);
    return moved;
  }

  private mouse(t: Target, p: MouseEventParams): void {
    if (t.dialog) return;
    const s = t.state;
    const hit = hitAt(this.scene(t), p.x, p.y + s.scrollY);
    switch (p.type) {
      case "mouseMoved": {
        const id = hit?.id ?? null;
        if (id !== s.hover) {
          s.hover = id;
          this.repaint(t);
        }
        return;
      }
      case "mouseWheel":
        this.scrollBy(t, p.deltaY ?? 0);
        return;
      case "mousePressed":
        if (p.button !== "left" && p.button !== "middle") return;
        s.pressed = hit?.id ?? null;
        if (p.button === "left") {
          s.focusRing = false;
          if (hit?.role === "field") this.focusField(t, hit.id, p.clickCount >= 2);
          else if (!hit || hit.role === "link") this.blur(t);
        }
        this.repaint(t);
        return;
      case "mouseReleased": {
        const pressed = s.pressed;
        s.pressed = null;
        if (hit && pressed === hit.id) this.click(t, hit, p.button, p.modifiers);
        this.repaint(t);
        return;
      }
    }
  }

  private blur(t: Target): void {
    t.state.focus = null;
    t.state.composition = "";
  }

  private focusField(t: Target, id: string, selectAll: boolean): void {
    const s = t.state;
    const len = (s.values[id] ?? "").length;
    if (s.focus !== id || selectAll) {
      s.caret = len;
      s.anchor = selectAll ? 0 : len;
    }
    s.focus = id;
    s.composition = "";
  }

  private click(t: Target, hit: Hit, button: MouseButtonName, modifiers: number): void {
    const s = t.state;
    if (hit.role === "link") {
      if (button !== "left" && button !== "middle") return;
      const url = absolute(hit.href ?? "", t.url);
      if (hit.download) return this.download(t, url, hit.download.filename, hit.download.bytes);
      if (button === "middle" || (modifiers & (MOD_CTRL | MOD_META)) !== 0) {
        this.open(url, { window: t.window, background: (modifiers & MOD_SHIFT) === 0, openerId: t.id, transition: "link" });
        return;
      }
      if (hit.target === "_blank") {
        this.open(url, { window: t.window, background: false, openerId: t.id, transition: "link" });
        return;
      }
      this.navigate(t, url, "link");
      return;
    }
    if (button !== "left") return;
    switch (hit.role) {
      case "field":
        return;
      case "checkbox":
        s.focus = hit.id;
        s.checked[hit.id] = !s.checked[hit.id];
        return;
      case "file":
        s.focus = hit.id;
        this.chooseFiles(t, hit);
        return;
      case "button":
        s.focus = hit.id;
        if (hit.action) this.run(t, hit.action);
        return;
    }
  }

  private chooseFiles(t: Target, hit: Hit): void {
    const params: CdpEvents["Page.fileChooserOpened"] = { frameId: t.id, mode: hit.multiple ? "selectMultiple" : "selectSingle" };
    if (hit.backendNodeId !== undefined) params.backendNodeId = hit.backendNodeId;
    this.toSessions(t, "Page.fileChooserOpened", params, (x) => x.intercept);
  }

  private run(t: Target, action: Action): void {
    switch (action.kind) {
      case "submit":
        this.submit(t);
        return;
      case "reload":
        this.startLoad(t, { url: t.url, transition: "reload", reload: true });
        return;
      case "upload":
        this.upload(t, action.field);
        return;
      case "dialog": {
        t.dialog = { type: action.type, action };
        const params: CdpEvents["Page.javascriptDialogOpening"] = { url: t.url, message: action.message, type: action.type };
        if (action.type === "prompt") params.defaultPrompt = action.defaultPrompt ?? "";
        t.state.pressed = null;
        t.state.hover = null;
        this.toSessions(t, "Page.javascriptDialogOpening", params);
        return;
      }
    }
  }

  private closeDialog(t: Target, accept: boolean, promptText: string | undefined): void {
    const d = t.dialog;
    if (!d) return;
    t.dialog = null;
    const input = d.type === "prompt" && accept ? (promptText ?? d.action.defaultPrompt ?? "") : "";
    this.toSessions(t, "Page.javascriptDialogClosed", { result: d.type === "alert" || accept, userInput: input });
    const accepted = d.type === "alert" || (accept && (d.type !== "prompt" || input.trim() !== ""));
    const banner = accepted ? d.action.accepted : d.action.dismissed;
    t.state.banner = banner ? { text: banner.text.replace("{input}", input.trim()), tone: banner.tone } : null;
    this.repaint(t);
  }

  private submit(t: Target): void {
    const next = t.page.form?.(t.state.values, t.state.checked);
    if (!next) return;
    if (next.remember) Object.assign(this.memory, next.remember);
    this.navigate(t, next.url, "form_submit");
  }

  /** The shop's upload: files → 201 and a banner; none → the page's request fails with a 500 (console error, exception). */
  private upload(t: Target, field: string): void {
    const files = t.state.files[field] ?? [];
    const url = new URL("/api/invoices", t.url).href;
    const requestId = `demo-req-${++this.requestSeq}`;
    const now = config.clock.now();
    const net = (x: Session) => x.network;
    const ok = files.length > 0;
    this.toSessions(t, "Network.requestWillBeSent", { requestId, request: { url, method: "POST" }, type: "Fetch" }, net);
    this.bodies.set(requestId, ok ? JSON.stringify({ uploaded: files.length, ids: files.map((_, i) => `inv_${4810 + i}`) }) : JSON.stringify({ error: "internal_error", message: "multipart body has no files" }));
    this.toSessions(t, "Network.responseReceived", { requestId, type: "Fetch", response: { url, status: ok ? 201 : 500, statusText: ok ? "Created" : "Internal Server Error" } }, net);
    this.toSessions(t, "Network.loadingFinished", { requestId }, net);
    if (ok) {
      t.state.banner = { text: `${files.length} ${files.length === 1 ? "file" : "files"} uploaded`, tone: "success" };
    } else {
      const stackTrace = { callFrames: [{ functionName: "upload", url: "https://shop.example.com/assets/upload.js", lineNumber: 44, columnNumber: 11 }] };
      this.toSessions(t, "Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", url } }, (x) => x.log);
      this.toSessions(t, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "Upload failed:" }, { type: "number", value: 500, description: "500" }], timestamp: now, stackTrace }, (x) => x.runtime);
      this.toSessions(t, "Runtime.exceptionThrown", { timestamp: now, exceptionDetails: { text: "Uncaught (in promise)", url: stackTrace.callFrames[0]?.url, lineNumber: 44, columnNumber: 11, exception: { type: "object", description: "Error: Upload failed with status 500\n    at upload (https://shop.example.com/assets/upload.js:45:12)" }, stackTrace } }, (x) => x.runtime);
      t.state.banner = { text: "Upload failed: choose at least one file and try again.", tone: "danger" };
    }
    this.repaint(t);
  }

  private download(t: Target, url: string, filename: string, bytes: number): void {
    const b = this.downloadBehavior;
    if (b?.behavior === "deny") return;
    const client = b?.events ? b.client : null;
    const r = this.rng;
    const guid = `${r.hex(8)}-${r.hex(4)}-4${r.hex(3)}-a${r.hex(3)}-${r.hex(12)}`;
    const send = (state: "inProgress" | "completed" | "canceled", received: number) => {
      if (!client) return;
      const params: CdpEvents["Browser.downloadProgress"] = { guid, totalBytes: bytes, receivedBytes: received, state };
      if (state === "completed") params.filePath = `${(b?.path ?? DOWNLOADS_DIR).replace(/\/+$/, "")}/${filename}`;
      this.emit(client, "Browser.downloadProgress", params);
    };
    if (client) this.emit(client, "Browser.downloadWillBegin", { frameId: t.id, guid, url, suggestedFilename: filename });
    send("inProgress", 0);
    let tick = 0;
    let cancelTick = () => {};
    const step = () => {
      tick++;
      if (tick >= DOWNLOAD_TICKS) {
        this.downloads.delete(guid);
        send("completed", bytes);
        return;
      }
      send("inProgress", Math.round((bytes * tick) / DOWNLOAD_TICKS));
      cancelTick = this.after(DOWNLOAD_TICK_MS, step);
    };
    cancelTick = this.after(DOWNLOAD_TICK_MS, step);
    this.downloads.set(guid, () => {
      cancelTick();
      this.downloads.delete(guid);
      send("canceled", Math.round((bytes * tick) / DOWNLOAD_TICKS));
    });
  }

  // ------------------------------------------------ keys and text

  private focused(t: Target): Hit | undefined {
    return t.state.focus ? findHit(this.scene(t), t.state.focus) : undefined;
  }

  private key(t: Target, p: KeyEventParams): void {
    if (t.dialog || p.type === "keyUp") return;
    const s = t.state;
    const focus = this.focused(t);
    const ctrl = (p.modifiers & (MOD_CTRL | MOD_META)) !== 0;
    const shift = (p.modifiers & MOD_SHIFT) !== 0;
    if (p.text && (p.type === "keyDown" || p.type === "char")) {
      if (p.text === "\r" || p.text === "\n") {
        if (p.type === "keyDown") this.enter(t, focus);
        return;
      }
      if (p.text === " " && focus && focus.role !== "field") return this.press(t, focus);
      if (focus?.role === "field" && !ctrl) return this.insert(t, p.text);
      if (!focus && p.text === " ") this.scrollBy(t, (shift ? -1 : 1) * Math.round(t.viewport.height * 0.875));
      return;
    }
    if (p.key === "Tab") return this.tab(t, shift ? -1 : 1);
    if (p.key === "Enter") return this.enter(t, focus);
    if (focus?.role === "field") {
      this.editKey(t, p, ctrl, shift);
      return;
    }
    if (focus && p.key === " ") return this.press(t, focus);
    const page = Math.round(t.viewport.height * 0.875);
    const by: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, " ": shift ? -page : page, Home: -s.scrollY, End: this.scene(t).height };
    const dy = by[p.key];
    if (dy !== undefined) this.scrollBy(t, dy);
  }

  private editKey(t: Target, p: KeyEventParams, ctrl: boolean, shift: boolean): void {
    const s = t.state;
    const id = s.focus;
    if (!id || s.composition) return;
    const v = s.values[id] ?? "";
    const [a, z] = s.anchor <= s.caret ? [s.anchor, s.caret] : [s.caret, s.anchor];
    const move = (to: number) => {
      s.caret = Math.max(0, Math.min(v.length, to));
      if (!shift) s.anchor = s.caret;
    };
    if ((ctrl && p.key.toLowerCase() === "a") || p.commands?.includes("selectAll")) {
      s.anchor = 0;
      s.caret = v.length;
    } else if (p.key === "Backspace" || p.key === "Delete") {
      if (a !== z) this.replace(t, "");
      else {
        const back = p.key === "Backspace";
        const at = back ? a : a + 1;
        if (back ? at <= 0 : at > v.length) return;
        const width = back && at >= 2 && /[\uDC00-\uDFFF]/.test(v.charAt(at - 1)) ? 2 : 1;
        s.values[id] = v.slice(0, at - width) + v.slice(at);
        s.caret = s.anchor = at - width;
      }
    } else if (p.key === "ArrowLeft") move(a !== z && !shift ? a : s.caret - 1);
    else if (p.key === "ArrowRight") move(a !== z && !shift ? z : s.caret + 1);
    else if (p.key === "Home" || p.key === "ArrowUp") move(0);
    else if (p.key === "End" || p.key === "ArrowDown") move(v.length);
    else return;
    this.repaint(t);
  }

  private replace(t: Target, text: string): void {
    const s = t.state;
    if (!s.focus) return;
    const v = s.values[s.focus] ?? "";
    const [a, z] = s.anchor <= s.caret ? [s.anchor, s.caret] : [s.caret, s.anchor];
    s.values[s.focus] = v.slice(0, a) + text + v.slice(z);
    s.caret = s.anchor = a + text.length;
    s.composition = "";
  }

  private insert(t: Target, text: string): void {
    if (this.focused(t)?.role !== "field" || !text) return;
    this.replace(t, text.replace(/[\r\n]+/g, " "));
    this.repaint(t);
  }

  private compose(t: Target, text: string): void {
    const s = t.state;
    if (this.focused(t)?.role !== "field") return;
    if (text && !s.composition && s.anchor !== s.caret) this.replace(t, "");
    s.composition = text;
    this.repaint(t);
  }

  /** Enter: a text field or checkbox submits its form (implicit submission), a control is pressed. */
  private enter(t: Target, focus: Hit | undefined): void {
    if (focus?.role === "field" || focus?.role === "checkbox") this.submit(t);
    else if (focus) this.press(t, focus);
  }

  /** Enter or Space on a focused control. */
  private press(t: Target, focus: Hit): void {
    if (focus.role === "button" && focus.action) this.run(t, focus.action);
    else if (focus.role === "checkbox") t.state.checked[focus.id] = !t.state.checked[focus.id];
    else if (focus.role === "file") this.chooseFiles(t, focus);
    this.repaint(t);
  }

  private tab(t: Target, dir: 1 | -1): void {
    const list = focusables(this.scene(t));
    if (!list.length) return;
    const s = t.state;
    const at = list.findIndex((h) => h.id === s.focus);
    const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length];
    if (!next) return;
    s.focusRing = true;
    s.composition = "";
    if (next.role === "field") this.focusField(t, next.id, true);
    else s.focus = next.id;
    this.reveal(t, next);
    this.repaint(t);
  }

  /** Scrolls an element into view (a third from the top) when it is not. */
  private reveal(t: Target, hit: Hit): void {
    const top = t.state.scrollY;
    const r = hit.rect;
    if (r.y >= top + 8 && r.y + r.height <= top + t.viewport.height - 8) return;
    if (this.scrollTo(t, r.y - Math.round(t.viewport.height / 3))) this.repaint(t);
  }

  // ------------------------------------------------ scripts

  private evaluate(t: Target, expression: string): { type: string; value?: unknown; subtype?: string } {
    const s = t.state;
    switch (scriptName(expression)) {
      case "favicon":
        return { type: "string", value: iconUrlOf(t.url) ?? "" };
      case "selection": {
        const f = this.focused(t);
        if (f?.role !== "field" || f.input?.type === "password") return { type: "string", value: "" };
        const v = s.values[f.id] ?? "";
        return { type: "string", value: v.slice(Math.min(s.anchor, s.caret), Math.max(s.anchor, s.caret)) };
      }
      case "cursor": {
        const at = /\((-?[\d.]+), (-?[\d.]+)\)\s*$/.exec(expression);
        const hit = at ? hitAt(this.scene(t), Number(at[1]), Number(at[2]) + s.scrollY) : undefined;
        return { type: "string", value: !hit ? "default" : hit.role === "field" ? "text" : "pointer" };
      }
      case "element": {
        const at = /\((-?[\d.]+|null), (-?[\d.]+|null)\)\s*$/.exec(expression);
        const point = at && at[1] !== "null" ? { x: Number(at[1]), y: Number(at[2]) } : null;
        const hit = point ? hitAt(this.scene(t), point.x, point.y + s.scrollY) : this.focused(t);
        return hit ? { type: "object", value: this.elementInfo(t, hit) } : { type: "object", subtype: "null", value: null };
      }
      case "measure": {
        const list: unknown = JSON.parse(/\((\[[^\]]*\])\)\s*$/.exec(expression)?.[1] ?? "[]");
        const refs: unknown[] = Array.isArray(list) ? list : [];
        const rects = refs.map((ref) => {
          const [doc, id] = typeof ref === "string" ? ref.split(":") : [];
          const hit = doc === String(this.documentOf(t)) && id ? findHit(this.scene(t), id) : undefined;
          return hit ? this.viewRect(t, hit) : null;
        });
        return { type: "object", value: { scroll: { x: 0, y: s.scrollY }, rects } };
      }
    }
    return { type: "undefined" };
  }

  /** Its document's number: refs of another document's elements name nothing here. */
  private documentOf(t: Target): number {
    let n = this.documents.get(t.state);
    if (n === undefined) this.documents.set(t.state, (n = ++this.documentSeq));
    return n;
  }

  /** Where the viewport shows a hit (its rectangle is in page px). */
  private viewRect(t: Target, hit: Hit): { x: number; y: number; width: number; height: number } {
    return { x: hit.rect.x, y: hit.rect.y - t.state.scrollY, width: hit.rect.width, height: hit.rect.height };
  }

  private elementInfo(t: Target, hit: Hit): Record<string, unknown> {
    const tag = hit.role === "link" ? "a" : hit.role === "button" ? "button" : "input";
    const type = hit.input?.type ?? (hit.role === "checkbox" ? "checkbox" : hit.role === "button" ? (hit.action?.kind === "submit" ? "submit" : "button") : undefined);
    return {
      tag,
      id: hit.id,
      name: hit.input?.name,
      type,
      label: hit.label,
      textLabel: (tag !== "input" && !!hit.label) || undefined,
      href: hit.role === "link" && hit.href ? absolute(hit.href, t.url) : undefined,
      autocomplete: hit.input?.autocomplete,
      selector: `#${hit.id}`,
      sensitive: sensitiveField(hit),
      rect: this.viewRect(t, hit),
      scroll: { x: 0, y: t.state.scrollY },
      ref: `${this.documentOf(t)}:${hit.id}`,
    };
  }

  // ------------------------------------------------ agent

  agentStep(targetId: string): boolean {
    const t = this.targets.get(targetId);
    if (!t || this.disposed || t.dialog) return false;
    if (t.loading) return true;
    const script = agentScript(t.id, t.agent.cycle);
    if (!script) return this.gentleScroll(t);
    for (let tries = 0; tries < script.length; tries++) {
      const step = script[t.agent.step];
      const r = step ? this.runStep(t, step) : "skip";
      if (r !== "more" && ++t.agent.step >= script.length) {
        t.agent.step = 0;
        t.agent.cycle++;
      }
      if (r !== "skip") return true;
    }
    return this.gentleScroll(t);
  }

  private gentleScroll(t: Target): boolean {
    const max = this.scene(t).height - t.viewport.height;
    if (max <= 0) return false;
    return this.scrollBy(t, t.state.scrollY >= max ? -t.state.scrollY : 140);
  }

  /** One step through the page's input paths: "more" while a typing step has characters left, "skip" when it does not apply. */
  private runStep(t: Target, step: Step): "done" | "more" | "skip" {
    const vp = (hit: Hit) => ({ x: Math.round(hit.rect.x + hit.rect.width / 2), y: Math.round(hit.rect.y + hit.rect.height / 2 - t.state.scrollY) });
    const pointer = (type: MouseType, hit: Hit) => this.mouse(t, { type, ...vp(hit), modifiers: 0, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
    switch (step.do) {
      case "scroll":
        return this.scrollBy(t, step.by) ? "done" : "skip";
      case "back": {
        if (t.index <= 0) return "skip";
        this.history(t, t.index - 1);
        return "done";
      }
      case "hover":
      case "click": {
        const hit = findHit(this.scene(t), step.id);
        if (!hit) return "skip";
        this.reveal(t, hit);
        pointer("mouseMoved", hit);
        if (step.do === "click") {
          pointer("mousePressed", hit);
          pointer("mouseReleased", hit);
        }
        return "done";
      }
      case "type": {
        const hit = findHit(this.scene(t), step.id);
        if (!hit || hit.role !== "field") return "skip";
        if (t.state.focus !== hit.id) {
          this.reveal(t, hit);
          pointer("mouseMoved", hit);
          pointer("mousePressed", hit);
          pointer("mouseReleased", hit);
        }
        const value = t.state.values[hit.id] ?? "";
        if (!step.text.startsWith(value)) {
          this.focusField(t, hit.id, true);
          this.replace(t, "");
        }
        const typed = t.state.values[hit.id] ?? "";
        for (const ch of step.text.slice(typed.length, typed.length + 2)) {
          this.key(t, { type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, text: ch, modifiers: 0, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        }
        return (t.state.values[hit.id] ?? "") === step.text ? "done" : "more";
      }
    }
  }
}
