import { describe, expect, test } from "bun:test";
import { ambientTime, fitOrbs, ORB_MAX, ORB_MIN } from "./layout";

describe("fitOrbs", () => {
  test("every agent fits on screen, with its label under the orb", () => {
    for (const [n, w, h] of [[1, 1280, 740], [7, 1280, 740], [12, 1280, 740], [9, 412, 780], [24, 412, 780], [40, 1920, 1000]] as const) {
      const g = fitOrbs(n, w, h, 64);
      expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
      expect(g.cols * (g.rows - 1)).toBeLessThan(n);
      if (g.orb > ORB_MIN) {
        expect(g.orb).toBeLessThanOrEqual((w / g.cols) * 0.56 + 0.5);
        expect(g.orb + 64).toBeLessThanOrEqual(h / g.rows + 0.5);
      }
    }
  });

  test("picks the arrangement with the biggest orbs, clamped", () => {
    // a wide tablet puts six agents in one or two rows, a phone in columns
    expect(fitOrbs(6, 1280, 740, 64).rows).toBeLessThanOrEqual(2);
    expect(fitOrbs(6, 412, 780, 56).cols).toBeLessThanOrEqual(2);
    expect(fitOrbs(1, 1920, 1080, 64).orb).toBe(ORB_MAX);
    expect(fitOrbs(300, 412, 600, 56).orb).toBe(ORB_MIN);
  });

  test("an empty flock or field has no rows", () => {
    expect(fitOrbs(0, 1280, 740, 64).rows).toBe(0);
    expect(fitOrbs(3, 0, 0, 64).cols).toBe(3);
  });
});

describe("ambientTime", () => {
  const now = 10_000_000;
  test("minutes with the board's verbs", () => {
    expect(ambientTime("needs", now - 20_000, now)).toBe("waiting <1m");
    expect(ambientTime("needs", now - 6 * 60_000 - 59_000, now)).toBe("waiting 6m");
    expect(ambientTime("running", now - 64 * 60_000, now)).toBe("turn 1h 04m");
    expect(ambientTime("review", now - 25 * 60_000, now)).toBe("finished 25m ago");
    expect(ambientTime("done", now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(ambientTime("running", undefined, now)).toBeNull();
    expect(ambientTime("quiet", now - 3 * 60_000 - 5000, now)).toBe("quiet 3m");
  });
});
