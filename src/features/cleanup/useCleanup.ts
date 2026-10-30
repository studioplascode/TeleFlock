import { useCallback, useEffect, useState } from "react";
import { core, toApiError, useHosts } from "@/core";
import type { ApiError, CleanupReport, CleanupStorage, GcCategory } from "@/core/gen";

/** A running scan or gc is followed with requests that wait this long for it on the host. */
const FOLLOW_MS = 15_000;
/** The first ask gives a quick scan this long to finish (no half-filled flash). */
const FIRST_WAIT_MS = 1_500;
/** While the page is visible the report is asked for again this often (the host rescans after a minute). */
const POLL_MS = 120_000;

export interface CleanupQuery<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** The host's tf-hostd predates the Cleanup page (`unknown_method`). */
  outdated: boolean;
  /** The host isn't online: asked once it is. */
  waiting: boolean;
}

/**
 * `cleanup.worktrees` of one host, followed while its scan runs (each answer is the latest, partly
 * filled report), asked again every 2 min while the page is visible and after `rescan()`.
 */
export function useCleanupReport(hostId: string | undefined): CleanupQuery<CleanupReport> & { rescan(): void; reload(): void } {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const [state, setState] = useState<{ hostId?: string; data?: CleanupReport; error?: ApiError }>({});
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
          setState({ hostId, data });
          if (!data.scanning) return;
        } catch (e) {
          if (live) setState((s) => ({ hostId, data: s.hostId === hostId ? s.data : undefined, error: toApiError(e) }));
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

  const outdated = state.hostId === hostId && state.error?.code === "unknown_method";
  useEffect(() => {
    if (!hostId || outdated) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setAsk((a) => ({ n: a.n + 1, refresh: false })), POLL_MS);
    return () => clearInterval(timer);
  }, [hostId, outdated]);

  const rescan = useCallback(() => setAsk((a) => ({ n: a.n + 1, refresh: true })), []);
  const reload = useCallback(() => setAsk((a) => ({ n: a.n + 1, refresh: false })), []);
  const current = state.hostId === hostId;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    outdated,
    waiting: !!hostId && !online,
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
 * omp's storage maintenance on one host (`cleanup.storage`, `cleanup.storageRun`): the last check and
 * apply, and the run in progress, followed until it ends.
 */
export function useCleanupStorage(hostId: string | undefined): StorageQuery {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const [state, setState] = useState<{ hostId?: string; data?: CleanupStorage; error?: ApiError; starting?: boolean }>({});
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
          setState((s) => ({ hostId, data, starting: s.hostId === hostId && !!s.starting }));
          if (!data.running) return;
        } catch (e) {
          if (live) setState((s) => ({ hostId, data: s.hostId === hostId ? s.data : undefined, error: toApiError(e) }));
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
      setState((s) => ({ ...s, hostId, starting: true, error: undefined }));
      core
        .host(hostId)
        .call("cleanup.storageRun", { apply, categories })
        .then(
          (data) => {
            setState({ hostId, data, starting: false });
            if (data.running) setFollow((n) => n + 1);
          },
          (e: unknown) => setState((s) => ({ ...s, hostId, starting: false, error: toApiError(e) })),
        );
    },
    [hostId],
  );

  const current = state.hostId === hostId;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    outdated: current && state.error?.code === "unknown_method",
    waiting: !!hostId && !online,
    starting: current && !!state.starting,
    check: () => run(false, []),
    apply: (categories) => run(true, categories),
  };
}
