import { apiError } from "../errors";
import type { Agent, CleanupAgent, CleanupReport, CleanupRepo, CleanupStorage, CleanupWorktree, GcCategory, GcRun, HostState, PrStatusResult, WorktreeList } from "../gen";
import type { DemoClock } from "./clock";
import { HOME, REPOS, WORKTREES, repoForPath } from "./data";

/** What the simulated Cleanup page backend (`cleanup.*`) needs from its demo host. */
export interface CleanupHostEnv {
  /** false: the host's tf-hostd predates the Cleanup page (every method answers `unknown_method`). */
  supported: boolean;
  clock: DemoClock;
  /** The board now (workspaces and agents, parked ones included). */
  state(): HostState;
  /** The host's own methods (`worktree.list`, `gh.prStatus`, `worktree.remove`). */
  call(method: string, params: Record<string, unknown>): unknown;
}

const DAY = 86_400_000;
const MB = 1024 * 1024;
const SCAN_MS = 1800;
const CHECK_MS = 2500;
const APPLY_MS = 1500;
const WAIT_MAX_MS = 20_000;

/** A pull request of a seeded worktree. */
interface SeedPr {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  closedDaysAgo?: number;
}

/** A linked worktree only this module knows (no herdr workspace, no agent on the board). */
interface Extra {
  path: string;
  branch?: string;
  head: string;
  createdDaysAgo: number;
  activeDaysAgo: number;
  bytes: number;
  pr?: SeedPr;
  dirty?: number;
  missing?: boolean;
  locked?: string;
  orphan?: boolean;
  session?: string;
  automation?: string;
}

function seedExtras(): Extra[] {
  return [
    { path: `${WORKTREES}/teleflock/ws-reconnect-v1`, branch: "feat/ws-reconnect-v1", head: "41c2aa0", createdDaysAgo: 58, activeDaysAgo: 41, bytes: 1940 * MB, session: "First try at WebSocket reconnect with jittered backoff" },
    {
      path: `${WORKTREES}/api-gateway/fix-rate-limit`,
      branch: "fix/rate-limit-burst",
      head: "c09b7e2",
      createdDaysAgo: 19,
      activeDaysAgo: 6,
      bytes: 612 * MB,
      pr: { number: 77, title: "Allow bursts above the rate limit", state: "CLOSED", closedDaysAgo: 5 },
      dirty: 3,
      session: "Rate limiter: allow short bursts",
    },
    { path: `${WORKTREES}/teleflock/try-yjs`, branch: "spike/try-yjs", head: "77ab10d", createdDaysAgo: 33, activeDaysAgo: 33, bytes: 0, missing: true },
    { path: `${WORKTREES}/marketing-site/hero-v1`, branch: "design/hero-v1", head: "e5f0019", createdDaysAgo: 96, activeDaysAgo: 71, bytes: 2380 * MB, locked: "on the external SSD", session: "First hero section draft" },
    { path: `${WORKTREES}/teleflock/bisect-flaky`, head: "0b9d3f4", createdDaysAgo: 26, activeDaysAgo: 25, bytes: 1210 * MB, orphan: true, session: "Bisect the flaky reconnect test" },
    {
      path: `${WORKTREES}/infra/automation-deps-audit-20261002-0300`,
      branch: "automation/nightly-dependency-audit-20261002-0300",
      head: "d1e2f3a",
      createdDaysAgo: 27,
      activeDaysAgo: 27,
      bytes: 228 * MB,
      pr: { number: 212, title: "Bump lockfile: 14 patched advisories", state: "MERGED", closedDaysAgo: 24 },
      automation: "Nightly dependency audit",
      session: "Nightly dependency audit",
    },
    {
      path: `${WORKTREES}/herdr-web/docs-typos`,
      branch: "docs/typos",
      head: "a7a7c01",
      createdDaysAgo: 12,
      activeDaysAgo: 9,
      bytes: 96 * MB,
      pr: { number: 31, title: "Fix typos in the getting-started guide", state: "MERGED", closedDaysAgo: 8 },
      session: "Fix docs typos",
    },
  ];
}

/** A size that stays put for a path. */
function sizeOf(path: string): number {
  let h = 2166136261;
  for (const c of path) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (80 + (h % 2300)) * MB;
}

