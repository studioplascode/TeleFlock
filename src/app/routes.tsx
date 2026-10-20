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
  return r.name === "agent" || r.name === "terminal" || r.name === "review" || (r.name === "board" && !mobile) || r.name === "design";
}

export function RouteView({ route, mobile }: { route: Route; mobile: boolean }) {
  switch (route.name) {
    case "board":
      return mobile ? <FlockHome /> : <BoardView />;
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
  }
}
