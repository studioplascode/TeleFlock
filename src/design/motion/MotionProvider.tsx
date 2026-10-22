import { MotionConfig } from "motion/react";
import { type ReactNode, useLayoutEffect } from "react";
import { useMediaQuery } from "../lib/hooks";
import { REDUCED_QUERY, motionAttribute, resolveReduced, useMotionPreference } from "./preference";
import { spring } from "./springs";

/** True when animations should be calm (user setting or OS prefers-reduced-motion). */
export function useCalmMotion(): boolean {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  return resolveReduced(preference, systemReduced);
}

/**
 * Settings → Motion → Lively ("full"): every running agent breathes, glows and orbits. The default
 * ("Calm", stored as "system") animates only changes and what needs you; Reduced animates nothing.
 */
export function useLivelyMotion(): boolean {
  return useMotionPreference((s) => s.preference) === "full";
}

/**
 * Mount once at the root. Syncs html[data-motion] ("reduced" | "calm" | "full": drives every CSS
 * loop, see motion.css) and configures motion's MotionConfig so JS animations honour the same preference.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  const calm = resolveReduced(preference, systemReduced);
  const attr = motionAttribute(preference, systemReduced);
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = attr;
  }, [attr]);
  return (
    <MotionConfig reducedMotion={calm ? "always" : "never"} transition={spring.smooth}>
      {children}
    </MotionConfig>
  );
}
