import { describe, expect, test } from "bun:test";
import type { CleanupReport, CleanupWorktree } from "@/core/gen";
import { bulkSet, classify, sortForPage, totals } from "./classify";
import { CRITICAL_BYTES, diskLevel, showDiskNotice, SNOOZE_MS } from "./disk";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function wt(path: string, p: Partial<CleanupWorktree> = {}): CleanupWorktree {
  return {
    path,
    branch: path.split("/").pop(),
    missing: false,
    dirty: 0,
    orphanCommits: false,
    agents: 0,
    busy: false,
    sizePartial: false,
    activeAt: NOW - 2 * DAY,
    createdAt: NOW - 20 * DAY,
    ...p,
  };
}

const pr = (state: string) => ({ number: 7, url: "https://github.com/o/r/pull/7", title: "t", state, draft: false });

describe("worktree classification", () => {
  test("merged and closed pull requests go with Delete merged/closed, open ones stay", () => {
    expect(classify(wt("/w/a", { pr: pr("MERGED") }), NOW, 14)).toMatchObject({ kind: "merged", shipped: true, stale: false });
    expect(classify(wt("/w/a", { pr: pr("CLOSED") }), NOW, 14)).toMatchObject({ kind: "closed", shipped: true });
    // An open PR is work in review: never stale, however old.
    expect(classify(wt("/w/a", { pr: pr("OPEN"), activeAt: NOW - 400 * DAY }), NOW, 14)).toMatchObject({ kind: "open", shipped: false, stale: false });
  });

  test("stale: no pull request, nothing open in it, untouched for the chosen days", () => {
    const old = wt("/w/old", { activeAt: NOW - 20 * DAY });
    expect(classify(old, NOW, 14)).toMatchObject({ kind: "stale", stale: true, shipped: false });
    expect(classify(old, NOW, 30)).toMatchObject({ kind: "active", stale: false });
    expect(classify(old, NOW, 14).idleDays).toBeCloseTo(20);
    // Open in herdr, or an (idle) agent in it: in use, not stale.
    expect(classify({ ...old, workspaceId: "w4" }, NOW, 14).kind).toBe("active");
    expect(classify({ ...old, agents: 1 }, NOW, 14).kind).toBe("active");
    // No activity known: falls back to when it was created; neither known: never stale.
    expect(classify(wt("/w/x", { activeAt: undefined, createdAt: NOW - 40 * DAY }), NOW, 14).kind).toBe("stale");
    expect(classify(wt("/w/x", { activeAt: undefined, createdAt: undefined }), NOW, 14)).toMatchObject({ kind: "active", idleDays: null });
  });

  test("a folder already gone is never taken by a bulk action (it may be on an unmounted disk)", () => {
    expect(classify(wt("/w/gone", { missing: true, dirty: undefined, activeAt: NOW - 90 * DAY }), NOW, 14)).toMatchObject({ kind: "missing", stale: false, shipped: false });
  });

  test("safety: busy, locked, unsaved detached commits and uncommitted changes keep bulk actions away", () => {
    const merged = { pr: pr("MERGED") };
    expect(classify(wt("/w/a", { ...merged, busy: true, agents: 1 }), NOW, 14)).toMatchObject({ kind: "busy", hold: "busy", shipped: false });
    expect(classify(wt("/w/a", { ...merged, locked: "" }), NOW, 14)).toMatchObject({ kind: "merged", hold: "locked", shipped: false });
    expect(classify(wt("/w/a", { ...merged, orphanCommits: true }), NOW, 14)).toMatchObject({ hold: "orphan", shipped: false });
    expect(classify(wt("/w/a", { ...merged, dirty: 3 }), NOW, 14)).toMatchObject({ hold: "dirty", shipped: false });
    // Unknown change count (git timed out): git itself refuses a dirty one without force.
    expect(classify(wt("/w/a", { ...merged, dirty: undefined }), NOW, 14)).toMatchObject({ hold: undefined, shipped: true });
    expect(classify(wt("/w/gone", { missing: true, locked: "usb disk" }), NOW, 14)).toMatchObject({ kind: "missing", hold: "locked", stale: false });
    expect(classify(wt("/w/old", { activeAt: NOW - 90 * DAY, dirty: 1 }), NOW, 14)).toMatchObject({ kind: "stale", hold: "dirty", stale: false });
  });
});

