/**
 * The TeleFlock Browser as the panel sees it: one CDP connection to this device's browser (the
 * browser target's WebSocket from `BrowserStatus.wsUrl`), a flat session per tab, the tab list,
 * the shown tab's screencast, forwarded input, dialogs, file choosers, downloads and favicons.
 * One controller per window, created on first use; it connects while a browser surface is mounted
 * or an observer is registered, and disconnects a little after the last one goes.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { getBrowserStatus, onBrowserStatus } from "@/core";
import { DEMO_BROWSER_WS, DEMO_SEARCH_URL } from "@/core/demo/browserTabs";
import type { BrowserStatus, BrowserTabOwner } from "@/core/gen";
import { isWindowActive, isWindowVisible, onWindowActive, onWindowVisible } from "@/design";
import { CdpConnection, CdpError, type SocketFactory } from "./cdp/connection";
import type { CdpCommands, DialogType, DownloadState, KeyEventParams, MouseEventParams, ScreencastFrameMetadata, StackTrace, TargetInfo } from "./cdp/protocol";
import { FAVICON_SCRIPT, SELECTION_SCRIPT, cursorScript, elementScript, measureScript } from "./cdp/scripts";
import { decodeBase64, encodeBase64 } from "./frames";
import { FreshFrames } from "./fresh";
import {
  type BrowserEvent,
  type ElementInfo,
  type Measured,
  type ObservedOwner,
  browserObservers,
  emitBrowserEvent,
  emitBrowserFrame,
  observersWant,
  onObserverAdded,
  onObserversChanged,
  setCaptureImpl,
  setMeasureImpl,
} from "./observe";
import { ownerOf, type TabOwner, userDrives } from "./owners";
import { EMPTY_TABS, type TabAction, type TabsState, cycleTab, isTabTarget, popClosed, reduceTabs } from "./tabs";

export type ConnPhase = "idle" | "connecting" | "open" | "lost";

export interface PendingDialog {
  tabId: string;
  type: DialogType;
  message: string;
  defaultPrompt?: string;
  url: string;
  at: number;
}

export interface PendingChooser {
  tabId: string;
  multiple: boolean;
  backendNodeId: number;
  at: number;
}

export interface DownloadItem {
  guid: string;
  tabId?: string;
  owner: TabOwner;
  url: string;
  name: string;
  total: number;
  received: number;
  state: DownloadState;
  path?: string;
  at: number;
}

export interface BrowserUiState {
  phase: ConnPhase;
  /** Why the last connection attempt failed or the connection dropped. */
  error: string | null;
  tabs: TabsState;
  /** Open JavaScript dialogs by tab. */
  dialogs: Record<string, PendingDialog>;
  /** A page asked for files: the panel opens the app's file picker. */
  chooser: PendingChooser | null;
  downloads: DownloadItem[];
  /** Page zoom by tab (1 = 100 %). */
  zoom: Record<string, number>;
  /** CSS cursor over the shown page. */
  cursor: string;
  /** Bumped to put focus in the address bar (Ctrl+L, a new tab). */
  addressFocus: number;
  /** The shown tab whose picture is from before its page changed and no new frame came yet: the panel shows the loading state. */
  staleFrame: string | null;
}

/** One screencast frame of the shown tab; `ack` lets the browser send the next one. */
export interface Frame {
  tabId: string;
  data: string;
  meta: ScreencastFrameMetadata;
  at: number;
  ack(): void;
}

export interface SurfaceSize {
  /** CSS pixels of the area the page is drawn in. */
  width: number;
  height: number;
  dpr: number;
}

export interface Surface {
  setSize(size: SurfaceSize): void;
  setVisible(visible: boolean): void;
  release(): void;
}

const INITIAL: BrowserUiState = { phase: "idle", error: null, tabs: EMPTY_TABS, dialogs: {}, chooser: null, downloads: [], zoom: {}, cursor: "default", addressFocus: 0, staleFrame: null };

/** Screencast budget: at most this many pixels per frame (a 4K fullscreen panel is scaled down). */
const MAX_FRAME_PIXELS = 2560 * 1600;
/** The device pixel ratio pages render at, at most (sharper costs encode/decode time for nothing visible). */
const MAX_DPR = 2;
/** Keep the connection this long after the last surface goes (the split toggles, routes change). */
const LINGER_MS = 20_000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000];
/** Chrome tells discovery clients a page's title once, when the page commits (then it is the address), never when the page sets it: ask this often. */
const TITLE_POLL_MS = 1500;
/** A frame is due this long after the shown page changed (or a tab was shown) before its picture counts as stale. */
const STALE_FRAME_MS = 700;
const FAVICON_MAX_BYTES = 256 * 1024;
const WORLD = "teleflock";
const DOWNLOADS_KEPT = 20;

