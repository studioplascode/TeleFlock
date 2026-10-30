import { useCallback, useEffect, useRef, useState } from "react";
import { apiError, core, type HostClient, toApiError, useHosts } from "@/core";
import type { ApiError, McpChanged, McpList, McpServer } from "@/core/gen";
import { type ToastInput, toast } from "@/design";
import { type AnswerKind, AnswerOrder } from "./answers";
import { type ReloadChange, reloadNote, scopeOf, serverKey, shareList } from "./model";

/** Long-poll step while a check runs (hostd waits up to 25 s). */
const WAIT_MS = 20_000;
const MAX_POLL_FAILURES = 3;

export interface McpQuery {
  data?: McpList;
  error?: ApiError;
  /** A read is in flight (first load, reload, "Check again"). */
  loading: boolean;
  /** The host's tf-hostd predates MCP servers (`unknown_method`). */
  outdated: boolean;
  /** Switches whose change is still on its way (server key → requested state). */
  pendingEnabled: Readonly<Record<string, boolean>>;
  reload(): void;
  /** "Check again": hostd connects every server anew. */
  refresh(): void;
  /** Runs a change; its list replaces the shown one (unless a newer answer came first) and a toast titled `title` says what reached running sessions. */
  mutate(run: (host: HostClient) => Promise<McpChanged>, title: string, change: ReloadChange): Promise<McpChanged>;
  /** Optimistic switch: flips at once, rolls back with a toast when the host refuses. */
  setEnabled(server: McpServer, enabled: boolean): void;
  /** `mcp.reload`: reload running sessions now. */
  reloadSessions(): void;
}

interface State {
  key: string | null;
  data?: McpList;
  error?: ApiError;
  loading: boolean;
}

/**
 * One quiet toast about a change ("Removed “x”") and what it did to running sessions, then extra
 * `lines` (a note, omp's own lines) and an optional `action`; none when no session ran and there
 * is nothing more to say.
 */
export function toastReload(title: string, changed: Pick<McpChanged, "reload">, change: ReloadChange, extra: { lines?: readonly (string | undefined)[]; action?: ToastInput["action"] } = {}): void {
  const note = reloadNote(changed.reload, change);
  const errors = changed.reload.errors;
  const lines = (extra.lines ?? []).filter((l): l is string => !!l);
  if (!note && errors.length === 0 && lines.length === 0) return;
  const description = [note && note.charAt(0).toUpperCase() + note.slice(1), ...lines, ...errors].filter(Boolean).join(" · ");
  toast({ title, description, status: errors.length ? "error" : undefined, duration: errors.length ? 6000 : extra.action ? 6000 : 3500, action: extra.action });
}

/**
 * `mcp.list` of one host and folder (`cwd` absent: user level). While hostd's check runs it
 * long-polls (`waitMs`) until the check ends; the poll stops on unmount, host or folder change.
 * Answers are ordered by {@link AnswerOrder}: a slow answer never replaces a newer one, and a
 * change's answer that lost to a newer read is followed by a fresh read.
 */
