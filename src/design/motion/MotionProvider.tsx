import { MotionConfig } from "motion/react";
import { type ReactNode, useLayoutEffect } from "react";
import { useMediaQuery } from "../lib/hooks";
import { REDUCED_QUERY, resolveReduced, useMotionPreference } from "./preference";
import { spring } from "./springs";

/** True when animations should be calm (user setting or OS prefers-reduced-motion). */
export function useCalmMotion(): boolean {
  const preference = useMotionPreference((s) => s.preference);
  const systemReduced = useMediaQuery(REDUCED_QUERY);
  return resolveReduced(preference, systemReduced);
}

/**
 * Mount once at the root. Syncs html[data-motion] (drives every CSS loop) and configures motion's
 * MotionConfig so JS animations honour the same preference.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const calm = useCalmMotion();
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = calm ? "reduced" : "full";
  }, [calm]);
  return (
    <MotionConfig reducedMotion={calm ? "always" : "never"} transition={spring.smooth}>
      {children}
    </MotionConfig>
  );
}