describe("bulk sets and totals", () => {
  const report: CleanupReport = {
    scanning: false,
    scannedAt: NOW,
    repos: [
      {
        root: "/r/app",
        name: "app",
        worktrees: [
          wt("/w/merged", { pr: pr("MERGED"), size: 300 }),
          wt("/w/closed-dirty", { pr: pr("CLOSED"), dirty: 2, size: 50 }),
          wt("/w/stale", { activeAt: NOW - 30 * DAY, size: 1000 }),
          wt("/w/gone", { missing: true, dirty: undefined }),
          wt("/w/fresh", { size: 20 }),
          wt("/w/busy", { pr: pr("MERGED"), busy: true, agents: 1, size: 5 }),
        ],
      },
      { root: "/r/lib", name: "lib", worktrees: [wt("/w/lib-merged", { pr: pr("MERGED"), size: 7, sizePartial: true })] },
    ],
  };

  test("Delete merged/closed takes what is safe and lists the rest with why", () => {
    const s = bulkSet(report, "shipped", NOW, 14);
    expect(s.items.map((w) => w.path)).toEqual(["/w/merged", "/w/lib-merged"]);
    expect(s.bytes).toBe(307);
    expect(s.held.map((h) => [h.worktree.path, h.hold])).toEqual([["/w/closed-dirty", "dirty"]]);
  });

  test("Prune stale takes stale ones, not the folders already gone", () => {
    const s = bulkSet(report, "stale", NOW, 14);
    expect(s.items.map((w) => w.path)).toEqual(["/w/stale"]);
    expect(bulkSet(report, "stale", NOW, 60).items).toEqual([]);
  });

  test("totals count kinds and known sizes", () => {
    const t = totals(report, NOW, 14);
    expect(t.worktrees).toBe(7);
    expect(t.bytes).toBe(300 + 50 + 1000 + 20 + 5 + 7);
    expect(t.partial).toBe(true);
    expect(t.byKind).toMatchObject({ merged: 2, closed: 1, stale: 1, missing: 1, active: 1, busy: 1 });
  });

  test("the page lists removable kinds first, the longest idle first within a kind", () => {
    const ws = [wt("/w/z-active"), wt("/w/stale-new", { activeAt: NOW - 20 * DAY }), wt("/w/stale-old", { activeAt: NOW - 50 * DAY }), wt("/w/m", { pr: pr("MERGED") })];
    expect(sortForPage(ws, NOW, 14).map((w) => w.path)).toEqual(["/w/m", "/w/stale-old", "/w/stale-new", "/w/z-active"]);
  });
});

describe("low disk", () => {
  const GIB = 1024 ** 3;
  test("levels by free space and share of the disk", () => {
    expect(diskLevel(1.5 * GIB, 16 * GIB)).toBe("critical");
    expect(diskLevel(CRITICAL_BYTES, 4000 * GIB)).toBe("low");
    expect(diskLevel(9 * GIB, 4000 * GIB)).toBe("low");
    expect(diskLevel(9 * GIB, 32 * GIB)).toBe("ok");
    expect(diskLevel(400 * GIB, 1000 * GIB)).toBe("ok");
    expect(diskLevel(0, 0)).toBe("ok");
  });

  test("hiding the notice lasts a day, unless the disk gets worse", () => {
    expect(showDiskNotice("ok", undefined, NOW)).toBe(false);
    expect(showDiskNotice("low", undefined, NOW)).toBe(true);
    const snooze = { level: "low" as const, until: NOW + SNOOZE_MS };
    expect(showDiskNotice("low", snooze, NOW + 1000)).toBe(false);
    expect(showDiskNotice("critical", snooze, NOW + 1000)).toBe(true);
    expect(showDiskNotice("low", snooze, NOW + SNOOZE_MS)).toBe(true);
  });
});