export function useMcp(hostId: string | undefined, cwd: string | undefined): McpQuery {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const key = hostId ? `${hostId}\u0000${cwd ?? ""}` : null;
  const [state, setState] = useState<State>({ key: null, loading: false });
  const [request, setRequest] = useState({ n: 0, refresh: false });
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  /** Orders the answers of the current host and folder. */
  const order = useRef(new AnswerOrder());
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  /** Shows `list` unless a newer answer is shown or the page moved on; what to ask next. */
  const accept = useCallback((k: string, startedAs: number, kind: AnswerKind, list: McpList): "poll" | "read" | undefined => {
    if (keyRef.current !== k) return undefined;
    const { show, next } = order.current.answer(startedAs, kind, list.check.running);
    if (show) setState((s) => ({ key: k, data: shareList(s.key === k ? s.data : undefined, list), loading: false }));
    return next;
  }, []);

  // Read on open, on host / folder change, when the host comes online, on reload and "Check again".
  useEffect(() => {
    if (!key || !hostId || !online) return;
    let live = true;
    const startedAs = order.current.start();
    setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: undefined, loading: true }));
    core
      .host(hostId)
      .call("mcp.list", { ...(cwd ? { cwd } : {}), ...(request.refresh ? { refresh: true } : {}) })
      .then(
        (list) => {
          if (live) accept(key, startedAs, "read", list);
          if (live) setState((s) => (s.key === key && s.loading ? { ...s, loading: false } : s));
        },
        (e: unknown) => {
          if (live) setState((s) => (s.key === key ? { ...s, error: toApiError(e), loading: false } : { key, error: toApiError(e), loading: false }));
        },
      );
    return () => {
      live = false;
    };
  }, [key, hostId, cwd, online, request, accept]);

  // Long-poll while a check runs.
  const running = state.key === key && !!state.data?.check.running;
  useEffect(() => {
    if (!running || !key || !hostId || !online) return;
    let live = true;
    let failures = 0;
    let timer: number | undefined;
    const poll = () => {
      const startedAs = order.current.start();
      core
        .host(hostId)
        .call("mcp.list", { ...(cwd ? { cwd } : {}), waitMs: WAIT_MS })
        .then(
          (list) => {
            if (!live) return;
            failures = 0;
            // A dropped (older) answer says nothing about the newer state: ask again.
            if (accept(key, startedAs, "poll", list) === "poll") poll();
          },
          () => {
            if (!live) return;
            failures += 1;
            if (failures <= MAX_POLL_FAILURES) timer = window.setTimeout(poll, 1500 * failures);
          },
        );
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [running, key, hostId, cwd, online, accept]);

  const reload = useCallback(() => setRequest((r) => ({ n: r.n + 1, refresh: false })), []);
  const refresh = useCallback(() => setRequest((r) => ({ n: r.n + 1, refresh: true })), []);

  const mutate = useCallback(
    (run: (host: HostClient) => Promise<McpChanged>, title: string, change: ReloadChange): Promise<McpChanged> => {
      if (!hostId || !key) return Promise.reject(apiError("not_connected", "No host selected"));
      const startedAs = order.current.start();
      return run(core.host(hostId)).then((changed) => {
        // Lost to a read started after it: that read may predate the change on the host.
        if (accept(key, startedAs, "change", changed.list) === "read") setRequest((r) => ({ n: r.n + 1, refresh: false }));
        toastReload(title, changed, change);
        return changed;
      });
    },
    [hostId, key, accept],
  );

  const setEnabled = useCallback(
    (server: McpServer, enabled: boolean) => {
      const k = serverKey(server);
      setPendingEnabled((p) => ({ ...p, [k]: enabled }));
      const settle = () =>
        setPendingEnabled((p) => {
          const { [k]: _done, ...rest } = p;
          return rest;
        });
      mutate((h) => h.call("mcp.setEnabled", { ...(cwd ? { cwd } : {}), name: server.name, scope: scopeOf(server), enabled }), `Switched “${server.name}” ${enabled ? "on" : "off"}`, enabled ? "add" : "remove").then(settle, (e: unknown) => {
        settle();
        const err = toApiError(e);
        toast({ title: `Couldn't switch “${server.name}” ${enabled ? "on" : "off"}`, description: [err.message, err.hint].filter(Boolean).join(" — "), status: "error" });
      });
    },
    [cwd, mutate],
  );

  const reloadSessions = useCallback(() => {
    if (!hostId) return;
    core
      .host(hostId)
      .call("mcp.reload", cwd ? { cwd } : {})
      .then(
        (reload) => {
          if (reloadNote(reload, "change") || reload.errors.length) toastReload("Reloaded running sessions", { reload }, "change");
          else toast({ title: "No running omp sessions to reload", duration: 3000 });
        },
        (e: unknown) => toast({ title: "Couldn't reload running sessions", description: toApiError(e).message, status: "error" }),
      );
  }, [hostId, cwd]);

  const current = state.key === key;
  const error = current ? state.error : undefined;
  return {
    data: current ? state.data : undefined,
    error,
    loading: current ? state.loading : !!key && online,
    outdated: error?.code === "unknown_method",
    pendingEnabled,
    reload,
    refresh,
    mutate,
    setEnabled,
    reloadSessions,
  };
}
