import { describe, expect, test } from "bun:test";
import type { SessionRows, TranscriptItem } from "@/core/gen";
import { append, hasNewer, hasOlder, prepend, windowOf } from "./previewWindow";

const row = (id: string): TranscriptItem => ({ kind: "user", id, at: 1, text: id, images: [], steering: false, synthetic: false });
const rows = (ids: string[], start: number, total: number): SessionRows => ({ items: ids.map(row), start, rows: total });

describe("preview window", () => {
  test("a window knows whether older and newer rows exist", () => {
    const w = windowOf(rows(["c", "d"], 2, 6));
    expect(w.ids).toEqual(["c", "d"]);
    expect(hasOlder(w)).toBe(true);
    expect(hasNewer(w)).toBe(true);
    expect(hasOlder(windowOf(rows(["a"], 0, 1)))).toBe(false);
    expect(hasNewer(windowOf(rows(["a"], 0, 1)))).toBe(false);
  });

  test("older rows go above and move the start", () => {
    const w = prepend(windowOf(rows(["c", "d"], 2, 6)), rows(["a", "b"], 0, 6));
    expect(w.ids).toEqual(["a", "b", "c", "d"]);
    expect(w.start).toBe(0);
    expect(Object.keys(w.items).sort()).toEqual(["a", "b", "c", "d"]);
    expect(hasOlder(w)).toBe(false);
  });

  test("newer rows go below", () => {
    const w = append(windowOf(rows(["a", "b"], 0, 6)), rows(["c", "d"], 2, 6));
    expect(w.ids).toEqual(["a", "b", "c", "d"]);
    expect(hasNewer(w)).toBe(true);
    expect(hasNewer(append(w, rows(["e", "f"], 4, 6)))).toBe(false);
  });

  test("rows the window holds are not doubled, and an empty answer ends the paging", () => {
    const w = windowOf(rows(["b", "c"], 1, 4));
    expect(prepend(w, rows(["a", "b"], 0, 4)).ids).toEqual(["a", "b", "c"]);
    expect(hasOlder(prepend(w, rows([], 0, 4)))).toBe(false);
    const shrunk = append(w, rows([], 3, 4));
    expect(hasNewer(shrunk)).toBe(false);
    expect(shrunk.ids).toEqual(["b", "c"]);
  });
});
