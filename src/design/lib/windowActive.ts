import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isAndroid, isTauri } from "./platform";

/*
 * Is the app window in front of the user, and can they see it at all?
 *
 * Visible: false while the document is hidden (other tab, phone screen off) or, in the desktop
 * app, while the native window is minimized or hidden to the tray: WebView2 keeps reporting a
 * visible document then, so it is asked (`isVisible` / `isMinimized`) every 2 s while the window
 * has no focus. While hidden, the shared clocks stop (time texts and sparkline sampling freeze,
 * clock.ts) and the board's live terminal tile detaches.
 *
 * Active: visible and focused. An unfocused window (another app in front, a board watched on a
 * second monitor) keeps its clocks and the live tile, but decorative loops, scrolling heartbeats
 * and ambient drift pause (html[data-active="false"], see motion.css) and motion's transform and
 * layout animations jump to their end (MotionProvider).
 */

type Listener = (on: boolean) => void;

const activeListeners = new Set<Listener>();
const visibleListeners = new Set<Listener>();
let focused = typeof document === "undefined" ? true : document.hasFocus();
let nativeFocused: boolean | null = null;
/** Desktop app: false while the native window is minimized or hidden to the tray. */
let nativeShown: boolean | null = null;
let shownPoll: ReturnType<typeof setInterval> | undefined;
let visible = computeVisible();
let active = computeActive();
let started = false;

const SHOWN_POLL_MS = 2000;

function computeVisible(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return false;
  return nativeShown ?? true;
}

function computeActive(): boolean {
  if (!visible) return false;
  // The native window's focus wins when Tauri reports it (some webviews skip window blur).
  return nativeFocused ?? focused;
}

function update(): void {
  const nextVisible = computeVisible();
  const visibleFlipped = nextVisible !== visible;
  visible = nextVisible;
  const nextActive = computeActive();
  const activeFlipped = nextActive !== active;
  active = nextActive;
  if (visibleFlipped) for (const l of visibleListeners) l(visible);
  if (activeFlipped) for (const l of activeListeners) l(active);
}

/** Desktop app without focus: ask the native window whether it is still on screen. */
function pollShown(on: boolean): void {
  clearInterval(shownPoll);
  shownPoll = undefined;
  if (!on) {
    nativeShown = null;
    return;
  }
  const win = getCurrentWindow();
  const check = () => {
    Promise.all([win.isVisible(), win.isMinimized()])
      .then(([shown, minimized]) => {
        if (shownPoll === undefined) return; // focus came back meanwhile
        nativeShown = shown && !minimized;
        update();
      })
      .catch(() => {});
  };
  shownPoll = setInterval(check, SHOWN_POLL_MS);
  check();
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Focus moving into a same-page iframe (a preview tunnel) blurs the window but keeps the
  // document focused: re-read hasFocus() once the move has settled.
  const refocus = () => {
    window.setTimeout(() => {
      focused = document.hasFocus();
      update();
    }, 0);
  };
  window.addEventListener("focus", () => {
    focused = true;
    update();
  });
  window.addEventListener("blur", refocus);
  document.addEventListener("visibilitychange", update);
  if (isTauri() && !isAndroid) {
    getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        nativeFocused = payload;
        pollShown(!payload);
        update();
      })
      .catch(() => {});
  }
  focused = document.hasFocus();
  update();
}

/** Current activity (starts tracking on first use). */
export function isWindowActive(): boolean {
  start();
  return active;
}

/** Subscribe to activity flips. Returns an unsubscribe function. */
export function onWindowActive(cb: Listener): () => void {
  start();
  activeListeners.add(cb);
  return () => activeListeners.delete(cb);
}

/** Live window activity for components (re-renders only when it flips). */
export function useWindowActive(): boolean {
  return useSyncExternalStore(
    (onChange) => onWindowActive(onChange),
    isWindowActive,
    () => true,
  );
}

/** Whether the window is on screen at all, focused or not (starts tracking on first use). */
export function isWindowVisible(): boolean {
  start();
  return visible;
}

/** Subscribe to visibility flips. Returns an unsubscribe function. */
export function onWindowVisible(cb: Listener): () => void {
  start();
  visibleListeners.add(cb);
  return () => visibleListeners.delete(cb);
}

/** Live window visibility for components (re-renders only when it flips). */
export function useWindowVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => onWindowVisible(onChange),
    isWindowVisible,
    () => true,
  );
}
