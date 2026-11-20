import { useCallback, useEffect, useState } from "react";
import { core, toApiError, useHosts } from "@/core";
import type { ApiError, CleanupReport, CleanupStorage, CleanupWorktree, GcCategory } from "@/core/gen";
import { followsScan, revalidates } from "./background";
import { keepReport, keepStorage, keptOf, useKept } from "./cache";

/** A running scan or gc is followed with requests that wait this long for it on the host. */
const FOLLOW_MS = 15_000;
/** The first ask gives a quick scan this long to finish (no half-filled flash); a fresh report is answered at once. */
const FIRST_WAIT_MS = 1_500;
/**
 * While the page is visible the report is asked for again this often: hosts ≥ 0.9.6 answer from the report
 * they keep fresh by themselves (their background scan's result arrives this way), older ones rescan when
 * theirs is over a minute old.
 */
const POLL_MS = 120_000;

export interface CleanupQuery<T> {
  /** The host's last answer this device has (`cache.ts`), also from an earlier visit or run of the app. */
  data: T | undefined;
  /** When this device received `data`. */
  receivedAt: number | undefined;
  error: ApiError | undefined;
  /** The host's tf-hostd predates the Cleanup page (`unknown_method`). */
  outdated: boolean;
  /** The host isn't online: asked once it is. */
  waiting: boolean;
  /**
   * `data` is the host's answer in this visit. Before that it is this device's copy from before the
   * visit (or the host's first scan after a start has nothing newer yet): nothing acts on it.
   */
  fresh: boolean;
  /** The host is online and asked, `data` is not fresh yet, and the ask did not fail. */
  updating: boolean;
}

export interface CleanupReportQuery extends CleanupQuery<CleanupReport> {
  /**
   * The host keeps its report fresh by itself and checks each worktree again right before removing it
   * (`CleanupReport.background`, tf-hostd ≥ 0.9.6), as its answer in this visit says: removals send `expect`
   * (and `forget` for a folder that is gone), and its bulk actions don't wait for a scan.
   */
  revalidates: boolean;
  /** Asks for everything again now (Rescan, `refresh`). */
  rescan(): void;
  /** Asks for the host's report again. */
  reload(): void;
  /**
   * The host's current row of one worktree (hostd refreshes the row in its report when it refuses a
   * removal because the worktree changed), kept as the page's report; undefined when it is not listed
   * any more. Rejects when the host can't be asked.
   */
  reloadRow(path: string): Promise<CleanupWorktree | undefined>;
}

/**
 * `cleanup.worktrees` of one host: the last report this device has at once, then the host's. Every ask
 * sends `latest`: a host ≥ 0.9.6 rescans by itself (every 30 min and soon after worktrees, workspaces or
 * agents change) and answers from that report at once, starting a scan only when it is older than that or
 * on `rescan()`; older hosts ignore it and rescan when their report is over a minute old. A scan the page
 * asked for (on older hosts: any) is followed while it runs (`followsScan`; each answer is the latest,
 * partly filled report); the host's own background scan is not. Asked again every 2 min while the page is
 * visible, and after `rescan()` / `reload()`.
 */
