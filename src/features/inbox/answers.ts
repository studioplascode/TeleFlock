import type { NeedsOption, NeedsYou } from "@/core/gen";

/** Ids of the two synthetic options an option-less confirm gets. */
const CONFIRM_ID = "__confirm";
const CANCEL_ID = "__cancel";

export const CONFIRM_OPTIONS: readonly NeedsOption[] = [
  { id: CONFIRM_ID, label: "Confirm", recommended: false, tone: "primary" },
  { id: CANCEL_ID, label: "Cancel", recommended: false, tone: "neutral" },
];

/** The options to draw for a needs-you request: its own, or Confirm / Cancel for a bare confirm. */
export function needsOptions(needs: Pick<NeedsYou, "kind" | "options">): readonly NeedsOption[] {
  return needs.options.length === 0 && needs.kind === "confirm" ? CONFIRM_OPTIONS : needs.options;
}

/** The answer an option sends: the synthetic confirm ids map to a plain confirm / cancel. */
export function optionAnswer(id: string): { choices: string[]; cancel: boolean } {
  if (id === CONFIRM_ID) return { choices: [], cancel: false };
  if (id === CANCEL_ID) return { choices: [], cancel: true };
  return { choices: [id], cancel: false };
}

/**
 * The answer "Other…" sends. Never with choices: the host reads free text only when `choices` is
 * empty, so on a multi-select the typed answer replaces any ticked options.
 */
export function otherAnswer(text: string): { choices: string[]; text: string; cancel: boolean } {
  return { choices: [], text: text.trim(), cancel: false };
}
