import { create } from "zustand";
import { navigate } from "@/core";

/** Anchor of the Refusal fallback card in Settings. */
export const REFUSAL_SECTION_ID = "settings-refusal-fallback";

interface FocusState {
  /** A request to bring the section into view, with the host whose rules to light up (`""`: none in particular). */
  request?: { hostId: string; n: number };
  ask(hostId: string): void;
  done(n: number): void;
}

let count = 0;

export const useRefusalFocus = create<FocusState>()((set) => ({
  ask: (hostId) => set({ request: { hostId, n: ++count } }),
  done: (n) => set((s) => (s.request?.n === n ? { request: undefined } : s)),
}));

/** Settings → Refusal fallback, on `hostId`'s rules (the omp settings page and a refusal row link here). */
export function openRefusalSettings(hostId = ""): void {
  useRefusalFocus.getState().ask(hostId);
  navigate({ name: "settings" });
}

const USER_SCROLL = ["wheel", "touchstart", "keydown"] as const;

/**
 * Scrolls `el` to the top of its scroller and keeps it there for 1.5 s while the page above it settles (the
 * cards fade in, hosts answer and rows change height), until the user scrolls.
 */
export function bringIntoView(el: HTMLElement | null): void {
  const page = el?.parentElement;
  if (!el || !page) return;
  const place = () => el.scrollIntoView({ block: "start" });
  place();
  const watch = new ResizeObserver(place);
  const stop = () => {
    watch.disconnect();
    for (const ev of USER_SCROLL) window.removeEventListener(ev, stop);
  };
  watch.observe(page);
  for (const ev of USER_SCROLL) window.addEventListener(ev, stop, { passive: true });
  setTimeout(stop, 1500);
}