export function useCleanupReport(hostId: string | undefined): CleanupReportQuery {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const kept = useKept(hostId)?.report;
  // What this visit heard from the host: a report it shows, or why not.
  const [visit, setVisit] = useState<{ hostId?: string; answered?: boolean; error?: ApiError }>({});
  const [ask, setAsk] = useState({ n: 0, refresh: false });

  useEffect(() => {
    if (!hostId || !online) return;
    let live = true;
    void (async () => {
      let refresh = ask.refresh;
      let waitMs = FIRST_WAIT_MS;
      for (;;) {
        try {
          const data = await core.host(hostId).call("cleanup.worktrees", { refresh, waitMs, latest: true });
          if (!live) return;
          // An answer with nothing in it yet (the host just started) leaves the report shown, still updating.
          const shown = keepReport(hostId, data);
          setVisit({ hostId, answered: shown });
          // The host's own background scan is not followed: the next ask (every 2 min) picks its result up.
          if (!followsScan(data)) return;
        } catch (e) {
          if (live) setVisit((v) => ({ hostId, answered: v.hostId === hostId && !!v.answered, error: toApiError(e) }));
          return;
        }
        refresh = false;
        waitMs = FOLLOW_MS;
      }
    })();
    return () => {
      live = false;
    };
  }, [hostId, online, ask]);

  const current = visit.hostId === hostId;
  const error = current ? visit.error : undefined;
  const outdated = error?.code === "unknown_method";
  useEffect(() => {
    if (!hostId || outdated) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setAsk((a) => ({ n: a.n + 1, refresh: false })), POLL_MS);
    return () => clearInterval(timer);
  }, [hostId, outdated]);

  const rescan = useCallback(() => setAsk((a) => ({ n: a.n + 1, refresh: true })), []);
  const reload = useCallback(() => setAsk((a) => ({ n: a.n + 1, refresh: false })), []);
  const reloadRow = useCallback(
    async (path: string): Promise<CleanupWorktree | undefined> => {
      if (!hostId) return undefined;
      const data = await core.host(hostId).call("cleanup.worktrees", { refresh: false, waitMs: 0, latest: true });
      keepReport(hostId, data);
      return keptOf(hostId)?.report?.data.repos.flatMap((r) => r.worktrees).find((w) => w.path === path);
    },
    [hostId],
  );
  const fresh = current && !!visit.answered;
  return {
    data: kept?.data,
    receivedAt: kept?.at,
    error,
    outdated,
    waiting: !!hostId && !online,
    fresh,
    updating: !!kept && online && !fresh && !error,
    revalidates: fresh && revalidates(kept?.data),
    rescan,
    reload,
    reloadRow,
  };
}

export interface StorageQuery extends CleanupQuery<CleanupStorage> {
  /** A check or apply this page asked for is being sent. */
  starting: boolean;
  check(): void;
  apply(categories: GcCategory[]): void;
}

/**
 * omp's storage maintenance on one host (`cleanup.storage`, `cleanup.storageRun`): the last status this
 * device has at once, then the host's last check and apply, and the run in progress, followed until it
 * ends.
 */
export function useCleanupStorage(hostId: string | undefined): StorageQuery {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const kept = useKept(hostId)?.storage;
  const [state, setState] = useState<{ hostId?: string; answered?: boolean; error?: ApiError; starting?: boolean }>({});
  const [follow, setFollow] = useState(0);

  useEffect(() => {
    if (!hostId || !online) return;
    let live = true;
    void (async () => {
      let waitMs = 0;
      for (;;) {
        try {
          const data = await core.host(hostId).call("cleanup.storage", { waitMs });
          if (!live) return;
          keepStorage(hostId, data);
          setState((s) => ({ hostId, answered: true, starting: s.hostId === hostId && !!s.starting }));
          if (!data.running) return;
        } catch (e) {
          if (live) setState((s) => ({ hostId, answered: s.hostId === hostId && !!s.answered, error: toApiError(e) }));
          return;
        }
        waitMs = FOLLOW_MS;
      }
    })();
    return () => {
      live = false;
    };
  }, [hostId, online, follow]);

  const run = useCallback(
    (apply: boolean, categories: GcCategory[]) => {
      if (!hostId) return;
      setState((s) => ({ hostId, answered: s.hostId === hostId && !!s.answered, starting: true }));
      core
        .host(hostId)
        .call("cleanup.storageRun", { apply, categories })
        .then(
          (data) => {
            keepStorage(hostId, data);
            setState({ hostId, answered: true, starting: false });
            if (data.running) setFollow((n) => n + 1);
          },
          (e: unknown) => setState((s) => ({ ...s, hostId, starting: false, error: toApiError(e) })),
        );
    },
    [hostId],
  );

  const current = state.hostId === hostId;
  const error = current ? state.error : undefined;
  const fresh = current && !!state.answered;
  return {
    data: kept?.data,
    receivedAt: kept?.at,
    error,
    outdated: error?.code === "unknown_method",
    waiting: !!hostId && !online,
    fresh,
    updating: !!kept && online && !fresh && !error,
    starting: current && !!state.starting,
    check: () => run(false, []),
    apply: (categories) => run(true, categories),
  };
}
