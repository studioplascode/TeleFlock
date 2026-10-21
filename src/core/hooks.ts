import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import type {
  AgentTemplate,
  Column,
  ConnStatus,
  HostProfile,
  HostState,
  Settings,
  TranscriptItem,
  TunnelInfo,
  UiRequest,
  Workspace,
} from "@/core/gen";
import type { ApiError, SessionMeta } from "@/core/gen";
import { activityWatchers, core, loadActivity, pushInternal, startCore } from "./client";
import type { AgentView, BtwEntry, CoreState, HostActivityEvent, HostNotification, SessionStatus } from "./store/state";
import { coreStore } from "./store/store";
import type { Backend } from "./transport/types";

const EMPTY_ARR: never[] = [];
const EMPTY_OBJ: Record<string, never> = {};

// Importing the hooks in the browser starts the core (idempotent; the app also calls startCore()
// before rendering). Never started from inside a render, so no store update happens mid-render.
if (typeof window !== "undefined") startCore();

/**
 * Selector access to the raw data store (cross-host aggregates). Selectors returning new
 * objects/arrays need `equal` (e.g. `shallow` from `zustand/shallow`) to avoid render loops.
 */
export function useCore<T>(selector: (s: CoreState) => T, equal?: (a: T, b: T) => boolean): T {
  const prev = useRef<{ v: T } | null>(null);
  return useStore(coreStore, (s) => {
    const v = selector(s);
    if (equal && prev.current && equal(prev.current.v, v)) return prev.current.v;
    prev.current = { v };
    return v;
  });
}

export function useBackend(): Backend {
  return useCore((s) => s.backend);
}

// ------------------------------------------------------------------ hosts

interface Prefs {
  filter: string;
}

const FILTER_KEY = "tf.hostFilter";

function readFilter(): string {
  try {
    return globalThis.localStorage?.getItem(FILTER_KEY) ?? "all";
  } catch {
    return "all";
  }
}

const prefsStore = createStore<Prefs>(() => ({ filter: readFilter() }));

export interface HostsView {
  profiles: HostProfile[];
  status: Record<string, ConnStatus>;
  /** Host id or `"all"`. */
  filter: string;
  setFilter(id: string): void;
  /** True once the profile list has arrived (first-run onboarding gate). */
  loaded: boolean;
}

function setFilter(filter: string): void {
  try {
    globalThis.localStorage?.setItem(FILTER_KEY, filter);
  } catch {
    /* storage unavailable */
  }
  prefsStore.setState({ filter });
}

let hostsCache: HostsView | null = null;

function getHostsView(): HostsView {
  const c = coreStore.getState();
  const p = prefsStore.getState();
  const h = hostsCache;
  if (h && h.profiles === c.profiles && h.status === c.status && h.loaded === c.profilesLoaded && h.filter === p.filter) {
    return h;
  }
  hostsCache = { profiles: c.profiles, status: c.status, filter: p.filter, setFilter, loaded: c.profilesLoaded };
  return hostsCache;
}

function subscribeHosts(cb: () => void): () => void {
  const a = coreStore.subscribe(cb);
  const b = prefsStore.subscribe(cb);
  return () => {
    a();
    b();
  };
}

/** Host profiles, statuses and the board host filter. Selectors must return stable values. */
export function useHosts(): HostsView;
export function useHosts<T>(selector: (h: HostsView) => T): T;
export function useHosts<T>(selector?: (h: HostsView) => T): T | HostsView {
  return useSyncExternalStore(subscribeHosts, () => (selector ? selector(getHostsView()) : getHostsView()));
}
useHosts.getState = getHostsView;

export function useHostState(hostId: string): HostState | undefined {
  return useCore((s) => s.hosts[hostId]?.state);
}

let statesCache: { hosts: CoreState["hosts"]; out: Record<string, HostState> } | null = null;

function hostStates(s: CoreState): Record<string, HostState> {
  if (statesCache?.hosts === s.hosts) return statesCache.out;
  const out: Record<string, HostState> = {};
  for (const [id, h] of Object.entries(s.hosts)) out[id] = h.state;
  statesCache = { hosts: s.hosts, out };
  return out;
}

/** Every known HostState (live or cached), keyed by host id. Stable between changes. */
export function useHostStates(): Record<string, HostState> {
  return useCore(hostStates);
}

