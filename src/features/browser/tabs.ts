/**
 * The panel's tabs: the browser's page targets in the order the panel shows them, which one is
 * shown, and what the strip and toolbar show for each. Pure; the controller feeds it CDP events.
 */
import type { TargetInfo } from "./cdp/protocol";

export interface Tab {
  /** CDP target id. */
  id: string;
  url: string;
  title: string;
  /** The tab whose page opened this one (`window.open`, `target=_blank`). */
  openerId?: string;
  loading: boolean;
  /** `data:` URL of the page's icon, once fetched. */
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The renderer crashed or was killed: the tab shows a notice with Reload. */
  crashed: boolean;
}

export interface TabsState {
  order: string[];
  byId: Record<string, Tab>;
  active: string | null;
  /** Most recently shown first (for the tab to show when the shown one closes). */
  recent: string[];
  /** URLs of closed tabs, the latest last (Reopen closed tab). */
  closed: string[];
}

export const EMPTY_TABS: TabsState = { order: [], byId: {}, active: null, recent: [], closed: [] };

const CLOSED_MAX = 20;

export type TabAction =
  | { type: "created"; info: TargetInfo; activate: boolean }
  | { type: "changed"; info: TargetInfo }
  | { type: "destroyed"; id: string }
  | { type: "crashed"; id: string }
  | { type: "activate"; id: string }
  | { type: "loading"; id: string; loading: boolean }
  | { type: "history"; id: string; canGoBack: boolean; canGoForward: boolean }
  | { type: "favicon"; id: string; favicon: string | undefined };

/** Page targets are tabs; DevTools front-ends, the browser's own UI, workers and extensions are not. */
export function isTabTarget(info: Pick<TargetInfo, "type" | "url">): boolean {
  return info.type === "page" && !info.url.startsWith("devtools://");
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function withRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)];
}

/**
 * Where a new tab goes: right after its opener and the opener's other children that follow it
 * (Chrome's order for links opened in a new tab), else at the end.
 */
function insertAt(s: TabsState, openerId: string | undefined): number {
  if (!openerId) return s.order.length;
  const at = s.order.indexOf(openerId);
  if (at < 0) return s.order.length;
  let i = at + 1;
  while (i < s.order.length && s.byId[s.order[i] ?? ""]?.openerId === openerId) i++;
  return i;
}

/** The tab to show when `id` (shown) closes: its opener, else its right neighbour, else its left. */
function successor(s: TabsState, id: string): string | null {
  const tab = s.byId[id];
  if (tab?.openerId && s.byId[tab.openerId] && tab.openerId !== id) return tab.openerId;
  const at = s.order.indexOf(id);
  return s.order[at + 1] ?? s.order[at - 1] ?? null;
}

export function reduceTabs(s: TabsState, a: TabAction): TabsState {
  switch (a.type) {
    case "created": {
      if (!isTabTarget(a.info)) return s;
      const id = a.info.targetId;
      if (s.byId[id]) return reduceTabs(s, { type: "changed", info: a.info });
      const tab: Tab = {
        id,
        url: a.info.url,
        title: a.info.title,
        openerId: a.info.openerId,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
      };
      const order = [...s.order];
      order.splice(insertAt(s, a.info.openerId), 0, id);
      const activate = a.activate || s.active == null;
      return {
        ...s,
        order,
        byId: { ...s.byId, [id]: tab },
        active: activate ? id : s.active,
        recent: activate ? withRecent(s.recent, id) : [...s.recent, id],
      };
    }
    case "changed": {
      const tab = s.byId[a.info.targetId];
      if (!tab) return s;
      const url = a.info.url;
      const title = a.info.title;
      if (url === tab.url && title === tab.title && a.info.openerId === tab.openerId) return s;
      const sameSite = origin(url) === origin(tab.url);
      const next: Tab = { ...tab, url, title, openerId: a.info.openerId ?? tab.openerId, favicon: sameSite ? tab.favicon : undefined };
      return { ...s, byId: { ...s.byId, [tab.id]: next } };
    }
    case "destroyed": {
      const tab = s.byId[a.id];
      if (!tab) return s;
      const active = s.active === a.id ? successor(s, a.id) : s.active;
      const byId = { ...s.byId };
      delete byId[a.id];
      const keep = tab.url && tab.url !== "about:blank" && !tab.url.startsWith("chrome://");
      const closed = keep ? [...s.closed, tab.url].slice(-CLOSED_MAX) : s.closed;
      const recent = s.recent.filter((x) => x !== a.id);
      return { order: s.order.filter((x) => x !== a.id), byId, active, recent: active ? withRecent(recent, active) : recent, closed };
    }
    case "crashed": {
      const tab = s.byId[a.id];
      if (!tab || tab.crashed) return s;
      return { ...s, byId: { ...s.byId, [a.id]: { ...tab, crashed: true, loading: false } } };
    }
    case "activate": {
      if (!s.byId[a.id] || s.active === a.id) return s;
      return { ...s, active: a.id, recent: withRecent(s.recent, a.id) };
    }
    case "loading": {
      const tab = s.byId[a.id];
      if (!tab || tab.loading === a.loading) return s;
      return { ...s, byId: { ...s.byId, [a.id]: { ...tab, loading: a.loading, crashed: a.loading ? false : tab.crashed } } };
    }
    case "history": {
      const tab = s.byId[a.id];
      if (!tab || (tab.canGoBack === a.canGoBack && tab.canGoForward === a.canGoForward)) return s;
      return { ...s, byId: { ...s.byId, [a.id]: { ...tab, canGoBack: a.canGoBack, canGoForward: a.canGoForward } } };
    }
    case "favicon": {
      const tab = s.byId[a.id];
      if (!tab || tab.favicon === a.favicon) return s;
      return { ...s, byId: { ...s.byId, [a.id]: { ...tab, favicon: a.favicon } } };
    }
  }
}

/** The tab `step` places from the shown one, wrapping around (Ctrl+Tab, Ctrl+Shift+Tab). */
export function cycleTab(s: TabsState, step: 1 | -1): string | null {
  if (s.order.length === 0) return null;
  const at = s.active ? s.order.indexOf(s.active) : -1;
  const n = s.order.length;
  return s.order[(((at + step) % n) + n) % n] ?? null;
}

/** The last closed tab's URL and the state without it (Reopen closed tab). */
export function popClosed(s: TabsState): { url: string | null; state: TabsState } {
  const url = s.closed[s.closed.length - 1] ?? null;
  return { url, state: url ? { ...s, closed: s.closed.slice(0, -1) } : s };
}

/** What a tab's strip entry and the window title call it. */
export function tabLabel(tab: Pick<Tab, "title" | "url">): string {
  const title = tab.title.trim();
  if (title && title !== tab.url) return title;
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    const u = new URL(tab.url);
    return u.host || tab.url;
  } catch {
    return tab.url;
  }
}
