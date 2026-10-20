import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";
import { MOBILE_MAX_WIDTH } from "../tokens";

/** Live `window.matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
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
