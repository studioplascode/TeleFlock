import { describe, expect, test } from "bun:test";
import { assignTiles, dropKeys, gridOf, LINGER_MS, MAX_TILES, normalizePins, placeAgent, RANK, renameKey, swapTiles, type WallCandidate, wallCandidates } from "./layout";

const NOW = 10_000_000;

function c(key: string, rank: number, since = NOW - 10 * 60_000): WallCandidate {
  return { key, rank, since };
}

function assign(over: Partial<Parameters<typeof assignTiles>[0]> = {}) {
  return assignTiles({ size: 4, pins: [], prev: [], candidates: [], hidden: [], auto: true, now: NOW, ...over });
}

describe("wall grid", () => {
  test("2×2 and 3×3", () => {
    expect(gridOf(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridOf(9)).toEqual({ cols: 3, rows: 3 });
  });
});

describe("wall candidates", () => {
  const base = { hostId: "h", turns: 2, title: "t", stateSince: NOW };
  const online = (hostId: string) => hostId === "h";
  test("needs you (oldest question first), running (longest first), review (newest first), fresh, then offline hosts; done never", () => {
    const list = wallCandidates(
      [
        { ...base, key: "h::done", column: "done" },
        { ...base, key: "off::ask", hostId: "off", column: "needs", needs: { since: NOW - 99_999 } as never },
        { ...base, key: "h::fresh", column: "review", turns: 0, title: "", stateSince: NOW - 1 },
        { ...base, key: "h::rev-old", column: "review", stateSince: NOW - 5000 },
        { ...base, key: "h::rev-new", column: "review", stateSince: NOW - 100 },
        { ...base, key: "h::run-short", column: "running", stateSince: NOW - 100 },
        { ...base, key: "h::run-long", column: "running", stateSince: NOW - 9000 },
        { ...base, key: "h::ask-new", column: "needs", stateSince: NOW - 99_999, needs: { since: NOW - 10 } as never },
        { ...base, key: "h::ask-old", column: "needs", stateSince: NOW, needs: { since: NOW - 500 } as never },
      ],
      online,
    );
    expect(list.map((x) => x.key)).toEqual(["h::ask-old", "h::ask-new", "h::run-long", "h::run-short", "h::rev-new", "h::rev-old", "h::fresh", "off::ask"]);
    expect(list.map((x) => x.rank)).toEqual([RANK.needs, RANK.needs, RANK.running, RANK.running, RANK.review, RANK.review, RANK.fresh, RANK.offline]);
    // a question's age counts from when it was asked, not from the herdr state change
    expect(list[1]?.since).toBe(NOW - 10);
  });
});

describe("assignTiles", () => {
  test("pins win; the rest fill with the most important candidates in tile order", () => {
    const tiles = assign({ pins: [null, "h::b"], candidates: [c("h::a", 0), c("h::b", 1), c("h::c", 1), c("h::d", 2), c("h::e", 2)] });
    expect(tiles).toEqual(["h::a", "h::b", "h::c", "h::d"]);
  });

  test("auto off leaves unpinned tiles empty", () => {
    expect(assign({ auto: false, pins: [null, "h::x"], candidates: [c("h::a", 0)] })).toEqual([null, "h::x", null, null]);
  });

  test("an auto-filled tile keeps its agent while it stays a candidate (no reshuffle when ranks change order)", () => {
    const prev = ["h::r1", "h::r2", "h::r3", "h::r4"];
    // r4 now runs longer than r1 and a fifth running agent appeared: nothing moves, nothing is displaced
    const tiles = assign({ prev, candidates: [c("h::r4", 1), c("h::r3", 1), c("h::r2", 1), c("h::r1", 1), c("h::r5", 1)] });
    expect(tiles).toEqual(prev);
  });

  test("a needs-you agent takes the least important auto tile at once, even one that just changed state", () => {
    const prev = ["h::run", "h::rev-old", "h::rev-new", "h::fresh"];
    const tiles = assign({ prev, candidates: [c("h::ask", 0), c("h::run", 1), c("h::rev-new", 2, NOW - 1000), c("h::rev-old", 2, NOW - 1000), c("h::fresh", 3, NOW)] });
    expect(tiles).toEqual(["h::run", "h::rev-old", "h::rev-new", "h::ask"]);
  });

  test("a running agent waits until a finished one has lingered, then takes its tile", () => {
    const prev = ["h::a", "h::b", "h::c", "h::done-just-now"];
    const candidates = [c("h::a", 1), c("h::b", 1), c("h::c", 1), c("h::new-run", 1), c("h::done-just-now", 2, NOW - 5000)];
    expect(assign({ prev, candidates })).toEqual(prev);
    const later = assign({ prev, candidates, now: NOW - 5000 + LINGER_MS });
    expect(later).toEqual(["h::a", "h::b", "h::c", "h::new-run"]);
  });

  test("pinned tiles are never displaced", () => {
    const tiles = assign({ pins: ["h::p1", "h::p2", "h::p3", "h::p4"], candidates: [c("h::ask", 0), c("h::p1", 2)] });
    expect(tiles).toEqual(["h::p1", "h::p2", "h::p3", "h::p4"]);
  });

  test("an agent leaving the candidates (done) frees its tile for the next one", () => {
    const tiles = assign({ prev: ["h::a", "h::gone", null, null], candidates: [c("h::a", 1), c("h::b", 2)] });
    expect(tiles).toEqual(["h::a", "h::b", null, null]);
  });

  test("hidden agents are never auto-filled but stay when pinned", () => {
    const tiles = assign({ prev: ["h::hid"], pins: [null, "h::pinned-hid"], hidden: ["h::hid", "h::pinned-hid"], candidates: [c("h::hid", 0), c("h::pinned-hid", 0), c("h::x", 1)] });
    expect(tiles).toEqual(["h::x", "h::pinned-hid", null, null]);
  });

  test("an agent shows once: duplicate pins and a pinned agent's old auto tile are skipped", () => {
    const tiles = assign({ pins: ["h::a", "h::a"], prev: [null, null, "h::a"], candidates: [c("h::a", 1), c("h::b", 1)] });
    expect(tiles).toEqual(["h::a", "h::b", null, null]);
  });

  test("pins beyond a 2×2 are kept for 3×3 and don't block auto-fill in the visible tiles", () => {
    const pins = normalizePins([null, null, null, null, null, "h::later"]);
    expect(assign({ pins, candidates: [c("h::later", 1)] })).toEqual(["h::later", null, null, null]);
    const nine = assignTiles({ size: 9, pins, prev: ["h::later"], candidates: [c("h::later", 1)], hidden: [], auto: true, now: NOW });
    expect(nine[5]).toBe("h::later");
    expect(nine.filter((k) => k === "h::later")).toHaveLength(1);
  });
});

describe("arranging tiles", () => {
  const shown = ["h::a", "h::b", "h::c", null];

  test("drag a tile onto another: both trade places and end up pinned", () => {
    expect(swapTiles([], shown, 0, 2).slice(0, 4)).toEqual(["h::c", null, "h::a", null]);
    // onto an empty tile: the moved agent is pinned there, its old tile fills itself again
    expect(swapTiles(["h::a"], shown, 0, 3).slice(0, 4)).toEqual([null, null, null, "h::a"]);
    expect(swapTiles(["h::a"], shown, 1, 1)).toEqual(normalizePins(["h::a"]));
  });

  test("placing an agent already on the wall trades places; a new one is pinned", () => {
    expect(placeAgent([], shown, 3, "h::b").slice(0, 4)).toEqual([null, null, null, "h::b"]);
    expect(placeAgent([], shown, 0, "h::b").slice(0, 2)).toEqual(["h::b", "h::a"]);
    expect(placeAgent(["h::a"], shown, 0, "h::z").slice(0, 4)).toEqual(["h::z", null, null, null]);
    // pinning the agent a tile already shows by itself
    expect(placeAgent([], shown, 1, "h::b").slice(0, 2)).toEqual([null, "h::b"]);
  });

  test("an agent pinned beyond the visible grid is not left there twice", () => {
    const pins = normalizePins([null, null, null, null, null, null, null, "h::z"]);
    const next = placeAgent(pins, shown, 0, "h::z");
    expect(next.filter((k) => k === "h::z")).toHaveLength(1);
    expect(next).toHaveLength(MAX_TILES);
  });

  test("resumed agents keep their tile; pruned ones leave the wall", () => {
    expect(renameKey(["h::old", null, "h::x"], "h::old", "h::new")).toEqual(["h::new", null, "h::x"]);
    expect(dropKeys(["h::gone", "h::x"], ["h::gone", "h::y"], new Set(["h::gone"]))).toEqual({ pins: [null, "h::x"], hidden: ["h::y"] });
  });
});
