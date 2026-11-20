import { apiError } from "../errors";
import type {
  Agent,
  CleanupAgent,
  CleanupExpect,
  CleanupOwner,
  CleanupOwnerRef,
  CleanupReport,
  CleanupRepo,
  CleanupScanKind,
  CleanupScanStats,
  CleanupStorage,
  CleanupWorktree,
  GcCategory,
  GcRun,
  HostState,
  PrStatusResult,
  WorktreeList,
} from "../gen";
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
const MIN = 60_000;
/** How often the host scans by itself (`CleanupBackground.everyMs`), as hostd. */
const EVERY_MS = 30 * MIN;
/** A background pass: short, since nothing changed since the last scan. */
const BACKGROUND_MS = 1200;
/** The host starts with the report of a background pass that ended this long ago. */
const SEEDED_AGO = 12 * MIN;
/** A removal brings the next background pass this close (hostd: a minute or two after a change). */
const CHANGE_MS = 90_000;
/** Without `latest` (apps before 0.9.6) a report over this old starts a scan, as before. */
const OLD_RULE_MS = MIN;

/** A pull request of a seeded worktree. */
interface SeedPr {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  closedDaysAgo?: number;
}

/** A linked worktree only this module knows (no herdr workspace, no agent on the board in it). */
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
  /** The main agent it belongs to: a card's id, or a `GONE` session. */
  owner?: string;
  /** That agent's subagents that worked in it. */
  subagents?: string[];
}

/** omp sessions whose worktrees outlived their card (`CleanupOwner.state` "gone"). */
const GONE: Record<string, { title: string; cwd: string; daysAgo: number }> = {
  wsv1: { title: "First try at WebSocket reconnect with jittered backoff", cwd: `${WORKTREES}/teleflock/ws-reconnect-v1`, daysAgo: 41 },
  burst: { title: "Rate limiter: allow short bursts", cwd: `${WORKTREES}/api-gateway/fix-rate-limit`, daysAgo: 6 },
  hero1: { title: "First hero section draft", cwd: `${WORKTREES}/marketing-site/hero-v1`, daysAgo: 71 },
  sweep: { title: "Security sweep across every service", cwd: `${HOME}/code/api-gateway`, daysAgo: 9 },
  nightly: { title: "Nightly dependency audit", cwd: `${HOME}/code/infra`, daysAgo: 24 },
  typos: { title: "Fix docs typos", cwd: `${WORKTREES}/herdr-web/docs-typos`, daysAgo: 9 },
};

