import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isAndroid, isTauri } from "./platform";

/*
 * Is the app window in front of the user? False while the document is hidden (minimized, other
 * tab, phone screen off) or the window has lost focus (another app is in front). Decorative loops,
 * scrolling heartbeats and ambient drift pause while inactive (html[data-active="false"], see
 * motion.css); clocks keep ticking while merely unfocused so a window watched on a second monitor
 * stays truthful.
 */

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let focused = typeof document === "undefined" ? true : document.hasFocus();
let nativeFocused: boolean | null = null;
let active = compute();
let started = false;

function compute(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return false;
  // The native window's focus wins when Tauri reports it (some webviews skip window blur).
  return nativeFocused ?? focused;
}

function update(): void {
  const next = compute();
  if (next === active) return;
  active = next;
  for (const l of listeners) l(active);
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
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Live window activity for components (re-renders only when it flips). */
export function useWindowActive(): boolean {
  return useSyncExternalStore(
    (onChange) => onWindowActive(onChange),
    isWindowActive,
    () => true,
  );
}
