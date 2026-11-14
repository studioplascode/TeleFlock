import { useCallback, useEffect, useState } from "react";
import { core, toApiError, useHosts } from "@/core";
import type { ApiError, CleanupReport, CleanupStorage, GcCategory } from "@/core/gen";
import { keepReport, keepStorage, useKept } from "./cache";

/** A running scan or gc is followed with requests that wait this long for it on the host. */
const FOLLOW_MS = 15_000;
/** The first ask gives a quick scan this long to finish (no half-filled flash). */
const FIRST_WAIT_MS = 1_500;
/** While the page is visible the report is asked for again this often (the host rescans after a minute). */
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

/**
 * `cleanup.worktrees` of one host: the last report this device has at once, then the host's, followed
 * while its scan runs (each answer is the latest, partly filled report), asked again every 2 min while
 * the page is visible and after `rescan()`.
 */
export function useCleanupReport(hostId: string | undefined): CleanupQuery<CleanupReport> & { rescan(): void; reload(): void } {
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
          const data = await core.host(hostId).call("cleanup.worktrees", { refresh, waitMs });
          if (!live) return;
          // An answer with nothing in it yet (the host just started) leaves the report shown, still updating.
          const shown = keepReport(hostId, data);
          setVisit({ hostId, answered: shown });
          if (!data.scanning) return;
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
  const fresh = current && !!visit.answered;
  return {
    data: kept?.data,
    receivedAt: kept?.at,
    error,
    outdated,
    waiting: !!hostId && !online,
    fresh,
    updating: !!kept && online && !fresh && !error,
    rescan,
    reload,
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
