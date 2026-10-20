import { useSyncExternalStore } from "react";

/** Hash routes (single router for the whole app). */
export type Route =
  | { name: "board" }
  | { name: "agent"; hostId: string; agentId: string }
  | { name: "terminal"; hostId: string; paneId?: string; agentId?: string }
  | { name: "review"; hostId: string; workspaceId: string }
  | { name: "inbox" }
  | { name: "activity" }
  | { name: "usage" }
  | { name: "hosts" }
  | { name: "settings" }
  | { name: "more" }
  | { name: "design" };

export type RouteName = Route["name"];

const SIMPLE: Record<string, Route> = {
  board: { name: "board" },
  inbox: { name: "inbox" },
  activity: { name: "activity" },
  usage: { name: "usage" },
  hosts: { name: "hosts" },
  settings: { name: "settings" },
  more: { name: "more" },
  design: { name: "design" },
};

const enc = encodeURIComponent;

/** Route → `#/…` hash (use as `href`). */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case "agent":
      return `#/agent/${enc(route.hostId)}/${enc(route.agentId)}`;
    case "terminal":
      if (route.agentId) return `#/terminal/${enc(route.hostId)}/a/${enc(route.agentId)}`;
      if (route.paneId) return `#/terminal/${enc(route.hostId)}/p/${enc(route.paneId)}`;
      return `#/terminal/${enc(route.hostId)}`;
    case "review":
      return `#/review/${enc(route.hostId)}/${enc(route.workspaceId)}`;
    default:
      return `#/${route.name}`;
  }
}

function dec(s: string | undefined): string | undefined {
  if (s === undefined || s === "") return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `#/…` (or `/…`) → Route. Unknown paths map to the board. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "").split("?")[0] ?? "";
  const parts = path.split("/");
  const head = parts[0] ?? "";
  if (head === "" ) return SIMPLE.board as Route;
  const simple = SIMPLE[head];
  if (simple) return simple;
  const a = dec(parts[1]);
  const b = dec(parts[2]);
  const c = dec(parts[3]);
  if (head === "agent" && a && b) return { name: "agent", hostId: a, agentId: b };
  if (head === "review" && a && b) return { name: "review", hostId: a, workspaceId: b };
  if (head === "terminal" && a) {
    if (b === "a" && c) return { name: "terminal", hostId: a, agentId: c };
    if (b === "p" && c) return { name: "terminal", hostId: a, paneId: c };
    // Legacy `#/terminal/:hostId/:paneId`.
    if (b && b !== "a" && b !== "p") return { name: "terminal", hostId: a, paneId: b };
    return { name: "terminal", hostId: a };
  }
  return SIMPLE.board as Route;
}

let lastHash: string | null = null;
let lastRoute: Route = { name: "board" };

/** Current route; referentially stable while the hash doesn't change. */
export function getRoute(): Route {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  if (hash !== lastHash) {
    lastHash = hash;
    lastRoute = parseHash(hash);
  }
  return lastRoute;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, getRoute);
}

/** Navigate to a route. `replace` avoids a history entry. */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const hash = routeToHash(route);
  if (window.location.hash === hash) return;
  if (opts.replace) {
    window.history.replaceState(window.history.state, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}
