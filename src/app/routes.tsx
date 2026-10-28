import { lazy } from "react";
import type { Route } from "@/core";
import { HostsView } from "@/features/hosts/HostsView";
import { SettingsView } from "@/features/settings/SettingsView";
import { MoreView } from "@/features/shell/MoreView";

/*
 * Route → screen. Feature screens are code-split; the shell's own screens load eagerly.
 * On phones the same routes render mobile layouts (each view adapts via useIsMobile), except the
 * board, whose phone home is FlockHome.
 */

const BoardView = lazy(() => import("@/features/board/BoardView").then((m) => ({ default: m.BoardView })));
const FlockHome = lazy(() => import("@/features/board/FlockHome").then((m) => ({ default: m.FlockHome })));
const InboxView = lazy(() => import("@/features/inbox/InboxView").then((m) => ({ default: m.InboxView })));
const ActivityView = lazy(() => import("@/features/activity/ActivityView").then((m) => ({ default: m.ActivityView })));
const UsageView = lazy(() => import("@/features/usage/UsageView").then((m) => ({ default: m.UsageView })));
const SessionView = lazy(() => import("@/features/session/SessionView").then((m) => ({ default: m.SessionView })));
const TerminalView = lazy(() => import("@/features/terminal/TerminalView").then((m) => ({ default: m.TerminalView })));
const ReviewView = lazy(() => import("@/features/review/ReviewView").then((m) => ({ default: m.ReviewView })));
const DispatchView = lazy(() => import("@/features/dispatch/DispatchView").then((m) => ({ default: m.DispatchView })));
const AutomationsView = lazy(() => import("@/features/automations/AutomationsView").then((m) => ({ default: m.AutomationsView })));
const OmpSettingsView = lazy(() => import("@/features/ompSettings/OmpSettingsView").then((m) => ({ default: m.OmpSettingsView })));
const McpView = lazy(() => import("@/features/mcp/McpView").then((m) => ({ default: m.McpView })));
const AccountsView = lazy(() => import("@/features/accounts/AccountsView").then((m) => ({ default: m.AccountsView })));
const DesignGallery = lazy(() => import("./routes/design/DesignGallery"));

/** Stable key per screen (agent/terminal/review include their ids so switching agents re-animates). */
export function routeKey(r: Route): string {
  switch (r.name) {
    case "agent":
      return `agent:${r.hostId}:${r.agentId}`;
    case "terminal":
      return `terminal:${r.hostId}:${r.agentId ?? ""}:${r.paneId ?? ""}`;
    case "review":
      return `review:${r.hostId}:${r.workspaceId}`;
    default:
      return r.name;
  }
}

/** Screens that own their full height (no page scroll / pull-to-refresh). The phone board scrolls. */
export function isFullBleed(r: Route, mobile: boolean): boolean {
  return r.name === "agent" || r.name === "dispatch" || r.name === "terminal" || r.name === "review" || (r.name === "board" && !mobile) || r.name === "design";
}

export function RouteView({ route, mobile }: { route: Route; mobile: boolean }) {
  switch (route.name) {
    case "board":
      return mobile ? <FlockHome /> : <BoardView />;
    case "dispatch":
      return <DispatchView />;
    case "agent":
      return <SessionView hostId={route.hostId} agentId={route.agentId} />;
    case "terminal":
      return <TerminalView hostId={route.hostId} paneId={route.paneId} agentId={route.agentId} />;
    case "review":
      return <ReviewView hostId={route.hostId} workspaceId={route.workspaceId} />;
    case "inbox":
      return <InboxView />;
    case "activity":
      return <ActivityView />;
    case "usage":
      return <UsageView />;
    case "hosts":
      return <HostsView />;
    case "settings":
      return <SettingsView />;
    case "more":
      return mobile ? <MoreView /> : <SettingsView />;
    case "design":
      return <DesignGallery />;
    case "automations":
      return <AutomationsView hostId={route.hostId} />;
    case "omp":
      return <OmpSettingsView hostId={route.hostId} />;
    case "mcp":
      return <McpView hostId={route.hostId} />;
    case "accounts":
      return <AccountsView hostId={route.hostId} link={route.link} />;
  }
}

/**
 * Warms the code-split screens one tap away, one per idle period, so the first open of an agent,
 * the inbox or a terminal renders at once instead of waiting for its chunk (seconds on a phone).
 */
export function prefetchViews(mobile: boolean): void {
  const order = [
    () => import("@/features/session/SessionView"),
    mobile ? () => import("@/features/board/FlockHome") : () => import("@/features/board/BoardView"),
    () => import("@/features/inbox/InboxView"),
    () => import("@/features/dispatch/DispatchView"),
    () => import("@/features/terminal/TerminalView"),
  ];
  const next = (i: number) => {
    const load = order[i];
    if (!load) return;
    const run = () => void load().then(() => next(i + 1), () => next(i + 1));
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
    else window.setTimeout(run, 300);
  };
  next(0);
}
