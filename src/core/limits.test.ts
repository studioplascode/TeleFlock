import { describe, expect, test } from "bun:test";
import { demoLimits } from "./demo/limits";
import type { AccountLimits, LimitWindow } from "./gen";
import { describePace, formatSpan, LIMITS_EVERY_MS, LIMITS_USAGE_EVERY_MS, MIN_PACE_SPAN_MS, nextAskIn, paceFromSamples, paceLookbackMs, projectWindow, sessionLimits, STALE_MS, tightestWindow, windowsForModel } from "./limits";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;

function win(over: Partial<LimitWindow> = {}): LimitWindow {
  return { id: "anthropic:5h", label: "Claude 5 Hour", window: "5 Hour", durationMs: 5 * HOUR, resetsAt: NOW + 2 * HOUR, used: 0.5, status: "ok", unit: "percent", notes: [], samples: [], ...over };
}

describe("paceFromSamples", () => {
  test("rate per hour between the first reading in the look-back and the newest", () => {
    const s = [
      { at: NOW - 3 * HOUR, used: 0 },
      { at: NOW - HOUR, used: 0.2 },
      { at: NOW, used: 0.5 },
    ];
    const p = paceFromSamples(s, HOUR);
    expect(p.ratePerHour ?? Number.NaN).toBeCloseTo(0.3);
    expect(p.basisMs).toBe(HOUR);
  });
  test("widens to an older reading when the look-back has too few", () => {
    const p = paceFromSamples([{ at: NOW - 2 * HOUR, used: 0.1 }, { at: NOW, used: 0.3 }], HOUR);
    expect(p.ratePerHour ?? Number.NaN).toBeCloseTo(0.1);
  });
  test("readings too close together give no pace", () => {
    expect(paceFromSamples([{ at: NOW - MIN, used: 0.1 }, { at: NOW, used: 0.2 }], HOUR).ratePerHour).toBeUndefined();
    expect(paceFromSamples([], HOUR)).toEqual({ basisMs: 0 });
  });
  test("a drop counts as zero, never negative", () => {
    expect(paceFromSamples([{ at: NOW - HOUR, used: 0.4 }, { at: NOW, used: 0.3 }], HOUR).ratePerHour).toBe(0);
  });
  test("look-back is a fifth of the window, 30 min … 24 h", () => {
    expect(paceLookbackMs(5 * HOUR)).toBe(HOUR);
    expect(paceLookbackMs(7 * 24 * HOUR)).toBe(24 * HOUR);
    expect(paceLookbackMs(HOUR)).toBe(30 * MIN);
    expect(paceLookbackMs(undefined)).toBe(24 * 3600_000 / 5);
  });
});

