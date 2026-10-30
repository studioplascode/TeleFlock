import { describe, expect, test } from "bun:test";
import type { AutoAnswerCountdown } from "@/core/gen";
import {
  clampPolicy,
  countdownState,
  currentCountdown,
  formatCountdown,
  formatWait,
  hostDecides,
  hostDefaultLabel,
  policyChipText,
  policySummary,
  samePolicy,
  specAutoAnswer,
  starPicks,
} from "./format";

const NOW = 1_000_000_000;
const cd = (patch: Partial<AutoAnswerCountdown>): AutoAnswerCountdown => ({ requestId: "r1", status: "counting", picks: ["Use SQLite"], ...patch });

describe("formatCountdown", () => {
  test("minutes and seconds, hours when needed", () => {
    expect(formatCountdown(760_000)).toBe("12:40");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(59_000)).toBe("0:59");
  });
  test("rounds partial seconds up and never goes negative", () => {
    expect(formatCountdown(759_001)).toBe("12:40");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
  });
  test("hour boundaries", () => {
    expect(formatCountdown(3_599_000)).toBe("59:59");
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(3_599_001)).toBe("1:00:00");
    expect(formatCountdown(86_400_000)).toBe("24:00:00");
  });
});

describe("formatWait", () => {
  test("minutes, hours and both", () => {
    expect(formatWait(1_200)).toBe("20 min");
    expect(formatWait(5_400)).toBe("1 h 30 min");
    expect(formatWait(7_200)).toBe("2 h");
    expect(formatWait(86_400)).toBe("24 h");
  });
  test("seconds under a minute, minutes rounded up after", () => {
    expect(formatWait(45)).toBe("45 s");
    expect(formatWait(61)).toBe("2 min");
    expect(formatWait(3_599)).toBe("1 h");
    expect(formatWait(-3)).toBe("0 s");
  });
});

describe("policies", () => {
  test("summaries", () => {
    expect(policySummary({ enabled: true, afterSecs: 1_200, onlyWhenNoApp: false })).toBe("after 20 min");
    expect(policySummary({ enabled: true, afterSecs: 1_200, onlyWhenNoApp: true })).toBe("after 20 min · only with no app connected");
    expect(policySummary({ enabled: false, afterSecs: 1_200, onlyWhenNoApp: true })).toBe("off");
    expect(policySummary(undefined)).toBe("off");
  });
  test("summary chips: nothing for the host default", () => {
    expect(policyChipText(undefined)).toBeNull();
    expect(policyChipText({ enabled: false, afterSecs: 1_200, onlyWhenNoApp: false })).toBe("Decide for me · off");
    expect(policyChipText({ enabled: true, afterSecs: 1_200, onlyWhenNoApp: false })).toBe("Decide for me · 20 min");
    expect(policyChipText({ enabled: true, afterSecs: 1_200, onlyWhenNoApp: true })).toBe("Decide for me · 20 min, no app");
  });
  test("host default label", () => {
    expect(hostDefaultLabel({ enabled: true, afterSecs: 1_200, onlyWhenNoApp: false })).toBe("Host default (after 20 min)");
    expect(hostDefaultLabel({ enabled: false, afterSecs: 1_200, onlyWhenNoApp: false })).toBe("Host default (off)");
  });
  test("clamped to what the host accepts", () => {
    expect(clampPolicy({ enabled: true, afterSecs: 5, onlyWhenNoApp: false }).afterSecs).toBe(60);
    expect(clampPolicy({ enabled: true, afterSecs: 999_999, onlyWhenNoApp: false }).afterSecs).toBe(86_400);
    expect(clampPolicy({ enabled: true, afterSecs: 90.4, onlyWhenNoApp: true })).toEqual({ enabled: true, afterSecs: 90, onlyWhenNoApp: true });
  });
  test("specs carry a policy only when set and the host has decide for me", () => {
    const own = { enabled: true, afterSecs: 600, onlyWhenNoApp: false };
    expect(specAutoAnswer(own, true)).toEqual({ autoAnswer: own });
    expect(specAutoAnswer(own, false)).toEqual({});
    expect(specAutoAnswer(undefined, true)).toEqual({});
    expect(hostDecides({ autoAnswer: { enabled: false, afterSecs: 1_200, onlyWhenNoApp: false } })).toBe(true);
    expect(hostDecides({})).toBe(false);
    expect(hostDecides(undefined)).toBe(false);
  });
  test("same policy: field by field, the host default (undefined) only equals itself", () => {
    const p = { enabled: true, afterSecs: 600, onlyWhenNoApp: false };
    expect(samePolicy(p, { ...p })).toBe(true);
    expect(samePolicy(p, { ...p, onlyWhenNoApp: true })).toBe(false);
    expect(samePolicy(p, { ...p, afterSecs: 660 })).toBe(false);
    expect(samePolicy(p, { ...p, enabled: false })).toBe(false);
    expect(samePolicy(undefined, undefined)).toBe(true);
    expect(samePolicy(p, undefined)).toBe(false);
  });
});

