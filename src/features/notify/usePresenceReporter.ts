import { useEffect } from "react";
import { isWindowActive, isWindowVisible, onWindowActive, onWindowVisible } from "@/design";
import { core } from "@/core";
import type { UiPresence } from "@/core/gen";
import { isApiError } from "@/features/shell/errors";
import { PresenceTracker } from "./presence";

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Tells the core what this window sees of you (`app.presence`: shown, focused, last input), so
 * hosts alert the device you are using and escalate to another when nobody saw it. Mount once.
 *
 * Reports once on mount, whenever the window's visibility or focus flips (`lib/windowActive.ts`
 * knows document visibility, blur/focus and, in the desktop app, minimized and hidden-to-tray
 * windows) and on input, at most once per 20 s while input continues. No timer runs: an idle
 * window costs nothing (architecture §6.3). Cores before 0.7.0 answer `unknown_method`: reporting
 * stops quietly. The core adds the system idle time and this device's settings.
 */
export function usePresenceReporter(): void {
  useEffect(() => {
    const tracker = new PresenceTracker(Date.now);
    let supported = true;
    const send = (p: UiPresence | null) => {
      if (!p || !supported) return;
      core.app("app.presence", p).catch((err: unknown) => {
        if (isApiError(err) && (err.code === "unknown_method" || err.code === "unsupported")) supported = false;
      });
    };
    const report = () => send(tracker.state(isWindowVisible(), isWindowActive()));
    const onInput = () => send(tracker.input(isWindowVisible(), isWindowActive()));
    report();
    const offs = [onWindowActive(report), onWindowVisible(report)];
    const opts = { passive: true, capture: true } as const;
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, opts);
    return () => {
      for (const off of offs) off();
      for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, opts);
    };
  }, []);
}
