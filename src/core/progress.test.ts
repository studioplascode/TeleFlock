import { describe, expect, test } from "bun:test";
import type { Subagent } from "./gen";
import { estimatedEnd, paceText, subagentEstimate, timeLeft, timeLeftOfAll, timeLeftText } from "./progress";

const S = 1000;
const MIN = 60 * S;
const NOW = 1_800_000_000_000;

/** `pct` done `elapsed` into a task, estimated at `at`. */
const est = (pct: number, elapsed: number, at = NOW) => ({ pct, at, since: at - elapsed });

describe("timeLeft", () => {
  test("the pace so far, counted down from when the estimate was made", () => {
    // 40 % in 12 minutes: 18 more at that pace.
    expect(timeLeft(est(40, 12 * MIN), NOW)).toEqual({ kind: "left", ms: 18 * MIN });
    expect(timeLeft(est(40, 12 * MIN), NOW + 5 * MIN)).toEqual({ kind: "left", ms: 13 * MIN });
    expect(timeLeftText({ kind: "left", ms: 13 * MIN })).toBe("~13m left");
    expect(timeLeftText({ kind: "left", ms: 80 * MIN })).toBe("~1h 20m left");
  });

  test("too early to say under 5 % done or with less than a minute behind the estimate", () => {
    expect(timeLeft(est(4.9, 30 * MIN), NOW)).toBeUndefined();
    expect(timeLeft(est(5, 30 * MIN), NOW)).toEqual({ kind: "left", ms: 570 * MIN });
    expect(timeLeft(est(50, 59 * S), NOW)).toBeUndefined();
    expect(timeLeft(est(50, MIN), NOW)).toEqual({ kind: "left", ms: MIN });
    // Junk: a start after the estimate, a missing percentage.
    expect(timeLeft(est(50, -5 * MIN), NOW)).toBeUndefined();
    expect(timeLeft(est(Number.NaN, 10 * MIN), NOW)).toBeUndefined();
  });

  test("the last minute still reads as a minute, never as zero", () => {
    expect(timeLeftText(timeLeft(est(50, 10 * MIN), NOW + 10 * MIN - 5 * S) ?? { kind: "due" })).toBe("~1m left");
  });

  test("past the estimated end: any minute for a fifth of the estimated whole (1–5 min), then over estimate", () => {
    // 50 % after 10 min: done at +10 min, 20 min in all, so any minute until 4 min past it.
    const e = est(50, 10 * MIN);
    expect(timeLeft(e, NOW + 10 * MIN)).toEqual({ kind: "due" });
    expect(timeLeft(e, NOW + 13 * MIN)).toEqual({ kind: "due" });
    expect(timeLeft(e, NOW + 14 * MIN)).toEqual({ kind: "over", ms: 4 * MIN });
    expect(timeLeftText({ kind: "due" })).toBe("any minute");
    expect(timeLeftText({ kind: "over", ms: 4 * MIN })).toBe("over estimate");
    // A short task gets a minute, a long one five.
    expect(timeLeft(est(50, 2 * MIN), NOW + 2 * MIN + 59 * S)).toEqual({ kind: "due" });
    expect(timeLeft(est(50, 2 * MIN), NOW + 3 * MIN)).toEqual({ kind: "over", ms: MIN });
    expect(timeLeft(est(50, 60 * MIN), NOW + 64 * MIN)).toEqual({ kind: "due" });
    expect(timeLeft(est(50, 60 * MIN), NOW + 65 * MIN)).toEqual({ kind: "over", ms: 5 * MIN });
  });

  test("100 %: nothing left by its own account, so any minute, then over estimate", () => {
    const e = est(100, 30 * MIN);
    expect(estimatedEnd(e)).toBe(NOW);
    expect(timeLeft(e, NOW)).toEqual({ kind: "due" });
    expect(timeLeft(e, NOW + 6 * MIN)).toEqual({ kind: "over", ms: 6 * MIN });
    // Over 100 % reads as 100 %, not as time running backwards.
    expect(estimatedEnd(est(130, 30 * MIN))).toBe(NOW);
  });

  test("a device clock behind the host's leaves more time, never a negative span", () => {
    expect(timeLeft(est(50, 10 * MIN), NOW - 2 * MIN)).toEqual({ kind: "left", ms: 12 * MIN });
  });
});

describe("timeLeftOfAll", () => {
  test("the estimate ending last, and none while one of them can't tell", () => {
    const quick = est(80, 8 * MIN); // ends at +2 min
    const slow = est(25, 4 * MIN); // ends at +12 min
    expect(timeLeftOfAll([quick, slow], NOW)).toEqual({ kind: "left", ms: 12 * MIN });
    expect(timeLeftOfAll([slow, quick], NOW + 13 * MIN)).toEqual({ kind: "due" });
    expect(timeLeftOfAll([quick, undefined], NOW)).toBeUndefined();
    expect(timeLeftOfAll([quick, est(3, 8 * MIN)], NOW)).toBeUndefined();
    expect(timeLeftOfAll([], NOW)).toBeUndefined();
  });
});

describe("subagentEstimate", () => {
  const sub = (over: Partial<Subagent>): Subagent => ({ id: "s1", name: "Scout", status: "running", startedAt: NOW - 6 * MIN, completionPct: 40, completionAt: NOW - MIN, ...over });
  test("since its start, as of when the percentage last changed; only while it runs and both are known", () => {
    expect(subagentEstimate(sub({}))).toEqual({ pct: 40, at: NOW - MIN, since: NOW - 6 * MIN });
    expect(subagentEstimate(sub({ status: "done" }))).toBeUndefined();
    expect(subagentEstimate(sub({ completionPct: undefined }))).toBeUndefined();
    // A host before 0.9.5 sends the percentage without when it was made.
    expect(subagentEstimate(sub({ completionAt: undefined }))).toBeUndefined();
  });
});

describe("paceText", () => {
  test("says the basis, what it points to, and why there is none", () => {
    expect(paceText(est(64, 12 * MIN), NOW + MIN)).toBe("64% after 12m: at that pace about 6m more.");
    expect(paceText(est(64, 12 * MIN), NOW + 7 * MIN)).toBe("64% after 12m: at that pace it should be done about now.");
    expect(paceText(est(50, 10 * MIN), NOW + 25 * MIN)).toBe("50% after 10m pointed to about 20m in all; it has taken 15m longer so far.");
    expect(paceText(est(3, 10 * MIN), NOW)).toBe("Too early to tell how long it takes: under 5% done.");
    expect(paceText(est(60, 30 * S), NOW)).toBe("Too early to tell how long it takes: less than a minute in.");
  });
});
