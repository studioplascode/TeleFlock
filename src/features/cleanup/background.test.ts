import { describe, expect, test } from "bun:test";
import type { CleanupBackground, CleanupReport, CleanupWorktree } from "@/core/gen";
import { backgroundNote, expectOf, followsScan, revalidates } from "./background";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function report(p: Partial<CleanupReport> = {}): CleanupReport {
  return { scannedAt: NOW - 12 * MIN, scanning: false, repos: [], ...p };
}

/** A 0.9.6 host's background: quiet (its next scan due), or its own scan running (`running`). */
function bg(running = false, everyMs = 30 * MIN): CleanupBackground {
  return { everyMs, running, nextAt: running ? undefined : NOW + 18 * MIN };
}

describe("hosts that keep their Cleanup report fresh (tf-hostd 0.9.6)", () => {
  test("revalidates: a report with `background`; older hosts' reports have none", () => {
    expect(revalidates(report({ background: bg() }))).toBe(true);
    expect(revalidates(report({ scanning: true, background: bg(true) }))).toBe(true);
    expect(revalidates(report())).toBe(false);
    expect(revalidates(undefined)).toBe(false);
  });

  test("followsScan: a scan the page asked for, never the host's own background scan; older hosts any scan", () => {
    expect(followsScan(report({ scanning: true, background: bg() }))).toBe(true);
    expect(followsScan(report({ scanning: true, background: bg(true) }))).toBe(false);
    expect(followsScan(report({ background: bg() }))).toBe(false);
    expect(followsScan(report({ scanning: true }))).toBe(true);
    expect(followsScan(report())).toBe(false);
    expect(followsScan(undefined)).toBe(false);
  });

  test("expectOf: the row's HEAD, branch, unpushed commits, agents and workspace; why it was chosen (a settled PR, else the stale cutoff)", () => {
    const w: CleanupWorktree = {
      path: "/w/feat-a",
      branch: "feat/a",
      head: "abc1234",
      missing: false,
      dirty: 2,
      unpushed: 1,
      orphanCommits: false,
      workspaceId: "ws1",
      agents: 1,
      busy: false,
      size: 10_000,
      sizePartial: false,
    };
    expect(expectOf(w)).toStrictEqual({ head: "abc1234", branch: "feat/a", unpushed: 1, agents: 1, workspaceId: "ws1" });
    const detached = expectOf({ ...w, branch: undefined, unpushed: undefined, workspaceId: undefined, agents: 0 });
    expect(detached).toMatchObject({ head: "abc1234", agents: 0 });
    expect(detached.branch).toBeUndefined();
    expect(detached.unpushed).toBeUndefined();
    expect(detached.workspaceId).toBeUndefined();

    const pr = { number: 41, url: "https://github.com/o/r/pull/41", title: "t", draft: false };
    expect(expectOf({ ...w, pr: { ...pr, state: "CLOSED" } }).pr).toStrictEqual({ number: 41, state: "CLOSED" });
    expect(expectOf({ ...w, pr: { ...pr, state: "MERGED" } }).pr).toStrictEqual({ number: 41, state: "MERGED" });
    expect(expectOf({ ...w, pr: { ...pr, state: "OPEN" } }).pr).toBeUndefined();
    expect(expectOf({ ...w, missing: true, pr: { ...pr, state: "MERGED" } }).pr).toBeUndefined();
    // Chosen as stale: the cutoff, unless a settled pull request is why it was chosen.
    expect(expectOf(w, 1_000).staleBefore).toBe(1_000);
    expect(expectOf({ ...w, pr: { ...pr, state: "MERGED" } }, 1_000)).toMatchObject({ pr: { number: 41, state: "MERGED" } });
    expect(expectOf({ ...w, pr: { ...pr, state: "MERGED" } }, 1_000).staleBefore).toBeUndefined();
    expect(expectOf({ ...w, missing: true }, 1_000).staleBefore).toBeUndefined();
  });

  test("backgroundNote: updated or updating in the background with the scan's age, how often the host checks", () => {
    const quiet = backgroundNote(report({ background: bg() }), NOW, "forge");
    expect(quiet).toMatchObject({ text: "Updated in the background · scanned 12m ago", running: false });
    expect(quiet?.about.startsWith("forge checks its worktrees every 30 minutes and soon after worktrees, workspaces or agents change, below the agents' work.")).toBe(true);
    expect(backgroundNote(report({ scanning: true, background: bg(true) }), NOW, "forge")).toMatchObject({ text: "Updating in the background · scanned 12m ago", running: true });
    expect(backgroundNote(report({ scanning: true, scannedAt: undefined, background: bg(true) }), NOW, "forge")?.text).toBe("Updating in the background");
    expect(backgroundNote(report({ background: bg(false, MIN) }), NOW, "")?.about.startsWith("The host checks its worktrees every 1 minute and")).toBe(true);
  });

  test("backgroundNote: nothing for older hosts, nor while a scan the page follows runs", () => {
    expect(backgroundNote(report(), NOW, "forge")).toBeUndefined();
    expect(backgroundNote(report({ scanning: true }), NOW, "forge")).toBeUndefined();
    expect(backgroundNote(report({ scanning: true, background: bg() }), NOW, "forge")).toBeUndefined();
  });
});
