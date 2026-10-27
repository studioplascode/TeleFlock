import { type RefObject, startTransition, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { MOBILE_MAX_WIDTH } from "../tokens";

/** One MediaQueryList per query: `matchMedia` is a native call worth avoiding on every snapshot read. */
const queries = new Map<string, MediaQueryList>();

function mediaQuery(query: string): MediaQueryList {
  let mql = queries.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    queries.set(query, mql);
  }
  return mql;
}

/** Live `window.matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = mediaQuery(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => mediaQuery(query).matches,
    () => false,
  );
}

/** Phone layout (narrow viewport). Use for layout decisions; use `useFinePointer` for hover/tilt affordances. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
}

/** Mouse/trackpad-class pointer with hover (desktop). False on touch devices. */
export function useFinePointer(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

/** Whether the element is (nearly) on screen. Used to pause canvas/rAF work for off-screen rows. */
export function useInView(ref: RefObject<Element | null>, rootMargin = "64px"): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/**
 * Whether the element is at least `px` wide (ResizeObserver; re-renders only when the answer
 * flips). For layout decisions that must also unmount work, where a CSS container query can't.
 */
export function useMinWidth(ref: RefObject<Element | null>, px: number): boolean {
  const [wide, setWide] = useState(true);
  // Layout effect + an immediate measurement: a narrow mount (e.g. beside an open split) must not paint the
  // wide layout for a frame before the observer's first callback.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // content-box width, matching ResizeObserver's contentRect (and unaffected by enter-animation transforms)
    const cs = getComputedStyle(el);
    setWide(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) >= px);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWide(entry.contentRect.width >= px);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return wide;
}

/**
 * False on mount; true once `afterMs` have passed and the main thread is idle. The flip renders
 * in a transition (time-sliced), so a heavy subtree gated on it mounts after an enter animation
 * instead of stalling it. Pass 0 under reduced motion.
 */
export function useIdleReady(afterMs: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idle = 0;
    const flip = () => startTransition(() => setReady(true));
    const timer = window.setTimeout(() => {
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(flip, { timeout: 200 });
      else flip();
    }, afterMs);
    return () => {
      clearTimeout(timer);
      if (idle) cancelIdleCallback(idle);
    };
  }, [afterMs]);
  return ready;
}
