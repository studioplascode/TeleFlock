import { type HTMLMotionProps, motion } from "motion/react";
import { spring } from "./springs";

export { AnimatePresence, LayoutGroup } from "motion/react";

/** Stable layoutId for an agent card so it can fly between kanban lanes / views. */
export function cardLayoutId(agentId: string): string {
  return `agent-card:${agentId}`;
}

export interface CardFlightProps extends HTMLMotionProps<"div"> {
  /** Agent id; cards with the same id animate between positions/lanes. */
  flightId: string;
  /** Turn off layout animation (e.g. while dnd-kit is dragging this card — dnd-kit owns the transform then). */
  grounded?: boolean;
}

/**
 * Wrap a kanban card so a status change makes it fly to its new lane. Put all lanes inside one
 * <LayoutGroup> and render each card exactly once (in its current lane).
 */
export function CardFlight({ flightId, grounded = false, transition, children, ...rest }: CardFlightProps) {
  return (
    <motion.div
      layout={!grounded}
      layoutId={grounded ? undefined : cardLayoutId(flightId)}
      transition={{ layout: spring.flight, ...transition }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
