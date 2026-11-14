import { describe, expect, test } from "bun:test";
import { BURST_GAP_MS, editGroup, emptyHistory, type FieldState, MAX_CHARS, MAX_STEPS, recordEdit, redoStep, undoKey, undoStep } from "./undo";

const at = (text: string, start = text.length, end = start): FieldState => ({ text, start, end });

/** A text box driven the way the browser and the app change it, `t` its clock. */
class Box {
  h = emptyHistory();
  state: FieldState;
  t = 0;
  constructor(text = "") {
    this.state = at(text);
  }
  edit(text: string, caret: number, inputType: string | null, wait = 60) {
    this.t += wait;
    this.h = recordEdit(this.h, this.state, text, inputType, this.t);
    this.state = at(text, caret);
  }
  type(chars: string, wait = 60) {
    for (const ch of chars) {
      const { text, start, end } = this.state;
      this.edit(text.slice(0, start) + ch + text.slice(end), start + ch.length, "insertText", wait);
    }
  }
  backspace(times = 1) {
    for (let i = 0; i < times; i++) {
      const { text, start, end } = this.state;
      const from = start === end ? start - 1 : start;
      this.edit(text.slice(0, from) + text.slice(end), from, "deleteContentBackward");
    }
  }
  select(start: number, end: number) {
    this.state = at(this.state.text, start, end);
  }
  undo() {
    const r = undoStep(this.h, this.state);
    if (r) [this.h, this.state] = [r.history, r.state];
    return this.state;
  }
  redo() {
    const r = redoStep(this.h, this.state);
    if (r) [this.h, this.state] = [r.history, r.state];
    return this.state;
  }
}

describe("composer undo history", () => {
  test("select all + delete comes back with its selection, and goes again on redo", () => {
    const box = new Box();
    box.type("fix the login bug");
    box.select(0, 17);
    box.backspace();
    expect(box.state.text).toBe("");
    expect(box.undo()).toEqual(at("fix the login bug", 0, 17));
    expect(box.redo()).toEqual(at(""));
    expect(box.undo().text).toBe("fix the login bug");
    // The typing before it was one step.
    expect(box.undo()).toEqual(at(""));
  });

  test("typing groups until a pause, a jump elsewhere or deleting", () => {
    const box = new Box();
    box.type("fix");
    box.t += BURST_GAP_MS;
    box.type(" it");
    box.backspace(2);
    box.select(0, 0);
    box.type("now ");
    expect(box.state.text).toBe("now fix ");
    expect(box.undo().text).toBe("fix ");
    expect(box.undo().text).toBe("fix it");
    expect(box.undo()).toEqual(at("fix"));
    expect(box.undo()).toEqual(at(""));
    expect(box.undo()).toEqual(at(""));
  });

  test("typing over a selection starts a step the typing after it joins", () => {
    const box = new Box("hello world");
    box.select(6, 11);
    box.type("there");
    box.type("!");
    expect(box.undo()).toEqual(at("hello world", 6, 11));
  });

  test("a paste, the app's edits and an input method's text are steps of their own or typing", () => {
    const box = new Box();
    box.type("see ");
    // A paste chip's token goes in with `insertText` (the box's own undoable edit), whole.
    box.edit("see [Paste #1 +40 lines] ", 25, "insertText");
    box.type("and");
    // A slash completion: the app writes the draft.
    box.edit("/plan see [Paste #1 +40 lines] and", 6, null);
    expect(box.undo()).toEqual(at("see [Paste #1 +40 lines] and"));
    expect(box.undo().text).toBe("see [Paste #1 +40 lines] ");
    expect(box.undo().text).toBe("see ");
    expect(box.undo().text).toBe("");
    // A composed word is typing.
    expect(editGroup(at("ab"), "ab日本", "insertCompositionText")).toEqual({ kind: "type", caret: 4 });
    expect(editGroup(at("ab"), "ab pasted", "insertFromPaste")).toBeNull();
    expect(editGroup(at("ab"), "abc", null)).toBeNull();
  });

  test("Delete and Backspace read the same around equal characters: the input type decides", () => {
    expect(editGroup(at("aab", 1), "ab", "deleteContentForward")).toEqual({ kind: "delete", caret: 1 });
    expect(editGroup(at("aab", 1), "ab", "deleteContentBackward")).toEqual({ kind: "delete", caret: 0 });
    expect(editGroup(at("abc", 1, 2), "ac", "deleteContentBackward")).toBeNull();
    expect(editGroup(at("abc", 1, 2), "ac", "deleteByCut")).toBeNull();
  });

  test("an edit forgets what was undone", () => {
    const box = new Box();
    box.type("a");
    box.undo();
    box.type("b");
    expect(box.redo()).toEqual(at("b"));
  });

  test("keeps the newest steps within its count and size", () => {
    const box = new Box();
    for (let i = 1; i <= MAX_STEPS + 5; i++) box.edit("x".repeat(i), i, null);
    expect(box.h.past.length).toBe(MAX_STEPS);
    expect(box.h.past[0]?.text.length).toBe(5);
    const big = new Box();
    big.edit("a".repeat(MAX_CHARS / 2 + 1), 0, null);
    big.edit("b".repeat(MAX_CHARS / 2 + 1), 0, null);
    big.edit("c", 1, null);
    expect(big.h.past.map((s) => s.text[0])).toEqual(["b"]);
  });

  test("the keys: Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo", () => {
    const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, code = `Key${k.toUpperCase()}`) =>
      undoKey({ key: k, code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt });
    expect(key("z", { ctrl: true })).toBe("undo");
    expect(key("Z", { ctrl: true, shift: true })).toBe("redo");
    expect(key("y", { ctrl: true })).toBe("redo");
    expect(key("z", { meta: true })).toBe("undo");
    expect(key("z", { meta: true, shift: true })).toBe("redo");
    // A Cyrillic layout: the Z key by its place.
    expect(key("я", { ctrl: true }, "KeyZ")).toBe("undo");
    // AltGr (Ctrl+Alt) types; Cmd+Y and Ctrl+Shift+Y are no redo; a bare Z is a letter.
    expect(key("z", { ctrl: true, alt: true })).toBeNull();
    expect(key("y", { meta: true })).toBeNull();
    expect(key("Y", { ctrl: true, shift: true })).toBeNull();
    expect(key("Z", { shift: true })).toBeNull();
  });
});
