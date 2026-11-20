import { describe, expect, test } from "bun:test";
import { expectOf } from "@/features/cleanup/background";
import { bulkSet, classify } from "@/features/cleanup/classify";
import { DemoCleanup } from "./cleanup";
import { ManualClock } from "./clock";
import type { CleanupReport, CleanupStorage, CleanupWorktree } from "../gen";
import { WORKTREES } from "./data";
import { DemoEngine } from "./engine";

const MIN = 60_000;

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(5000);
  /** A call that is given `ms` of demo time to answer. */
  const call = async <T,>(hostId: string, method: string, params: unknown = {}, ms = 400): Promise<T> => {
    const p = engine.callHost(hostId, method, params);
    clock.advance(ms);
    return (await p) as T;
  };
  // Without `latest` (apps before 0.9.6) the seeded report, 12 minutes old, starts a scan.
  const scanned = () => call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 5000 }, 2500);
  return { clock, call, scanned };
}

const all = (r: CleanupReport): CleanupWorktree[] => r.repos.flatMap((x) => x.worktrees);
const at = (r: CleanupReport, path: string) => all(r).find((w) => w.path === path);

describe("demo cleanup", () => {
  test("without `latest` a report over a minute old starts a scan that fills sizes and pull requests in, then answers at once", async () => {
    const r = rig();
    const first = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0 });
    expect(first.scanning).toBe(true);
    expect(all(first).every((w) => w.size === undefined && w.pr === undefined)).toBe(true);
    const done = await r.scanned();
    expect(done.scanning).toBe(false);
    expect(typeof done.scannedAt).toBe("number");
    expect(all(done).some((w) => w.size !== undefined)).toBe(true);
    // gobump: a parked agent's worktree whose pull request is merged
    const gobump = all(done).find((w) => w.lastAgent?.name === "gobump");
    expect(gobump?.pr?.state).toBe("MERGED");
    expect(gobump?.lastAgent?.parked).toBe(true);
  });

  test("a 0.9.6 host answers `latest` at once from the report of its background pass 12 minutes ago: no scan starts", async () => {
    const r = rig();
    const t0 = r.clock.now();
    const report = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 5000, latest: true });
    expect(report.scanning).toBe(false);
    expect(report.scannedAt).toBe(t0 - 12 * MIN);
    expect(report.background).toEqual({ everyMs: 30 * MIN, running: false, nextAt: t0 + 18 * MIN - 1200 });
    expect(report.stats).toMatchObject({ kind: "background", at: t0 - 12 * MIN, low: true, cancelled: false, statuses: 0, sizeWalks: 0, dirReads: 0, prLookups: 0, sessionBytes: 0 });
    expect(report.stats?.statusesKept).toBe(all(report).length);
    // Sizes and pull requests are filled in already.
    expect(all(report).filter((w) => !w.missing).every((w) => w.size !== undefined)).toBe(true);
    expect(all(report).find((w) => w.lastAgent?.name === "gobump")?.pr?.state).toBe("MERGED");
    const again = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
    expect(again).toMatchObject({ scanning: false, scannedAt: t0 - 12 * MIN });
    // Rescan runs a scan the page follows (`background.running` false).
    const rescan = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: true, waitMs: 0, latest: true });
    expect(rescan).toMatchObject({ scanning: true, background: { running: false } });
    const done = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 5000, latest: true }, 2500);
    expect(done.scanning).toBe(false);
    expect(done.stats).toMatchObject({ kind: "refresh", low: false });
    expect(done.scannedAt).toBeGreaterThan(t0);
  });

  test("a background pass every 30 minutes: not followed, sizes kept while it runs, then the report's time", () => {
    const clock = new ManualClock();
    const host = new DemoCleanup({ supported: true, clock, state: () => ({ agents: [], workspaces: [] }) as never, call: (m: string) => (m === "worktree.list" ? { worktrees: [] } : {}) });
    const ask = () => host.call("cleanup.worktrees", { refresh: false, waitMs: 5000, latest: true }) as CleanupReport;
    const t0 = clock.now();
    expect(ask().background?.nextAt).toBe(t0 + 18 * MIN - 1200);
    clock.advance(18 * MIN - 600);
    const during = ask();
    expect(during).toMatchObject({ scanning: true, scannedAt: t0 - 12 * MIN, background: { everyMs: 30 * MIN, running: true } });
    expect(during.background?.nextAt).toBeUndefined();
    expect(all(during).filter((w) => !w.missing).every((w) => w.size !== undefined)).toBe(true);
    clock.advance(1000);
    const after = ask();
    expect(after).toMatchObject({ scanning: false, scannedAt: t0 + 18 * MIN, background: { running: false, nextAt: t0 + 48 * MIN - 1200 } });
    expect(after.stats).toMatchObject({ kind: "background", low: true, ms: 1200 });
  });

  test("forget drops only git's record of a folder that is gone; one that is there is refused (not_missing)", async () => {
    const r = rig();
    const report = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
    const present = `${WORKTREES}/teleflock/ws-reconnect-v1`;
    const gone = `${WORKTREES}/teleflock/try-yjs`;
    expect(at(report, gone)?.missing).toBe(true);
    await expect(r.call("forge", "cleanup.remove", { path: present, force: false, trust: false, forget: true })).rejects.toMatchObject({ code: "not_missing" });
    await r.call("forge", "cleanup.remove", { path: gone, force: false, trust: false, forget: true, expect: expectOf(at(report, gone) as CleanupWorktree) });
    const after = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
    expect(at(after, gone)).toBeUndefined();
    expect(at(after, present)).toBeDefined();
  });

  test("a removal confirmed on facts that changed since is refused (worktree_changed); the current ones pass", async () => {
    const r = rig();
    const report = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
    const w = at(report, `${WORKTREES}/teleflock/ws-reconnect-v1`) as CleanupWorktree;
    const shown = expectOf(w);
    await expect(r.call("forge", "cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: { ...shown, head: "0000000" } })).rejects.toMatchObject({
      code: "worktree_changed",
      message: expect.stringContaining("HEAD moved"),
    });
    await expect(r.call("forge", "cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: { ...shown, branch: "feat/other" } })).rejects.toMatchObject({ code: "worktree_changed" });
    // A herdr workspace shows this one now: the page saw none.
    const open = all(report).find((x) => x.workspaceId !== undefined) as CleanupWorktree;
    await expect(r.call("forge", "cleanup.remove", { path: open.path, force: false, trust: false, forget: false, expect: { ...expectOf(open), workspaceId: undefined } })).rejects.toMatchObject({
      code: "worktree_changed",
    });
    expect(at(await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true }), w.path)).toBeDefined();
    await r.call("forge", "cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: shown });
    expect(at(await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0, latest: true }), w.path)).toBeUndefined();
  });

  test("every kind and safety hold shows up", async () => {
    const r = rig();
    const report = await r.scanned();
    const now = r.clock.now();
    const kinds = new Set(all(report).map((w) => classify(w, now, 14).kind));
    for (const k of ["merged", "closed", "stale", "missing", "active"]) expect(kinds.has(k as never)).toBe(true);
    const holds = new Set(all(report).map((w) => classify(w, now, 14).hold));
    for (const h of ["dirty", "locked", "orphan"]) expect(holds.has(h as never)).toBe(true);
    const shipped = bulkSet(report, "shipped", now, 14);
    expect(shipped.items.length).toBeGreaterThan(0);
    expect(shipped.held.map((h) => h.hold)).toContain("dirty");
  });

  test("cleanup.remove keeps hostd's checks: locked never, unsaved commits and changes need force", async () => {
    const r = rig();
    await r.scanned();
    const locked = `${WORKTREES}/marketing-site/hero-v1`;
    await expect(r.call("forge", "cleanup.remove", { path: locked, force: true, trust: false })).rejects.toMatchObject({ code: "worktree_locked" });
    const orphan = `${WORKTREES}/teleflock/bisect-flaky`;
    await expect(r.call("forge", "cleanup.remove", { path: orphan, force: false, trust: false })).rejects.toMatchObject({ code: "orphan_commits" });
    await r.call("forge", "cleanup.remove", { path: orphan, force: true, trust: false });
    const dirty = `${WORKTREES}/api-gateway/fix-rate-limit`;
    await expect(r.call("forge", "cleanup.remove", { path: dirty, force: false, trust: false })).rejects.toMatchObject({ code: "dirty_worktree" });
    const stale = `${WORKTREES}/teleflock/ws-reconnect-v1`;
    await r.call("forge", "cleanup.remove", { path: stale, force: false, trust: false });
    const after = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 0 });
    expect(at(after, stale)).toBeUndefined();
    expect(at(after, orphan)).toBeUndefined();
    expect(at(after, locked)).toBeDefined();
  });

  test("a parked agent's merged worktree goes by path and its card with it", async () => {
    const r = rig();
    const report = await r.scanned();
    const gobump = all(report).find((w) => w.lastAgent?.name === "gobump") as CleanupWorktree;
    await r.call("forge", "cleanup.remove", { path: gobump.path, force: false, trust: false });
    const again = await r.call<CleanupReport>("forge", "cleanup.worktrees", { refresh: true, waitMs: 5000 }, 2500);
    expect(at(again, gobump.path)).toBeUndefined();
  });

  test("omp storage: a dry run of blobs, WAL and compression; apply only what was picked; sessions never", async () => {
    const r = rig();
    const idle = await r.call<CleanupStorage>("forge", "cleanup.storage", { waitMs: 0 });
    expect(idle.check).toBeUndefined();
    await expect(r.call("forge", "cleanup.storageRun", { apply: true, categories: [] })).rejects.toMatchObject({ code: "invalid_params" });
    const checked = await r.call<CleanupStorage>("forge", "cleanup.storageRun", { apply: false, categories: [] }, 3000);
    expect(checked.running).toBeUndefined();
    expect(checked.check?.categories).toEqual(["blobs", "compress", "wal"]);
    expect(checked.check?.blobs?.wouldDelete).toBeGreaterThan(0);
    expect(checked.check?.compress?.supported).toBe(false);
    expect(checked.sessions?.bytes).toBeGreaterThan(0);
    const applied = await r.call<CleanupStorage>("forge", "cleanup.storageRun", { apply: true, categories: ["blobs"] }, 2000);
    expect(applied.applied).toMatchObject({ apply: true, categories: ["blobs"] });
    expect(applied.applied?.blobs?.deleted).toBe(checked.check?.blobs?.wouldDelete);
    expect(applied.applied?.wal).toBeUndefined();
    const recheck = await r.call<CleanupStorage>("forge", "cleanup.storageRun", { apply: false, categories: [] }, 3000);
    expect(recheck.check?.blobs?.wouldDelete).toBe(0);
    expect(recheck.check?.wal?.walBytes).toBeGreaterThan(0);
  });

  test("worktrees name their main agent: cards, sessions without one, and subagents' worktrees", async () => {
    const r = rig();
    const report = await r.scanned();
    const owners = new Map((report.owners ?? []).map((o) => [o.key, o]));
    const ownerOf = (path: string) => owners.get(at(report, path)?.owner?.key ?? "");
    const sweep = all(report).filter((w) => ownerOf(w.path)?.title === "Security sweep across every service");
    expect(new Set(sweep.map((w) => w.path.split("/").at(-2))).size).toBe(3);
    expect(ownerOf(sweep[0]?.path ?? "")?.state).toBe("gone");
    expect(sweep.flatMap((w) => w.owner?.subagents ?? [])).toContain("SweepSecrets.Verify");
    expect(ownerOf(`${WORKTREES}/api-gateway/invoices-pdf`)?.agentId).toBe("invoices");
    expect(ownerOf(`${WORKTREES}/teleflock/try-yjs`)).toBeUndefined();
  });

  test("studio-pc's tf-hostd predates the page; its disk is nearly full", () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    let health: { diskFree: number; diskTotal: number } | undefined;
    engine.subscribe((e) => {
      if (e.type === "hostSnapshot" && e.hostId === "studio-pc") health = e.state.health;
    });
    clock.advance(5000);
    expect(health && health.diskFree / health.diskTotal).toBeLessThan(0.05);
    const old = new DemoCleanup({ supported: false, clock, state: () => ({}) as never, call: () => ({}) });
    expect(() => old.call("cleanup.worktrees", {})).toThrow();
  });
});