describe("projectWindow", () => {
  test("runs out before the reset at the current pace", () => {
    // 20 %/h, 50 % left → 2.5 h; resets in 3 h.
    const w = win({ resetsAt: NOW + 3 * HOUR, samples: [{ at: NOW - HOUR, used: 0.3 }] });
    const p = projectWindow(w, NOW, NOW);
    expect(p.outcome).toBe("runsOut");
    expect(p.ratePerHour ?? Number.NaN).toBeCloseTo(0.2);
    expect(p.etaMs ?? Number.NaN).toBeCloseTo(2.5 * HOUR, -3);
    expect(describePace(p)).toBe("At this pace you hit the limit in ~2h 30m, 30m before it resets");
  });
  test("window resets before exhaustion", () => {
    // 5 %/h, 50 % left → 10 h; resets in 2 h → ~60 % at reset.
    const w = win({ samples: [{ at: NOW - HOUR, used: 0.45 }] });
    const p = projectWindow(w, NOW, NOW);
    expect(p.outcome).toBe("resetsFirst");
    expect(p.atReset ?? Number.NaN).toBeCloseTo(0.6);
    expect(describePace(p)).toBe("Resets before you run out (~60% used at reset)");
  });
  test("no consumption", () => {
    const p = projectWindow(win({ samples: [{ at: NOW - 2 * HOUR, used: 0.5 }] }), NOW, NOW);
    expect(p.outcome).toBe("idle");
    expect(p.atReset).toBe(0.5);
    expect(p.remaining).toBe(0.5);
  });
  test("already exhausted", () => {
    const p = projectWindow(win({ used: 1, status: "exhausted", samples: [{ at: NOW - HOUR, used: 0.8 }] }), NOW, NOW);
    expect(p.outcome).toBe("exhausted");
    expect(p.remaining).toBe(0);
    expect(describePace(p)).toBe("Limit reached · resets in 2h");
  });
  test("overage counts as exhausted", () => {
    expect(projectWindow(win({ used: 1.2 }), NOW, NOW).outcome).toBe("exhausted");
  });
  test("reset time passed since the reading", () => {
    const p = projectWindow(win({ resetsAt: NOW - MIN }), NOW - 10 * MIN, NOW);
    expect(p.outcome).toBe("reset");
  });
  test("stale data is flagged and the pace keeps running since the reading", () => {
    const fetched = NOW - 30 * MIN;
    const w = win({ resetsAt: NOW + 4 * HOUR, samples: [{ at: fetched - HOUR, used: 0.3 }] });
    const p = projectWindow(w, fetched, NOW);
    expect(p.stale).toBe(true);
    expect(p.outcome).toBe("runsOut");
    // 2.5 h from the reading, 30 min of it already elapsed.
    expect(p.etaMs ?? Number.NaN).toBeCloseTo(2 * HOUR, -3);
    expect(projectWindow(w, NOW - STALE_MS + MIN, NOW).stale).toBe(false);
    expect(projectWindow(w, undefined, NOW).stale).toBe(true);
  });
  test("not enough readings yet", () => {
    const p = projectWindow(win({ samples: [{ at: NOW - MIN, used: 0.49 }] }), NOW, NOW);
    expect(p.outcome).toBe("unknown");
    expect(p.basisMs).toBeLessThan(MIN_PACE_SPAN_MS);
    expect(describePace(p)).toBe("Measuring pace…");
  });
  test("no amount", () => {
    expect(projectWindow(win({ used: undefined }), NOW, NOW).outcome).toBe("unknown");
  });
  test("no reset time: runs out whenever the pace says", () => {
    const p = projectWindow(win({ resetsAt: undefined, samples: [{ at: NOW - HOUR, used: 0.45 }] }), NOW, NOW);
    expect(p.outcome).toBe("runsOut");
    expect(p.etaMs ?? Number.NaN).toBeCloseTo(10 * HOUR, -3);
  });
});

