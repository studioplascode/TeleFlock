import { type KeyboardEvent, type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { emptyHistory, type FieldState, recordEdit, redoStep, undoKey, undoStep } from "./undo";

export interface UndoOptions {
  /** The draft's key: another draft (another agent, target or repository) starts a new history. */
  key: string;
  /** The draft's text, without the interim words of a dictation under way. */
  text: string;
  setText(text: string): void;
  ta: RefObject<HTMLTextAreaElement | null>;
  /** After an undo or redo put `text` back, the caret at `caret` (popups follow it). */
  onRestore?(text: string, caret: number): void;
}

export interface UndoControls {
  /** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo; true when it took the key. First in the box's `onKeyDown`. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** Follows the selection (the box's `onSelect`): an edit the app makes starts from it. */
  onSelect(el: HTMLTextAreaElement): void;
  /** Starts over at `text`, the draft once a send took off what it sent (a send is not undone into the box). */
  reset(text: string): void;
}

const clamped = (text: string, s: { start: number; end: number }): FieldState => ({ text, start: Math.min(s.start, text.length), end: Math.min(s.end, text.length) });

/**
 * A composer's undo history (`./undo`) on its text box. Every change of the draft is a step, grouped
 * by what the box's `beforeinput` said it was (typing, deleting, a paste…); a change without one is
 * the app's own edit (a slash completion, a picked file, dictation), a step of its own. An input
 * method's composition becomes one step when it ends. The browser's own undo (its menu, a key it
 * binds) runs this history instead of its stack.
 */
export function useUndoHistory({ key, text, setText, ta, onRestore }: UndoOptions): UndoControls {
  const history = useRef(emptyHistory());
  /** The draft the history last saw. */
  const seen = useRef({ key, text });
  /** The box's selection as last seen: where an edit by the app starts from. */
  const sel = useRef({ start: text.length, end: text.length });
  /** The user's input under way (`beforeinput`): the field before it and its `inputType`. */
  const input = useRef<{ before: FieldState; inputType: string } | null>(null);
  /** The field before the input method's composition under way. */
  const composition = useRef<FieldState | null>(null);
  /** What an undo or redo puts back: its change is no edit, and its selection comes back too. */
  const restoring = useRef<FieldState | null>(null);

  /** Takes the box's selection while it shows the draft (not a dictation's interim words). */
  const follow = () => {
    const el = ta.current;
    if (el && el.value === seen.current.text) sel.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const select = (s: FieldState) => {
    sel.current = { start: s.start, end: s.end };
    const el = ta.current;
    if (el?.value === s.text) el.setSelectionRange(s.start, s.end);
  };

  useLayoutEffect(() => {
    const was = seen.current;
    seen.current = { key, text };
    if (was.key !== key) {
      history.current = emptyHistory();
      input.current = composition.current = restoring.current = null;
      sel.current = { start: text.length, end: text.length };
      return;
    }
    if (was.text === text) return;
    const back = restoring.current;
    restoring.current = null;
    if (back?.text === text) {
      select(back);
      return;
    }
    const user = input.current?.before.text === was.text ? input.current : null;
    input.current = null;
    // During a composition the box shows its words as they form: the step comes when it ends.
    if (!composition.current) history.current = recordEdit(history.current, user?.before ?? clamped(was.text, sel.current), text, user ? user.inputType : null, Date.now());
    follow();
  }, [key, text]);

  const step = (which: "undo" | "redo") => {
    follow();
    const now = clamped(seen.current.text, sel.current);
    const r = which === "undo" ? undoStep(history.current, now) : redoStep(history.current, now);
    if (!r) return;
    history.current = r.history;
    input.current = null;
    if (r.state.text === now.text) select(r.state);
    else {
      restoring.current = r.state;
      setText(r.state.text);
    }
    onRestore?.(r.state.text, r.state.end);
  };

  const onBeforeInput = useEffectEvent((e: InputEvent) => {
    if ((e.inputType === "historyUndo" || e.inputType === "historyRedo") && e.cancelable) {
      // The browser's own undo (its menu, a key it binds) works on a stack the app's edits spoil.
      e.preventDefault();
      step(e.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    const el = ta.current;
    if (!el || e.isComposing || composition.current || el.value !== seen.current.text) return;
    const pending = { before: { text: el.value, start: el.selectionStart, end: el.selectionEnd }, inputType: e.inputType };
    input.current = pending;
    // An input that changes nothing (Backspace at the very start) leaves nothing for it to describe.
    window.setTimeout(() => {
      if (input.current === pending) input.current = null;
    });
  });
  const onCompositionStart = useEffectEvent(() => {
    follow();
    composition.current = clamped(seen.current.text, sel.current);
    input.current = null;
  });
  const onCompositionEnd = useEffectEvent(() => {
    // The input event that commits it comes before compositionend (Chromium) or after it (WebKit).
    window.setTimeout(() => {
      const before = composition.current;
      composition.current = null;
      if (!before || before.text === seen.current.text) return;
      history.current = recordEdit(history.current, before, seen.current.text, "insertCompositionText", Date.now());
      follow();
    });
  });
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    const before = (e: Event) => onBeforeInput(e as InputEvent);
    const start = () => onCompositionStart();
    const end = () => onCompositionEnd();
    el.addEventListener("beforeinput", before);
    el.addEventListener("compositionstart", start);
    el.addEventListener("compositionend", end);
    return () => {
      el.removeEventListener("beforeinput", before);
      el.removeEventListener("compositionstart", start);
      el.removeEventListener("compositionend", end);
    };
  }, [ta]);

  return {
    onKeyDown(e) {
      const which = undoKey(e);
      if (!which) return false;
      e.preventDefault();
      step(which);
      return true;
    },
    onSelect(el) {
      if (el.value === seen.current.text) sel.current = { start: el.selectionStart, end: el.selectionEnd };
    },
    reset(t) {
      history.current = emptyHistory();
      seen.current = { key: seen.current.key, text: t };
      input.current = composition.current = restoring.current = null;
    },
  };
}
