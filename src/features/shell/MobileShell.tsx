import { Grid2x2, Inbox, LayoutGrid, type LucideIcon, Send, SquareTerminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { cn, spring, toast } from "@/design";
import { navigate, type Route, useHosts, useInbox, useNotifications, useRoute, useUi } from "@/core";
import { terminalRouteKey, terminalTabTarget, useLastTerminal } from "@/features/terminal/lastTerminal";
import { EdgeSwipeBack } from "./EdgeSwipeBack";
import { haptic } from "./haptics";
import { useSoftKeyboard } from "./softKeyboard";
import { MOBILE_TABS, ViewStage } from "./ViewStage";

type Tab = (typeof MOBILE_TABS)[number];

const TAB_META: Record<Tab, { label: string; icon: LucideIcon }> = {
  board: { label: "Flock", icon: LayoutGrid },
  dispatch: { label: "Dispatch", icon: Send },
  inbox: { label: "Inbox", icon: Inbox },
  terminal: { label: "Terminal", icon: SquareTerminal },
  more: { label: "More", icon: Grid2x2 },
};

/** Which tab a route belongs to (pushed screens keep their parent tab lit). */
function tabFor(r: Route): Tab {
  switch (r.name) {
    case "dispatch":
      return "dispatch";
    case "inbox":
      return "inbox";
    case "terminal":
      return "terminal";
    case "more":
    case "hosts":
    case "settings":
    case "usage":
    case "activity":
      return "more";
    default:
      return "board";
  }
}

/**
 * Terminal tab: the last terminal used, else the agent of the last session viewed, else the
 * "Attach to…" chooser. Tapping it again on a terminal goes back to the chooser.
 */
function openTerminalTab(route: Route, hostId: string): void {
  if (route.name === "terminal") {
    // already on the chooser (a new shell from it carries `?shell=…`: tapping returns to the list)
    if (!route.agentId && !route.paneId && !window.location.hash.includes("?")) return;
    // back to the chooser: a terminal picked from it is pushed (back chevron, edge swipe)
    useLastTerminal.getState().setTabRoot(null);
    navigate({ name: "terminal", hostId: route.hostId });
    return;
  }
  const target: Extract<Route, { name: "terminal" }> = terminalTabTarget() ?? { name: "terminal", hostId };
  useLastTerminal.getState().setTabRoot(terminalRouteKey(target));
  navigate(target);
}

function BottomNav() {
  const route = useRoute();
  const active = tabFor(route);
  const needs = useInbox().length;
  const unread = useNotifications((n) => n.unread) > 0;
  const { profiles, status } = useHosts();
  const hostIssue = profiles.some((p) => {
    const ph = status[p.id]?.phase;
    return ph === "authRequired" || ph === "hostKey" || ph === "error";
  });

  const go = (tab: Tab) => {
    haptic("select");
    if (tab === "terminal") {
      const host = profiles.find((p) => status[p.id]?.phase === "online") ?? profiles[0];
      if (!host) {
        toast({ title: "Add a host first", description: "The terminal attaches to herdr on one of your hosts." });
        navigate({ name: "hosts" });
        return;
      }
      openTerminalTab(route, host.id);
      return;
    }
    if (tab === active && tab === route.name) return;
    navigate({ name: tab });
  };

  return (
    <nav
      className="relative z-sticky shrink-0 border-t border-line bg-[rgb(12_12_18/0.86)] px-1 pt-1 pb-[max(4px,env(safe-area-inset-bottom))]"
      aria-label="Primary"
    >
      <ul className="grid grid-cols-5">
        {MOBILE_TABS.map((tab) => {
          const { label, icon: Icon } = TAB_META[tab];
          const on = active === tab;
          // One meaning per mark: Inbox's number is what needs you (its dot: unread updates); More's dot is a host problem.
          const badge = tab === "inbox" ? needs : 0;
          const dot = tab === "inbox" ? unread : tab === "more" && hostIssue;
          const dotLabel = tab === "inbox" ? "unread updates" : "a host needs attention";
          return (
            <li key={tab}>
              <button
                type="button"
                onClick={() => go(tab)}
                aria-current={on ? "page" : undefined}
                aria-label={[label, badge > 0 && `${badge} need you`, dot && dotLabel].filter(Boolean).join(", ")}
                className="relative flex min-h-11 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-md py-0.5 text-[10px] leading-3 font-bold focus-ring"
              >
                <span className="relative grid h-7 w-12 place-items-center">
                  {on && (
                    <motion.span
                      layoutId="tf-tab-pill"
                      transition={spring.snappy}
                      className="absolute inset-0 rounded-full bg-accent/18 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4),0_0_18px_-4px_rgb(163_92_240/0.7)]"
                      aria-hidden
                    />
                  )}
                  <motion.span animate={{ scale: on ? 1.08 : 1, y: on ? -1 : 0 }} transition={spring.bouncy} className="relative">
                    <Icon className={cn("size-5", on ? "text-accent-hi" : "text-mute")} />
                  </motion.span>
                  {badge > 0 && (
                    <motion.span
                      key={badge}
                      initial={{ scale: 0.4 }}
                      animate={{ scale: 1 }}
                      transition={spring.bouncy}
                      aria-hidden
                      className="absolute -top-1 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-sun px-1 text-[9.5px] leading-none font-extrabold text-white shadow-[0_0_0_2px_rgb(12_12_18)] sun-pulse"
                    >
                      {badge > 99 ? "99+" : badge}
                    </motion.span>
                  )}
                  {dot && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-0 size-2 rounded-full shadow-[0_0_0_2px_rgb(12_12_18)]",
                        // beside a count the dot moves to the other corner so both stay readable
                        badge > 0 ? "left-1" : "right-2.5",
                        tab === "inbox" ? "bg-accent-hi" : "bg-sun-2 shadow-glow-sun",
                      )}
                    />
                  )}
                </span>
                <span className={cn("max-w-full truncate px-0.5", on ? "text-ink" : "text-mute")}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Nav in/out: springs for focus mode, instant when the soft keyboard takes the space (it animates itself). */
const NAV_VARIANTS = {
  hidden: (instant: boolean) => ({ height: 0, opacity: 0, transition: instant ? { duration: 0 } : spring.smooth }),
  shown: { height: "auto", opacity: 1, transition: spring.smooth },
};

/**
 * Phone frame: safe areas, routed views with push/pop transitions, bottom nav, edge-swipe back.
 * The bottom nav steps aside on the agent view (a drill-down that wants every row for the chat),
 * in focus mode and while the soft keyboard is up, and the frame pads itself above a keyboard
 * that overlays the webview, so the composer always sits on top of it.
 */
export function MobileShell() {
  const route = useRoute();
  const focus = useUi((s) => s.focusMode);
  const keyboard = useSoftKeyboard();
  const terminalKey = route.name === "terminal" ? terminalRouteKey(route) : null;
  const terminalRoot = useLastTerminal((s) => terminalKey !== null && s.tabRoot === terminalKey);
  const sessionHost = route.name === "agent" ? route.hostId : undefined;
  const sessionAgent = route.name === "agent" ? route.agentId : undefined;
  // The Terminal tab falls back to the agent of the last session viewed.
  useEffect(() => {
    if (sessionHost && sessionAgent) useLastTerminal.getState().rememberSession(sessionHost, sessionAgent);
  }, [sessionHost, sessionAgent]);
  // A terminal is the tab's root only while you stay on the tab that opened it.
  useEffect(() => {
    if (terminalKey === null) useLastTerminal.getState().setTabRoot(null);
  }, [terminalKey]);
  const atRoot =
    route.name === "board" ||
    route.name === "dispatch" ||
    route.name === "inbox" ||
    route.name === "more" ||
    (route.name === "terminal" && !route.agentId && !route.paneId) ||
    terminalRoot;
  const nav = !focus && !keyboard && route.name !== "agent";
  return (
    <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--kb-inset,0px)] pl-[env(safe-area-inset-left)]">
      <main className="relative min-h-0 flex-1">
        <ViewStage mobile />
      </main>
      <AnimatePresence initial={false} custom={keyboard}>
        {nav && (
          <motion.div key="nav" data-toast-anchor custom={keyboard} variants={NAV_VARIANTS} initial="hidden" animate="shown" exit="hidden" className="shrink-0 overflow-hidden">
            <BottomNav />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Without the nav (agent view, focus mode) the frame still keeps clear of the gesture bar /
          home indicator; with the keyboard up the keyboard covers that strip, so no spacer. */}
      {!nav && !keyboard && <div className="safe-bottom shrink-0" aria-hidden />}
      <EdgeSwipeBack enabled={!atRoot} />
    </div>
  );
}
