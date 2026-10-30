import { describe, expect, test } from "bun:test";
import { applyUsageAnswer, calendar, hourOffsetAt, OLD_HOSTD_USAGE, rangeSince, refreshUsage, snapshot, todaySpend, usageIsStale, usageParams, usageToStore, type HostUsage } from "@/core/usage";
import type { UsageInsights, UsageReport } from "@/core/gen";
import { activeDays, bars, daySeries, heatmap, mergeInsights, nextDayKey, streaks, zeroStat } from "./usageData";

const HOUR = 3_600_000;
const MIN = 60_000;
const berlin = calendar("Europe/Berlin");

/** A host's report with requests at the given instants (cost $1 each), UTC-hour buckets. */
function report(events: number[], extra: Partial<UsageInsights> = {}): UsageInsights {
  const hours = new Map<number, number>();
  for (const at of events) hours.set(Math.floor(at / HOUR), (hours.get(Math.floor(at / HOUR)) ?? 0) + 1);
  const keys = [...hours.keys()].sort((a, b) => a - b);
  const n = keys.map((k) => hours.get(k) ?? 0);
  const totals = { ...zeroStat(), requests: events.length, costUsd: events.length, tokens: events.length * 100 };
  return {
    version: "v",
    hourOffset: 0,
    hours: { hour: keys, costUsd: n, tokens: n.map((x) => x * 100), input: n, output: n, cacheRead: n.map(() => 0), cacheWrite: n.map(() => 0), requests: n, errors: n.map(() => 0), unpriced: n.map(() => 0) },
    totals,
    models: [{ provider: "anthropic", model: "opus", stat: { ...totals } }],
    providers: [{ key: "anthropic", stat: { ...totals } }],
    projects: [],
    agents: [{ key: "main", stat: { ...totals } }],
    subagents: [],
    tiers: [],
    tools: [{ name: "read", calls: events.length, errors: 0, costUsd: 0 }],
    sessions: [],
    sessionCount: 1,
    subagentCount: 0,
    records: {},
    activity: { hour: keys, requests: n },
    work: { agentMs: 0, stretches: [] },
    ...extra,
  };
}

describe("calendar", () => {
  test("a DST day is one local day of 25 hours; days step by the calendar, not by 24 h", () => {
    const oct25 = berlin.startOfDay(Date.UTC(2026, 9, 25, 12));
    expect(oct25).toBe(Date.UTC(2026, 9, 24, 22)); // 00:00 CEST
    const oct26 = berlin.addDays(oct25, 1);
    expect(oct26).toBe(Date.UTC(2026, 9, 25, 23)); // 00:00 CET
    expect(oct26 - oct25).toBe(25 * HOUR);
    expect(berlin.day(oct26 - 1)).toBe("2026-10-25");
    expect(berlin.addDays(oct26, -2)).toBe(Date.UTC(2026, 9, 23, 22));
    // Spring forward: 23 hours.
    const mar29 = berlin.startOfDay(Date.UTC(2026, 2, 29, 12));
    expect(berlin.addDays(mar29, 1) - mar29).toBe(23 * HOUR);
  });
  test("hour offsets: whole-hour zones 0, India 30, Nepal 45", () => {
    const t = Date.UTC(2026, 9, 29, 12);
    expect(hourOffsetAt(berlin, t)).toBe(0);
    expect(hourOffsetAt(calendar("Asia/Kolkata"), t)).toBe(30);
    expect(hourOffsetAt(calendar("Asia/Kathmandu"), t)).toBe(45);
    expect(hourOffsetAt(calendar("America/St_Johns"), t)).toBe(30);
  });
  test("range windows start at local midnight", () => {
    const now = Date.UTC(2026, 9, 29, 10);
    expect(rangeSince("today", now, berlin)).toBe(Date.UTC(2026, 9, 28, 23));
    // 7 days back crosses the DST change: still a local midnight (CEST then).
    expect(rangeSince("7d", now, berlin)).toBe(Date.UTC(2026, 9, 22, 22));
    expect(rangeSince("all", now, berlin)).toBeUndefined();
    const p = usageParams("30d", now, "abc", false, berlin);
    // `days` is what a tf-hostd from before 0.7 needs to take the request at all.
    expect(p).toEqual({ view: "insights", days: 30, since: Date.UTC(2026, 8, 29, 22), hourOffset: 0, refresh: undefined, have: "abc" });
    expect(usageParams("today", now, undefined, true, berlin)).toMatchObject({ view: "summary", days: 1 });
    expect(usageParams("all", now, undefined, false, berlin).days).toBe(366);
  });
  test("a legacy answer (tf-hostd before 0.7) is an error the page can show, not an empty report", () => {
    const e: HostUsage = { loading: false };
    applyUsageAnswer(e, { days: [], models: [] }, 1);
    expect(e.error).toBe(OLD_HOSTD_USAGE);
    applyUsageAnswer(e, { index: { ready: false } as never }, 2);
    expect(e.error).toBeUndefined();
  });
  test("Refresh on an offline host says so instead of doing nothing", async () => {
    await refreshUsage(["offline-host"], "7d");
    expect(snapshot(["offline-host"], "7d")["offline-host"]?.error).toContain("offline");
  });
});

