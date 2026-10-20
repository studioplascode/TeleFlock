import { useCallback, useEffect, useState } from "react";
import { core, toApiError } from "@/core";
import type { ApiError, HostMethods } from "@/core/gen";

export interface HostQuery<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True while a request is in flight (also during refetches; `data` keeps the last value). */
  loading: boolean;
  reload: () => void;
}

/**
 * One host request bound to component state. Re-runs when `hostId`, `method` or the JSON of `params`
 * changes; `params: null` (or no host) skips the request. Stale responses are dropped.
 */
export function useHostQuery<M extends keyof HostMethods>(
  hostId: string | undefined,
  method: M,
  params: HostMethods[M]["params"] | null,
): HostQuery<HostMethods[M]["result"]> {
  const paramsJson = hostId && params !== null ? JSON.stringify(params) : null;
  const key = paramsJson === null ? null : `${hostId}\u0000${method}\u0000${paramsJson}`;
  const [state, setState] = useState<{ key: string | null; data?: HostMethods[M]["result"]; error?: ApiError; loading: boolean }>({
    key: null,
    loading: key !== null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key || !hostId || paramsJson === null) return;
    let live = true;
    setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: undefined, loading: true }));
    core
      .host(hostId)
      .call(method, JSON.parse(paramsJson) as HostMethods[M]["params"])
      .then(
        (data) => live && setState({ key, data, loading: false }),
        (e: unknown) => live && setState({ key, error: toApiError(e), loading: false }),
      );
    return () => {
      live = false;
    };
  }, [key, hostId, method, paramsJson, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: key !== null && (!current || state.loading),
    reload,
  };
}
