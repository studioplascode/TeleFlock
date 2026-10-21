import { useCallback, useEffect, useRef, useState } from "react";
import { core, toApiError, useHosts } from "@/core";
import type { ApiError, HostMethods } from "@/core/gen";

export interface HostQuery<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True while a request is in flight (also during refetches; `data` keeps the last value). */
  loading: boolean;
  reload: () => void;
  /** The request failed because the host isn't online yet; it re-runs by itself once it is. */
  waiting: boolean;
}

/**
 * One host request bound to component state. Re-runs when `hostId`, `method` or the JSON of `params`
 * changes; `params: null` (or no host) skips the request. Stale responses are dropped. A request that
 * failed while the host was still connecting re-runs once the host comes online.
 */
export function useHostQuery<M extends keyof HostMethods>(
  hostId: string | undefined,
  method: M,
  params: HostMethods[M]["params"] | null,
): HostQuery<HostMethods[M]["result"]> {
  const paramsJson = hostId && params !== null ? JSON.stringify(params) : null;
  const key = paramsJson === null ? null : `${hostId}\u0000${method}\u0000${paramsJson}`;
  const [state, setState] = useState<{ key: string | null; data?: HostMethods[M]["result"]; error?: ApiError; loading: boolean; retryOnline?: boolean }>({
    key: null,
    loading: key !== null,
  });
  const [nonce, setNonce] = useState(0);
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const onlineRef = useRef(online);
  useEffect(() => {
    onlineRef.current = online;
  }, [online]);

  useEffect(() => {
    if (!key || !hostId || paramsJson === null) return;
    let live = true;
    const startedOnline = onlineRef.current;
    setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: undefined, loading: true }));
    core
      .host(hostId)
      .call(method, JSON.parse(paramsJson) as HostMethods[M]["params"])
      .then(
        (data) => live && setState({ key, data, loading: false }),
        (e: unknown) => live && setState({ key, error: toApiError(e), loading: false, retryOnline: !startedOnline }),
      );
    return () => {
      live = false;
    };
  }, [key, hostId, method, paramsJson, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = state.key === key;
  const retry = current && !!state.retryOnline && online;
  useEffect(() => {
    if (retry) reload();
  }, [retry, reload]);
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: key !== null && (!current || state.loading),
    reload,
    waiting: current && !!state.retryOnline && !online,
  };
}
