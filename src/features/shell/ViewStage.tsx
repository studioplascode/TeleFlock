import { AlertOctagon, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Component, type ErrorInfo, type ReactNode, Suspense, useState } from "react";
import { Button, cn, LogoMark, spring, tween } from "@/design";
import { navigate, type Route, useRoute } from "@/core";
import { isFullBleed, RouteView, routeKey } from "@/app/routes";
import { PullToRefresh } from "./PullToRefresh";

/** Bottom-nav tabs, in order (direction of the slide between them). */
export const MOBILE_TABS = ["board", "dispatch", "inbox", "terminal", "more"] as const satisfies readonly Route["name"][];

interface Boundary {
  error: Error | null;
}

/** Keeps one broken screen from taking the whole app down; offers a retry. */
class ViewErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, Boundary> {
  override state: Boundary = { error: null };

  static getDerivedStateFromError(error: Error): Boundary {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("view crashed", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex w-full max-w-md min-w-0 flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-lg bg-error/14 text-error">
            <AlertOctagon className="size-6" />
          </span>
          <h2 className="font-display text-xl font-bold">This view hit a snag</h2>
          <p className="max-w-full text-sm break-words text-mute">{error.message}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<RotateCcw />} onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button variant="secondary" onClick={() => navigate({ name: "board" })}>
              Back to the board
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

function Loading() {
  return (
    <div className="grid h-full min-h-[50dvh] place-items-center" aria-busy>
      <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring.smooth, delay: 0.15 }}>
        <LogoMark size={40} animated />
      </motion.span>
    </div>
  );
}

const TAB_INDEX: Partial<Record<Route["name"], number>> = { board: 0, dispatch: 1, inbox: 2, terminal: 3, more: 4 };

/** Slide direction for the transition from `prev` to `next`: 1 forward (from the right), -1 back. */
function direction(prev: Route, next: Route): number {
  // Tabs sit at depth 0 (a terminal bound to an agent/pane is pushed on top); everything else is depth 1.
  const tab = (r: Route) => (r.name === "terminal" && (r.agentId || r.paneId) ? undefined : TAB_INDEX[r.name]);
  const tp = tab(prev);
  const tn = tab(next);
  if (tp === undefined && tn === undefined) return 1;
  if (tp === undefined) return -1;
  if (tn === undefined) return 1;
  return Math.sign(tn - tp) || 1;
}

/**
 * The view container: renders the current route with a transition (desktop: rise + blur-in;
 * phone: native-feeling horizontal push/pop), a loading mark while code-split screens load,
 * page scrolling (and pull-to-refresh on phones) for non-full-bleed screens.
 */
export function ViewStage({ mobile }: { mobile: boolean }) {
  const route = useRoute();
  const key = routeKey(route);
  const [nav, setNav] = useState<{ route: Route; dir: number }>({ route, dir: 1 });
  const changed = routeKey(nav.route) !== key;
  const dir = changed ? direction(nav.route, route) : nav.dir;
  if (changed) setNav({ route, dir });
  const full = isFullBleed(route, mobile);

  const variants = mobile
    ? {
        initial: (d: number) => ({ x: `${d * 28}%`, opacity: 0 }),
        animate: { x: "0%", opacity: 1, transition: spring.sheet },
        exit: (d: number) => ({ x: `${d * -18}%`, opacity: 0, transition: tween.fast }),
      }
    : {
        initial: { opacity: 0, y: 14, scale: 0.992, filter: "blur(6px)" },
        // `filter: none` once settled: a lingering blur(0px) keeps the whole view on its own render
        // surface and turns it into the containing block for position:fixed descendants.
        animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: spring.smooth, transitionEnd: { filter: "none" } },
        exit: { opacity: 0, y: -6, filter: "blur(4px)", transition: tween.fast },
      };

  const view = (
    <ViewErrorBoundary resetKey={key}>
      <Suspense fallback={<Loading />}>
        <RouteView route={route} mobile={mobile} />
      </Suspense>
    </ViewErrorBoundary>
  );

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        <motion.div key={key} custom={dir} variants={variants} initial="initial" animate="animate" exit="exit" className="absolute inset-0 flex flex-col">
          {full ? (
            <div className="min-h-0 flex-1">{view}</div>
          ) : mobile ? (
            <PullToRefresh className="min-h-0 flex-1">{view}</PullToRefresh>
          ) : (
            <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain")}>{view}</div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
