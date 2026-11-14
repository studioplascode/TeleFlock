/*
 * A composer's own undo history (`useUndoHistory` wires it to the text box).
 *
 * Native undo can't serve the composers. WebKitGTK (Linux) binds no key to it at all; every draft
 * write the app makes (a slash completion, a send, a picked file, dictation into an unfocused box)
 * empties Chromium's undo stack and leaves WebKit's stale; and React rewriting a controlled
 * textarea's text on every keystroke stops Chromium from grouping typing, so it undoes one
 * character at a time.
 *
 * Each step keeps the field as it was before it (text and selection), so an undo puts back exactly
 * that. Typing and deleting at the caret group into bursts, one step until a pause, a jump
 * elsewhere or another kind of edit; a paste, a cut, a replaced or deleted selection and the app's
 * own edits are steps of their own.
 */

/** A text field's text and selection. */
export interface FieldState {
  text: string;
  start: number;
  end: number;
}

/** The burst of typing or deleting the newest step holds: where its caret is now, when it last grew. */
interface Burst {
  kind: "type" | "delete";
  caret: number;
  at: number;
}

export interface UndoHistory {
  /** The field before each step, oldest first. */
  past: readonly FieldState[];
  /** The field as each undo found it, the next redo last. */
  future: readonly FieldState[];
  burst: Burst | null;
}

/** A pause this long ends a burst of typing. */
export const BURST_GAP_MS = 1000;
/** At most this many steps, and this many characters in all of them (the newest step is always kept). */
export const MAX_STEPS = 100;
export const MAX_CHARS = 1_000_000;

export const emptyHistory = (): UndoHistory => ({ past: [], future: [], burst: null });

/** `inputType`s of typing: a character, a line break, an input method's text. */
const TYPING: Record<string, true> = { insertText: true, insertCompositionText: true, insertLineBreak: true, insertParagraph: true };

/**
 * How an edit from `before` to `after` groups: typing (a character, or an input method's text, at
 * the caret or over the selection) and deleting next to the caret return the burst it makes; null
 * for a step of its own. `inputType` is the browser's for the user's input ("" when it didn't say),
 * null for an edit the app made.
 */
export function editGroup(before: FieldState, after: string, inputType: string | null): { kind: Burst["kind"]; caret: number } | null {
  if (inputType === null) return null;
  const { text, start, end } = before;
  const head = text.slice(0, start);
  const tail = text.slice(end);
  if (after.length >= head.length + tail.length && after.startsWith(head) && after.endsWith(tail)) {
    const added = after.slice(start, after.length - tail.length);
    // A paste, a drop or a spelling fix is no typing; nor is text put in whole with no `inputType`.
    const typed = inputType === "insertCompositionText" || ((TYPING[inputType] === true || inputType === "") && [...added].length === 1);
    return added && typed ? { kind: "type", caret: start + added.length } : null;
  }
  // Deleting at the caret; a cut or a drag takes a selection.
  const deleting = inputType === "" || (inputType.startsWith("delete") && inputType !== "deleteByCut" && inputType !== "deleteByDrag");
  if (start !== end || after.length >= text.length || !deleting) return null;
  const removed = text.length - after.length;
  // Backspace (and its word / line forms) before the caret, Delete after it; around equal
  // characters both read the same, and the `inputType` tells which.
  const back = removed <= start && after === text.slice(0, start - removed) + tail;
  const forward = after === head + text.slice(start + removed);
  if (forward && (inputType.endsWith("Forward") || !back)) return { kind: "delete", caret: start };
  return back ? { kind: "delete", caret: start - removed } : null;
}

/** The newest steps within `MAX_STEPS` and `MAX_CHARS`. */
function trimmed(past: readonly FieldState[]): readonly FieldState[] {
  let keep = 0;
  let chars = 0;
  for (let i = past.length - 1; i >= 0 && keep < MAX_STEPS; i--) {
    chars += past[i]?.text.length ?? 0;
    if (keep > 0 && chars > MAX_CHARS) break;
    keep++;
  }
  return keep === past.length ? past : past.slice(past.length - keep);
}

/**
 * The history after the field went from `before` to `after` (`inputType` as for `editGroup`) at
 * time `at`: a new step, or the burst it continues (typing on at its caret before a pause). Any
 * edit forgets what was undone.
 */
export function recordEdit(h: UndoHistory, before: FieldState, after: string, inputType: string | null, at: number): UndoHistory {
  if (before.text === after) return h;
  const group = editGroup(before, after, inputType);
  const burst = group && { ...group, at };
  const b = h.burst;
  if (group && b && b.kind === group.kind && before.start === before.end && before.start === b.caret && at - b.at <= BURST_GAP_MS) {
    return { past: h.past, future: [], burst };
  }
  return { past: trimmed([...h.past, before]), future: [], burst };
}

/** One step back: the state to put in the field, and the history that can redo `current`. Null: nothing to undo. */
export function undoStep(h: UndoHistory, current: FieldState): { history: UndoHistory; state: FieldState } | null {
  const state = h.past.at(-1);
  if (!state) return null;
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current], burst: null }, state };
}

/** One undone step again; null when nothing was undone since the last edit. */
export function redoStep(h: UndoHistory, current: FieldState): { history: UndoHistory; state: FieldState } | null {
  const state = h.future.at(-1);
  if (!state) return null;
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1), burst: null }, state };
}

/**
 * The undo and redo keys: Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo. AltGr (Ctrl+Alt on
 * Windows) types, so a chord with Alt is none; a layout without Latin letters goes by the key's place.
 */
export function undoKey(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  const letter = /^[a-z]$/.test(k) ? k : e.code === "KeyZ" ? "z" : e.code === "KeyY" ? "y" : "";
  if (letter === "z") return e.shiftKey ? "redo" : "undo";
  return letter === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey ? "redo" : null;
}