function seedExtras(): Extra[] {
  const sub = (repo: string, name: string, x: Omit<Extra, "path" | "head" | "bytes">): Extra => ({ path: `${WORKTREES}/${repo}/${name}`, head: name.slice(0, 4).padEnd(7, "0"), bytes: sizeOf(name), ...x });
  return [
    { path: `${WORKTREES}/teleflock/ws-reconnect-v1`, branch: "feat/ws-reconnect-v1", head: "41c2aa0", createdDaysAgo: 58, activeDaysAgo: 41, bytes: 1940 * MB, session: "First try at WebSocket reconnect with jittered backoff", owner: "wsv1" },
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
      owner: "burst",
    },
    { path: `${WORKTREES}/teleflock/try-yjs`, branch: "spike/try-yjs", head: "77ab10d", createdDaysAgo: 33, activeDaysAgo: 33, bytes: 0, missing: true },
    { path: `${WORKTREES}/marketing-site/hero-v1`, branch: "design/hero-v1", head: "e5f0019", createdDaysAgo: 96, activeDaysAgo: 71, bytes: 2380 * MB, locked: "on the external SSD", session: "First hero section draft", owner: "hero1" },
    { path: `${WORKTREES}/teleflock/bisect-flaky`, head: "0b9d3f4", createdDaysAgo: 26, activeDaysAgo: 25, bytes: 1210 * MB, orphan: true, session: "Bisect the flaky reconnect test", owner: "flaky", subagents: ["Bisect"] },
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
      owner: "nightly",
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
      owner: "typos",
    },
    // An orchestrator whose card is gone: its subagents worked in worktrees of three repositories.
    sub("api-gateway", "sweep-authz", { branch: "sweep/authz", createdDaysAgo: 10, activeDaysAgo: 9, pr: { number: 88, title: "Check authorization on every admin route", state: "MERGED", closedDaysAgo: 3 }, owner: "sweep", subagents: ["SweepAuthz"] }),
    sub("teleflock", "sweep-csp", { branch: "sweep/csp", createdDaysAgo: 18, activeDaysAgo: 16, owner: "sweep", subagents: ["SweepCsp"] }),
    sub("infra", "sweep-secrets", { branch: "sweep/secrets", createdDaysAgo: 10, activeDaysAgo: 9, dirty: 2, pr: { number: 41, title: "Move secrets to the vault", state: "CLOSED", closedDaysAgo: 2 }, owner: "sweep", subagents: ["SweepSecrets", "SweepSecrets.Verify"] }),
    // Subagent worktrees of cards on the board.
    sub("api-gateway", "invoices-pdf", { branch: "invoices/pdf-renderer", createdDaysAgo: 5, activeDaysAgo: 4, pr: { number: 93, title: "Render invoices as PDF", state: "MERGED", closedDaysAgo: 1 }, owner: "invoices", subagents: ["PdfRenderer"] }),
    sub("api-gateway", "invoices-tax", { branch: "invoices/tax-rules", createdDaysAgo: 5, activeDaysAgo: 1, pr: { number: 94, title: "Tax rules per country", state: "OPEN" }, owner: "invoices", subagents: ["TaxRules"] }),
    sub("infra", "audit-iam", { branch: "audit/iam", createdDaysAgo: 30, activeDaysAgo: 22, owner: "audit", subagents: ["IamReview"] }),
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

/** A Cleanup scan: who started it (a page that waits takes a background pass over), and when. */
interface Scan {
  kind: CleanupScanKind;
  startedAt: number;
  /** Cancels its end (a Rescan stops any other scan). */
  cancel(): void;
}

/** `CleanupRemoveParams.expect` as the app sent it. */
function expectFrom(raw: unknown): CleanupExpect | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  return {
    head: typeof e.head === "string" ? e.head : undefined,
    branch: typeof e.branch === "string" ? e.branch : undefined,
    unpushed: typeof e.unpushed === "number" ? e.unpushed : undefined,
    agents: typeof e.agents === "number" ? e.agents : 0,
    workspaceId: typeof e.workspaceId === "string" ? e.workspaceId : undefined,
  };
}

/**
 * tf-hostd's Cleanup page for the demo, as a 0.9.6 host: forge's worktrees (its workspaces' linked
 * worktrees, the parked agents' merged ones, and a few that only git still knows: stale, gone, locked,
 * closed with changes, a detached HEAD with unsaved commits, an automation's merged one). It starts with the
 * report of a background pass 12 minutes ago and keeps it fresh by itself (a short pass every 30 min, and
 * 90 s after a removal), so a page asking with `latest` is answered at once; Rescan, a report older than
 * that, or an app without `latest` and a report over a minute old run a scan that fills sizes and pull
 * requests in ~2 s. `cleanup.remove` keeps hostd's checks (busy, locked, unsaved commits, dirty, `expect`,
 * `forget`), and an `omp gc` check / apply covers blobs and WAL (compression unsupported, as on Linux).
 * studio-pc plays a host whose tf-hostd predates the page.
 */
export class DemoCleanup {
  private extras = seedExtras();
  /** The scan running now. */
  private scan?: Scan;
  /** The last scan that ended: the report's `scannedAt` and `stats`. */
  private last: { kind: CleanupScanKind; startedAt: number; at: number };
  /** When the next background pass is due. */
  private nextAt = 0;
  private cancelNext: () => void = () => {};
  private scanWaiters = new Set<() => void>();
  private blobs = { count: 23, bytes: 184 * MB };
  private wal = { history: 6 * MB, models: Math.round(0.3 * MB) };
  private gc: { running?: Run; check?: GcRun; applied?: GcRun } = {};