describe("currentCountdown", () => {
  const policy = { enabled: true, afterSecs: 1_200, onlyWhenNoApp: false };
  test("only for the question the agent shows", () => {
    const countdown = cd({ deadline: NOW + 1000 });
    expect(currentCountdown({ needs: { requestId: "r1" } as never, autoAnswer: { policy, source: "host", countdown } })).toBe(countdown);
    expect(currentCountdown({ needs: { requestId: "r2" } as never, autoAnswer: { policy, source: "host", countdown } })).toBeUndefined();
    expect(currentCountdown({ needs: undefined, autoAnswer: { policy, source: "host", countdown } })).toBeUndefined();
    expect(currentCountdown({ needs: { requestId: "r1" } as never, autoAnswer: { policy, source: "host" } })).toBeUndefined();
    expect(currentCountdown(undefined)).toBeUndefined();
  });
});

describe("countdownState", () => {
  test("counting", () => {
    const v = countdownState(cd({ deadline: NOW + 760_000 }), NOW);
    expect(v.phase).toBe("counting");
    expect(v.remainingMs).toBe(760_000);
    expect(v.text).toBe("auto-picks ★ Use SQLite in 12:40");
    expect(v.compact).toBe("auto-picks in 12:40");
    expect(v.detail).toBe("Decide for me picks ★ Use SQLite in 13 min unless you answer.");
    expect(v.ticking).toBe(true);
  });
  test("counting past an hour", () => {
    expect(countdownState(cd({ deadline: NOW + 3_723_000 }), NOW).text).toBe("auto-picks ★ Use SQLite in 1:02:03");
  });
  test("a past deadline is due: auto-picking", () => {
    for (const deadline of [NOW, NOW - 1, NOW - 60_000]) {
      const v = countdownState(cd({ deadline }), NOW);
      expect(v.phase).toBe("due");
      expect(v.remainingMs).toBe(0);
      expect(v.text).toBe("auto-picking ★ Use SQLite…");
      expect(v.compact).toBe("auto-picking…");
      expect(v.ticking).toBe(false);
    }
  });
  test("answering is due whatever its deadline says", () => {
    const v = countdownState(cd({ status: "answering", deadline: NOW + 60_000 }), NOW);
    expect(v.phase).toBe("due");
    expect(v.text).toBe("auto-picking ★ Use SQLite…");
  });
  test("waiting for no app: the clock stands", () => {
    const v = countdownState(cd({ status: "waitingForNoApp", remainingMs: 760_000 }), NOW);
    expect(v.phase).toBe("waiting");
    expect(v.remainingMs).toBe(760_000);
    expect(v.text).toBe("auto-picks ★ Use SQLite when no app is connected · 12:40 left");
    expect(v.compact).toBe("when no app · 12:40 left");
    expect(v.ticking).toBe(false);
    expect(countdownState(cd({ status: "waitingForNoApp", remainingMs: 760_000 }), NOW + 3_600_000).text).toBe(v.text);
  });
  test("cancelled: nothing on cards, a quiet line on the ask card", () => {
    const v = countdownState(cd({ status: "cancelled", remainingMs: 300_000 }), NOW);
    expect(v.phase).toBe("cancelled");
    expect(v.compact).toBe("");
    expect(v.text).toBe("Won't auto-pick this question");
    expect(v.ticking).toBe(false);
  });
  test("several picks, and none known", () => {
    expect(starPicks(["A", "B"])).toBe("★ A, ★ B");
    expect(countdownState(cd({ picks: ["A", "B"], deadline: NOW + 61_000 }), NOW).text).toBe("auto-picks ★ A, ★ B in 1:01");
    expect(starPicks([])).toBe("★ the recommended option");
  });
});
