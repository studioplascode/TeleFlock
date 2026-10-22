import { describe, expect, test } from "bun:test";
import type { HostLimits } from "@/core";
import type { LimitAccount, LimitWindow } from "@/core/gen";
import { limitHeadline, shortWindow } from "./limitHeadline";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function win(over: Partial<LimitWindow>): LimitWindow {
  return { id: "anthropic:5h", label: "Claude 5 Hour", window: "5 Hour", used: 0.5, status: "ok", unit: "percent", notes: [], samples: [], resetsAt: NOW + 2 * HOUR + 45 * 60_000, ...over };
}

function account(key: string, windows: LimitWindow[], over: Partial<LimitAccount> = {}): LimitAccount {
  return { key, provider: "anthropic", label: key, windows, notes: [], disabled: false, fetchedAt: NOW, ...over };
}

function hosts(...accounts: LimitAccount[][]): Record<string, HostLimits> {
  return Object.fromEntries(accounts.map((a, i) => [`h${i}`, { loading: false, data: { fetchedAt: NOW, accounts: a, sessions: [] } }]));
}

describe("shortWindow", () => {
  test("abbreviates provider window names", () => {
    expect(shortWindow({ window: "5 Hour", label: "x" })).toBe("5h");
    expect(shortWindow({ window: "7 days", label: "x" })).toBe("7d");
    expect(shortWindow({ window: "30 min", label: "x" })).toBe("30m");
    expect(shortWindow({ window: "1 month", label: "x" })).toBe("1mo");
    expect(shortWindow({ window: "Weekly", label: "x" })).toBe("Weekly");
    expect(shortWindow({ label: "Claude 5 Hour" })).toBe("Claude 5 Hour");
  });
});

describe("limitHeadline", () => {
  test("null without any amount", () => {
    expect(limitHeadline({}, NOW)).toBeNull();
    expect(limitHeadline(hosts([account("a", [win({ used: undefined })])]), NOW)).toBeNull();
  });

  test("one account: provider, window, left and reset, unnamed", () => {
    const h = limitHeadline(hosts([account("a", [win({ used: 0.57 })])]), NOW);
    expect(h?.text).toBe("Claude 5h · 43% left · resets 2h 45m");
    expect(h?.tone).toBe("mute");
  });

  test("several accounts: the least remaining wins and is named; shared accounts count once", () => {
    const roomy = account("me@a", [win({ used: 0.2 })]);
    const tight = account("me@b", [win({ used: 0.9, status: "warning" })]);
    const h = limitHeadline(hosts([roomy, tight], [tight]), NOW);
    expect(h?.text).toBe("Claude 5h (me@b) · 10% left · resets 2h 45m");
    expect(h?.tone).toBe("warn");
  });

  test("an exhausted window beats a nearly full one; disabled credentials are skipped", () => {
    const full = account("x", [win({ used: 1.02, window: "7 days", id: "anthropic:7d" })]);
    const almost = account("y", [win({ used: 0.99 })]);
    const off = account("z", [win({ used: 1.5 })], { disabled: true });
    const h = limitHeadline(hosts([almost, full, off]), NOW);
    expect(h?.text.startsWith("Claude 7d (x)")).toBe(true);
    expect(h?.tone).toBe("error");
  });
});
