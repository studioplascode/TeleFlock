import { createContext, useContext, useState } from "react";
import { needleOf } from "./match";
import { holds } from "./rowText";
import { useFindStore } from "./store";

/**
 * The find scope the rows below belong to: the agent key for a session transcript, a preview
 * key for rows held outside the store. Rows read it through `useFindReveal`.
 */
export const FindScopeCtx = createContext<string | null>(null);

/**
 * True while Find's current match is in row `itemId`: the row opens what hides the match
 * (a collapsed tool card, thinking, a summary). With `text`, only when that part holds the
 * query (one file of a multi-file diff, say). Re-renders only when the answer changes.
 */
export function useFindReveal(itemId: string, text?: string | null): boolean {
  const scope = useContext(FindScopeCtx);
  return useFindStore((s) => {
    const f = scope ? s.scopes[scope] : undefined;
    if (!f?.open || f.active?.id !== itemId) return false;
    return text === undefined || holds(text, needleOf(f.query, f.caseSensitive));
  });
}


/**
 * Calls `open` (a state setter of the calling component) when Find's current match lands in row
 * `itemId` (and in `text`, when given): the part stays open afterwards, like one the user opened.
 */
export function useOpenOnFind(itemId: string, open: () => void, text?: string | null): void {
  const reveal = useFindReveal(itemId, text);
  const [seen, setSeen] = useState(false);
  if (reveal !== seen) {
    setSeen(reveal);
    if (reveal) open();
  }
}