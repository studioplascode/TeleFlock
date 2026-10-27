import { type HTMLMotionProps, LayoutGroup, motion } from "motion/react";
import { createContext, type ReactNode, useContext } from "react";
import { spring } from "./springs";

export { AnimatePresence, LayoutGroup } from "motion/react";

/** Stable layoutId for an agent card so it can fly between kanban lanes / views. */
export function cardLayoutId(agentId: string): string {
  return `agent-card:${agentId}`;
}

/** The FlightGroup's arrangement (undefined outside one). */
const Arrangement = createContext<string | undefined>(undefined);

/**
 * A <LayoutGroup> of CardFlights. `arrangement` names everything that moves a card, e.g. every
 * lane's keys in order: the cards measure their layout only when it changes, so a card that
 * re-renders for its data costs no layout read (without it, motion re-measures the whole group on
 * every render of any card). A change re-measures every card at once, which is what lets the card
 * leaving one lane fly into the next and its neighbours slide.
 */
export function FlightGroup({ id, arrangement, children }: { id: string; arrangement: string; children: ReactNode }) {
  return (
    <LayoutGroup id={id}>
      <Arrangement.Provider value={arrangement}>{children}</Arrangement.Provider>
    </LayoutGroup>
  );
}

export interface CardFlightProps extends HTMLMotionProps<"div"> {
  /** Agent id; cards with the same id animate between positions/lanes. */
  flightId: string;
  /** Turn off layout animation (e.g. while dnd-kit is dragging this card — dnd-kit owns the transform then). */
  grounded?: boolean;
}

/**
 * Wrap a kanban card so a status change makes it fly to its new lane. Put all lanes inside one
 * <FlightGroup> (or a plain <LayoutGroup>, which measures on every render) and render each card
 * exactly once (in its current lane).
 */
export function CardFlight({ flightId, grounded = false, transition, children, ...rest }: CardFlightProps) {
  const arrangement = useContext(Arrangement);
  return (
    <motion.div
      layout={!grounded}
      layoutId={grounded ? undefined : cardLayoutId(flightId)}
      layoutDependency={arrangement}
      transition={{ layout: spring.flight, ...transition }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
