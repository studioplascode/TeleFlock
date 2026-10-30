import { describe, expect, test } from "bun:test";
import { CHIME_GATE, ChimeGate, chimeState, type ChimeKind, stateChanges } from "./chimes";

const T = 1_000_000;
const snap = (entries: [string, ChimeKind | null][]) => new Map(entries);

describe("chimeState", () => {
  test("the state an agent is in; a fresh agent (never prompted) has none", () => {
    expect(chimeState({ key: "k", column: "needs", turns: 1, title: "x" })).toBe("needs");
    expect(chimeState({ key: "k", column: "review", turns: 3, title: "x" })).toBe("review");
    expect(chimeState({ key: "k", column: "review", turns: 0, title: "" })).toBeNull();
    expect(chimeState({ key: "k", column: "done", turns: 3, title: "x" })).toBe("done");
  });
});

describe("stateChanges", () => {
  test("agents entering a state, one change each", () => {
    const prev = snap([["a", "running"], ["b", "running"], ["c", "needs"], ["d", null]]);
    const next = snap([["a", "needs"], ["b", "running"], ["c", "running"], ["d", "running"]]);
    expect(stateChanges(prev, next)).toEqual([
      { key: "a", kind: "needs" },
      { key: "c", kind: "running" },
      { key: "d", kind: "running" },
    ]);
  });

  test("agents seen for the first time only chime when they arrive needing you", () => {
    expect(stateChanges(snap([]), snap([["a", "running"], ["b", "review"], ["c", "needs"]]))).toEqual([{ key: "c", kind: "needs" }]);
  });

  test("becoming fresh or leaving says nothing", () => {
    expect(stateChanges(snap([["a", "review"], ["gone", "running"]]), snap([["a", null]]))).toEqual([]);
  });
});

describe("ChimeGate", () => {
  test("a lone change chimes at once", () => {
    const g = new ChimeGate();
    expect(g.offer([{ key: "a", kind: "review" }], T)).toBe("review");
    expect(g.due()).toBeNull();
  });

  test("changes inside the gap join one chime at its end, with the most important kind", () => {
    const g = new ChimeGate();
    expect(g.offer([{ key: "a", kind: "running" }], T)).toBe("running");
    expect(g.offer([{ key: "b", kind: "review" }], T + 100)).toBeNull();
    expect(g.offer([{ key: "c", kind: "needs" }, { key: "d", kind: "done" }], T + 900)).toBeNull();
    expect(g.due()).toBe(T + CHIME_GATE.gapMs);
    expect(g.flush(T + CHIME_GATE.gapMs - 1)).toBeNull();
    expect(g.flush(T + CHIME_GATE.gapMs)).toBe("needs");
    expect(g.due()).toBeNull();
    expect(g.flush(T + 10 * CHIME_GATE.gapMs)).toBeNull();
  });

  test("a burst of ten agents finishing together is one chime", () => {
    const g = new ChimeGate();
    const burst = Array.from({ length: 10 }, (_, i) => ({ key: `a${i}`, kind: "review" as const }));
    expect(g.offer(burst, T)).toBe("review");
    expect(g.due()).toBeNull();
  });

  test("the same agent re-entering the same state soon stays quiet (a run of questions)", () => {
    const g = new ChimeGate();
    expect(g.offer([{ key: "a", kind: "needs" }], T)).toBe("needs");
    expect(g.offer([{ key: "a", kind: "running" }], T + 5000)).toBe("running");
    expect(g.offer([{ key: "a", kind: "needs" }], T + 10_000)).toBeNull();
    expect(g.due()).toBeNull();
    // another agent's question still sounds
    expect(g.offer([{ key: "b", kind: "needs" }], T + 12_000)).toBe("needs");
    // and so does this agent's once the repeat window is over
    expect(g.offer([{ key: "a", kind: "needs" }], T + CHIME_GATE.repeatMs + 1)).toBe("needs");
  });

  test("past the per-minute budget only needs-you gets through", () => {
    const g = new ChimeGate({ gapMs: 1000, repeatMs: 30_000, perMinute: 3 });
    expect(g.offer([{ key: "a", kind: "review" }], T)).toBe("review");
    expect(g.offer([{ key: "b", kind: "review" }], T + 1000)).toBe("review");
    expect(g.offer([{ key: "c", kind: "running" }], T + 2000)).toBe("running");
    expect(g.offer([{ key: "d", kind: "review" }], T + 3000)).toBeNull();
    expect(g.offer([{ key: "e", kind: "needs" }], T + 4000)).toBe("needs");
    // the minute rolls on: the budget is back
    expect(g.offer([{ key: "f", kind: "review" }], T + 61_000)).toBe("review");
  });
});
