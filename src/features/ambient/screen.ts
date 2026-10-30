import { useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "@/design";

/** The Screen Wake Lock API is there (Chromium browsers, WebView2; not Android's WebView or WebKitGTK). */
export const wakeLockSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;

/**
 * Keeps the screen on while `on` and the page is visible (an ambient display on a shelf must not
 * sleep). The browser drops the lock whenever the page is hidden; it is asked for again when the
 * page comes back. Returns whether a lock is held right now.
 */
export function useWakeLock(on: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on || !wakeLockSupported) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = () => {
      if (disposed || lock || document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then(
        (l) => {
          if (disposed) {
            void l.release();
            return;
          }
          lock = l;
          setHeld(true);
          l.addEventListener("release", () => {
            lock = null;
            setHeld(false);
          });
        },
        () => setHeld(false),
      );
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
      setHeld(false);
    };
  }, [on]);
  return held;
}

/**
 * Browser full screen for the whole page (dialogs and the answer HUD portal into it too). Not
 * offered inside the desktop app, whose webviews don't turn the window full screen by themselves.
 */
export const fullscreenSupported = typeof document !== "undefined" && document.fullscreenEnabled === true && !isTauri();

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

export function useFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenElement != null,
    () => false,
  );
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
}
