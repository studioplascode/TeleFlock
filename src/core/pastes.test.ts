import { describe, expect, test } from "bun:test";
import {
  addPaste,
  attachmentBlock,
  DEFAULT_PASTE_MENU_THRESHOLD,
  type DraftPaste,
  deletionRange,
  expandPastes,
  isMarkerSized,
  keptPastes,
  lineCount,
  livePastes,
  MAX_ORPHAN_PASTES,
  missingPastes,
  nextPasteNumber,
  normalizePaste,
  offersMenu,
  parseThreshold,
  pasteSize,
  pasteToken,
  previewLines,
  reconcileTokens,
  replaceToken,
  snapCaret,
  tokenSpans,
} from "./pastes";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
const paste = (n: number, text: string, mode: DraftPaste["mode"] = "inline", at = n): DraftPaste => ({ n, text, mode, at });

describe("thresholds (omp 18.13.3 editor.ts / input-controller.ts)", () => {
  test("marker-sized: more than 10 lines or more than 1000 characters", () => {
    expect(isMarkerSized(lines(10))).toBe(false);
    expect(isMarkerSized(lines(11))).toBe(true);
    expect(isMarkerSized("x".repeat(1000))).toBe(false);
    expect(isMarkerSized("x".repeat(1001))).toBe(true);
    // A trailing newline is a line, as omp's split("\n") counts.
    expect(lineCount("a\nb\n")).toBe(3);
  });

  test("the menu from paste.largeMenuThreshold lines on; 0 never asks; only marker-sized pastes", () => {
    expect(offersMenu(lines(99), 100)).toBe(false);
    expect(offersMenu(lines(100), 100)).toBe(true);
    expect(offersMenu(lines(500), 0)).toBe(false);
    // Under the marker size no menu, whatever the threshold says.
    expect(offersMenu(lines(5), 3)).toBe(false);
    expect(offersMenu(lines(11), 3)).toBe(true);
  });

  test("the setting's value as a threshold", () => {
    expect(parseThreshold(250)).toBe(250);
    expect(parseThreshold("500")).toBe(500);
    expect(parseThreshold(0)).toBe(0);
    for (const bad of [undefined, null, "", "lots", -1, Number.NaN, {}]) expect(parseThreshold(bad)).toBe(DEFAULT_PASTE_MENU_THRESHOLD);
  });

  test("clipboard line endings become \\n", () => {
    expect(normalizePaste("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("tokens", () => {
  test("omp's markers: +L lines past 10 lines, else C chars", () => {
    expect(pasteToken(paste(1, lines(240)))).toBe("[Paste #1, +240 lines]");
    expect(pasteToken(paste(2, "y".repeat(1834)))).toBe("[Paste #2, 1834 chars]");
    expect(pasteSize(lines(240))).toBe("240 lines");
    expect(pasteSize("y".repeat(1834))).toBe("1,834 chars");
  });

  test("spans, live pastes in text order, orphans and lost pastes", () => {
    const a = paste(1, lines(12, "a"));
    const b = paste(2, lines(30, "b"));
    const text = `see ${pasteToken(b)} and ${pasteToken(a)} `;
    expect(tokenSpans(text, [a, b]).map((s) => [s.n, text.slice(s.start, s.end)])).toEqual([
      [2, pasteToken(b)],
      [1, pasteToken(a)],
    ]);
    expect(livePastes(text, [a, b, paste(3, lines(20))]).map((p) => p.n)).toEqual([2, 1]);
    // A marker whose paste is gone (another device's draft, cleared storage).
    expect(missingPastes(`${text}[Paste #7, +40 lines]`, [a, b])).toEqual([7]);
    // New numbers go past every paste and every marker in the text.
    expect(nextPasteNumber([a, b], "[Paste #7, +40 lines]")).toBe(8);
    expect(nextPasteNumber([], "")).toBe(1);
  });
});

describe("prompt serialization (omp #expandPasteMarkers, then trim on submit)", () => {
  test("inline pastes are their text; blocks are wrapped in <attachment> tags", () => {
    const a = paste(1, lines(12));
    const b = paste(2, lines(120, "log"), "block");
    const message = `Fix this:\n${pasteToken(a)} \nusing ${pasteToken(b)} `;
    expect(expandPastes(message, [a, b]).trim()).toBe(`Fix this:\n${a.text} \nusing <attachment>\n${b.text}\n</attachment>`);
    expect(attachmentBlock("x")).toBe("<attachment>\nx\n</attachment>");
  });

  test("one pass: a pasted text holding another token stays verbatim", () => {
    const inner = paste(1, lines(11));
    const outer = paste(2, `${pasteToken(inner)}\n${lines(20)}`);
    expect(expandPastes(`${pasteToken(outer)}`, [inner, outer])).toBe(outer.text);
  });

  test("every copy of a token expands; text without tokens is untouched", () => {
    const a = paste(1, lines(11));
    expect(expandPastes(`${pasteToken(a)} ${pasteToken(a)}`, [a])).toBe(`${a.text} ${a.text}`);
    expect(expandPastes("plain [Paste #9, +20 lines]", [a])).toBe("plain [Paste #9, +20 lines]");
  });

  test("removing a token takes the space after it", () => {
    const a = paste(1, lines(11));
    expect(replaceToken(`x ${pasteToken(a)} y`, a, "")).toBe("x y");
    expect(replaceToken(`x ${pasteToken(a)} y`, a, "local://paste-1.md")).toBe("x local://paste-1.md y");
  });
});

describe("editing around tokens", () => {
  const a = paste(1, lines(12));
  const tok = pasteToken(a);
  const text = `ab ${tok} cd`;
  const spans = tokenSpans(text, [a]);
  const start = 3;
  const end = 3 + tok.length;

  test("Backspace at a token's end and Delete at its start take all of it", () => {
    expect(deletionRange(spans, end, end, "Backspace")).toEqual({ start, end });
    expect(deletionRange(spans, start, start, "Delete")).toEqual({ start, end });
    expect(deletionRange(spans, start, start, "Backspace")).toBeNull();
    expect(deletionRange(spans, end + 1, end + 1, "Backspace")).toBeNull();
    // A selection cutting into it grows to all of it; one around it stands.
    expect(deletionRange(spans, 1, start + 4, "Backspace")).toEqual({ start: 1, end });
    expect(deletionRange(spans, 0, text.length, "Delete")).toBeNull();
  });

  test("the caret steps over a token and never rests in it", () => {
    expect(snapCaret(spans, start + 1, start)).toBe(end);
    expect(snapCaret(spans, end - 1, end)).toBe(start);
    expect(snapCaret(spans, start + 2, 0)).toBe(end);
    expect(snapCaret(spans, end, end)).toBeNull();
  });

  test("edits that cut into a token keep it whole", () => {
    // Typing inside: the character lands after the token.
    const typed = `${text.slice(0, start + 5)}Z${text.slice(start + 5)}`;
    expect(reconcileTokens(text, typed, start + 6, [a])).toEqual({ text: `ab ${tok}Z cd`, caret: end + 1 });
    // A word deletion that ate the token's tail: all of it goes.
    const cut = `ab ${tok.slice(0, 8)} cd`;
    expect(reconcileTokens(text, cut, 3 + 8, [a])).toEqual({ text: "ab  cd", caret: 3 });
    // Ordinary edits elsewhere stand.
    expect(reconcileTokens(text, `${text}!`, text.length + 1, [a])).toBeNull();
    expect(reconcileTokens(text, `abc ${tok} cd`, 3, [a])).toBeNull();
  });
});

describe("chip lifecycle", () => {
  test("paste → chip, delete → kept for undo (newest few), send → gone", () => {
    let pastes: DraftPaste[] = [];
    let text = "Look at ";
    const add = (body: string, at: number) => {
      const p = paste(nextPasteNumber(pastes, text), body, "inline", at);
      pastes = [...pastes, p];
      text += `${pasteToken(p)} `;
      return p;
    };
    const first = add(lines(40), 1);
    expect(livePastes(text, pastes)).toEqual([first]);
    // Removed from the message: no chip, but undo can bring it back.
    text = replaceToken(text, first, "");
    expect(livePastes(text, pastes)).toEqual([]);
    expect(keptPastes(text, pastes)).toEqual([first]);
    // Only the newest MAX_ORPHAN_PASTES deleted ones are kept.
    for (let i = 0; i < 5; i++) {
      const p = add(lines(15), 10 + i);
      text = replaceToken(text, p, "");
    }
    const kept = keptPastes(text, pastes);
    expect(kept).toHaveLength(MAX_ORPHAN_PASTES);
    expect(kept.map((p) => p.at)).toEqual([12, 13, 14]);
    // A live one is always kept.
    const live = add(lines(11), 0);
    expect(keptPastes(text, pastes).map((p) => p.n)).toContain(live.n);
  });

  test("a full draft refuses the new paste; room is made from deleted ones only", () => {
    const old = [paste(1, lines(12), "inline", 1), paste(2, lines(12), "inline", 2), paste(3, lines(12), "inline", 3)];
    const fresh = paste(4, lines(12), "inline", 4);
    const tokens = (...ps: DraftPaste[]) => ps.map(pasteToken).join(" ");
    // Three in the draft, room for three: refused, nothing evicted.
    expect(addPaste(tokens(...old), old, fresh, 3)).toBeNull();
    // #1 was deleted from the text: it goes, the two still in the draft stay.
    expect(addPaste(tokens(old[1] as DraftPaste, old[2] as DraftPaste), old, fresh, 3)?.map((p) => p.n)).toEqual([2, 3, 4]);
    // Room left: nothing goes.
    expect(addPaste(tokens(old[0] as DraftPaste), old, fresh, 5)?.map((p) => p.n)).toEqual([1, 2, 3, 4]);
  });

  test("preview lines skip leading blank lines and clip long ones", () => {
    expect(previewLines("\n\n  first\nsecond\n\nfourth", 3)).toEqual(["  first", "second", ""]);
    expect(previewLines(`${"x".repeat(200)}\ny`, 1, 10)).toEqual([`${"x".repeat(9)}…`]);
  });
});