function hostOrder(s: CoreState): string[] {
  const ids = s.profiles.map((p) => p.id);
  for (const id of Object.keys(s.hosts)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Known hosts in profile order (plus any host with state but no profile). */
export function useHostIds(): string[] {
  return useCore(useShallow(hostOrder));
}

/** True when the host's state is a cached snapshot (host not online). */
export function useHostStale(hostId: string): boolean {
  return useCore((s) => s.hosts[hostId] !== undefined && s.status[hostId]?.phase !== "online");
}

export function useWorkspaces(hostId: string): Workspace[] {
  return useCore((s) => s.hosts[hostId]?.state.workspaces ?? EMPTY_ARR);
}

/** Non-reactive: every workspace on every host (palette search). */
export function getWorkspacesSnapshot(): { hostId: string; ws: Workspace }[] {
  const s = coreStore.getState();
  return hostOrder(s).flatMap((hostId) => (s.hosts[hostId]?.state.workspaces ?? []).map((ws) => ({ hostId, ws })));
}

// ------------------------------------------------------------------ agents

export function useAgent(key: string): AgentView | undefined {
  return useCore((s) => s.agents[key]);
}

export interface AgentFilter {
  column?: Column;
  /** Host id, or `"all"` / undefined for every host. */
  hostId?: string;
  workspaceId?: string;
  repo?: string;
  kind?: string;
  q?: string;
}

function matches(a: AgentView, f: AgentFilter, q: string): boolean {
  if (f.column && a.column !== f.column) return false;
  if (f.hostId && f.hostId !== "all" && a.hostId !== f.hostId) return false;
  if (f.workspaceId && a.workspaceId !== f.workspaceId) return false;
  if (f.repo && a.repo !== f.repo) return false;
  if (f.kind && a.kind !== f.kind) return false;
  if (q) {
    const hay = `${a.name} ${a.title} ${a.repo ?? ""} ${a.branch ?? ""} ${a.kind} ${a.live.line ?? ""}`.toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  return true;
}

/**
 * Lane order: needs → oldest request first; running → longest running first;
 * review/done → most recent first. No column → host, workspace, name.
 */
export function compareAgents(s: CoreState, column: Column | undefined): (a: AgentView, b: AgentView) => number {
  if (column === "needs") return (a, b) => (a.needs?.since ?? a.stateSince) - (b.needs?.since ?? b.stateSince) || a.name.localeCompare(b.name);
  if (column === "running") return (a, b) => a.stateSince - b.stateSince || a.name.localeCompare(b.name);
  if (column === "review" || column === "done") return (a, b) => b.stateSince - a.stateSince || a.name.localeCompare(b.name);
  const order = hostOrder(s);
  const wsOrder = (a: AgentView) => s.hosts[a.hostId]?.state.workspaces.find((w) => w.id === a.workspaceId)?.order ?? 1e9;
  return (a, b) =>
    order.indexOf(a.hostId) - order.indexOf(b.hostId) || wsOrder(a) - wsOrder(b) || a.name.localeCompare(b.name);
}

export function selectAgentKeys(s: CoreState, f: AgentFilter = {}): string[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const list = Object.values(s.agents).filter((a) => matches(a, f, q));
  list.sort(compareAgents(s, f.column));
  return list.map((a) => a.key);
}

/** Agent keys matching the filter, ordered for display. Re-renders only when the list changes. */
export function useAgentKeys(filter: AgentFilter = {}): string[] {
  const { column, hostId, workspaceId, repo, kind, q } = filter;
  return useCore(useShallow((s) => selectAgentKeys(s, { column, hostId, workspaceId, repo, kind, q })));
}

export function useColumnKeys(column: Column, filter: Omit<AgentFilter, "column"> = {}): string[] {
  return useAgentKeys({ ...filter, column });
}

/** Non-reactive: every agent (palette search). */
export function getAgentViews(): AgentView[] {
  const s = coreStore.getState();
  return selectAgentKeys(s).map((k) => s.agents[k] as AgentView);
}

/** Agent keys in Needs-you across hosts, oldest first. */
export function useInbox(): string[] {
  return useCore(useShallow((s) => selectAgentKeys(s, { column: "needs" })));
}

// ------------------------------------------------------------------ sessions

export interface SessionView {
  status: SessionStatus;
  meta?: SessionMeta;
  itemIds: string[];
  ui?: UiRequest | null;
  hasMore: boolean;
  error?: ApiError;
  endedReason?: string;
}

/** Session header data. Pair with `openSession(key)` (ref-counted) in an effect. */
export function useSession(key: string): SessionView {
  return useCore(
    useShallow((s): SessionView => {
      const e = s.sessions[key];
      if (!e) return { status: "idle", itemIds: EMPTY_ARR, hasMore: false };
      return {
        status: e.status,
        meta: e.meta,
        itemIds: e.itemIds,
        ui: e.ui,
        hasMore: e.hasMore,
        error: e.error,
        endedReason: e.endedReason,
      };
    }),
  );
}

/** One transcript row (per-row subscription). */
export function useSessionItem(key: string, itemId: string): TranscriptItem | undefined {
  return useCore((s) => s.sessions[key]?.items[itemId]);
}

/** Loaded transcript rows of a session, oldest first (imperative; for one-shot actions like copy). */
export function getTranscript(key: string): { items: TranscriptItem[]; hasMore: boolean } {
  const e = coreStore.getState().sessions[key];
  if (!e) return { items: [], hasMore: false };
  return { items: e.itemIds.flatMap((id) => e.items[id] ?? []), hasMore: e.hasMore };
}

/** `/btw` side answers streamed for this session, by btw id. */
export function useBtw(key: string): Record<string, BtwEntry> {
  return useCore((s) => s.sessions[key]?.btw ?? EMPTY_OBJ);
}

// ------------------------------------------------------------------ notifications

export interface NotificationsView {
  items: HostNotification[];
  unread: number;
  markRead(): void;
  clear(): void;
}

function markRead(): void {
  const s = coreStore.getState();
  if (!s.notifications.some((n) => !n.read)) return;
  coreStore.setState({ notifications: s.notifications.map((n) => (n.read ? n : { ...n, read: true })) });
}

function clearNotifications(): void {
  coreStore.setState({ notifications: [] });
}

let notifCache: NotificationsView | null = null;

function notificationsView(s: CoreState): NotificationsView {
  if (notifCache?.items === s.notifications) return notifCache;
  notifCache = {
    items: s.notifications,
    unread: s.notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0),
    markRead,
    clear: clearNotifications,
  };
  return notifCache;
}

export function useNotifications(): NotificationsView;
export function useNotifications<T>(selector: (v: NotificationsView) => T): T;
export function useNotifications<T>(selector?: (v: NotificationsView) => T): T | NotificationsView {
  return useCore((s) => (selector ? selector(notificationsView(s)) : notificationsView(s)));
}
useNotifications.getState = () => notificationsView(coreStore.getState());

// ------------------------------------------------------------------ activity

let activityCache: { activity: CoreState["activity"]; hostId: string; out: HostActivityEvent[] } | null = null;

function selectActivity(s: CoreState, hostId: string | undefined): HostActivityEvent[] {
  const id = hostId ?? "*";
  if (activityCache && activityCache.activity === s.activity && activityCache.hostId === id) return activityCache.out;
  let out: HostActivityEvent[];
  if (hostId) out = s.activity[hostId]?.events ?? EMPTY_ARR;
  else {
    out = Object.values(s.activity).flatMap((a) => a.events);
    out.sort((a, b) => b.at - a.at);
  }
  activityCache = { activity: s.activity, hostId: id, out };
  return out;
}

/**
 * Activity feed (newest first) of one host, or of every host. Loads `host.activity` on mount and
 * refreshes when agents change lanes / notifications arrive while mounted.
 */
export function useActivity(hostId?: string): HostActivityEvent[] {
  const ids = useHostIds();
  const status = useHosts((h) => h.status);
  const targets = hostId ? [hostId] : ids;
  const onlineKey = targets.filter((id) => status[id]?.phase === "online").join("|");
  useEffect(() => {
    const watchKey = hostId ?? "*";
    activityWatchers.set(watchKey, (activityWatchers.get(watchKey) ?? 0) + 1);
    for (const id of onlineKey ? onlineKey.split("|") : []) {
      if (!coreStore.getState().activity[id]?.loaded) void loadActivity(id, false).catch(() => {});
    }
    return () => {
      const n = (activityWatchers.get(watchKey) ?? 1) - 1;
      if (n > 0) activityWatchers.set(watchKey, n);
      else activityWatchers.delete(watchKey);
    };
  }, [hostId, onlineKey]);
  // Per-host stable arrays are cached in the selector (single-entry memo per call site is enough
  // because the cache is keyed by the activity map identity).
  return useCore(useShallow((s) => selectActivity(s, hostId)));
}

/** Pages older activity for a host. */
export function loadOlderActivity(hostId: string): Promise<void> {
  return loadActivity(hostId, true);
}

// ------------------------------------------------------------------ settings & tunnels

export const DEFAULT_SETTINGS: Settings = {
  motion: "system",
  notifyNeeds: true,
  notifyFinished: true,
  notifyErrors: true,
  notifySound: false,
  keepAlive: true,
  terminalFontSize: 13,
  confirmArchive: false,
  defaultPlan: false,
  deviceName: "TeleFlock",
  mutedAgents: [],
  templates: [],
};

export interface SettingsView extends Settings {
  update(patch: Partial<Settings>): Promise<void>;
  /** Mute/unmute OS notifications, toasts and sounds for one agent (`hostId::agentId`). */
  setMuted(key: string, muted: boolean): Promise<void>;
  /** Insert or replace a template by id. */
  saveTemplate(template: AgentTemplate): Promise<void>;
  removeTemplate(id: string): Promise<void>;
  loaded: boolean;
}

/** Locally intended settings not yet confirmed by `settings.set` (read-your-writes for helpers). */
let pendingSettings: Settings | null = null;
/** `settings.set` calls run one at a time, in call order, so responses can't reorder. */
let settingsChain: Promise<void> = Promise.resolve();

/** Settings with every list present (older backends may omit newer fields), pending writes included. */
function currentSettings(): Settings {
  return pendingSettings ?? { ...DEFAULT_SETTINGS, ...coreStore.getState().settings };
}

function updateSettings(patch: Partial<Settings>): Promise<void> {
  const prev = currentSettings();
  const next = { ...prev, ...patch };
  pendingSettings = next;
  // Optimistic and synchronous: the UI and the next helper call see it immediately.
  coreStore.setState({ settings: next });
  const run = settingsChain.then(async () => {
    try {
      const saved = await core.app("settings.set", next);
      if (pendingSettings === next) {
        pendingSettings = null;
        pushInternal({ type: "settings", settings: saved });
      }
    } catch (err) {
      // Roll back only if nothing newer was written meanwhile (a newer write carries this patch too).
      if (pendingSettings === next) {
        pendingSettings = null;
        pushInternal({ type: "settings", settings: prev });
      }
      throw err;
    }
  });
  settingsChain = run.catch(() => {});
  return run;
}

function setMuted(key: string, muted: boolean): Promise<void> {
  const list = currentSettings().mutedAgents.filter((k) => k !== key);
  return updateSettings({ mutedAgents: muted ? [...list, key] : list });
}

function saveTemplate(template: AgentTemplate): Promise<void> {
  const list = currentSettings().templates;
  const i = list.findIndex((t) => t.id === template.id);
  return updateSettings({ templates: i < 0 ? [...list, template] : list.map((t, j) => (j === i ? template : t)) });
}

function removeTemplate(id: string): Promise<void> {
  return updateSettings({ templates: currentSettings().templates.filter((t) => t.id !== id) });
}

let settingsCache: { src: Settings | null; out: SettingsView } | null = null;

function settingsView(s: CoreState): SettingsView {
  if (settingsCache?.src === s.settings) return settingsCache.out;
  const out: SettingsView = { ...DEFAULT_SETTINGS, ...s.settings, update: updateSettings, setMuted, saveTemplate, removeTemplate, loaded: s.settings !== null };
  settingsCache = { src: s.settings, out };
  return out;
}

/** Non-reactive: is this agent muted (no needs-you toasts, sounds or OS notifications)? */
export function isMuted(key: string): boolean {
  return coreStore.getState().settings?.mutedAgents?.includes(key) ?? false;
}

/** Reactive variant of `isMuted` for a mute toggle / bell icon. */
export function useIsMuted(key: string): boolean {
  return useCore((s) => s.settings?.mutedAgents?.includes(key) ?? false);
}

export function useSettings(): SettingsView;
export function useSettings<T>(selector: (v: SettingsView) => T): T;
export function useSettings<T>(selector?: (v: SettingsView) => T): T | SettingsView {
  return useCore((s) => (selector ? selector(settingsView(s)) : settingsView(s)));
}
useSettings.getState = () => settingsView(coreStore.getState());

export function useTunnels(): TunnelInfo[] {
  return useCore((s) => s.tunnels);
}
