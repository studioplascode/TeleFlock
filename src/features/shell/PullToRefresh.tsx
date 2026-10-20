import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { cn, LogoMark, Spinner, spring, toast } from "@/design";
import { refreshAll } from "@/core";
import { errorHint, errorMessage } from "./errors";
import { haptic } from "./haptics";

const TRIGGER = 68;
const HOLD = 54;
const MAX = 130;

export interface PullToRefreshProps {
  /** Defaults to re-fetching `state.get` from every host. */
  onRefresh?: () => Promise<unknown>;
  children: ReactNode;
  /** Classes for the scroll container. */
  className?: string;
  /** Ref to the scroll container. */
  scrollRef?: Ref<HTMLDivElement>;
}

/**
 * Mobile scroll container with pull-to-refresh: rubber-band pull, the logo mark winds up as you
 * pull, a haptic tick at the trigger point, and a spinner while the refresh runs.
 */
export function PullToRefresh({ onRefresh = refreshAll, children, className, scrollRef }: PullToRefreshProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const pull = useMotionValue(0);
  const [refreshing, setRefreshing] = useState(false);
  const rotate = useTransform(pull, [0, TRIGGER], [-140, 0]);
  const opacity = useTransform(pull, [0, 24, TRIGGER], [0, 0.6, 1]);
  const scale = useTransform(pull, [0, TRIGGER, MAX], [0.5, 1, 1.12]);
  const indicatorY = useTransform(pull, (v) => v - 44);
  const live = useRef({ onRefresh, refreshing });
  useEffect(() => {
    live.current = { onRefresh, refreshing };
  });

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let startY: number | null = null;
    let armed = false;
    const onStart = (e: TouchEvent) => {
      if (live.current.refreshing || node.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0]?.clientY ?? null;
      armed = false;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      if (dy <= 0 || node.scrollTop > 0) {
        pull.set(0);
        return;
      }
      const v = Math.min(MAX, dy * 0.5);
      pull.set(v);
      if (!armed && v >= TRIGGER) {
        armed = true;
        haptic("tick");
      } else if (armed && v < TRIGGER) armed = false;
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (!armed) {
        animate(pull, 0, spring.smooth);
        return;
      }
      setRefreshing(true);
      animate(pull, HOLD, spring.snappy);
      live.current
        .onRefresh()
        .then(
          () => haptic("success"),
          (err: unknown) => {
            haptic("warning");
            toast({ title: `Refresh failed: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
          },
        )
        .finally(() => {
          setRefreshing(false);
          animate(pull, 0, spring.smooth);
        });
    };
    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: true });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [pull]);

  return (
    <div
      ref={(node) => {
        el.current = node;
        if (typeof scrollRef === "function") scrollRef(node);
        else if (scrollRef) scrollRef.current = node;
      }}
      className={cn("relative overflow-y-auto overscroll-y-contain", className)}
    >
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-0 z-raised flex justify-center"
        style={{ y: indicatorY, opacity }}
        aria-hidden={!refreshing}
      >
        <motion.div
          style={{ scale }}
          className="grid size-10 place-items-center rounded-full bg-tile-3 shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line-2)]"
        >
          {refreshing ? (
            <Spinner size={20} label="Refreshing" />
          ) : (
            <motion.span style={{ rotate }} className="grid place-items-center">
              <LogoMark size={22} title="" />
            </motion.span>
          )}
        </motion.div>
      </motion.div>
      <motion.div style={{ y: pull }}>{children}</motion.div>
    </div>
  );
}