  constructor(private readonly env: CleanupHostEnv) {
    const at = this.now - SEEDED_AGO;
    this.last = { kind: "background", startedAt: at - BACKGROUND_MS, at };
    if (env.supported) this.plan(at + EVERY_MS - BACKGROUND_MS);
  }

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `unknown method \`${method}\``);
    switch (method) {
      case "cleanup.worktrees":
        return this.worktrees(Boolean(p.refresh), typeof p.waitMs === "number" ? p.waitMs : 0, Boolean(p.latest));
      case "cleanup.remove":
        return this.remove(String(p.path ?? ""), Boolean(p.force), Boolean(p.trust), Boolean(p.forget), expectFrom(p.expect));
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

  /** Schedules the next background pass (hostd: every `everyMs`, and soon after a change). */
  private plan(at: number): void {
    this.cancelNext();
    this.nextAt = at;
    // While a scan the page asked for runs, its end plans the next pass.
    this.cancelNext = this.env.clock.after(at - this.now, () => {
      if (!this.scan) this.start("background");
    });
  }

  /** Starts a scan; a Rescan stops the one that runs. */
  private start(kind: CleanupScanKind): void {
    this.scan?.cancel();
    const ms = kind === "background" ? BACKGROUND_MS : SCAN_MS;
    const scan: Scan = { kind, startedAt: this.now, cancel: () => {} };
    scan.cancel = this.env.clock.after(ms, () => this.end(scan));
    this.scan = scan;
  }

  private end(scan: Scan): void {
    this.scan = undefined;
    this.last = { kind: scan.kind, startedAt: scan.startedAt, at: this.now };
    // The next pass ends as this report turns `everyMs` old: a page asking with `latest` never waits for one.
    this.plan(this.now + EVERY_MS - BACKGROUND_MS);
    for (const w of [...this.scanWaiters]) w();
  }

  /** hostd scans again a minute or two after a worktree, workspace or agent changed. */
  private changed(): void {
    if (this.nextAt > this.now + CHANGE_MS) this.plan(this.now + CHANGE_MS);
  }

  private worktrees(refresh: boolean, waitMs: number, latest: boolean): CleanupReport | Promise<CleanupReport> {
    const running = this.scan;
    // `latest` (apps ≥ 0.9.6): the report is good while younger than the background interval; else a minute.
    const young = this.now - this.last.at < (latest ? EVERY_MS : OLD_RULE_MS);
    if (refresh) {
      // A Rescan stops any other scan that runs (a background pass, a page's) and runs now.
      if (running?.kind !== "refresh") this.start("refresh");
    } else if (!young) {
      if (!running) this.start("page");
      // A page that waits takes a background pass over: it goes on at normal priority.
      else if (running.kind === "background") running.kind = "page";
    }
    const scan = this.scan;
    const wait = Math.min(Math.max(0, waitMs), WAIT_MAX_MS);
    // Nobody waits for a background pass (apps ≥ 0.9.6 don't follow it); a scan the page asked for is waited
    // for, and older apps wait for any scan.
    if (!scan || wait === 0 || (latest && scan.kind === "background")) return this.report();
    return this.waitFor(this.scanWaiters, wait, () => this.report());
  }

  private report(): CleanupReport {
    const scan = this.scan;
    // A page's or a Rescan's scan fills sizes and pull requests in as it ends; a background pass keeps them.
    const filled = !scan || scan.kind === "background";
    const state = this.env.state();
    const byRepo = new Map<string, CleanupWorktree[]>();
    const seen = new Set<string>();
    const owners = new Map<string, CleanupOwner>();
    const add = (w: CleanupWorktree) => {
      const repo = repoForPath(w.path);
      if (!repo || seen.has(w.path)) return;
      seen.add(w.path);
      byRepo.set(repo.name, [...(byRepo.get(repo.name) ?? []), w]);
    };
    // hostd's `CleanupOwner`: a card on the board, else a session that outlived its card.
    const own = (id: string | undefined, subagents: string[] = []): CleanupOwnerRef | undefined => {
      const card = state.agents.find((a) => a.id === id);
      const gone = id ? GONE[id] : undefined;
      if (card) {
        const key = card.omp?.sessionFile ?? `agent:${card.id}`;
        const lifecycle = card.parked ? (card.parked.ended ? "ended" : "parked") : "live";
        owners.set(key, { key, state: lifecycle, agentId: card.id, name: card.name, title: card.title || undefined, herdr: card.parked ? undefined : card.state, sessionId: card.omp?.sessionId, cwd: card.cwd, at: card.live.lastEventAt ?? card.stateSince });
        return { key, subagents };
      }
      if (!gone || !id) return undefined;
      const key = `${HOME}/.omp/agent/sessions/gone-${id}.jsonl`;
      owners.set(key, { key, state: "gone", title: gone.title, sessionId: `gone-${id}`, cwd: gone.cwd, at: this.now - gone.daysAgo * DAY });
      return { key, subagents };
    };
    for (const repo of REPOS) {
      let listed: WorktreeList;
      try {
        listed = this.env.call("worktree.list", { cwd: repo.root }) as WorktreeList;
      } catch {
        continue;
      }
      for (const e of listed.worktrees.filter((x) => !x.primary)) add(this.fromBoard(e.path, e.branch, e.head, e.workspaceId, e.dirty ?? 0, state, filled, own));
    }
    for (const a of state.agents) {
      const wt = a.parked?.worktree;
      if (wt) add(this.fromBoard(wt.path, a.branch, undefined, undefined, 0, state, filled, own));
    }
    for (const x of this.extras) add({ ...this.fromExtra(x, filled), owner: own(x.owner, x.subagents) });
    const repos: CleanupRepo[] = [...byRepo.entries()]
      .map(([name, worktrees]) => ({ root: REPOS.find((r) => r.name === name)?.root ?? `${HOME}/code/${name}`, name, worktrees: worktrees.sort((a, b) => a.path.localeCompare(b.path)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      scannedAt: this.last.at,
      scanning: scan !== undefined,
      repos,
      owners: [...owners.values()],
      background: { everyMs: EVERY_MS, running: scan?.kind === "background", nextAt: scan ? undefined : this.nextAt },
      stats: this.stats(repos),
    };
  }

  /**
   * What the last scan looked at (`CleanupScanStats`): a background pass found nothing changed, so it only
   * looked at file times; a page's scan ran git and checked the trees' folders; a Rescan walked them and asked
   * gh again.
   */
  private stats(repos: CleanupRepo[]): CleanupScanStats {
    const { kind, startedAt, at } = this.last;
    const list = repos.flatMap((r) => r.worktrees);
    const n = list.length;
    const present = list.filter((w) => !w.missing).length;
    const branches = list.filter((w) => w.branch !== undefined).length;
    const common = { kind, at, ms: at - startedAt, low: kind === "background", cancelled: false, repos: repos.length, worktrees: n, sizesDeferred: 0, dirStats: 4 * n + repos.length };
    if (kind === "background")
      return { ...common, reposListed: 0, statuses: 0, statusesKept: n, gitCalls: 0, sizeWalks: 0, sizeChecks: 0, sizesKept: present, dirReads: 0, dirEntries: 0, prLookups: 0, prsKept: branches, sessionFiles: 0, sessionBytes: 0 };
    const refresh = kind === "refresh";
    return {
      ...common,
      reposListed: repos.length,
      statuses: present,
      statusesKept: n - present,
      gitCalls: repos.length + 2 * present,
      sizeWalks: refresh ? present : 0,
      sizeChecks: refresh ? 0 : present,
      sizesKept: refresh ? 0 : present,
      dirReads: (refresh ? 3100 : 40) * present,
      dirEntries: (refresh ? 52_000 : 640) * present,
      prLookups: refresh ? branches : 0,
      prsKept: refresh ? 0 : branches,
      sessionFiles: refresh ? 12 : 1,
      sessionBytes: refresh ? 2_400_000 : 36_000,
    };
  }

  private fromBoard(
    path: string,
    branch: string | undefined,
    head: string | undefined,
    workspaceId: string | undefined,
    dirty: number,
    state: HostState,
    filled: boolean,
    own: (id: string | undefined) => CleanupOwnerRef | undefined,
  ): CleanupWorktree {
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
      activeBy: lastAgent ? "agent" : "git",
      size: filled ? sizeOf(path) : undefined,
      sizePartial: false,
      pr: filled && found ? { number: found.number, url: found.url, title: found.title, state: found.state, draft: found.draft, closedAt: found.state === "OPEN" ? undefined : this.now - 2 * DAY } : undefined,
      prCheckedAt: filled ? this.now : undefined,
      lastAgent,
      owner: own(last?.id),
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
      activeBy: x.subagents || x.session ? "agent" : "git",
      size: filled && !x.missing ? x.bytes : undefined,
      sizePartial: false,
      pr: filled ? pr : undefined,
      prCheckedAt: filled && x.branch ? this.now : undefined,
      lastAgent: x.session ? { title: x.session, parked: false, at: this.now - x.activeDaysAgo * DAY } : undefined,
      automation: x.automation,
    };
  }

  /**
   * hostd's `expect` check right before a removal: the worktree is still what the page showed (its row as
   * this host reports it now). One that is not listed is left to the removal's own checks.
   */
  private recheck(path: string, expect: CleanupExpect): void {
    const w = this.report().repos.flatMap((r) => r.worktrees).find((x) => x.path === path);
    if (!w) return;
    const changed: string[] = [];
    if ((w.branch ?? null) !== (expect.branch ?? null)) changed.push(`it is on ${w.branch ?? "a detached HEAD"} now, not ${expect.branch ?? "a detached HEAD"}`);
    else if ((w.head ?? null) !== (expect.head ?? null)) changed.push(`its HEAD moved from ${expect.head ?? "none"} to ${w.head ?? "none"}`);
    if ((w.unpushed ?? 0) > (expect.unpushed ?? 0)) changed.push(`it has ${w.unpushed} unpushed commits now (${expect.unpushed ?? 0} before)`);
    if (w.agents > expect.agents) changed.push("an agent has a pane in it now");
    if (w.workspaceId !== undefined && w.workspaceId !== expect.workspaceId) changed.push("a herdr workspace shows it now");
    if (changed.length > 0) throw apiError("worktree_changed", changed.join("; "), { hint: "Look at it again before removing it." });
  }

  private remove(path: string, force: boolean, trust: boolean, forget: boolean, expect: CleanupExpect | undefined): unknown {
    if (expect) this.recheck(path, expect);
    const extra = this.extras.find((x) => x.path === path);
    // Forget only drops git's record of a folder that is gone, never a checkout.
    if (forget && !extra?.missing)
      throw apiError("not_missing", `${path} is there: Forget only drops git's record of a worktree whose folder is gone`, {
        hint: "Something is at that path again (a disk mounted again, a restored folder, an empty mount point): delete it as a worktree instead.",
      });
    if (extra) {
      if (extra.locked !== undefined)
        throw apiError("worktree_locked", `${path} is locked (${extra.locked})`, { hint: `TeleFlock never removes a locked worktree. Unlock it first if it should go: git worktree unlock ${path}` });
      if (extra.orphan && !force)
        throw apiError("orphan_commits", `its detached HEAD ${extra.head} is on no branch: removing the worktree loses that commit`, { hint: "Create a branch there to keep it (git switch -c <name>), or remove it with force to discard it." });
      if ((extra.dirty ?? 0) > 0 && !force)
        throw apiError("dirty_worktree", `'${path}' contains modified or untracked files, use --force to delete it`, { hint: "Remove it with “force” to discard them (the branch is kept)." });
      this.extras = this.extras.filter((x) => x !== extra);
      this.changed();
      return {};
    }
    const state = this.env.state();
    const ws = state.workspaces.find((w) => w.worktree?.path === path);
    const agent = state.agents.find((a) => !a.parked && ws && a.workspaceId === ws.id && busy(a));
    if (agent) throw apiError("busy", `agent ${agent.name} is working in ${path}`, { hint: "Wait until it is done, or stop it, before removing its worktree.", retryable: true });
    const out = ws ? this.env.call("worktree.remove", { workspaceId: ws.id, force, trust }) : this.env.call("worktree.remove", { workspaceId: "", path, force, trust });
    this.changed();
    return out;
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
