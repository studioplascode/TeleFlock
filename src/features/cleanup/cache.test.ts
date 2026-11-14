import { describe, expect, test, vi } from "bun:test";
import type { CleanupPr, CleanupReport, CleanupStorage, CleanupWorktree } from "@/core/gen";

// The cache persists to localStorage, which bun doesn't provide: an in-memory stand-in, installed
// before the module loads (it restores at load). It holds what an earlier run of the app kept.
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage;

const MB = 1024 * 1024;
const pr: CleanupPr = { number: 7, url: "https://github.com/o/r/pull/7", title: "Fix", state: "MERGED", draft: false, closedAt: 50 };

function wt(path: string, extra: Partial<CleanupWorktree> = {}): CleanupWorktree {
  return { path, branch: "feat", head: "abc1234", missing: false, orphanCommits: false, agents: 0, busy: false, sizePartial: false, ...extra };
}

function report(worktrees: CleanupWorktree[], extra: Partial<CleanupReport> = {}): CleanupReport {
  return { scanning: false, repos: [{ root: "/r", name: "r", worktrees }], owners: [], ...extra };
}

const storage: CleanupStorage = { agentDir: "/home/u/.omp/agent", sessions: { bytes: 5 * MB, files: 40 } };
mem["tf.cleanup.cache"] = JSON.stringify({ v: 1, hosts: { forge: { report: { data: report([wt("/wt/a", { size: 3 * MB })], { scannedAt: 1_000 }), at: 2_000 } } } });
const { cleanupFromStore, cleanupToStore, keepReport, keepStorage, keptOf, settleReport } = await import("./cache");

describe("a host's report as the page shows it", () => {
  test("after a restart of the app, the report kept on the device is there before the host answers", () => {
    expect(keptOf("forge")?.report).toEqual({ data: report([wt("/wt/a", { size: 3 * MB })], { scannedAt: 1_000 }), at: 2_000 });
  });

  test("a finished scan replaces it as it is", () => {
    const prev = report([wt("/wt/a", { size: 3 * MB }), wt("/wt/gone", { size: MB })], { scannedAt: 1_000 });
    const next = report([wt("/wt/a")], { scannedAt: 9_000 });
    expect(settleReport(prev, next)).toBe(next);
  });

  test("the host's first scan after a start has nothing yet: what was shown stays", () => {
    const prev = report([wt("/wt/a")], { scannedAt: 1_000 });
    const nothing: CleanupReport = { scanning: true, repos: [] };
    expect(settleReport(prev, nothing)).toBeUndefined();
    expect(settleReport(undefined, nothing)).toBe(nothing);
  });

  test("a scan in progress shows earlier sizes and pull requests until its own arrive", () => {
    const prev = report(
      [
        wt("/wt/a", { size: 3 * MB, sizePartial: true, pr, prCheckedAt: 500 }),
        wt("/wt/moved-on", { size: 2 * MB, pr, prCheckedAt: 500 }),
        wt("/wt/gone", { size: MB }),
      ],
      { scannedAt: 1_000 },
    );
    const next = report([wt("/wt/a"), wt("/wt/moved-on", { head: "fff0000" }), wt("/wt/gone", { missing: true }), wt("/wt/new")], { scanning: true });
    const shown = settleReport(prev, next);
    const by = (path: string) => shown?.repos[0]?.worktrees.find((w) => w.path === path);
    expect(shown?.scannedAt).toBe(1_000);
    expect(shown?.scanning).toBe(true);
    expect(by("/wt/a")).toMatchObject({ size: 3 * MB, sizePartial: true, pr, prCheckedAt: 500 });
    expect(by("/wt/moved-on")?.size).toBe(2 * MB);
    expect(by("/wt/moved-on")?.pr).toBeUndefined();
    expect(by("/wt/gone")?.size).toBeUndefined();
    expect(by("/wt/new")).toEqual(wt("/wt/new"));
    // the host's own values win
    const measured = settleReport(prev, report([wt("/wt/a", { size: 4 * MB, prCheckedAt: 900 })], { scanning: true }));
    expect(measured?.repos[0]?.worktrees[0]).toEqual(wt("/wt/a", { size: 4 * MB, prCheckedAt: 900 }));
  });

  test("answers are kept per host and saved on the device a second later", () => {
    vi.useFakeTimers();
    try {
      expect(keepReport("studio", { scanning: true, repos: [] }, 10)).toBe(true);
      expect(keepReport("studio", report([wt("/wt/s", { size: MB })], { scannedAt: 20 }), 30)).toBe(true);
      expect(keepReport("studio", { scanning: true, repos: [] }, 40)).toBe(false);
      keepStorage("studio", { ...storage, running: { apply: false, categories: ["blobs"], startedAt: 5, errors: [] } }, 50);
      expect(keptOf("studio")?.report?.at).toBe(30);
      expect(keptOf("forge")?.report?.at).toBe(2_000);
      vi.advanceTimersByTime(1_000);
    } finally {
      vi.useRealTimers();
    }
    const saved = cleanupFromStore(mem["tf.cleanup.cache"] ?? null);
    expect(saved.get("studio")?.report?.data.repos[0]?.worktrees[0]?.size).toBe(MB);
    expect(saved.get("studio")?.storage?.data).toEqual(storage);
    expect(saved.get("forge")?.report?.at).toBe(2_000);
  });
});

describe("what the device keeps", () => {
  test("the most recently answered hosts first, as many as fit; a report with nothing in it is not kept", () => {
    const big = report(Array.from({ length: 40 }, (_, i) => wt(`/wt/${"x".repeat(40)}-${i}`, { size: i * MB })), { scannedAt: 5 });
    const one = JSON.stringify({ report: { data: big, at: 1 } }).length;
    const kept = cleanupToStore(
      [
        ["old", { report: { data: big, at: 1 } }],
        ["new", { report: { data: big, at: 3 } }],
        ["mid", { report: { data: big, at: 2 } }],
        ["starting", { report: { data: { scanning: true, repos: [] }, at: 4 } }],
      ],
      2 * one + 10,
    );
    expect(Object.keys(kept.hosts).sort()).toEqual(["mid", "new"]);
  });

  test("a copy of another format, or a damaged one, is ignored", () => {
    for (const raw of [null, "", "{", "[]", "null", JSON.stringify({ v: 2, hosts: {} }), JSON.stringify({ v: 1, hosts: null })]) {
      expect(cleanupFromStore(raw).size).toBe(0);
    }
    const mixed = JSON.stringify({ v: 1, hosts: { a: { report: { data: { repos: "no" }, at: 1 } }, b: { storage: { data: storage, at: 2 } } } });
    expect([...cleanupFromStore(mixed).keys()]).toEqual(["b"]);
  });
});