const MIME_BY_EXT: Record<string, string> = { ico: "image/x-icon", png: "image/png", svg: "image/svg+xml", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function observedOwner(owner: TabOwner): ObservedOwner | undefined {
  if (owner.kind === "user") return undefined;
  return { kind: "agent", hostId: owner.hostId, agentId: owner.agentId, agentName: owner.agentName, ...(owner.detached ? { detached: true } : {}), ...(owner.takenOver ? { takenOver: true } : {}) };
}

function stackLines(trace: StackTrace | undefined): string[] | undefined {
  const frames = trace?.callFrames.slice(0, 5);
  if (!frames?.length) return undefined;
  return frames.map((f) => `${f.functionName || "(anonymous)"} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
}

function sameOwnerEntry(a: BrowserTabOwner | undefined, b: BrowserTabOwner | undefined): boolean {
  if (!a || !b) return a === b;
  return a.hostId === b.hostId && a.agentId === b.agentId && a.lent === b.lent && a.takenOver === b.takenOver && a.detached === b.detached;
}

interface CastState {
  tabId: string;
  sessionId: string;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  nth: number;
}

interface NetRequest {
  url: string;
  method: string;
  type?: string;
  status?: number;
  statusText?: string;
}

type InputMethod = "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText" | "Input.imeSetComposition";

/** A tab's input in order (see `BrowserController.input`). */
interface InputLane {
  /** Settles once every input queued so far has been sent. */
  sent: Promise<void>;
  /** The last input sent; settles once the tab handled it. */
  handled: Promise<unknown>;
  /** Inputs queued and not sent yet. */
  queued: number;
}

/** What observers learn of an input: its event, with the element under `lookup` (a viewport point) or the focused one. */
interface Observed {
  lookup?: { x: number; y: number } | "focus";
  event(element: ElementInfo | undefined): BrowserEvent;
}

export class BrowserController {
  readonly store = createStore<BrowserUiState>(() => INITIAL);
  private status: BrowserStatus | null = getBrowserStatus();
  private conn: CdpConnection | null = null;
  private connUrl: string | null = null;
  private connecting: Promise<void> | null = null;
  private generation = 0;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private lingering = false;

  private readonly sessions = new Map<string, string>();
  private readonly tabOf = new Map<string, string>();
  private readonly attaching = new Set<string>();
  private readonly worlds = new Map<string, number>();
  private readonly emulated = new Map<string, string>();
  private readonly domains = new Map<string, { console: boolean; network: boolean }>();
  private readonly requests = new Map<string, Map<string, NetRequest>>();
  private readonly faviconCache = new Map<string, string | null>();
  private readonly lastNavUrl = new Map<string, string>();
  private readonly activateOnCreate = new Set<string>();
  private preferActive: string | null = null;
  private cast: CastState | null = null;
  private castActivated: string | null = null;

  private readonly surfaces = new Map<number, { size: SurfaceSize | null; visible: boolean }>();
  private nextSurface = 1;
  private lastSize: SurfaceSize | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly frameListeners = new Set<(f: Frame) => void>();
  private lastFrame: Frame | null = null;
  private titleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly fresh = new FreshFrames(
    {
      after: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      shown: () => this.state.tabs.active,
      driven: (tabId) => userDrives(this.ownerOf(tabId)),
      stale: (tabId) => {
        if (this.state.staleFrame !== tabId) this.set({ staleFrame: tabId });
      },
      restart: () => this.restartCast(),
    },
    STALE_FRAME_MS,
  );
  /** The user's last click in the panel: popups it opens become the shown tab. */
  private lastClick = { at: 0, background: false };
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorAt: { tabId: string; x: number; y: number } | null = null;
  private readonly lanes = new Map<string, InputLane>();
  private demoDrive: ReturnType<typeof setInterval> | undefined;

  constructor() {
    onBrowserStatus((s) => this.setStatus(s));
    onWindowVisible(() => this.syncScreencast());
    onWindowActive(() => this.syncScreencast());
    onObserversChanged(() => {
      this.syncConnection();
      this.syncScreencast();
      this.syncDomains();
    });
    onObserverAdded((o) => this.snapshotFor(o));
    setCaptureImpl((tabId, opts) => this.capture(tabId, opts));
    setMeasureImpl((tabId, refs) => this.measure(tabId, refs));
  }

  // ---------------------------------------------------------------- state access

  get state(): BrowserUiState {
    return this.store.getState();
  }

  private set(patch: Partial<BrowserUiState> | ((s: BrowserUiState) => Partial<BrowserUiState>)): void {
    this.store.setState(patch);
  }

  private reduce(action: TabAction): void {
    const before = this.state.tabs;
    const tabs = reduceTabs(before, action);
    if (tabs === before) return;
    this.set({ tabs });
    if (tabs.active !== before.active) this.activeChanged(before.active);
  }

  get connection(): CdpConnection | null {
    return this.conn;
  }

  get browserStatus(): BrowserStatus | null {
    return this.status;
  }

  get headed(): boolean {
    return this.status?.headed ?? false;
  }

  /** Where the address bar searches: the fake browser's own search page on `?demo`, else the default engine. */
  get searchUrl(): string | undefined {
    return this.status?.wsUrl === DEMO_BROWSER_WS ? DEMO_SEARCH_URL : undefined;
  }

  ownerOf(tabId: string): TabOwner {
    return ownerOf(this.status?.tabs, tabId);
  }

  // ---------------------------------------------------------------- status and connection

  private setStatus(status: BrowserStatus | null): void {
    const prev = this.status;
    this.status = status;
    this.ownersChanged(prev?.tabs, status?.tabs);
    if (prev?.headed !== status?.headed) this.emulated.clear();
    this.syncConnection();
    this.syncDemoDrive();
  }

  private wanted(): boolean {
    return this.surfaces.size > 0 || browserObservers().length > 0 || this.lingering;
  }

  private targetUrl(): string | null {
    const s = this.status;
    return s?.state === "running" && s.wsUrl ? s.wsUrl : null;
  }

  private syncConnection(): void {
    const url = this.wanted() ? this.targetUrl() : null;
    if (url === this.connUrl && (this.conn || this.connecting)) return;
    if (this.conn || this.connecting) this.disconnect();
    if (!url) {
      if (this.state.phase !== "idle") this.set({ phase: "idle", error: null });
      return;
    }
    this.connect(url);
  }

  private connect(url: string): void {
    const gen = ++this.generation;
    this.connUrl = url;
    clearTimeout(this.retryTimer);
    this.set({ phase: "connecting" });
    this.connecting = (async () => {
      // The demo's fake browser (canned pages and their painter) loads only on `?demo`, not with every real panel.
      const socket: SocketFactory | undefined = url === DEMO_BROWSER_WS ? (await import("./demo/fakeBrowser")).demoSocket : undefined;
      const conn = await CdpConnection.open(url, { socket });
      if (gen !== this.generation) {
        conn.close();
        return;
      }
      this.conn = conn;
      this.listen(conn);
      await conn.send("Target.setDiscoverTargets", { discover: true });
      const dir = this.status?.downloadDir;
      if (dir) await conn.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true }).catch(() => {});
      if (gen !== this.generation) return;
      this.retry = 0;
      this.set({ phase: "open", error: null });
      this.syncScreencast();
      this.startTitlePoll();
    })()
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        this.conn?.close();
        this.conn = null;
        this.set({ phase: "lost", error: errorText(e) });
        this.scheduleReconnect();
      })
      .finally(() => {
        if (gen === this.generation) this.connecting = null;
      });
  }

  private scheduleReconnect(): void {
    clearTimeout(this.retryTimer);
    const delay = RECONNECT_MS[Math.min(this.retry, RECONNECT_MS.length - 1)] ?? 10_000;
    this.retry++;
    this.retryTimer = setTimeout(() => {
      this.connUrl = null;
      this.syncConnection();
    }, delay);
  }

  /** Reconnect now (the panel's Retry). */
  reconnect(): void {
    this.retry = 0;
    this.disconnect();
    this.syncConnection();
  }

  private disconnect(): void {
    this.generation++;
    clearTimeout(this.retryTimer);
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    this.connUrl = null;
    this.resetSessions();
    conn?.close();
  }

  private resetSessions(): void {
    this.preferActive = this.state.tabs.active ?? this.preferActive;
    this.sessions.clear();
    this.tabOf.clear();
    this.attaching.clear();
    this.worlds.clear();
    this.lanes.clear();
    this.emulated.clear();
    this.domains.clear();
    this.requests.clear();
    this.lastNavUrl.clear();
    this.cast = null;
    this.castActivated = null;
    this.lastFrame = null;
    clearInterval(this.titleTimer);
    this.fresh.reset();
    this.set({ tabs: EMPTY_TABS, dialogs: {}, chooser: null, staleFrame: null });
  }

  private listen(conn: CdpConnection): void {
    conn.onClose((reason) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.connUrl = null;
      this.resetSessions();
      this.set({ phase: this.wanted() && this.targetUrl() ? "lost" : "idle", error: reason });
      if (this.wanted() && this.targetUrl()) this.scheduleReconnect();
    });
    conn.on("Target.targetCreated", ({ targetInfo }) => this.targetCreated(targetInfo));
    conn.on("Target.targetInfoChanged", ({ targetInfo }) => this.targetChanged(targetInfo));
    conn.on("Target.targetDestroyed", ({ targetId }) => this.targetDestroyed(targetId));
    conn.on("Target.targetCrashed", ({ targetId }) => this.reduce({ type: "crashed", id: targetId }));
    conn.on("Target.detachedFromTarget", ({ sessionId }) => this.sessionDetached(sessionId));
    conn.on("Page.screencastFrame", (p, sid) => this.handleFrame(p.data, p.metadata, p.sessionId, sid));
    conn.on("Page.frameStartedLoading", ({ frameId }, sid) => {
      const tabId = this.tab(sid);
      if (tabId && frameId === tabId) this.reduce({ type: "loading", id: tabId, loading: true });
    });
    conn.on("Page.frameStoppedLoading", ({ frameId }, sid) => {
      const tabId = this.tab(sid);
      if (!tabId || frameId !== tabId) return;
      this.reduce({ type: "loading", id: tabId, loading: false });
      void this.refreshHistory(tabId, false);
      void this.fetchFavicon(tabId);
    });
    conn.on("Page.frameNavigated", ({ frame }, sid) => {
      const tabId = this.tab(sid);
      if (!tabId || frame.parentId) return;
      this.worlds.delete(tabId);
      if (tabId === this.state.tabs.active) this.fresh.expect(tabId);
      void this.refreshHistory(tabId, true, false);
    });
    conn.on("Page.navigatedWithinDocument", ({ frameId }, sid) => {
      const tabId = this.tab(sid);
      if (tabId && frameId === tabId) void this.refreshHistory(tabId, true, true);
    });
    conn.on("Page.loadEventFired", (_p, sid) => {
      const tabId = this.tab(sid);
      if (tabId) void this.fetchFavicon(tabId);
    });
    conn.on("Page.javascriptDialogOpening", (p, sid) => {
      const tabId = this.tab(sid);
      if (!tabId) return;
      const dialog: PendingDialog = { tabId, type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url, at: Date.now() };
      this.set((s) => ({ dialogs: { ...s.dialogs, [tabId]: dialog } }));
      emitBrowserEvent({ at: dialog.at, tabId, type: "dialog", dialog: p.type, message: p.message });
    });
    conn.on("Page.javascriptDialogClosed", (_p, sid) => {
      const tabId = this.tab(sid);
      if (!tabId || !this.state.dialogs[tabId]) return;
      this.set((s) => {
        const dialogs = { ...s.dialogs };
        delete dialogs[tabId];
        return { dialogs };
      });
    });
    conn.on("Page.fileChooserOpened", (p, sid) => {
      const tabId = this.tab(sid);
      // An agent's page asks its agent; only the user's own pages open the app's picker.
      if (!tabId || p.backendNodeId == null || !userDrives(this.ownerOf(tabId))) return;
      this.set({ chooser: { tabId, multiple: p.mode === "selectMultiple", backendNodeId: p.backendNodeId, at: Date.now() } });
    });
    conn.on("Browser.downloadWillBegin", (p) => {
      const tabId = this.state.tabs.byId[p.frameId] ? p.frameId : undefined;
      const item: DownloadItem = { guid: p.guid, tabId, owner: tabId ? this.ownerOf(tabId) : { kind: "user" }, url: p.url, name: p.suggestedFilename, total: 0, received: 0, state: "inProgress", at: Date.now() };
      this.set((s) => ({ downloads: [item, ...s.downloads.filter((d) => d.guid !== p.guid)].slice(0, DOWNLOADS_KEPT) }));
    });
    conn.on("Browser.downloadProgress", (p) => {
      this.set((s) => ({
        downloads: s.downloads.map((d) => {
          if (d.guid !== p.guid) return d;
          const dir = this.status?.downloadDir;
          const path = p.filePath ?? (p.state === "completed" && dir ? `${dir.replace(/[\\/]+$/, "")}/${d.name}` : d.path);
          return { ...d, total: p.totalBytes, received: p.receivedBytes, state: p.state, path };
        }),
      }));
    });
    conn.on("Runtime.consoleAPICalled", (p, sid) => {
      const tabId = this.tab(sid);
      if (!tabId || !(p.type === "error" || p.type === "warning" || p.type === "assert")) return;
      const text = p.args.map((a) => (typeof a.value === "string" ? a.value : a.description ?? (a.value === undefined ? a.type : JSON.stringify(a.value)))).join(" ");
      const top = p.stackTrace?.callFrames[0];
      emitBrowserEvent({ at: Date.now(), tabId, type: "console", level: p.type === "warning" ? "warning" : "error", text, source: top ? `${top.url}:${top.lineNumber + 1}` : undefined, stack: stackLines(p.stackTrace) });
    });
    conn.on("Runtime.exceptionThrown", ({ exceptionDetails: d }, sid) => {
      const tabId = this.tab(sid);
      if (!tabId) return;
      emitBrowserEvent({ at: Date.now(), tabId, type: "exception", text: d.exception?.description ?? d.text, source: d.url ? `${d.url}:${d.lineNumber + 1}` : undefined, stack: stackLines(d.stackTrace) });
    });
    conn.on("Log.entryAdded", ({ entry }, sid) => {
      const tabId = this.tab(sid);
      if (!tabId || !(entry.level === "error" || entry.level === "warning")) return;
      emitBrowserEvent({ at: Date.now(), tabId, type: "console", level: entry.level, text: entry.text, source: entry.url ? `${entry.url}${entry.lineNumber != null ? `:${entry.lineNumber + 1}` : ""}` : undefined, stack: stackLines(entry.stackTrace) });
    });
    conn.on("Network.requestWillBeSent", (p, sid) => {
      const tabId = this.tab(sid);
      if (!tabId) return;
      let reqs = this.requests.get(tabId);
      if (!reqs) this.requests.set(tabId, (reqs = new Map()));
      if (reqs.size > 2000) reqs.clear();
      reqs.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type });
    });
    conn.on("Network.responseReceived", (p, sid) => {
      const r = this.requests.get(this.tab(sid) ?? "")?.get(p.requestId);
      if (!r) return;
      if (p.type) r.type = p.type;
      if (p.response.status >= 400) {
        r.status = p.response.status;
        r.statusText = p.response.statusText;
      }
    });
    conn.on("Network.loadingFinished", ({ requestId }, sid) => {
      const tabId = this.tab(sid);
      const reqs = tabId ? this.requests.get(tabId) : undefined;
      const r = reqs?.get(requestId);
      if (!tabId || !sid || !r) return;
      reqs?.delete(requestId);
      if (r.status == null) return;
      void this.reportFailed(tabId, sid, requestId, r);
    });
    conn.on("Network.loadingFailed", (p, sid) => {
      const tabId = this.tab(sid);
      const reqs = tabId ? this.requests.get(tabId) : undefined;
      const r = reqs?.get(p.requestId);
      if (!tabId || !r) return;
      reqs?.delete(p.requestId);
      if (p.canceled) return;
      emitBrowserEvent({ at: Date.now(), tabId, type: "requestFailed", url: r.url, method: r.method, resourceType: p.type ?? r.type, error: p.errorText });
    });
  }

  private async reportFailed(tabId: string, sessionId: string, requestId: string, r: NetRequest): Promise<void> {
    let body: string | undefined;
    if (r.type === "XHR" || r.type === "Fetch" || r.type === "Document") {
      const res = await this.conn?.send("Network.getResponseBody", { requestId }, sessionId).catch(() => null);
      if (res && !res.base64Encoded) body = res.body.slice(0, 300);
    }
    emitBrowserEvent({ at: Date.now(), tabId, type: "requestFailed", url: r.url, method: r.method, resourceType: r.type, status: r.status, statusText: r.statusText, body });
  }

  private tab(sessionId: string | undefined): string | undefined {
    return sessionId ? this.tabOf.get(sessionId) : undefined;
  }

  // ---------------------------------------------------------------- targets

  private targetCreated(info: TargetInfo): void {
    if (!isTabTarget(info)) return;
    const s = this.state.tabs;
    const recentClick = Date.now() - this.lastClick.at < 2000;
    const active = s.active;
    const activeOwner = active ? this.ownerOf(active) : null;
    // A popup the user's click opened, the tab a watched agent opened from its shown tab, a tab the
    // user asked for, or the tab that was shown before a reconnect.
    const activate =
      this.activateOnCreate.delete(info.targetId) ||
      info.targetId === this.preferActive ||
      (!!active && info.openerId === active && ((recentClick && !this.lastClick.background) || activeOwner?.kind === "agent"));
    this.reduce({ type: "created", info, activate });
    const tab = this.state.tabs.byId[info.targetId];
    if (tab) emitBrowserEvent({ at: Date.now(), tabId: tab.id, type: "tab", change: "opened", url: tab.url, title: tab.title, openerId: tab.openerId, owner: observedOwner(this.ownerOf(tab.id)) });
    void this.attach(info.targetId);
  }

  private targetChanged(info: TargetInfo): void {
    const before = this.state.tabs.byId[info.targetId];
    if (!before) {
      if (isTabTarget(info)) this.targetCreated(info);
      return;
    }
    this.reduce({ type: "changed", info });
    const after = this.state.tabs.byId[info.targetId];
    if (after && after !== before && (after.url !== before.url || after.title !== before.title)) {
      emitBrowserEvent({ at: Date.now(), tabId: after.id, type: "tab", change: "updated", url: after.url, title: after.title, owner: observedOwner(this.ownerOf(after.id)) });
    }
  }

  private targetDestroyed(targetId: string): void {
    const tab = this.state.tabs.byId[targetId];
    const sid = this.sessions.get(targetId);
    if (sid) this.tabOf.delete(sid);
    this.sessions.delete(targetId);
    this.worlds.delete(targetId);
    this.lanes.delete(targetId);
    this.emulated.delete(targetId);
    this.domains.delete(targetId);
    this.requests.delete(targetId);
    this.lastNavUrl.delete(targetId);
    if (this.cast?.tabId === targetId) this.cast = null;
    if (this.state.dialogs[targetId] || this.state.chooser?.tabId === targetId) {
      this.set((s) => {
        const dialogs = { ...s.dialogs };
        delete dialogs[targetId];
        return { dialogs, chooser: s.chooser?.tabId === targetId ? null : s.chooser };
      });
    }
    this.reduce({ type: "destroyed", id: targetId });
    if (tab) emitBrowserEvent({ at: Date.now(), tabId: targetId, type: "tab", change: "closed", url: tab.url, title: tab.title, owner: observedOwner(this.ownerOf(targetId)) });
    this.syncScreencast();
  }

  private sessionDetached(sessionId: string): void {
    const tabId = this.tabOf.get(sessionId);
    if (!tabId) return;
    this.tabOf.delete(sessionId);
    this.sessions.delete(tabId);
    this.worlds.delete(tabId);
    this.emulated.delete(tabId);
    this.domains.delete(tabId);
    if (this.cast?.sessionId === sessionId) this.cast = null;
    // The tab is still there (its renderer was swapped): attach again.
    if (this.state.tabs.byId[tabId]) setTimeout(() => void this.attach(tabId), 100);
  }

  private async attach(targetId: string): Promise<void> {
    const conn = this.conn;
    if (!conn || this.sessions.has(targetId) || this.attaching.has(targetId)) return;
    this.attaching.add(targetId);
    try {
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
      if (conn !== this.conn || !this.state.tabs.byId[targetId]) {
        void conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      this.sessions.set(targetId, sessionId);
      this.tabOf.set(sessionId, targetId);
      await conn.send("Page.enable", {}, sessionId);
      // Headless has no file dialog of its own; the app's picker stands in. A window of its own keeps Chrome's.
      if (!this.headed) await conn.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId).catch(() => {});
      await this.refreshHistory(targetId, false);
      void this.fetchFavicon(targetId);
      this.syncDomains();
      if (this.state.tabs.active === targetId) {
        await this.syncEmulation(targetId);
        this.syncScreencast();
      }
    } catch (e) {
      if (!(e instanceof CdpError) || e.code !== "closed") console.warn("[browser] attach failed", targetId, errorText(e));
    } finally {
      this.attaching.delete(targetId);
    }
  }

  private async refreshHistory(tabId: string, navigated: boolean, sameDocument = false): Promise<void> {
    const sid = this.sessions.get(tabId);
    if (!sid || !this.conn) return;
    try {
      const h = await this.conn.send("Page.getNavigationHistory", {}, sid);
      this.reduce({ type: "history", id: tabId, canGoBack: h.currentIndex > 0, canGoForward: h.currentIndex < h.entries.length - 1 });
      const entry = h.entries[h.currentIndex];
      if (!navigated || !entry || this.lastNavUrl.get(tabId) === entry.url) return;
      this.lastNavUrl.set(tabId, entry.url);
      emitBrowserEvent({ at: Date.now(), tabId, type: "navigation", url: entry.url, title: entry.title || undefined, sameDocument, transition: entry.transitionType, owner: observedOwner(this.ownerOf(tabId)) });
    } catch {
      // the tab went away
    }
  }

  // ---------------------------------------------------------------- ownership

  private ownersChanged(prev: readonly BrowserTabOwner[] | undefined, next: readonly BrowserTabOwner[] | undefined): void {
    const ids = new Set([...(prev ?? []).map((e) => e.targetId), ...(next ?? []).map((e) => e.targetId)]);
    for (const id of ids) {
      const a = prev?.find((e) => e.targetId === id);
      const b = next?.find((e) => e.targetId === id);
      if (sameOwnerEntry(a, b)) continue;
      const tab = this.state.tabs.byId[id];
      if (!tab) continue;
      const owner = ownerOf(next, id);
      emitBrowserEvent({ at: Date.now(), tabId: id, type: "tab", change: "owner", url: tab.url, title: tab.title, owner: observedOwner(owner) ?? { kind: "user" } });
      // Handed back to its agent: its own viewport again.
      if (a?.takenOver && b && !b.takenOver && !b.detached) void this.clearEmulation(id);
      if (id === this.state.tabs.active) void this.syncEmulation(id);
      // A tab the user may no longer drive keeps no file chooser of the user's open.
      if (!userDrives(owner) && this.state.chooser?.tabId === id) this.set({ chooser: null });
    }
    // A tab an agent just opened while the user watches that agent: show it.
    const active = this.state.tabs.active;
    const watching = active ? ownerOf(next, active) : null;
    if (watching?.kind === "agent") {
      for (const e of next ?? []) {
        if (prev?.some((p) => p.targetId === e.targetId)) continue;
        if (e.hostId === watching.hostId && e.agentId === watching.agentId && this.state.tabs.byId[e.targetId] && !e.lent) {
          this.activate(e.targetId, false);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- the shown tab

  private activeChanged(prev: string | null): void {
    const active = this.state.tabs.active;
    this.lastFrame = null;
    this.set({ cursor: "default", staleFrame: null });
    if (active && active !== prev) this.fresh.expect(active);
    if (active) {
      const tab = this.state.tabs.byId[active];
      if (tab) emitBrowserEvent({ at: Date.now(), tabId: active, type: "tab", change: "activated", url: tab.url, title: tab.title, owner: observedOwner(this.ownerOf(active)) });
      void this.syncEmulation(active);
    }
    if (prev !== active) this.syncScreencast();
  }

  /** Shows a tab (the strip, Ctrl+Tab). */
  activate(tabId: string, user = true): void {
    if (!this.state.tabs.byId[tabId]) return;
    if (user) emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "switchTab" });
    this.reduce({ type: "activate", id: tabId });
  }

  cycle(step: 1 | -1): void {
    const id = cycleTab(this.state.tabs, step);
    if (id) this.activate(id);
  }

  // ---------------------------------------------------------------- surfaces and screencast

  /** A place that shows the browser (the split panel, the Browser page, fullscreen). */
  addSurface(): Surface {
    const id = this.nextSurface++;
    this.surfaces.set(id, { size: null, visible: true });
    clearTimeout(this.lingerTimer);
    this.lingering = false;
    this.syncConnection();
    return {
      setSize: (size) => {
        const s = this.surfaces.get(id);
        if (!s) return;
        s.size = size;
        this.lastSize = size;
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          const active = this.state.tabs.active;
          if (active) void this.syncEmulation(active);
          this.syncScreencast();
        }, 120);
      },
      setVisible: (visible) => {
        const s = this.surfaces.get(id);
        if (!s || s.visible === visible) return;
        s.visible = visible;
        this.syncScreencast();
      },
      release: () => {
        if (!this.surfaces.delete(id)) return;
        if (this.surfaces.size === 0) {
          this.lingering = true;
          clearTimeout(this.lingerTimer);
          this.lingerTimer = setTimeout(() => {
            this.lingering = false;
            this.syncConnection();
          }, LINGER_MS);
        }
        const active = this.state.tabs.active;
        if (active && this.surfaces.size > 0) void this.syncEmulation(active);
        this.syncScreencast();
      },
    };
  }

  private surfaceSize(): SurfaceSize | null {
    let size: SurfaceSize | null = null;
    for (const s of this.surfaces.values()) if (s.visible && s.size) size = s.size;
    return size ?? this.lastSize;
  }

  private surfaceVisible(): boolean {
    for (const s of this.surfaces.values()) if (s.visible) return true;
    return false;
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.frameListeners.add(cb);
    if (this.lastFrame && this.lastFrame.tabId === this.state.tabs.active) cb(this.lastFrame);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  private handleFrame(data: string, meta: ScreencastFrameMetadata, frameNumber: number, sessionId: string | undefined): void {
    const conn = this.conn;
    const tabId = this.tab(sessionId);
    if (!conn || !sessionId || !tabId) return;
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      void conn.send("Page.screencastFrameAck", { sessionId: frameNumber }, sessionId).catch(() => {});
    };
    if (tabId !== this.state.tabs.active) {
      ack();
      return;
    }
    const at = meta.timestamp ? Math.round(meta.timestamp * 1000) : Date.now();
    const frame: Frame = { tabId, data, meta, at, ack };
    this.lastFrame = frame;
    this.fresh.frame(tabId);
    if (browserObservers().some((o) => o.frame)) {
      const size = jpegSize(data);
      emitBrowserFrame({ at, tabId, owner: observedOwner(this.ownerOf(tabId)), data, width: size?.width ?? Math.round(meta.deviceWidth), height: size?.height ?? Math.round(meta.deviceHeight), viewport: { width: meta.deviceWidth, height: meta.deviceHeight }, scroll: { x: meta.scrollOffsetX, y: meta.scrollOffsetY } });
    }
    if (this.frameListeners.size === 0) {
      ack();
      return;
    }
    for (const l of [...this.frameListeners]) {
      try {
        l(frame);
      } catch (e) {
        console.error("[browser] frame listener failed", e);
        ack();
      }
    }
  }

  private syncScreencast(): void {
    const conn = this.conn;
    const tabId = this.state.tabs.active;
    const sessionId = tabId ? this.sessions.get(tabId) : undefined;
    const size = this.surfaceSize();
    const want = !!conn && this.state.phase === "open" && !!tabId && !!sessionId && isWindowVisible() && (this.surfaceVisible() || observersWant("frames")) && !!size;
    let next: CastState | null = null;
    if (want && tabId && sessionId && size) {
      const dpr = Math.min(Math.max(size.dpr, 1), MAX_DPR);
      let w = Math.max(1, Math.round(size.width * dpr));
      let h = Math.max(1, Math.round(size.height * dpr));
      const area = w * h;
      if (area > MAX_FRAME_PIXELS) {
        const k = Math.sqrt(MAX_FRAME_PIXELS / area);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const active = isWindowActive();
      next = { tabId, sessionId, maxWidth: w, maxHeight: h, quality: active ? 80 : 70, nth: active ? 1 : 3 };
    }
    const cur = this.cast;
    if (cur && next && cur.sessionId === next.sessionId && cur.maxWidth === next.maxWidth && cur.maxHeight === next.maxHeight && cur.quality === next.quality && cur.nth === next.nth) return;
    if (cur && conn) void conn.send("Page.stopScreencast", {}, cur.sessionId).catch(() => {});
    this.cast = next;
    if (!next || !conn) return;
    const start = next;
    void (async () => {
      try {
        if (this.castActivated !== start.tabId) {
          this.castActivated = start.tabId;
          await conn.send("Target.activateTarget", { targetId: start.tabId });
        }
        if (this.cast !== start) return;
        await conn.send("Page.startScreencast", { format: "jpeg", quality: start.quality, maxWidth: start.maxWidth, maxHeight: start.maxHeight, everyNthFrame: start.nth }, start.sessionId);
      } catch (e) {
        if (this.cast === start) this.cast = null;
        if (!(e instanceof CdpError) || (e.code !== "closed" && e.code !== "detached")) console.warn("[browser] screencast failed", errorText(e));
      }
    })();
  }

  /** Stops the screencast and starts it again: Chrome sends a frame as it starts (and a tab it left hidden is shown again). */
  private restartCast(): void {
    const cur = this.cast;
    if (!this.conn || !cur) return;
    void this.conn.send("Page.stopScreencast", {}, cur.sessionId).catch(() => {});
    this.cast = null;
    if (!this.headed) this.castActivated = null;
    this.syncScreencast();
  }

  private startTitlePoll(): void {
    clearInterval(this.titleTimer);
    this.titleTimer = setInterval(() => void this.pollTitles(), TITLE_POLL_MS);
  }

  /** The titles the pages have now, for the tabs the panel shows. */
  private async pollTitles(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.state.phase !== "open" || !isWindowVisible() || !(this.surfaceVisible() || observersWant("frames"))) return;
    const { targetInfos } = await conn.send("Target.getTargets", {}).catch(() => ({ targetInfos: [] as TargetInfo[] }));
    if (conn !== this.conn) return;
    for (const info of targetInfos) if (this.state.tabs.byId[info.targetId]) this.targetChanged(info);
  }

  /** The user's own pages lay out for the panel (CSS size, zoom, sharpness); an agent's keep the agent's viewport. */
  private async syncEmulation(tabId: string): Promise<void> {
    const conn = this.conn;
    const sid = this.sessions.get(tabId);
    const size = this.surfaceSize();
    if (!conn || !sid || !size || this.headed) return;
    const owner = this.ownerOf(tabId);
    if (!userDrives(owner) || (owner.kind === "agent" && owner.lent)) return;
    const zoom = this.state.zoom[tabId] ?? 1;
    const dpr = Math.min(Math.max(size.dpr, 1), MAX_DPR);
    const width = Math.max(200, Math.round(size.width / zoom));
    const height = Math.max(150, Math.round(size.height / zoom));
    const scale = Math.round(dpr * zoom * 1000) / 1000;
    const key = `${width}x${height}@${scale}`;
    if (this.emulated.get(tabId) === key) return;
    this.emulated.set(tabId, key);
    await conn.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false }, sid).catch(() => {
      this.emulated.delete(tabId);
    });
  }

  private async clearEmulation(tabId: string): Promise<void> {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid || !this.emulated.has(tabId)) return;
    this.emulated.delete(tabId);
    await this.conn.send("Emulation.clearDeviceMetricsOverride", {}, sid).catch(() => {});
  }

  // ---------------------------------------------------------------- observers

  private syncDomains(): void {
    const conn = this.conn;
    if (!conn) return;
    const wantConsole = observersWant("console");
    const wantNetwork = observersWant("network");
    for (const [tabId, sid] of this.sessions) {
      // Recording records the user's own tabs only.
      const mine = this.ownerOf(tabId).kind === "user";
      const cur = this.domains.get(tabId) ?? { console: false, network: false };
      const next = { console: wantConsole && mine, network: wantNetwork && mine };
      if (cur.console !== next.console) {
        void conn.send(next.console ? "Runtime.enable" : "Runtime.disable", {}, sid).catch(() => {});
        void conn.send(next.console ? "Log.enable" : "Log.disable", {}, sid).catch(() => {});
      }
      if (cur.network !== next.network) {
        void conn.send(next.network ? "Network.enable" : "Network.disable", {}, sid).catch(() => {});
        if (!next.network) this.requests.delete(tabId);
      }
      this.domains.set(tabId, next);
    }
  }

  private snapshotFor(o: { event?(e: BrowserEvent): void }): void {
    const { tabs } = this.state;
    const now = Date.now();
    for (const id of tabs.order) {
      const tab = tabs.byId[id];
      if (!tab || id === tabs.active) continue;
      o.event?.({ at: now, tabId: id, type: "tab", change: "opened", url: tab.url, title: tab.title, openerId: tab.openerId, owner: observedOwner(this.ownerOf(id)) });
    }
    const active = tabs.active ? tabs.byId[tabs.active] : undefined;
    if (active) o.event?.({ at: now, tabId: active.id, type: "tab", change: "activated", url: active.url, title: active.title, owner: observedOwner(this.ownerOf(active.id)) });
  }

  private async capture(tabId: string | undefined, opts: { format?: "png" | "jpeg"; quality?: number }): Promise<{ at: number; data: string } | null> {
    const id = tabId ?? this.state.tabs.active;
    const sid = id ? this.sessions.get(id) : undefined;
    if (!this.conn || !sid) return null;
    try {
      const format = opts.format ?? "png";
      const r = await this.conn.send("Page.captureScreenshot", format === "jpeg" ? { format, quality: opts.quality ?? 80 } : { format }, sid);
      return { at: Date.now(), data: r.data };
    } catch {
      return null;
    }
  }

  /** Element info for the recording log (only while an observer asks for it): at a viewport point, else the focused element. */
  private elementAt(tabId: string, point?: { x: number; y: number }): Promise<ElementInfo | undefined> {
    if (!observersWant("elements")) return Promise.resolve(undefined);
    return this.evaluate<ElementInfo | null>(tabId, elementScript(point)).then((v) => v ?? undefined);
  }

  /** Where elements of earlier lookups are now (`measureElements`). */
  private measure(tabId: string, refs: readonly string[]): Promise<Measured | null> {
    return this.evaluate<Measured | null>(tabId, measureScript(refs)).then((v) => v ?? null);
  }

  // ---------------------------------------------------------------- page scripts

  /** Runs a page script in the panel's isolated world (made on demand, again after a navigation). */
  async evaluate<T>(tabId: string, expression: string): Promise<T | undefined> {
    const conn = this.conn;
    const sid = this.sessions.get(tabId);
    if (!conn || !sid) return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let contextId = this.worlds.get(tabId);
      try {
        if (contextId == null) {
          contextId = (await conn.send("Page.createIsolatedWorld", { frameId: tabId, worldName: WORLD }, sid)).executionContextId;
          this.worlds.set(tabId, contextId);
        }
        const r = await conn.send("Runtime.evaluate", { expression, contextId, returnByValue: true, silent: true }, sid);
        if (r.exceptionDetails) return undefined;
        // returnByValue: the script's JSON result; each caller's script defines `T`.
        return r.result.value as T;
      } catch (e) {
        this.worlds.delete(tabId);
        if (attempt === 1 || !(e instanceof CdpError) || typeof e.code !== "number") return undefined;
      }
    }
    return undefined;
  }

  private async fetchFavicon(tabId: string): Promise<void> {
    const conn = this.conn;
    const sid = this.sessions.get(tabId);
    const tab = this.state.tabs.byId[tabId];
    if (!conn || !sid || !tab || tab.loading || !/^https?:/.test(tab.url)) return;
    const href = await this.evaluate<string>(tabId, FAVICON_SCRIPT);
    if (!href) return;
    let icon = this.faviconCache.get(href);
    if (icon === undefined) {
      icon = await this.loadIcon(conn, sid, tabId, href);
      if (this.faviconCache.size > 200) this.faviconCache.clear();
      this.faviconCache.set(href, icon);
    }
    if (this.state.tabs.byId[tabId]) this.reduce({ type: "favicon", id: tabId, favicon: icon ?? undefined });
  }

  private async loadIcon(conn: CdpConnection, sid: string, frameId: string, url: string): Promise<string | null> {
    try {
      const { resource } = await conn.send("Network.loadNetworkResource", { frameId, url, options: { disableCache: false, includeCredentials: false } }, sid);
      if (!resource.success || !resource.stream) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const r = await conn.send("IO.read", { handle: resource.stream, size: 65536 }, sid);
          const bytes = r.base64Encoded ? decodeBase64(r.data) : new TextEncoder().encode(r.data);
          chunks.push(bytes);
          total += bytes.length;
          if (r.eof || total > FAVICON_MAX_BYTES) break;
        }
      } finally {
        void conn.send("IO.close", { handle: resource.stream }, sid).catch(() => {});
      }
      if (total === 0 || total > FAVICON_MAX_BYTES) return null;
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      const header = Object.entries(resource.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim();
      const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? "";
      const mime = header?.startsWith("image/") ? header : (MIME_BY_EXT[ext] ?? "image/x-icon");
      return `data:${mime};base64,${encodeBase64(all)}`;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- input

  /**
   * Sends input to a tab (CDP keeps a session's input in order); `observe` makes it an event for
   * observers. While one wants elements, an input with a lookup waits until the tab has handled
   * the input before it (a lookup sent alongside input runs before or after it, as the page's
   * scheduler likes), then for the element under the point or the focused one, and only then is
   * sent: a key names the field it went into, also right after a click, Tab or the page moved the
   * focus. Later input queues behind it, so events go out in the order of the input.
   */
  private input<M extends InputMethod>(tabId: string, method: M, params: CdpCommands[M]["params"], observe?: Observed): void {
    let lane = this.lanes.get(tabId);
    if (!lane) this.lanes.set(tabId, (lane = { sent: Promise.resolve(), handled: Promise.resolve(), queued: 0 }));
    const own = lane;
    const lookup = observe?.lookup && observersWant("elements") ? observe.lookup : undefined;
    const send = (element?: ElementInfo) => {
      const conn = this.conn;
      const sid = this.sessions.get(tabId);
      if (!conn || !sid) return;
      own.handled = conn.send(method, params, sid).catch(() => {});
      if (observe) emitBrowserEvent(observe.event(element));
    };
    if (!lookup && own.queued === 0) return send();
    own.queued++;
    own.sent = own.sent
      .then(async () => send(lookup ? await own.handled.then(() => this.elementAt(tabId, lookup === "focus" ? undefined : lookup)) : undefined))
      .catch((e: unknown) => console.error("[browser] input failed", e))
      .finally(() => {
        own.queued--;
      });
  }

  mouse(tabId: string, params: MouseEventParams): void {
    if (!userDrives(this.ownerOf(tabId))) return;
    const at = Date.now();
    const { x, y, clickCount, modifiers } = params;
    const button = params.button === "none" ? "left" : params.button;
    switch (params.type) {
      case "mousePressed":
        this.lastClick = { at, background: params.button === "middle" || (modifiers & (2 | 4)) !== 0 };
        return this.input(tabId, "Input.dispatchMouseEvent", params, { lookup: { x, y }, event: (element) => ({ at, tabId, type: "pointer", action: "down", x, y, button, clickCount, modifiers, element }) });
      case "mouseReleased":
        return this.input(tabId, "Input.dispatchMouseEvent", params, { event: () => ({ at, tabId, type: "pointer", action: "up", x, y, button, clickCount, modifiers }) });
      case "mouseWheel":
        return this.input(tabId, "Input.dispatchMouseEvent", params, { event: () => ({ at, tabId, type: "wheel", x, y, deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 }) });
      case "mouseMoved":
        this.input(tabId, "Input.dispatchMouseEvent", params);
        return this.trackCursor(tabId, x, y);
    }
  }

  key(tabId: string, params: KeyEventParams): void {
    if (!userDrives(this.ownerOf(tabId))) return;
    const at = Date.now();
    const down = params.type === "keyDown" || params.type === "rawKeyDown";
    this.input(tabId, "Input.dispatchKeyEvent", params, down ? { lookup: "focus", event: (element) => ({ at, tabId, type: "key", key: params.key, code: params.code, modifiers: params.modifiers, text: params.text, element }) } : undefined);
  }

  insertText(tabId: string, text: string, via: "paste" | "ime" | "insert"): void {
    if (!text || !userDrives(this.ownerOf(tabId))) return;
    const at = Date.now();
    this.input(tabId, "Input.insertText", { text }, { lookup: "focus", event: (element) => ({ at, tabId, type: "text", text, via, element }) });
  }

  compose(tabId: string, text: string, selectionStart: number, selectionEnd: number): void {
    if (!userDrives(this.ownerOf(tabId))) return;
    this.input(tabId, "Input.imeSetComposition", { text, selectionStart, selectionEnd });
  }

  /** Copies the page's selection to the device's clipboard (the headless browser's clipboard is its own), once the input before is handled. */
  async copySelection(tabId: string): Promise<boolean> {
    const lane = this.lanes.get(tabId);
    if (lane) await lane.sent.then(() => lane.handled);
    const text = await this.evaluate<string>(tabId, SELECTION_SCRIPT);
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private trackCursor(tabId: string, x: number, y: number): void {
    this.cursorAt = { tabId, x, y };
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const at = this.cursorAt;
      if (!at || at.tabId !== this.state.tabs.active) return;
      void this.evaluate<string>(at.tabId, cursorScript(at.x, at.y)).then((cursor) => {
        if (cursor && at.tabId === this.state.tabs.active && cursor !== this.state.cursor) this.set({ cursor });
      });
    }, 90);
  }

  // ---------------------------------------------------------------- toolbar actions

  navigate(tabId: string, url: string): void {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid || !userDrives(this.ownerOf(tabId))) return;
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "navigate", url });
    void this.conn.send("Page.navigate", { url }, sid).catch(() => {});
  }

  async history(tabId: string, step: -1 | 1): Promise<void> {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid || !userDrives(this.ownerOf(tabId))) return;
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: step < 0 ? "back" : "forward" });
    try {
      const h = await this.conn.send("Page.getNavigationHistory", {}, sid);
      const entry = h.entries[h.currentIndex + step];
      if (entry) await this.conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sid);
    } catch {
      // the tab went away
    }
  }

  reload(tabId: string, ignoreCache = false): void {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid || !userDrives(this.ownerOf(tabId))) return;
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "reload" });
    void this.conn.send("Page.reload", { ignoreCache }, sid).catch(() => {});
  }

  stop(tabId: string): void {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid) return;
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "stop" });
    void this.conn.send("Page.stopLoading", {}, sid).catch(() => {});
  }

  /** Opens a tab of the user's (in the user's window, so it never hides an agent's tab). */
  async newTab(url = "about:blank"): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    emitBrowserEvent({ at: Date.now(), tabId: this.state.tabs.active ?? "", type: "ui", action: "newTab", url });
    const { tabs } = this.state;
    const mine = tabs.recent.find((id) => this.ownerOf(id).kind === "user");
    try {
      if (mine) await conn.send("Target.activateTarget", { targetId: mine });
      const { targetId } = await conn.send("Target.createTarget", mine ? { url } : { url, newWindow: true });
      if (this.state.tabs.byId[targetId]) this.activate(targetId, false);
      else this.activateOnCreate.add(targetId);
      this.castActivated = null;
      if (url === "about:blank") this.set((s) => ({ addressFocus: s.addressFocus + 1 }));
    } catch (e) {
      console.warn("[browser] new tab failed", errorText(e));
    }
  }

  closeTab(tabId: string): void {
    if (!this.conn) return;
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "closeTab" });
    void this.conn.send("Target.closeTarget", { targetId: tabId }).catch(() => {});
  }

  /** Closes every tab of an agent (its own and the ones lent to it stay the user's: those are given back instead). */
  closeTabs(tabIds: readonly string[]): void {
    for (const id of tabIds) this.closeTab(id);
  }

  reopenClosed(): void {
    const { url, state } = popClosed(this.state.tabs);
    if (!url) return;
    this.set({ tabs: state });
    void this.newTab(url);
  }

  zoom(tabId: string, zoom: number): void {
    const z = Math.min(5, Math.max(0.25, zoom));
    this.set((s) => ({ zoom: { ...s.zoom, [tabId]: z } }));
    emitBrowserEvent({ at: Date.now(), tabId, type: "ui", action: "zoom" });
    void this.syncEmulation(tabId);
  }

  focusAddress(): void {
    this.set((s) => ({ addressFocus: s.addressFocus + 1 }));
  }

  answerDialog(tabId: string, accept: boolean, promptText?: string): void {
    const sid = this.sessions.get(tabId);
    if (!this.conn || !sid) return;
    void this.conn.send("Page.handleJavaScriptDialog", promptText != null ? { accept, promptText } : { accept }, sid).catch(() => {});
  }

  clearChooser(): void {
    this.set({ chooser: null });
  }

  /** Puts files on the page's file field (paths on this device: staged by the app core). */
  async setFiles(chooser: PendingChooser, paths: string[]): Promise<void> {
    const sid = this.sessions.get(chooser.tabId);
    if (this.state.chooser === chooser) this.set({ chooser: null });
    if (!this.conn || !sid || paths.length === 0) return;
    await this.conn.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId }, sid);
  }

  cancelDownload(guid: string): void {
    void this.conn?.send("Browser.cancelDownload", { guid }).catch(() => {});
  }

  dismissDownload(guid: string): void {
    this.set((s) => ({ downloads: s.downloads.filter((d) => d.guid !== guid) }));
  }

  // ---------------------------------------------------------------- demo

  /** `?demo`: an attached agent that is driving moves its tabs in the fake browser. */
  private syncDemoDrive(): void {
    const demo = this.status?.wsUrl === DEMO_BROWSER_WS;
    if (!demo) {
      clearInterval(this.demoDrive);
      this.demoDrive = undefined;
      return;
    }
    if (this.demoDrive) return;
    this.demoDrive = setInterval(() => {
      const s = this.status;
      if (!s || s.wsUrl !== DEMO_BROWSER_WS || !this.conn) return;
      const now = Date.now();
      // Loaded on `?demo` only (see connect).
      void import("./demo/fakeBrowser").then(({ demoAgentStep }) => {
        for (const t of s.tabs) {
          if (t.takenOver || t.detached || t.lent || t.activeAt == null || now - t.activeAt > 5000) continue;
          demoAgentStep(t.targetId);
        }
      });
    }, 1500);
  }
}

/** Pixel size of a base64 JPEG (its SOF marker), without decoding the image. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64.slice(0, 4096));
  } catch {
    return null;
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0), width: ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0) };
    }
    i += 2 + len;
  }
  return null;
}

let instance: BrowserController | null = null;

/** The window's browser controller (created on first use). */
export function browserController(): BrowserController {
  instance ??= new BrowserController();
  return instance;
}

export function useBrowserUi<T>(selector: (s: BrowserUiState) => T): T {
  return useStore(browserController().store, selector);
}
