import { describe, expect, test } from "bun:test";
import { noticeRank, trayTop } from "./notice";

describe("notice tray", () => {
  test("the folded line shows the most urgent kind first, then the earlier host", () => {
    const ranks = {
      "demo": noticeRank("demo"),
      "setup:forge": noticeRank("setup", 0),
      "accounts:lab": noticeRank("accounts", 2),
      "stale:studio": noticeRank("stale", 1),
    };
    expect(trayTop(ranks)).toEqual({ top: "stale:studio", more: 3 });
    const { "stale:studio": _, ...rest } = ranks;
    expect(trayTop(rest)).toEqual({ top: "accounts:lab", more: 2 });
    expect(trayTop({ "stale:b": noticeRank("stale", 1), "stale:a": noticeRank("stale", 4) })).toEqual({ top: "stale:b", more: 1 });
  });

  test("a kind outranks any host position", () => {
    expect(noticeRank("stale", 999)).toBeLessThan(noticeRank("accounts", 0));
    expect(noticeRank("setup", 999)).toBeLessThan(noticeRank("demo", 0));
  });

  test("one notice has nothing more; none has no line", () => {
    expect(trayTop({ demo: noticeRank("demo") })).toEqual({ top: "demo", more: 0 });
    expect(trayTop({})).toEqual({ top: undefined, more: 0 });
  });
});
