/** A text box Rambler fills: the composers' textarea or the ask card's single-line field. */
export type TextField = HTMLTextAreaElement | HTMLInputElement;

/** What a draft setter takes (`useDraft`'s, a `useState` setter). */
export type SetText = (update: (text: string) => string) => void;

/**
 * Replaces `[start, end)` of the box's text with `by` as one edit. With the box focused (`focus` brings it there:
 * not on a phone, where it would raise the keyboard) it is an `insertText` / `delete` the browser can undo with
 * Ctrl+Z and that fires the usual input event; otherwise the draft is rewritten directly.
 */
export function replaceRange(el: TextField | null | undefined, setText: SetText, start: number, end: number, by: string, focus: boolean): void {
  if (el && focus && document.activeElement !== el) el.focus({ preventScroll: true });
  if (el && document.activeElement === el) {
    el.setSelectionRange(start, end);
    let done = false;
    try {
      done = by ? document.execCommand("insertText", false, by) : document.execCommand("delete");
    } catch {
      done = false;
    }
    if (done) return;
  }
  setText((cur) => cur.slice(0, start) + by + cur.slice(end));
}

/** The sentence-join of the existing dictation path: a space unless the text is empty or ends in whitespace. */
export function joiner(before: string): string {
  return before && !/\s$/.test(before) ? " " : "";
}
