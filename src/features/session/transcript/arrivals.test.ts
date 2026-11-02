import { describe, expect, test } from "bun:test";
import { arrivedSince, type ListMark } from "./arrivals";

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `m${from + i}`);
const mark = (list: readonly string[], view?: string): ListMark => ({ count: list.length, lastId: list.at(-1), view });

describe("rows that arrived while scrolled up", () => {
  test("rows after the last one count", () => {
    expect(arrivedSince(mark(ids(3)), ids(5), undefined)).toBe(2);
    expect(arrivedSince(mark(ids(3), "all"), ids(4), "all")).toBe(1);
  });

  test("older rows paged in above are not new", () => {
    expect(arrivedSince(mark(ids(3, 5)), ids(7), undefined)).toBe(0);
    expect(arrivedSince(mark(ids(3, 5)), ids(8), undefined)).toBe(1);
  });

  test("an unchanged or shorter list adds nothing", () => {
    expect(arrivedSince(mark(ids(4)), ids(4), undefined)).toBe(0);
    expect(arrivedSince(mark(ids(4)), ids(2), undefined)).toBe(0);
  });

  test("rows another view brings back are not new", () => {
    // The board filtered to two agents (3 of 23 messages, the last one m10), then the filter cleared.
    const between = mark(["m3", "m8", "m10"], "Sweep Size64|");
    expect(arrivedSince(between, ids(23), "|")).toBe(0);
    // A search without matches, then cleared.
    expect(arrivedSince(mark([], "|zzz"), ids(23), "|")).toBe(0);
    // The same view still counts what arrives.
    expect(arrivedSince(between, ["m3", "m8", "m10", "m24"], "Sweep Size64|")).toBe(1);
  });
});