describe("tightestWindow / windowsForModel / sessionLimits", () => {
  const five = win({ samples: [{ at: NOW - HOUR, used: 0.45 }] }); // resets first, 50 % left
  const week = win({ id: "anthropic:7d", durationMs: 7 * 24 * HOUR, resetsAt: NOW + 3 * 24 * HOUR, used: 0.8, samples: [{ at: NOW - 24 * HOUR, used: 0.6 }] }); // runs out in 24 h
  const opus = win({ id: "anthropic:7d:opus", tier: "opus", used: 0.95 });

  test("soonest run-out beats less remaining", () => {
    expect(tightestWindow([five, week], NOW, NOW)?.window.id).toBe("anthropic:7d");
    expect(tightestWindow([five, opus], NOW, NOW)?.window.id).toBe("anthropic:7d:opus");
    expect(tightestWindow([], NOW, NOW)).toBeUndefined();
  });
  test("tier windows only for models that name the tier", () => {
    const acct = { key: "k", provider: "anthropic", label: "a", windows: [five, week, opus], notes: [], disabled: false };
    expect(windowsForModel(acct, { id: "claude-opus-5" }).map((w) => w.id)).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:opus"]);
    expect(windowsForModel(acct, { id: "claude-sonnet-5" }).map((w) => w.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
  });
  test("session account: pin, else the provider's only account", () => {
    const a = { key: "anthropic|a", provider: "anthropic", label: "a", windows: [five], notes: [], disabled: false };
    const b = { key: "anthropic|b", provider: "anthropic", label: "b", windows: [week], notes: [], disabled: false };
    const c = { key: "openai-codex|c", provider: "openai-codex", label: "c", fetchedAt: NOW, windows: [five], notes: [], disabled: false };
    const data: AccountLimits = { fetchedAt: NOW, accounts: [a, b, c], sessions: [{ sessionId: "s1", provider: "anthropic", accountKey: "anthropic|b" }, { sessionId: "s2", provider: "anthropic" }] };
    const model = { provider: "anthropic", id: "claude-opus-5" };
    expect(sessionLimits(data, "s1", model, NOW)?.account.key).toBe("anthropic|b");
    expect(sessionLimits(data, "s1", model, NOW)?.pinned).toBe(true);
    expect(sessionLimits(data, "s2", model, NOW)).toBeUndefined();
    const codex = sessionLimits(data, "s9", { provider: "openai-codex", id: "gpt" }, NOW);
    expect(codex?.account.key).toBe("openai-codex|c");
    expect(codex?.pinned).toBe(false);
    expect(codex?.stale).toBe(false);
    expect(sessionLimits(data, "s1", undefined, NOW)).toBeUndefined();
  });
});

test("formatSpan", () => {
  expect(formatSpan(45 * MIN)).toBe("45m");
  expect(formatSpan(3 * HOUR + 20 * MIN)).toBe("3h 20m");
  expect(formatSpan(2 * HOUR)).toBe("2h");
  expect(formatSpan(52 * HOUR)).toBe("2d 4h");
  expect(formatSpan(-5)).toBe("0m");
});

describe("nextAskIn (limits poll cadence)", () => {
  test("the shortest cadence among the subscribers counts from the last ask", () => {
    expect(nextAskIn([LIMITS_EVERY_MS, LIMITS_USAGE_EVERY_MS], NOW - 20_000, NOW)).toBe(LIMITS_USAGE_EVERY_MS - 20_000);
    expect(nextAskIn([LIMITS_EVERY_MS], NOW - 20_000, NOW)).toBe(LIMITS_EVERY_MS - 20_000);
  });
  test("overdue or never asked: now", () => {
    expect(nextAskIn([LIMITS_EVERY_MS], NOW - LIMITS_EVERY_MS - 1, NOW)).toBe(0);
    expect(nextAskIn([LIMITS_USAGE_EVERY_MS], undefined, NOW)).toBe(0);
  });
  test("subscribers that don't poll (inactive window) never schedule an ask", () => {
    expect(nextAskIn([null, null], NOW - 10 * HOUR, NOW)).toBeNull();
    expect(nextAskIn([], undefined, NOW)).toBeNull();
    expect(nextAskIn([null, LIMITS_EVERY_MS], NOW, NOW)).toBe(LIMITS_EVERY_MS);
  });
});

describe("demo limits", () => {
  test("windows drift over time and reset on schedule", () => {
    const t0 = demoLimits("demo-1", NOW, [], true);
    const t1 = demoLimits("demo-1", NOW + 30 * MIN, [], true);
    const five0 = t0.accounts[0]?.windows[0];
    const five1 = t1.accounts[0]?.windows[0];
    expect(five0 && five1).toBeTruthy();
    if (!five0 || !five1) return;
    expect(five0.resetsAt).toBeGreaterThan(NOW);
    if (five1.resetsAt === five0.resetsAt) expect(five1.used ?? 0).toBeGreaterThanOrEqual(five0.used ?? 0);
    else expect(five1.used ?? 1).toBeLessThan(five0.used ?? 0);
    expect(t0.accounts.some((a) => a.disabled && a.error)).toBe(true);
    // Samples stay inside the current period and before the report.
    for (const a of t0.accounts)
      for (const w of a.windows) for (const s of w.samples) expect(s.at).toBeGreaterThanOrEqual((w.resetsAt ?? 0) - (w.durationMs ?? 0));
  });
  test("every projection state shows up over a week", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 7 * 24 * HOUR; t += 47 * MIN) {
      const d = demoLimits("demo-1", NOW + t, [], false);
      for (const a of d.accounts) for (const w of a.windows) seen.add(projectWindow(w, a.fetchedAt, NOW + t).outcome);
    }
    for (const o of ["runsOut", "resetsFirst", "exhausted"]) expect(seen.has(o)).toBe(true);
  });
  test("sessions map to accounts by provider", () => {
    const agent = { omp: { sessionId: "s1", model: { provider: "openai-codex", id: "gpt-6-luna" } } } as never;
    const d = demoLimits("demo-1", NOW, [agent], false);
    expect(d.sessions[0]?.accountKey).toBe(d.accounts.find((a) => a.provider === "openai-codex")?.key);
  });
});