function busy(a: Agent): boolean {
  return a.column === "running" || a.column === "needs" || a.state === "working" || a.state === "blocked";
}

interface Run {
  run: GcRun;
  endsAt: number;
  waiters: Set<() => void>;
}

/**
 * tf-hostd's Cleanup page for the demo: forge's worktrees (its workspaces' linked worktrees, the parked
 * agents' merged ones, and a few that only git still knows: stale, gone, locked, closed with changes, a
 * detached HEAD with unsaved commits, an automation's merged one), a scan that fills sizes and pull
 * requests in ~2 s, `cleanup.remove` with hostd's checks (busy, locked, unsaved commits, dirty), and an
 * `omp gc` check / apply of blobs and WAL (compression unsupported, as on Linux). studio-pc plays a host
 * whose tf-hostd predates the page.
 */
export class DemoCleanup {
  private extras = seedExtras();
  private scanEndsAt = 0;
  private scanned = false;
  private scanWaiters = new Set<() => void>();
  private blobs = { count: 23, bytes: 184 * MB };
  private wal = { history: 6 * MB, models: Math.round(0.3 * MB) };
  private gc: { running?: Run; check?: GcRun; applied?: GcRun } = {};

  constructor(private readonly env: CleanupHostEnv) {}

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `unknown method \`${method}\``);
    switch (method) {
      case "cleanup.worktrees":
        return this.worktrees(Boolean(p.refresh), typeof p.waitMs === "number" ? p.waitMs : 0);
      case "cleanup.remove":
        return this.remove(String(p.path ?? ""), Boolean(p.force), Boolean(p.trust));
      case "cleanup.storage":
        return this.storage(typeof p.waitMs === "number" ? p.waitMs : 0);
      case "cleanup.storageRun":
        return this.storageRun(Boolean(p.apply), Array.isArray(p.categories) ? p.categories.filter((c): c is GcCategory => c === "blobs" || c === "wal" || c === "compress") : []);
      default:
        throw apiError("unknown_method", `unknown method \`${method}\``);
    }
  }

  private get now(): number {
    return this.env.clock.now();
  }

  /** Resolves when `waiters` fire or after `wait` ms, whichever is first. */
  private waitFor<T>(waiters: Set<() => void>, wait: number, answer: () => T): Promise<T> {
    // Executor form: the app's TS lib (ES2023) predates `Promise.withResolvers`.
    return new Promise<T>((resolve) => {
      let cancel: () => void = () => {};
      const wake = () => {
        waiters.delete(wake);
        cancel();
        resolve(answer());
      };
      waiters.add(wake);
      cancel = this.env.clock.after(wait, wake);
    });
  }

  // ---------------------------------------------------------------- worktrees

  private worktrees(refresh: boolean, waitMs: number): CleanupReport | Promise<CleanupReport> {
    if (this.now >= this.scanEndsAt && (refresh || !this.scanned)) {
      this.scanEndsAt = this.now + SCAN_MS;
      this.env.clock.after(SCAN_MS, () => {
        this.scanned = true;
        for (const w of [...this.scanWaiters]) w();
      });
    }
    const wait = Math.min(Math.max(0, waitMs), WAIT_MAX_MS);
    if (this.now >= this.scanEndsAt || wait === 0) return this.report();
    return this.waitFor(this.scanWaiters, wait, () => this.report());
  }

  private report(): CleanupReport {
    const scanning = this.now < this.scanEndsAt;
    const state = this.env.state();
    const byRepo = new Map<string, CleanupWorktree[]>();
    const seen = new Set<string>();
    const add = (w: CleanupWorktree) => {
      const repo = repoForPath(w.path);
      if (!repo || seen.has(w.path)) return;
      seen.add(w.path);
      byRepo.set(repo.name, [...(byRepo.get(repo.name) ?? []), w]);
    };
    for (const repo of REPOS) {
      let listed: WorktreeList;
      try {
        listed = this.env.call("worktree.list", { cwd: repo.root }) as WorktreeList;
      } catch {
        continue;
      }
      for (const e of listed.worktrees.filter((x) => !x.primary)) add(this.fromBoard(e.path, e.branch, e.head, e.workspaceId, e.dirty ?? 0, state, !scanning));
    }
    for (const a of state.agents) {
      const wt = a.parked?.worktree;
      if (wt) add(this.fromBoard(wt.path, a.branch, undefined, undefined, 0, state, !scanning));
    }
    for (const x of this.extras) add(this.fromExtra(x, !scanning));
    const repos: CleanupRepo[] = [...byRepo.entries()]
      .map(([name, worktrees]) => ({ root: REPOS.find((r) => r.name === name)?.root ?? `${HOME}/code/${name}`, name, worktrees: worktrees.sort((a, b) => a.path.localeCompare(b.path)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { scannedAt: this.scanned ? this.scanEndsAt : undefined, scanning, repos };
  }

  private fromBoard(path: string, branch: string | undefined, head: string | undefined, workspaceId: string | undefined, dirty: number, state: HostState, filled: boolean): CleanupWorktree {
    const live = state.agents.filter((a) => !a.parked && workspaceId && a.workspaceId === workspaceId);
    const parked = state.agents.filter((a) => a.parked?.worktree?.path === path);
    const at = (a: Agent) => (a.parked ? a.parked.at : (a.live.lastEventAt ?? a.stateSince));
    const last = [...live, ...parked].sort((a, b) => at(b) - at(a))[0];
    const lastAgent: CleanupAgent | undefined = last && { agentId: last.id, name: last.name, title: last.title || undefined, state: last.parked ? undefined : last.state, parked: !!last.parked, at: at(last) };
    let status: PrStatusResult = {};
    try {
      // The host's own `gh.prStatus` answer for this checkout.
      status = this.env.call("gh.prStatus", { cwd: path }) as PrStatusResult;
    } catch {
      status = {};
    }
    const found = status.pr;
    const days = (sizeOf(path) / MB) % 17;
    const createdAt = this.now - (days + 3) * DAY;
    return {
      path,
      branch,
      head,
      missing: false,
      dirty,
      orphanCommits: false,
      workspaceId,
      agents: live.length,
      busy: live.some(busy),
      createdAt,
      activeAt: lastAgent ? Math.max(lastAgent.at, createdAt) : this.now - days * DAY,
      size: filled ? sizeOf(path) : undefined,
      sizePartial: false,
      pr: filled && found ? { number: found.number, url: found.url, title: found.title, state: found.state, draft: found.draft, closedAt: found.state === "OPEN" ? undefined : this.now - 2 * DAY } : undefined,
      prCheckedAt: filled ? this.now : undefined,
      lastAgent,
    };
  }

  private fromExtra(x: Extra, filled: boolean): CleanupWorktree {
    const repo = repoForPath(x.path)?.name ?? "repo";
    const pr = x.pr && {
      number: x.pr.number,
      url: `https://github.com/demo/${repo}/pull/${x.pr.number}`,
      title: x.pr.title,
      state: x.pr.state,
      draft: false,
      closedAt: x.pr.closedDaysAgo !== undefined ? this.now - x.pr.closedDaysAgo * DAY : undefined,
    };
    return {
      path: x.path,
      branch: x.branch,
      head: x.head,
      missing: !!x.missing,
      locked: x.locked,
      dirty: x.missing ? undefined : (x.dirty ?? 0),
      orphanCommits: !!x.orphan,
      agents: 0,
      busy: false,
      createdAt: this.now - x.createdDaysAgo * DAY,
      activeAt: this.now - x.activeDaysAgo * DAY,
      size: filled && !x.missing ? x.bytes : undefined,
      sizePartial: false,
      pr: filled ? pr : undefined,
      prCheckedAt: filled && x.branch ? this.now : undefined,
      lastAgent: x.session ? { title: x.session, parked: false, at: this.now - x.activeDaysAgo * DAY } : undefined,
      automation: x.automation,
    };
  }

  private remove(path: string, force: boolean, trust: boolean): unknown {
    const extra = this.extras.find((x) => x.path === path);
    if (extra) {
      if (extra.locked !== undefined)
        throw apiError("worktree_locked", `${path} is locked (${extra.locked})`, { hint: `TeleFlock never removes a locked worktree. Unlock it first if it should go: git worktree unlock ${path}` });
      if (extra.orphan && !force)
        throw apiError("orphan_commits", `its detached HEAD ${extra.head} is on no branch: removing the worktree loses that commit`, { hint: "Create a branch there to keep it (git switch -c <name>), or remove it with force to discard it." });
      if ((extra.dirty ?? 0) > 0 && !force)
        throw apiError("dirty_worktree", `'${path}' contains modified or untracked files, use --force to delete it`, { hint: "Remove it with “force” to discard them (the branch is kept)." });
      this.extras = this.extras.filter((x) => x !== extra);
      return {};
    }
    const state = this.env.state();
    const ws = state.workspaces.find((w) => w.worktree?.path === path);
    const agent = state.agents.find((a) => !a.parked && ws && a.workspaceId === ws.id && busy(a));
    if (agent) throw apiError("busy", `agent ${agent.name} is working in ${path}`, { hint: "Wait until it is done, or stop it, before removing its worktree.", retryable: true });
    return ws ? this.env.call("worktree.remove", { workspaceId: ws.id, force, trust }) : this.env.call("worktree.remove", { workspaceId: "", path, force, trust });
  }

  // ---------------------------------------------------------------- omp storage

  private storageNow(): CleanupStorage {
    return {
      agentDir: `${HOME}/.omp/agent`,
      running: this.gc.running?.run,
      check: this.gc.check,
      applied: this.gc.applied,
      sessions: this.gc.check ? { bytes: 2140 * MB, files: 1022 } : undefined,
    };
  }

  private storage(waitMs: number): CleanupStorage | Promise<CleanupStorage> {
    const r = this.gc.running;
    const wait = Math.min(Math.max(0, waitMs), WAIT_MAX_MS);
    if (!r || wait === 0) return this.storageNow();
    return this.waitFor(r.waiters, wait, () => this.storageNow());
  }

  private storageRun(apply: boolean, asked: GcCategory[]): CleanupStorage | Promise<CleanupStorage> {
    const categories = (["blobs", "compress", "wal"] as const).filter((c) => !apply || asked.includes(c));
    if (categories.length === 0) throw apiError("invalid_params", "name at least one storage category (blobs, wal, compress)");
    const r = this.gc.running;
    if (r && (r.run.apply !== apply || r.run.categories.join() !== categories.join()))
      throw apiError("busy", `TeleFlock is already ${r.run.apply ? "applying omp's storage cleanup" : "checking omp's storage"} on this host`, { retryable: true });
    if (!r) {
      const run: Run = { run: { apply, categories, startedAt: this.now, errors: [] }, endsAt: this.now + (apply ? APPLY_MS : CHECK_MS), waiters: new Set() };
      this.gc.running = run;
      this.env.clock.after(run.endsAt - this.now, () => this.finish(run));
    }
    return this.storage(WAIT_MAX_MS);
  }

  private finish(r: Run): void {
    const { apply, categories } = r.run;
    const run: GcRun = { ...r.run, finishedAt: this.now };
    if (categories.includes("blobs")) {
      run.blobs = { referenced: 412, wouldDelete: this.blobs.count, deleted: apply ? this.blobs.count : 0, bytes: this.blobs.bytes };
      if (apply) this.blobs = { count: 0, bytes: 0 };
    }
    if (categories.includes("wal")) {
      const dbs = [
        { path: `${HOME}/.omp/agent/history.db`, walBytes: apply ? 0 : this.wal.history, checkpointed: apply },
        { path: `${HOME}/.omp/agent/models.db`, walBytes: apply ? 0 : this.wal.models, checkpointed: apply },
      ];
      run.wal = { databases: dbs, walBytes: apply ? 0 : this.wal.history + this.wal.models, checkpointed: apply };
      if (apply) this.wal = { history: 0, models: 0 };
    }
    if (categories.includes("compress"))
      run.compress = { supported: false, sessions: 0, wouldCompress: 0, compressed: 0, bytes: 0, allocatedBefore: 0, allocatedAfter: 0, skippedLive: 0 };
    this.gc.running = undefined;
    if (apply) this.gc.applied = run;
    else this.gc.check = run;
    for (const w of [...r.waiters]) w();
  }
}
