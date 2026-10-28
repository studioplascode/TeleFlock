import { describe, expect, test } from "bun:test";
import { projectWindow } from "@/core/limits";
import type { LimitWindow } from "@/core/gen";
import { expiredLogin, formatPlan, formatSpanShort, paceAlert, paceStatus, tierLabel, windowLabel } from "./limitsUi";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function win(over: Partial<LimitWindow> = {}): LimitWindow {
  return { id: "anthropic:7d", label: "Claude 7 Day", window: "7 Day", durationMs: 7 * DAY, resetsAt: NOW + 6 * DAY, used: 0.1, status: "ok", unit: "percent", notes: [], samples: [], ...over };
}

describe("paceAlert", () => {
  test("a window that runs out before its reset says when, briefly and in full", () => {
    // 1 %/h for the last 10 h, 90 % left → ~90 h; resets in 6 d.
    const w = win({ samples: [{ at: NOW - 10 * HOUR, used: 0 }] });
    const pace = projectWindow(w, NOW, NOW);
    expect(pace.outcome).toBe("runsOut");
    const a = paceAlert(w, pace);
    expect(a?.status).toBe("needs-you");
    expect(a?.status).toBe(paceStatus(w, pace));
    expect(a?.short).toBe("runs out in ~3d at this pace");
    expect(a?.full).toBe("At this pace you run out in ~3d 18h (2d 6h before it resets)");
  });

  test("a used-up window says so, with its reset", () => {
    const w = win({ used: 1, status: "exhausted", resetsAt: NOW + 21 * MIN });
    const a = paceAlert(w, projectWindow(w, NOW, NOW));
    expect(a).toEqual({ status: "error", short: "limit reached", full: "Limit reached · resets in 21m" });
  });

  test("omp's exhausted verdict counts even when the reading rounds below 100 %", () => {
    const w = win({ used: 0.995, status: "exhausted", resetsAt: NOW + 2 * HOUR, samples: [{ at: NOW - HOUR, used: 0.995 }] });
    expect(paceAlert(w, projectWindow(w, NOW, NOW))?.short).toBe("limit reached");
  });

  test("no alert while the window resets first, is idle, or can't be measured yet", () => {
    const resetsFirst = win({ samples: [{ at: NOW - 10 * HOUR, used: 0.09 }] });
    expect(projectWindow(resetsFirst, NOW, NOW).outcome).toBe("resetsFirst");
    expect(paceAlert(resetsFirst, projectWindow(resetsFirst, NOW, NOW))).toBeUndefined();
    const idle = win({ samples: [{ at: NOW - 10 * HOUR, used: 0.1 }] });
    expect(paceAlert(idle, projectWindow(idle, NOW, NOW))).toBeUndefined();
    expect(paceAlert(win(), projectWindow(win(), NOW, NOW))).toBeUndefined();
  });

  test("a window that reset since omp's exhausted reading raises no alert", () => {
    const w = win({ used: 1, status: "exhausted", resetsAt: NOW - MIN });
    expect(paceAlert(w, projectWindow(w, NOW, NOW))).toBeUndefined();
  });
});

describe("formatSpanShort", () => {
  test("keeps the largest unit, rounded down", () => {
    expect(formatSpanShort(0)).toBe("1m");
    expect(formatSpanShort(45 * MIN + 59_000)).toBe("45m");
    expect(formatSpanShort(2 * HOUR + 50 * MIN)).toBe("2h");
    expect(formatSpanShort(47 * HOUR + 59 * MIN)).toBe("47h");
    expect(formatSpanShort(4 * DAY + 13 * HOUR)).toBe("4d");
  });
});

describe("windowLabel", () => {
  test("one spelling for every provider's window names", () => {
    expect(windowLabel({ window: "5 Hour", label: "Claude 5 Hour" })).toBe("5 hours");
    expect(windowLabel({ window: "5 hours", label: "5 hours" })).toBe("5 hours");
    expect(windowLabel({ window: "7 Day", label: "Claude 7 Day (Opus)" })).toBe("7 days");
    expect(windowLabel({ window: "7 days", label: "7 days" })).toBe("7 days");
    expect(windowLabel({ window: "5h", label: "x" })).toBe("5 hours");
    expect(windowLabel({ window: "1 hour", label: "x" })).toBe("1 hour");
    expect(windowLabel({ window: "30 min", label: "x" })).toBe("30 minutes");
    expect(windowLabel({ window: "1 month", label: "x" })).toBe("1 month");
    expect(windowLabel({ window: "weekly", label: "x" })).toBe("Weekly");
  });

  test("without a window name: the duration in the label, else the window's length, else the label", () => {
    expect(windowLabel({ label: "GPT-5 Codex 7 days" })).toBe("7 days");
    expect(windowLabel({ label: "Monthly credits", durationMs: 30 * DAY })).toBe("30 days");
    expect(windowLabel({ label: "Requests", durationMs: HOUR })).toBe("1 hour");
    expect(windowLabel({ label: "Tokens" })).toBe("Tokens");
  });

  test("tiers read the same on both pages", () => {
    expect(tierLabel({ tier: "opus" })).toBe("Opus only");
    expect(tierLabel({ tier: " " })).toBeUndefined();
    expect(tierLabel({})).toBeUndefined();
  });
});

describe("formatPlan", () => {
  test("one casing for every provider's plan names", () => {
    expect(formatPlan("pro")).toBe("Pro");
    expect(formatPlan("Max 20x")).toBe("Max 20x");
    expect(formatPlan("max_20x")).toBe("Max 20x");
    expect(formatPlan("default_claude_max_20x")).toBe("Max 20x");
    expect(formatPlan("prolite")).toBe("Pro Lite");
    expect(formatPlan("team")).toBe("Team");
    expect(formatPlan("OpenCode Go")).toBe("OpenCode Go");
  });
});

describe("expiredLogin", () => {
  test("a failed refresh reads as an expired login, omp's reason kept as the detail", () => {
    const usage = expiredLogin("Claude", "Disabled by omp: oauth refresh failed: invalid_grant (Refresh token expired)");
    const accounts = expiredLogin("Claude", "oauth refresh failed: invalid_grant (Refresh token expired)");
    expect(accounts).toEqual(usage);
    expect(`${usage.title} ${usage.action}`).toBe("This login expired: Claude no longer accepts it. Sign in again to bring it back.");
    expect(usage.detail).toBe("oauth refresh failed: invalid_grant (Refresh token expired)");
  });

  test("other causes don't claim an expiry", () => {
    const stopped = { title: "omp stopped using this login.", action: "Sign in again to bring it back." };
    expect(expiredLogin("Claude", "disabled")).toEqual({ ...stopped, detail: "disabled" });
    expect(expiredLogin("Claude", undefined)).toEqual({ ...stopped, detail: undefined });
  });
});
