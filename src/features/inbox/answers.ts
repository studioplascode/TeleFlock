import type { NeedsKind, NeedsOption, NeedsYou } from "@/core/gen";

/** Ids of the two synthetic options an option-less confirm gets. */
const CONFIRM_ID = "__confirm";
const CANCEL_ID = "__cancel";

export const CONFIRM_OPTIONS: readonly NeedsOption[] = [
  { id: CONFIRM_ID, label: "Confirm", recommended: false, tone: "primary" },
  { id: CANCEL_ID, label: "Cancel", recommended: false, tone: "neutral" },
];

/**
 * The options to draw for a needs-you request: its own, or Confirm / Cancel for a bare confirm. An
 * agent's request for the user's browser offers Deny only where this device can't allow it
 * (`hostsBrowser` false: a phone, an app core without the browser); allowing belongs to a computer
 * with the browser.
 */
export function needsOptions(needs: Pick<NeedsYou, "kind" | "options" | "browser">, hostsBrowser = true): readonly NeedsOption[] {
  if (needs.browser && !hostsBrowser) return needs.options.filter((o) => o.id === "deny");
  return needs.options.length === 0 && needs.kind === "confirm" ? CONFIRM_OPTIONS : needs.options;
}

/**
 * Whether "Skip (answer nothing)" is offered for a request of this kind. Skip cancels the dialog,
 * which omp reads as Deny / No: approvals and confirms already offer that as an option, and omp
 * refuses to dismiss a plan review remotely. Callers still need options or an editor to skip from.
 */
export function skipOffered(kind: NeedsKind): boolean {
  return kind !== "approval" && kind !== "confirm" && kind !== "planReview";
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
