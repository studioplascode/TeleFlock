import { emptyHistory, type FieldState, recordEdit, redoStep, type UndoHistory, undoKey, undoStep } from "@/features/session/composer/undo";

/*
 * Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z or Ctrl+Y (redo) in every text field of the app, as other
 * programs have them. WebKitGTK (the Linux app) binds no key to undo at all, and where the webview
 * has one (Chromium), a controlled field undoes one character at a time. Each text field gets the
 * composers' history (`features/session/composer/undo.ts`): typing and deleting at the caret group
 * into bursts until a pause, a paste, a cut or a replaced selection is a step of its own, an input
 * method's composition one step when it ends. An undo puts the text and selection back and fires
 * `input`, so a React field's `onChange` follows it.
 *
 * Fields with an undo history of their own (the composers, `data-own-undo`) and the terminal's
 * input are left alone; a key a field's own handler already took (`defaultPrevented`) too. Secrets
 * never get a history: password inputs, and fields that show a secret as text on demand
 * (`data-no-undo`), so no earlier state of a typed secret can be brought back. A value the app sets
 * itself (a save clearing a form, a reset) starts the field's history over.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;

/** `<input>` types that hold editable text with a caret (never `password`). */
const TEXT_INPUTS: Record<string, true> = { text: true, search: true, url: true, tel: true, email: true };

/** The text field an event is about, or null when it isn't one this covers. */
function fieldOf(target: EventTarget | null): Field | null {
  const el = target as Partial<Field> & { closest?(selector: string): unknown } | null;
  if (!el || (el.tagName !== "TEXTAREA" && !(el.tagName === "INPUT" && TEXT_INPUTS[(el as HTMLInputElement).type] === true))) return null;
  if (el.readOnly || el.disabled || el.closest?.("[data-own-undo], [data-no-undo], .xterm")) return null;
  return el as Field;
}

const stateOf = (el: Field): FieldState => ({ text: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length });

interface Track {
  history: UndoHistory;
  /** The field's text as the history last saw it: anything else was set by the app. */
  seen: string;
  /** The user's input under way (`beforeinput`): the field before it and its `inputType`. */
  pending: { before: FieldState; inputType: string } | null;
  /** The field before the input method's composition under way. */
  composing: FieldState | null;
}

/** Installs the undo on `target` (the document); returns the cleanup. */
export function installFieldUndo(target: Pick<Document, "addEventListener" | "removeEventListener"> = document): () => void {
  const tracks = new WeakMap<Field, Track>();
  /** The field's history; a text the app wrote since (a cleared form) starts it over, so nothing it replaced comes back. */
  const track = (el: Field): Track => {
    let t = tracks.get(el);
    if (!t || (t.seen !== el.value && !t.pending && !t.composing)) {
      t = { history: emptyHistory(), seen: el.value, pending: null, composing: null };
      tracks.set(el, t);
    }
    return t;
  };

  const step = (el: Field, which: "undo" | "redo") => {
    const t = track(el);
    const now = stateOf(el);
    const r = which === "undo" ? undoStep(t.history, now) : redoStep(t.history, now);
    if (!r) return;
    t.history = r.history;
    t.pending = null;
    t.seen = r.state.text;
    if (r.state.text !== now.text) {
      // The prototype's setter: React tracks the value it last set, and an input event with the
      // text written past it is how its `onChange` learns of the change.
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (set) set.call(el, r.state.text);
      else el.value = r.state.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    try {
      el.setSelectionRange(r.state.start, r.state.end);
    } catch {
      // email inputs have no selection
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const which = undoKey(e);
    const el = which && fieldOf(e.target);
    if (!which || !el) return;
    e.preventDefault();
    step(el, which);
  };
  const onBeforeInput = (e: InputEvent) => {
    const el = fieldOf(e.target);
    if (!el || e.defaultPrevented) return;
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      // The webview's own undo (its menu, a key it binds) would work on its own stack.
      if (!e.cancelable) return;
      e.preventDefault();
      step(el, e.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    const t = track(el);
    if (e.isComposing || t.composing) return;
    const pending = { before: stateOf(el), inputType: e.inputType };
    t.pending = pending;
    // An input that changes nothing (Backspace at the very start) fires no input event.
    setTimeout(() => {
      if (t.pending === pending) t.pending = null;
    });
  };
  const onInput = (e: Event) => {
    const el = fieldOf(e.target);
    const t = el && tracks.get(el);
    if (!el || !t?.pending || (e as InputEvent).isComposing) return;
    t.history = recordEdit(t.history, t.pending.before, el.value, t.pending.inputType, Date.now());
    t.seen = el.value;
    t.pending = null;
  };
  const onCompositionStart = (e: CompositionEvent) => {
    const el = fieldOf(e.target);
    if (!el) return;
    const t = track(el);
    t.composing = stateOf(el);
    t.pending = null;
  };
  const onCompositionEnd = (e: CompositionEvent) => {
    const el = fieldOf(e.target);
    const t = el && tracks.get(el);
    if (!el || !t) return;
    // The input event that commits it comes before compositionend (Chromium) or after it (WebKit).
    setTimeout(() => {
      const before = t.composing;
      t.composing = null;
      if (before && before.text !== el.value) t.history = recordEdit(t.history, before, el.value, "insertCompositionText", Date.now());
      t.seen = el.value;
    });
  };

  // Bubble phase on the document: a field's own handlers (React's, the composers', xterm's) run first.
  const listeners: [string, (e: never) => void][] = [
    ["keydown", onKeyDown],
    ["beforeinput", onBeforeInput],
    ["input", onInput],
    ["compositionstart", onCompositionStart],
    ["compositionend", onCompositionEnd],
  ];
  for (const [type, l] of listeners) target.addEventListener(type, l as EventListener);
  return () => {
    for (const [type, l] of listeners) target.removeEventListener(type, l as EventListener);
  };
}
