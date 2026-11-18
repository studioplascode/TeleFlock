import { afterEach, expect, test } from "bun:test";
import { installFieldUndo } from "./fieldUndo";

type Listener = (e: unknown) => void;

/** A document stand-in that records the listeners. */
function fakeDocument() {
  const listeners = new Map<string, Listener>();
  const target = {
    addEventListener: (type: string, l: Listener) => listeners.set(type, l),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Document;
  return { target, listeners, fire: (type: string, e: unknown) => listeners.get(type)?.(e) };
}

/** A text field: its value, selection and the input events an undo fires (`changes`). */
function field(tagName = "INPUT", attr: "own" | "secret" | null = null) {
  const f = {
    tagName,
    type: "text",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    readOnly: false,
    disabled: false,
    changes: [] as string[],
    closest: (s: string) => ((attr === "own" && s.includes("data-own-undo")) || (attr === "secret" && s.includes("data-no-undo")) ? f : null),
    setSelectionRange(a: number, b: number) {
      f.selectionStart = a;
      f.selectionEnd = b;
    },
    dispatchEvent(e: Event) {
      if (e.type === "input") f.changes.push(f.value);
      return true;
    },
  };
  return f;
}

/** The user types `text` at the caret, one character per input, as a browser reports it. */
function type(doc: ReturnType<typeof fakeDocument>, f: ReturnType<typeof field>, text: string, inputType = "insertText") {
  for (const ch of inputType === "insertText" ? [...text] : [text]) {
    doc.fire("beforeinput", { target: f, inputType, defaultPrevented: false, isComposing: false, cancelable: true });
    f.value = f.value.slice(0, f.selectionStart) + ch + f.value.slice(f.selectionEnd);
    f.selectionStart = f.selectionEnd = f.selectionStart + ch.length;
    doc.fire("input", { target: f, isComposing: false });
  }
}

function key(doc: ReturnType<typeof fakeDocument>, target: unknown, k: string, opts: { shift?: boolean; taken?: boolean } = {}) {
  const e = { target, key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true, metaKey: false, altKey: false, shiftKey: !!opts.shift, defaultPrevented: !!opts.taken, preventDefault: () => (e.defaultPrevented = true) };
  doc.fire("keydown", e);
  return e.defaultPrevented;
}

let stop: (() => void) | null = null;
afterEach(() => stop?.());

test("Ctrl+Z undoes a burst of typing in any text field, Ctrl+Shift+Z and Ctrl+Y redo it, and the field's onChange hears it", () => {
  const doc = fakeDocument();
  stop = installFieldUndo(doc.target);
  const f = field("TEXTAREA");
  type(doc, f, "hello");
  type(doc, f, " world pasted", "insertFromPaste");
  expect(key(doc, f, "z")).toBe(true);
  expect(f.value).toBe("hello");
  expect([f.selectionStart, f.selectionEnd]).toEqual([5, 5]);
  key(doc, f, "z");
  expect(f.value).toBe("");
  // Nothing more to undo: the key is still taken, the field stays.
  key(doc, f, "z");
  expect(f.value).toBe("");
  key(doc, f, "z", { shift: true });
  expect(f.value).toBe("hello");
  key(doc, f, "y");
  expect(f.value).toBe("hello world pasted");
  expect(f.changes).toEqual(["hello", "", "hello", "hello world pasted"]);
});

test("composers with their own history, a key a field already took, and other elements are left alone", () => {
  const doc = fakeDocument();
  stop = installFieldUndo(doc.target);
  const own = field("TEXTAREA", "own");
  type(doc, own, "abc");
  expect(key(doc, own, "z")).toBe(false);
  expect(own.value).toBe("abc");
  const f = field();
  type(doc, f, "abc");
  key(doc, f, "z", { taken: true });
  expect(f.value).toBe("abc");
  const checkbox = { ...field(), type: "checkbox" };
  expect(key(doc, checkbox, "z")).toBe(false);
  expect(key(doc, { tagName: "DIV" }, "z")).toBe(false);
});

test("the webview's own undo (its menu) runs the same history", () => {
  const doc = fakeDocument();
  stop = installFieldUndo(doc.target);
  const f = field();
  type(doc, f, "abc");
  const e = { target: f, inputType: "historyUndo", cancelable: true, defaultPrevented: false, isComposing: false, preventDefault: () => (e.defaultPrevented = true) };
  doc.fire("beforeinput", e);
  expect(e.defaultPrevented).toBe(true);
  expect(f.value).toBe("");
});

test("secrets get no history: password inputs and show/hide secret fields; a value the app sets starts the history over", () => {
  const doc = fakeDocument();
  stop = installFieldUndo(doc.target);
  const password = { ...field(), type: "password" };
  type(doc, password, "hunter2");
  expect(key(doc, password, "z")).toBe(false);
  expect(password.value).toBe("hunter2");
  const shown = field("INPUT", "secret");
  type(doc, shown, "token");
  expect(key(doc, shown, "z")).toBe(false);
  expect(shown.value).toBe("token");
  // A save clears the form: what was typed before never comes back.
  const f = field();
  type(doc, f, "secret-ish");
  f.value = "";
  f.selectionStart = f.selectionEnd = 0;
  key(doc, f, "z");
  expect(f.value).toBe("");
  type(doc, f, "new");
  key(doc, f, "z");
  expect(f.value).toBe("");
  expect(f.changes).toEqual([""]);
});
