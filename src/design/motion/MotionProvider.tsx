import { MotionConfig } from "motion/react";
import { type ReactNode, useLayoutEffect } from "react";
import { useMediaQuery } from "../lib/hooks";
import { useWindowActive } from "../lib/windowActive";
import { type MotionLevel, REDUCED_QUERY, motionAttribute, resolveReduced, useMotionPreference } from "./preference";
import { spring } from "./springs";

/**
 * True when motion is *reduced* (Settings → Motion → Reduced, or the OS prefers-reduced-motion):
 * no loops, no tilt, no scrolling heartbeat. The default Calm level is not reduced; ask
 * `useMotionLevel()` when Calm and Lively must differ.
 */
export function useCalmMotion(): boolean {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  return resolveReduced(preference, systemReduced);
}

/** Resolved motion level, the same value as html[data-motion]: "reduced" | "calm" | "full". */
export function useMotionLevel(): MotionLevel {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  return motionAttribute(preference, systemReduced);
}

/**
 * Settings → Motion → Lively ("full"): every running agent breathes, glows and orbits and the
 * ambient background drifts. The default ("Calm", stored as "system") holds the screen still: what
 * needs you pulses a few times when it arrives, then rests (the card nudge repeats every 20 s);
 * Reduced animates nothing.
 */
export function useLivelyMotion(): boolean {
  return useMotionPreference((s) => s.preference) === "full";
}

/**
 * Mount once at the root. Syncs html[data-motion] ("reduced" | "calm" | "full": drives every CSS
 * loop, see motion.css) and html[data-active] ("false" while the window is hidden or unfocused:
 * every loop pauses), and configures motion's MotionConfig so JS animations honour the preference.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  const active = useWindowActive();
  const calm = resolveReduced(preference, systemReduced);
  const attr = motionAttribute(preference, systemReduced);
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = attr;
  }, [attr]);
  useLayoutEffect(() => {
    document.documentElement.dataset.active = String(active);
  }, [active]);
  return (
    <MotionConfig reducedMotion={calm ? "always" : "never"} transition={spring.smooth}>
      {children}
    </MotionConfig>
  );
}