describe("hosts in other time zones, merged into this device's days", () => {
  // Tokyo host: 23:30 local on Oct 24 = 14:30Z. New York host: 23:30 local on Oct 24 = 03:30Z Oct 25.
  const tokyo = Date.UTC(2026, 9, 24, 14, 30);
  const newYork = Date.UTC(2026, 9, 25, 3, 30);
  // On the DST day itself: 23:30 CET Oct 25 (22:30Z) and 00:30 CET Oct 26 (23:30Z).
  const lateOct25 = Date.UTC(2026, 9, 25, 22, 30);
  const earlyOct26 = Date.UTC(2026, 9, 25, 23, 30);
  const m = mergeInsights([
    { hostId: "tokyo", insights: report([tokyo, lateOct25]) },
    { hostId: "nyc", insights: report([newYork, earlyOct26, earlyOct26 + 5 * MIN]) },
  ]);
  const days = daySeries(m.hours, berlin, Date.UTC(2026, 9, 24, 6), Date.UTC(2026, 9, 26, 12));

  test("each request lands on the device's day, not on its host's label", () => {
    expect(days.map((d) => d.key)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    // Both hosts would have called their request "2026-10-24": here they are a day apart.
    expect(days.map((d) => d.requests)).toEqual([1, 2, 2]);
    expect(days.map((d) => d.cost)).toEqual([1, 2, 2]);
    expect(days[2]!.start - days[1]!.start).toBe(25 * HOUR);
  });
  test("merge sums by key and by absolute hour", () => {
    expect(m.totals.requests).toBe(5);
    expect(m.models).toHaveLength(1);
    expect(m.models[0]!.stat.requests).toBe(5);
    expect(m.models[0]!.hosts).toEqual(["tokyo", "nyc"]);
    expect(m.tools[0]!.calls).toBe(5);
    // The two New York requests share one hour bucket; the merged hours keep absolute order.
    expect(m.hours.map((h) => h.requests)).toEqual([1, 1, 1, 2]);
    expect(m.sessionCount).toBe(2);
  });
  test("same UTC hour from two hosts adds up", () => {
    const t = Date.UTC(2026, 9, 28, 9, 10);
    const both = mergeInsights([
      { hostId: "a", insights: report([t]) },
      { hostId: "b", insights: report([t + 20 * MIN]) },
    ]);
    expect(both.hours).toHaveLength(1);
    expect(both.hours[0]!.requests).toBe(2);
  });
});

describe("streaks, calendar, bars", () => {
  const now = Date.UTC(2026, 9, 29, 10); // Thursday
  const at = (d: number) => Date.UTC(2026, 9, d, 9);
  const act = activeDays(mergeInsights([{ hostId: "h", insights: report([at(20), at(21), at(22), at(26), at(27), at(28), at(29), at(29) + HOUR]) }]).activity, berlin);
  test("current and longest streaks over local days", () => {
    expect(streaks(act, berlin, now)).toEqual({ current: 4, longest: 4, activeDays: 7, todayActive: true });
    // Before anything today, yesterday's streak is still alive.
    const noToday = new Map([...act].filter(([k]) => k !== "2026-10-29"));
    expect(streaks(noToday, berlin, now).current).toBe(3);
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
  });
  test("heatmap: weeks of Monday…Sunday ending this week, future days empty", () => {
    const cols = heatmap(act, berlin, now, 2);
    expect(cols).toHaveLength(2);
    expect(cols[0]![0]!.key).toBe("2026-10-19");
    expect(cols[1]![3]!.key).toBe("2026-10-29");
    expect(cols[1]![3]!.requests).toBe(2);
    expect(cols[1]![4]!.future).toBe(true);
    expect(cols[1]![3]!.level).toBe(4);
  });
  test("bars group long ranges, newest bar ending today", () => {
    const days = daySeries([], berlin, Date.UTC(2026, 6, 1, 12), now);
    const b = bars(days, 30);
    expect(b.length).toBeLessThanOrEqual(30);
    expect(b[b.length - 1]!.key).toBe(days[days.length - 1 - (b[b.length - 1]!.span - 1)]!.key);
    expect(b.reduce((n, x) => n + x.span, 0)).toBe(days.length);
  });
});

describe("last good reports and today", () => {
  const now = Date.UTC(2026, 9, 29, 10);
  const full: UsageReport = { index: { path: "/s", ready: true, syncing: false }, insights: report([now - HOUR, now - 30 * MIN, Date.UTC(2026, 9, 28, 9)], { version: "v1", since: rangeSince("today", now, berlin) }) };
  test("unchanged keeps the report; a failed request never drops it; not ready clears it", () => {
    const e: HostUsage = { loading: false };
    applyUsageAnswer(e, full, now);
    expect(e.insights?.version).toBe("v1");
    applyUsageAnswer(e, { index: { path: "/s", ready: true, syncing: true }, unchanged: true }, now + MIN);
    expect(e.insights?.version).toBe("v1");
    expect(e.index?.syncing).toBe(true);
    // A failed request only marks the entry: what was shown stays, flagged stale.
    e.error = "timeout";
    expect(e.insights).toBeDefined();
    expect(usageIsStale(e, true, MIN, now + MIN)).toBe(true);
    expect(usageIsStale({ ...e, error: undefined }, false, MIN, now + MIN)).toBe(true);
    expect(usageIsStale({ ...e, error: undefined }, true, MIN, now + 2 * MIN)).toBe(false);
    applyUsageAnswer(e, { index: { path: "/s", ready: false, syncing: true } }, now + 2 * MIN);
    expect(e.insights).toBeUndefined();
    expect(e.error).toBeUndefined();
  });
  test("today: indexed hours since local midnight + live since the sync + ledger growth", () => {
    const usage: HostUsage = { ...full, live: { since: now - 5 * MIN, costUsd: 0.5, tokens: 50, input: 40, output: 10, ledgerToday: { costUsd: 2, tokens: 200, input: 150, output: 50 } }, receivedAt: now - MIN, loading: false };
    const t = todaySpend([{ hostId: "a", usage, ledger: { costUsd: 2.25, tokens: 230, input: 170, output: 60 }, online: true }], now, berlin);
    expect(t.cost).toBeCloseTo(2 + 0.5 + 0.25); // two indexed requests today ($1 each), live, growth
    expect(t.requests).toBe(2);
    expect(t.live).toBeCloseTo(0.75);
    expect(t.stale).toEqual([]);
    // Offline: the last report alone, flagged stale; a host without one: its ledger, approximate.
    const off = todaySpend(
      [
        { hostId: "a", usage, ledger: { costUsd: 9, tokens: 1, input: 1, output: 0 }, online: false },
        { hostId: "b", ledger: { costUsd: 1.5, tokens: 10, input: 5, output: 5 }, online: true },
      ],
      now,
      berlin,
    );
    expect(off.cost).toBeCloseTo(2 + 1.5);
    expect(off.stale).toEqual(["a"]);
    expect(off.approx).toEqual(["b"]);
  });
  test("persisting keeps today's summaries first within the budget", () => {
    const big: HostUsage = { insights: report(Array.from({ length: 400 }, (_, i) => now - i * HOUR)), receivedAt: now, loading: false };
    const small: HostUsage = { insights: report([now]), receivedAt: now, loading: false };
    const stored = usageToStore([{ key: "a|30d", usage: big }, { key: "a|today", usage: small }, { key: "b|today", usage: { loading: false } }], JSON.stringify(small).length + 50);
    expect(Object.keys(stored.entries)).toEqual(["a|today"]);
  });
});

describe("useSyncExternalStore snapshots", () => {
  test("two ranges read by one component stay referentially stable (the Usage page crashed in a render loop)", () => {
    const a = snapshot(["h"], "30d");
    const b = snapshot(["h"], "today");
    expect(snapshot(["h"], "30d")).toBe(a);
    expect(snapshot(["h"], "today")).toBe(b);
    expect(snapshot(["h", "i"], "30d")).not.toBe(a);
  });
});
