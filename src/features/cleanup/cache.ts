/**
 * Each host's last Cleanup answers on this device: its report (`cleanup.worktrees`) and omp's storage
 * status (`cleanup.storage`). Kept in memory across visits of the page and in localStorage
 * (`tf.cleanup.cache`) across restarts of the app, so the page shows them at once while it asks the
 * host again; the host's answers replace them (`settleReport`). A copy of another format, or one
 * that can't be read, is ignored.
 */
import { useSyncExternalStore } from "react";
import type { CleanupReport, CleanupStorage, CleanupWorktree } from "@/core/gen";

/** An answer, and when this device received it. */
export interface Kept<T> {
  data: T;
  at: number;
}

export interface HostCleanup {
  report?: Kept<CleanupReport>;
  storage?: Kept<CleanupStorage>;
}

const hosts = new Map<string, HostCleanup>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** What this device keeps of a host. */
export function keptOf(hostId: string | undefined): HostCleanup | undefined {
  return hostId ? hosts.get(hostId) : undefined;
}

/** What this device keeps of a host, kept current. */
export function useKept(hostId: string | undefined): HostCleanup | undefined {
  return useSyncExternalStore(subscribe, () => keptOf(hostId));
}

function put(hostId: string, next: HostCleanup): void {
  hosts.set(hostId, next);
  emit();
  persistSoon();
}

/** `w` with what it has not filled in yet (size, pull request) taken from `old`, the same worktree as shown before. */
function filledFrom(old: CleanupWorktree | undefined, w: CleanupWorktree): CleanupWorktree {
  if (!old) return w;
  let out = w;
  if (w.size === undefined && old.size !== undefined && !w.missing) out = { ...out, size: old.size, sizePartial: old.sizePartial };
  // hostd keys a pull request by path, branch and HEAD: one of another branch or commit is not this one's
  if (w.prCheckedAt === undefined && old.prCheckedAt !== undefined && old.branch === w.branch && old.head === w.head) {
    out = { ...out, pr: old.pr, prCheckedAt: old.prCheckedAt, prError: old.prError };
  }
  return out;
}

/**
 * What the page shows after the host's answer `next`, given what it showed (`prev`): a finished scan
 * as it is. A scan in progress with what it has not filled in yet (sizes, pull requests), and when the
 * last scan finished, taken from `prev`, as hostd itself keeps earlier values until new ones arrive
 * (also across a restart of the daemon, or for one that predates its cache). `undefined` (keep
 * `prev`) while the host has nothing yet: its first scan after a start is still at git.
 */
export function settleReport(prev: CleanupReport | undefined, next: CleanupReport): CleanupReport | undefined {
  if (!next.scanning || !prev) return next;
  if (next.scannedAt === undefined && next.repos.length === 0) return undefined;
  const old = new Map(prev.repos.flatMap((r) => r.worktrees.map((w) => [w.path, w] as const)));
  return {
    ...next,
    scannedAt: next.scannedAt ?? prev.scannedAt,
    repos: next.repos.map((r) => ({ ...r, worktrees: r.worktrees.map((w) => filledFrom(old.get(w.path), w)) })),
  };
}

/** Keeps the host's answer to `cleanup.worktrees` (`settleReport`); false when it changed nothing shown. */
export function keepReport(hostId: string, answer: CleanupReport, at = Date.now()): boolean {
  const cur = hosts.get(hostId);
  const data = settleReport(cur?.report?.data, answer);
  if (!data) return false;
  put(hostId, { ...cur, report: { data, at } });
  return true;
}

/** Keeps the host's answer to `cleanup.storage` / `cleanup.storageRun`. */
export function keepStorage(hostId: string, data: CleanupStorage, at = Date.now()): void {
  put(hostId, { ...hosts.get(hostId), storage: { data, at } });
}

// ───────────────────────────── persistence ─────────────────────────────

const STORE_KEY = "tf.cleanup.cache";
/** Characters kept in localStorage at most (it holds ~5 MB per origin, shared with drafts and settings). */
const STORE_BUDGET = 1_000_000;

interface Stored {
  v: 1;
  hosts: Record<string, HostCleanup>;
}

const newest = (h: HostCleanup) => Math.max(h.report?.at ?? 0, h.storage?.at ?? 0);

/**
 * What is kept on the device: the most recently answered hosts first, as many as fit the budget. Left
 * out: a report with nothing in it yet (a host's first scan at git), and a storage run in progress
 * (it has ended by the next start; the host says how).
 */
export function cleanupToStore(list: readonly (readonly [string, HostCleanup])[], budget = STORE_BUDGET): Stored {
  const out: Stored = { v: 1, hosts: {} };
  let used = 0;
  for (const [hostId, h] of [...list].sort((a, b) => newest(b[1]) - newest(a[1]))) {
    const report = h.report && (h.report.data.scannedAt !== undefined || h.report.data.repos.length > 0) ? h.report : undefined;
    const storage = h.storage && { ...h.storage, data: { ...h.storage.data, running: undefined } };
    if (!report && !storage) continue;
    const value: HostCleanup = { report, storage };
    const size = JSON.stringify(value).length;
    if (used + size > budget) continue;
    used += size;
    out.hosts[hostId] = value;
  }
  return out;
}

/** The hosts a stored copy holds; nothing when it is missing, of another format or damaged. */
export function cleanupFromStore(raw: string | null): Map<string, HostCleanup> {
  const out = new Map<string, HostCleanup>();
  if (!raw) return out;
  try {
    const stored = JSON.parse(raw) as Partial<Stored> | null;
    if (stored?.v !== 1 || typeof stored.hosts !== "object" || stored.hosts === null) return out;
    for (const [hostId, h] of Object.entries(stored.hosts)) {
      const report = h.report && Array.isArray(h.report.data?.repos) && typeof h.report.at === "number" ? h.report : undefined;
      const storage = h.storage && typeof h.storage.data?.agentDir === "string" && typeof h.storage.at === "number" ? h.storage : undefined;
      if (report || storage) out.set(hostId, { report, storage });
    }
  } catch {
    // damaged: the next answers replace it
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
  if (typeof globalThis.localStorage === "undefined") return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(cleanupToStore([...hosts.entries()])));
    } catch {
      // storage full or unavailable: the answers stay in memory for this run
    }
  }, 1_000);
}

function restore(): void {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return;
  }
  for (const [hostId, h] of cleanupFromStore(raw)) hosts.set(hostId, h);
}
restore();
