import type { Transition } from "motion/react";

/**
 * Spring presets (motion's duration/bounce form: `visualDuration` is the time to visually reach
 * the target; `bounce` 0 = critically damped). Use these instead of ad-hoc numbers.
 */
export const spring = {
  /** Micro-interactions: toggles, pills, indicators. */
  snappy: { type: "spring", visualDuration: 0.22, bounce: 0.18 },
  /** Default UI movement. */
  smooth: { type: "spring", visualDuration: 0.4, bounce: 0.1 },
  /** Playful pop for things appearing (badges, toasts, orbs). */
  bouncy: { type: "spring", visualDuration: 0.5, bounce: 0.38 },
  /** Slow, weighty drift (ambient, big panels). */
  gentle: { type: "spring", visualDuration: 0.8, bounce: 0.05 },
  /** Cards flying between kanban columns (shared layout). */
  flight: { type: "spring", visualDuration: 0.55, bounce: 0.22 },
  /** Bottom sheets and drawers. */
  sheet: { type: "spring", visualDuration: 0.42, bounce: 0.08 },
  /** Press feedback. */
  press: { type: "spring", visualDuration: 0.15, bounce: 0.3 },
} as const satisfies Record<string, Transition>;

/** Non-spring tweens for opacity/colour, where overshoot makes no sense. */
export const tween = {
  fast: { type: "tween", duration: 0.15, ease: [0.16, 1, 0.3, 1] },
  base: { type: "tween", duration: 0.25, ease: [0.16, 1, 0.3, 1] },
  slow: { type: "tween", duration: 0.6, ease: [0.16, 1, 0.3, 1] },
} as const satisfies Record<string, Transition>;

/** Spread onto any motion element for springy press/hover feedback. */
export const pressMotion = {
  whileTap: { scale: 0.96 },
  whileHover: { y: -1 },
  transition: spring.press,
} as const;

/** Enter/exit variants for list items and popovers. */
export const fadeRise = {
  initial: { opacity: 0, y: 8, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.smooth },
  exit: { opacity: 0, y: 4, scale: 0.985, transition: tween.fast },
} as const;

export const popIn = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1, transition: spring.bouncy },
  exit: { opacity: 0, scale: 0.6, transition: tween.fast },
} as const;
