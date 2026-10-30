import { describe, expect, test } from "bun:test";
import type { WrappedReport } from "@/core/gen";
import {
  buildCard,
  fastestModel,
  fileName,
  formatMoment,
  formatRange,
  formatSpan,
  formatWork,
  hourOffset,
  isOvernight,
  longestOvernight,
  mergeReports,
  shortModel,
  topSubagent,
  unionSpans,
  weekOf,
} from "./model";

/** Local time, so the tests read the same in every time zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function report(over: Partial<WrappedReport> = {}): WrappedReport {
  return { since: 0, until: 0, agents: 0, subagents: 0, automationRuns: 0, workMs: 0, busy: [], models: [], crew: [], ...over };
}

describe("weeks", () => {
  test("Monday 00:00 to the next Monday, local", () => {
    const wed = at(2026, 10, 28, 15, 30);
    expect(weekOf(wed)).toEqual({ since: at(2026, 10, 26), until: at(2026, 11, 2), back: 0 });
    expect(weekOf(wed, 1)).toEqual({ since: at(2026, 10, 19), until: at(2026, 10, 26), back: 1 });
    expect(weekOf(at(2026, 11, 1, 23, 59)).since).toBe(at(2026, 10, 26)); // Sunday belongs to the week before
    expect(weekOf(at(2026, 10, 26)).since).toBe(at(2026, 10, 26)); // Monday midnight starts one
  });

  test("labels", () => {
    expect(formatRange(weekOf(at(2026, 10, 28)))).toBe("Oct 26 – Nov 1, 2026");
    expect(formatRange(weekOf(at(2026, 10, 14)))).toBe("Oct 12 – 18, 2026");
    expect(formatRange(weekOf(at(2026, 12, 30)))).toBe("Dec 28, 2026 – Jan 3, 2027");
    expect(fileName(weekOf(at(2026, 10, 28)))).toBe("flock-wrapped-2026-10-26.png");
  });

  test("hour offset is the UTC offset modulo an hour", () => {
    const off = hourOffset(at(2026, 10, 28));
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(60);
    expect(off).toBe((((-new Date(at(2026, 10, 28)).getTimezoneOffset()) % 60) + 60) % 60);
  });
});

describe("stretches", () => {
  test("merge across pauses of at most 10 minutes", () => {
    const spans = [
      { start: 100 * MIN, end: 120 * MIN },
      { start: 0, end: 30 * MIN },
      { start: 40 * MIN, end: 50 * MIN }, // 10 min after the first: joined
      { start: 61 * MIN, end: 70 * MIN }, // 11 min: a new stretch
      { start: 65 * MIN, end: 68 * MIN }, // inside the previous one
      { start: 200 * MIN, end: 200 * MIN }, // empty
    ];
    expect(unionSpans(spans)).toEqual([
      { start: 0, end: 50 * MIN },
      { start: 61 * MIN, end: 70 * MIN },
      { start: 100 * MIN, end: 120 * MIN },
    ]);
  });

  test("overnight: some of it between midnight and 06:00", () => {
    expect(isOvernight({ start: at(2026, 10, 27, 22, 40), end: at(2026, 10, 28, 4, 50) })).toBe(true);
    expect(isOvernight({ start: at(2026, 10, 28, 2), end: at(2026, 10, 28, 3) })).toBe(true);
    expect(isOvernight({ start: at(2026, 10, 27, 20), end: at(2026, 10, 27, 23, 59) })).toBe(false);
    expect(isOvernight({ start: at(2026, 10, 28, 6), end: at(2026, 10, 28, 12) })).toBe(false);
    expect(isOvernight({ start: at(2026, 10, 27, 9), end: at(2026, 10, 29, 9) })).toBe(true); // a two-day run
  });

  test("the longest overnight stretch wins over a longer daytime one", () => {
    const night = { start: at(2026, 10, 27, 23), end: at(2026, 10, 28, 4) };
    const shorterNight = { start: at(2026, 10, 29, 1), end: at(2026, 10, 29, 2) };
    const day = { start: at(2026, 10, 28, 9), end: at(2026, 10, 28, 19) };
    expect(longestOvernight([shorterNight, day, night])).toEqual(night);
    expect(longestOvernight([day])).toBeNull();
  });
});

describe("awards", () => {
  test("fastest model needs five timed requests", () => {
    const models = [
      { provider: "anthropic", model: "steady", requests: 400, tps: 400 * 90, tpsN: 400 },
      { provider: "openai", model: "fluke", requests: 3, tps: 3 * 900, tpsN: 3 },
      { provider: "google", model: "quick", requests: 20, tps: 20 * 150, tpsN: 20 },
    ];
    expect(fastestModel(models)).toEqual({ provider: "google", model: "quick", requests: 20, tps: 150 });
    expect(fastestModel(models.slice(0, 2).map((m) => ({ ...m, tpsN: 2 })))).toBeNull();
  });

  test("busiest subagent: most steps, then most output", () => {
    const crew = [
      { name: "Scout", requests: 40, tokens: 9e5, output: 9_000, costUsd: 1 },
      { name: "Worker", requests: 40, tokens: 8e5, output: 12_000, costUsd: 1 },
      { name: "Explore", requests: 12, tokens: 1e5, output: 1_000, costUsd: 0.2 },
    ];
    expect(topSubagent(crew)?.name).toBe("Worker");
    expect(topSubagent([])).toBeNull();
  });

  test("model ids lose their date stamp", () => {
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(shortModel("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });
});

describe("hosts add up", () => {
  const forge = report({
    agents: 21,
    subagents: 64,
    automationRuns: 5,
    workMs: 30 * HOUR,
    busy: [{ start: at(2026, 10, 27, 23), end: at(2026, 10, 28, 3) }],
    models: [{ provider: "anthropic", model: "claude-haiku-4-5", requests: 50, tps: 50 * 160, tpsN: 50 }],
    crew: [{ name: "Explore", requests: 30, tokens: 1e6, output: 2e4, costUsd: 2 }],
    code: {
      repos: [{ name: "teleflock", path: "/w/teleflock" }],
      commits: [
        { sha: "aaaaaaaaaaaa", repo: "teleflock", at: at(2026, 10, 27, 12), added: 100, removed: 20 },
        { sha: "bbbbbbbbbbbb", repo: "teleflock", at: at(2026, 10, 27, 13), added: 10, removed: 5 },
      ],
    },
    prs: [{ url: "u/7", number: 7, title: "Wrapped card", repo: "acme/teleflock", mergedAt: at(2026, 10, 28, 9) }],
    index: { path: "/x/stats.db", ready: true, syncing: true },
  });
  const studio = report({
    agents: 4,
    subagents: 10,
    workMs: 2 * HOUR,
    // Starts 10 min after forge's stretch ends: one flock stretch.
    busy: [{ start: at(2026, 10, 28, 3, 10), end: at(2026, 10, 28, 5) }],
    models: [{ provider: "anthropic", model: "claude-haiku-4-5", requests: 50, tps: 50 * 100, tpsN: 50 }],
    crew: [
      { name: "Explore", requests: 15, tokens: 5e5, output: 1e4, costUsd: 1 },
      { name: "Worker", requests: 40, tokens: 2e6, output: 5e4, costUsd: 4 },
    ],
    code: {
      repos: [{ name: "teleflock", path: "/h/teleflock" }, { name: "notes", path: "/h/notes", error: "timed out" }],
      // Forge's commit fetched into studio's clone: counted once.
      commits: [
        { sha: "aaaaaaaaaaaa", repo: "teleflock", at: at(2026, 10, 27, 12), added: 100, removed: 20 },
        { sha: "cccccccccccc", repo: "docs", at: at(2026, 10, 29, 8), added: 300, removed: 0 },
      ],
    },
    prs: [
      { url: "u/7", number: 7, title: "Wrapped card", repo: "acme/teleflock", mergedAt: at(2026, 10, 28, 9) },
      { url: "u/9", number: 9, title: "Fix the relay", repo: "acme/teleflock", mergedAt: at(2026, 10, 29, 9) },
    ],
    prsNote: "GitHub did not answer for notes.",
    pending: true,
    index: { path: "/y/stats.db", ready: false, syncing: false },
  });

  test("sums, deduplicated commits and pull requests, merged lists", () => {
    const f = mergeReports([forge, studio]);
    expect([f.agents, f.subagents, f.automationRuns, f.workMs]).toEqual([25, 74, 5, 32 * HOUR]);
    expect(f.busy).toEqual([{ start: at(2026, 10, 27, 23), end: at(2026, 10, 28, 5) }]);
    expect([f.commits, f.added, f.removed]).toEqual([3, 410, 25]);
    expect(f.repos.map((r) => [r.name, r.commits])).toEqual([["docs", 1], ["teleflock", 2]]);
    expect(f.prs?.map((p) => p.number)).toEqual([9, 7]);
    expect(f.models).toEqual([{ provider: "anthropic", model: "claude-haiku-4-5", requests: 100, tps: 50 * 260, tpsN: 100 }]);
    expect(fastestModel(f.models)?.tps).toBe(130);
    expect(topSubagent(f.crew)).toEqual({ name: "Explore", requests: 45, tokens: 1.5e6, output: 3e4, costUsd: 3 });
    expect(f.notes).toEqual(["git could not read notes (timed out)", "GitHub did not answer for notes."]);
    expect(mergeReports([forge, studio], ["forge", "studio-pc"]).notes).toEqual(["studio-pc: git could not read notes (timed out)", "studio-pc: GitHub did not answer for notes."]);
    expect([f.pending, f.indexing, f.unindexed]).toEqual([true, true, 1]);
  });

  test("no host could ask GitHub: unknown, not zero", () => {
    const f = mergeReports([report({ prsNote: "gh is not signed in on this host: run `gh auth login` there to count merged pull requests." })]);
    expect(f.prs).toBeNull();
    const card = buildCard(f, weekOf(at(2026, 10, 28)), 1);
    const prs = card.stats.find((s) => s.key === "prs");
    expect([prs?.value, prs?.empty]).toEqual(["—", true]);
  });

  test("the card", () => {
    const card = buildCard(mergeReports([forge, studio]), weekOf(at(2026, 10, 28), 1), 2);
    expect(card.period).toBe("Last week");
    expect(card.range).toBe("Oct 19 – 25, 2026");
    expect(card.hero).toEqual({ value: "32 h", caption: "of unattended work", detail: "Agents working on their own between your prompts, added up", empty: false });
    const by = Object.fromEntries(card.stats.map((s) => [s.key, `${s.value} | ${s.detail}`]));
    expect(by).toEqual({
      agents: "25 | 74 subagents · 5 from automations",
      lines: "435 | +410 −25 · 3 commits",
      prs: "2 | Latest: Fix the relay",
      overnight: `6 h | ${formatMoment(at(2026, 10, 27, 23))} → ${formatMoment(at(2026, 10, 28, 5))}`,
      fastest: "claude-haiku-4-5 | 130 tok/s · anthropic",
      crew: "Explore | 45 steps · 1.5M tokens",
    });
    expect(card.footer).toBe("2 hosts · 25 agents");
    expect(card.summary).toContain("Flock Wrapped, Oct 19 – 25, 2026: 32 h of unattended work");
    expect(card.summary).toContain("Fastest model: claude-haiku-4-5 (130 tok/s · anthropic)");
  });

  test("an empty week reads as one", () => {
    const card = buildCard(mergeReports([report()]), weekOf(at(2026, 10, 28)), 1);
    expect(card.period).toBe("This week so far");
    expect(card.hero.value).toBe("0 h");
    expect(card.hero.empty).toBe(true);
    expect(card.stats.map((s) => s.value)).toEqual(["0", "0", "—", "—", "—", "—"]);
    expect(card.stats.find((s) => s.key === "lines")?.detail).toBe("No commits of yours");
  });
});

describe("words", () => {
  test("durations", () => {
    expect(formatWork(0)).toBe("0 h");
    expect(formatWork(35 * MIN)).toBe("35 min");
    expect(formatWork(6.5 * HOUR)).toBe("6.5 h");
    expect(formatWork(6 * HOUR)).toBe("6 h");
    expect(formatWork(1234.4 * HOUR)).toBe("1,234 h");
    expect(formatSpan(6 * HOUR + 10 * MIN)).toBe("6 h 10 min");
    expect(formatSpan(45 * MIN)).toBe("45 min");
    expect(formatSpan(12 * HOUR)).toBe("12 h");
    expect(formatMoment(at(2026, 10, 27, 22, 40))).toBe("Tue 22:40");
  });
});
