import { useSyncExternalStore } from "react";

/** Hash routes (single router for the whole app). */
export type Route =
  | { name: "board" }
  | { name: "dispatch" }
  | { name: "agent"; hostId: string; agentId: string }
  | { name: "terminal"; hostId: string; paneId?: string; agentId?: string }
  | { name: "review"; hostId: string; workspaceId: string }
  | { name: "inbox" }
  | { name: "activity" }
  | { name: "usage" }
  /** The week's digest of every host in view, shared as an image. */
  | { name: "wrapped" }
  | { name: "hosts" }
  | { name: "settings" }
  | { name: "more" }
  | { name: "design" }
  /** Live transcripts of 4 or 9 agents in a grid (desktop; a big monitor). */
  | { name: "wall" }
  /** One orb per agent for a tablet or second screen; the shell's chrome steps aside. */
  | { name: "ambient" }
  /** Scheduled agent runs of one host (`hostId` absent: the first / last used host). */
  | { name: "automations"; hostId?: string }
  /** omp's own settings (models, roles, tools, …) of one host. */
  | { name: "omp"; hostId?: string }
  /** omp's MCP servers of one host (list, add, sign in, test, enable/disable). */
  | { name: "mcp"; hostId?: string }
  /** omp's skills and plugins of one host (installed, switches, updates, the registry, marketplaces). */
  | { name: "plugins"; hostId?: string }
  /** One host's linked worktrees (pull request, age, changes, size, last agent) and omp's storage cleanup. */
  | { name: "cleanup"; hostId?: string }
  /** Subscription accounts and API keys omp signs in with on one host; `link` opens the Link
   * account sheet: on that provider (`#/accounts/<hostId>/link/<provider>`), or on the provider
   * picker when empty (`#/accounts/<hostId>/link`). */
  | { name: "accounts"; hostId?: string; link?: string };

export type RouteName = Route["name"];

const SIMPLE: Record<string, Route> = {
  board: { name: "board" },
  dispatch: { name: "dispatch" },
  inbox: { name: "inbox" },
  activity: { name: "activity" },
  usage: { name: "usage" },
  wrapped: { name: "wrapped" },
  hosts: { name: "hosts" },
  settings: { name: "settings" },
  more: { name: "more" },
  design: { name: "design" },
  wall: { name: "wall" },
  ambient: { name: "ambient" },
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
    case "automations":
    case "omp":
    case "mcp":
    case "plugins":
    case "cleanup":
      return route.hostId ? `#/${route.name}/${enc(route.hostId)}` : `#/${route.name}`;
    case "accounts":
      if (!route.hostId) return "#/accounts";
      if (route.link === undefined) return `#/accounts/${enc(route.hostId)}`;
      return route.link ? `#/accounts/${enc(route.hostId)}/link/${enc(route.link)}` : `#/accounts/${enc(route.hostId)}/link`;
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
  if (head === "automations" || head === "omp" || head === "mcp" || head === "plugins" || head === "cleanup") return a ? { name: head, hostId: a } : { name: head };
  if (head === "accounts") {
    if (!a) return { name: "accounts" };
    return b === "link" ? { name: "accounts", hostId: a, link: c ?? "" } : { name: "accounts", hostId: a };
  }
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
