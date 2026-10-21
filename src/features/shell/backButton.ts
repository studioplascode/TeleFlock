import { useEffect } from "react";

/**
 * Open overlays the Android back button should close before it navigates: Radix dialogs and
 * bottom sheets, menus, select lists, and in-place popups such as the composer's slash palette.
 */
const OVERLAY = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"]:not([data-state="closed"])',
  '[role="listbox"]:not([data-state="closed"])',
].join(", ");

/** History-state key marking the entries pushed for open overlays (value: overlay depth). */
const MARK = "tfOverlay";

function depthOf(state: unknown): number {
  const v = state && typeof state === "object" ? (state as Record<string, unknown>)[MARK] : undefined;
  return typeof v === "number" ? v : 0;
}

/** Close the topmost overlay the way a keyboard user would (every overlay here handles Escape). */
function closeTop(): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

/**
 * Android back-button semantics for the phone shell: back (hardware/gesture back, which the
 * webview turns into `history.back()`, or the in-app edge swipe) closes the topmost open
 * sheet/menu/popup first and only navigates once nothing is open.
 *
 * Every overlay that opens gets a same-URL history entry. Back pops it and we close the overlay;
 * an overlay closed any other way (tap outside, drag down, a button) pops its own entry, and an
 * entry orphaned by navigating out of an overlay is skipped when back reaches it.
 */
export function useOverlayBack(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    // Overlay entries we pushed that are still in history (stacked under the current entry or on top).
    let pushed = depthOf(window.history.state);
    // popstate events caused by our own history.go(), which must not close anything.
    let ignorePops = 0;
    let frame = 0;

    const sync = () => {
      frame = 0;
      const open = document.querySelectorAll(OVERLAY).length;
      const top = depthOf(window.history.state);
      if (open > pushed && top === pushed) {
        // Newly opened overlay(s): one entry each, on top of the current page.
        for (let d = pushed + 1; d <= open; d++) window.history.pushState({ ...(window.history.state ?? {}), [MARK]: d }, "");
        pushed = open;
      } else if (open < pushed) {
        // Closed without back: drop our now-stale entries if they are still the current ones.
        const stale = top - open;
        pushed = open;
        if (stale > 0) {
          ignorePops++;
          window.history.go(-stale);
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };

    const onPop = (e: PopStateEvent) => {
      if (ignorePops > 0) {
        ignorePops--;
        return;
      }
      const level = depthOf(e.state);
      const open = document.querySelectorAll(OVERLAY).length;
      if (open > level) {
        // Back while an overlay is open: close the topmost one; its entry is already gone.
        pushed = level;
        closeTop();
      } else if (level > 0 && open === 0) {
        // Landed on an entry orphaned by navigating out of an overlay: keep going back.
        pushed = 0;
        ignorePops++;
        window.history.go(-level);
      } else {
        pushed = Math.min(pushed, level);
      }
    };

    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "role"] });
    window.addEventListener("popstate", onPop);
    return () => {
      mo.disconnect();
      window.removeEventListener("popstate", onPop);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled]);
}
