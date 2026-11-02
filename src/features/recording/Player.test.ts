import { describe, expect, test } from "bun:test";
import { frameAt, shownFrame, skipRemoved } from "./Player";

// The first picture of a recording comes a moment after it starts.
const frames = [
  { t: 420, size: 1 },
  { t: 900, size: 1 },
  { t: 1500, size: 1 },
];

describe("player pictures", () => {
  test("a position shows the last frame at or before it; before the first frame it shows the first, not nothing", () => {
    expect(frameAt(frames, 899)).toBe(0);
    expect(frameAt(frames, 900)).toBe(1);
    expect(frameAt(frames, 99_999)).toBe(2);
    expect(frameAt(frames, 0)).toBe(-1);
    expect(shownFrame(frames, 0)).toBe(0);
    expect(shownFrame(frames, 419)).toBe(0);
    expect(shownFrame(frames, 1000)).toBe(1);
    expect(shownFrame([], 0)).toBe(-1);
  });

  test("playback skips a removed part it reaches", () => {
    const removed = [{ start: 2000, end: 3000 }];
    expect(skipRemoved(1999, removed)).toBe(1999);
    expect(skipRemoved(2000, removed)).toBe(3000);
    expect(skipRemoved(2999, removed)).toBe(3000);
    expect(skipRemoved(3000, removed)).toBe(3000);
  });
});
