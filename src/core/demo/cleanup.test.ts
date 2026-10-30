import { describe, expect, test } from "bun:test";
import { bulkSet, classify } from "@/features/cleanup/classify";
import { DemoCleanup } from "./cleanup";
import { ManualClock } from "./clock";
import type { CleanupReport, CleanupStorage, CleanupWorktree } from "../gen";
import { WORKTREES } from "./data";
import { DemoEngine } from "./engine";

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
  const scanned = () => call<CleanupReport>("forge", "cleanup.worktrees", { refresh: false, waitMs: 5000 }, 2500);
  return { clock, call, scanned };
}

const all = (r: CleanupReport): CleanupWorktree[] => r.repos.flatMap((x) => x.worktrees);
const at = (r: CleanupReport, path: string) => all(r).find((w) => w.path === path);

describe("demo cleanup", () => {
  test("a scan fills sizes and pull requests in, then answers at once", async () => {
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

  test("a parked agent's merged worktree goes by path and the card stays", async () => {
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
