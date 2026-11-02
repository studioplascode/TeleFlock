import { create } from "zustand";

/**
 * Where opening a "decided for you" notification lands (`HostPage` `decisions`): the Inbox brings
 * the decision with that notification into view and highlights it (`flash`, a `decisionKey`), or
 * its "Decided for you" section when none has it (reviewed elsewhere meanwhile). Kept out of the
 * Inbox's own module so opening a notification doesn't load the Inbox.
 */
export interface DecisionFocus {
  focus: { hostId: string; notificationId?: string; at: number } | null;
  flash: string | null;
}

export const useDecisionFocus = create<DecisionFocus>(() => ({ focus: null, flash: null }));

/** The Inbox's next render brings this host's decision (its notification's) or the section into view. */
export function focusDecisions(hostId: string, notificationId?: string): void {
  useDecisionFocus.setState({ focus: { hostId, notificationId, at: Date.now() } });
}
