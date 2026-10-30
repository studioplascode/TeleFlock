import { describe, expect, test } from "bun:test";
import { buildCard, mergeReports, weekOf } from "@/features/wrapped/model";
import { demoWrapped } from "./wrapped";

const HOUR = 3_600_000;

describe("demo host.wrapped", () => {
  const week = weekOf(new Date(2026, 9, 28, 12).getTime(), 1);
  const later = week.until + 30 * 24 * HOUR;

  test("first ask is still counting commits, then everything; the same week every time", () => {
    const first = demoWrapped("t-forge", true, { since: week.since, until: week.until }, later);
    expect(first.pending).toBe(true);
    expect(first.code).toBeUndefined();
    const full = demoWrapped("t-forge", true, { since: week.since, until: week.until }, later + 5_000);
    expect(full.pending).toBeUndefined();
    expect(full.code?.commits.length).toBe(18 + 8 + 3);
    expect(full.busy).toEqual(first.busy);
    const again = demoWrapped("t-forge", true, { since: week.since, until: week.until }, later + 9_000);
    expect({ ...again, index: undefined }).toEqual({ ...full, index: undefined });
    for (const s of full.busy) {
      expect(s.start).toBeGreaterThanOrEqual(week.since);
      expect(s.end).toBeLessThanOrEqual(week.until);
    }
    for (const c of full.code?.commits ?? []) expect(c.at).toBeLessThan(week.until);
  });

  test("a week in progress stops at now", () => {
    const now = week.since + 2.5 * 24 * HOUR;
    demoWrapped("t-forge", true, { since: week.since }, now);
    const r = demoWrapped("t-forge", true, { since: week.since }, now + 5_000);
    expect(r.until).toBe(now + 5_000);
    expect(Math.max(...r.busy.map((s) => s.end))).toBeLessThanOrEqual(now + 5_000);
    expect(r.prs?.every((p) => p.mergedAt < now + 5_000)).toBe(true);
    expect(r.agents).toBeLessThan(31);
  });

  test("both demo hosts make a full card", () => {
    const ask = (id: string, rich: boolean) => {
      demoWrapped(id, rich, { since: week.since, until: week.until }, later);
      return demoWrapped(id, rich, { since: week.since, until: week.until }, later + 5_000);
    };
    const f = mergeReports([ask("c-forge", true), ask("c-studio", false)], ["forge", "studio-pc"]);
    expect(f.commits).toBe(18 + 8 + 6 + 3); // the shared three once
    expect(f.notes).toEqual(["studio-pc: gh is not signed in on this host: run `gh auth login` there to count merged pull requests."]);
    const card = buildCard(f, week, 2);
    const by = Object.fromEntries(card.stats.map((s) => [s.key, s]));
    expect(by.fastest?.value).toBe("gpt-6-luna");
    expect(by.crew?.value).toBe("Worker");
    expect(by.prs?.value).toBe("6");
    expect(by.overnight?.empty).toBe(false);
    expect(card.hero.empty).toBe(false);
  });
});
