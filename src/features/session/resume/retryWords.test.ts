import { describe, expect, test } from "bun:test";
import type { RetryWait } from "@/core/gen";
import { countdown, retryBadgeText, retryDetail, retryText } from "./words";

const UTC = { locale: "en-GB", timeZone: "UTC" };
const NOW = Date.UTC(2026, 10, 3, 16, 54);

const wait = (over: Partial<RetryWait> = {}): RetryWait => ({
  kind: "rateLimit",
  attempt: 1,
  maxAttempts: 10,
  since: NOW,
  retryAt: NOW + 294_000,
  error: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
  ...over,
});

describe("retry words", () => {
  test("countdown clock rounds up and never goes negative", () => {
    expect(countdown(294_000)).toBe("4:54");
    expect(countdown(293_001)).toBe("4:54");
    expect(countdown(7_000)).toBe("0:07");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(-5_000)).toBe("0:00");
    expect(countdown(3_723_000)).toBe("1:02:03");
  });

  test("strip and card line: kind word, live countdown, attempt", () => {
    expect(retryText(wait(), NOW)).toBe("Rate limit · retrying in 4:54 (1/10)");
    expect(retryText(wait(), NOW + 1_000)).toBe("Rate limit · retrying in 4:53 (1/10)");
    expect(retryText(wait({ kind: "usageLimit", attempt: 3 }), NOW)).toBe("Usage limit · retrying in 4:54 (3/10)");
    expect(retryText(wait({ kind: "overloaded" }), NOW)).toBe("Overloaded · retrying in 4:54 (1/10)");
    expect(retryText(wait({ kind: "other" }), NOW)).toBe("Provider error · retrying in 4:54 (1/10)");
  });

  test("omp reporting no attempt leaves the count out; a due retry says it is retrying now", () => {
    expect(retryText(wait({ attempt: 0 }), NOW)).toBe("Rate limit · retrying in 4:54");
    expect(retryText(wait(), NOW + 294_000)).toBe("Rate limit · retrying now… (1/10)");
    expect(retryText(wait(), NOW + 400_000)).toBe("Rate limit · retrying now… (1/10)");
  });

  test("badge is compact", () => {
    expect(retryBadgeText(wait(), NOW)).toBe("Rate limit · retry 4:54");
    expect(retryBadgeText(wait(), NOW + 300_000)).toBe("Rate limit · retrying");
  });

  test("tooltip: nothing to answer, omp's error, the next attempt", () => {
    expect(retryDetail(wait(), NOW, UTC)).toEqual([
      "omp is waiting to try again on its own; nothing to answer.",
      '429 {"type":"error","error":{"type":"rate_limit_error"}}',
      "Next attempt ~16:58 (1/10)",
    ]);
  });
});
