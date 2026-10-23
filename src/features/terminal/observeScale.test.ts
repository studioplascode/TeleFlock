import { describe, expect, test } from "bun:test";
import { observeTransform } from "./observeScale";

/** Board tiles: no zoom cap (TerminalPane `compact`). */
const TILE_MAX = Number.POSITIVE_INFINITY;

describe("observeTransform", () => {
  test("tail: a board tile is filled edge to edge, the grid's top cut, its bottom rows kept", () => {
    // 110×32 pane at 7px (461×333 px) in a wide 569×148 tile
    const s = 569 / 461;
    expect(observeTransform({ width: 569, height: 148 }, { width: 461, height: 333 }, TILE_MAX, "tail")).toBe(
      `translate(0px, ${Math.round(148 - 333 * s)}px) scale(${Number(s.toFixed(4))})`,
    );
  });

  test("tail: a grid short for the tile keeps its full width, spare height centred", () => {
    expect(observeTransform({ width: 400, height: 400 }, { width: 400, height: 200 }, TILE_MAX, "tail")).toBe("translate(0px, 100px) scale(1)");
  });

  test("tail: growth stops at maxScale, the spare width centred", () => {
    expect(observeTransform({ width: 1000, height: 100 }, { width: 100, height: 100 }, 2, "tail")).toBe("translate(400px, -100px) scale(2)");
  });

  test("contain: a full view never zooms past 1 (driver's size, centred)", () => {
    expect(observeTransform({ width: 800, height: 600 }, { width: 400, height: 600 }, 1, "contain")).toBe("translate(200px, 0px) scale(1)");
  });

  test("contain: a grid bigger than the view shrinks to fit it whole", () => {
    expect(observeTransform({ width: 500, height: 500 }, { width: 1000, height: 500 }, 1, "contain")).toBe("translate(0px, 125px) scale(0.5)");
  });

  test("exact fit and unmeasurable sizes leave no transform", () => {
    expect(observeTransform({ width: 640, height: 480 }, { width: 640, height: 480 }, 2, "contain")).toBe("");
    expect(observeTransform({ width: 640, height: 480 }, { width: 640, height: 480 }, 2, "tail")).toBe("");
    expect(observeTransform({ width: 0, height: 480 }, { width: 640, height: 480 }, 2, "tail")).toBe("");
    expect(observeTransform({ width: 640, height: 480 }, { width: 0, height: 0 }, 2, "contain")).toBe("");
  });
});
