import { useCallback, useEffect, useRef, useState } from "react";
import { core, toApiError, useHosts } from "@/core";
import type { ApiError, OmpSettingChange, OmpSettings } from "@/core/gen";
import { applyLocal } from "./model";
import { toast } from "@/design";

export interface OmpSettingsState {
  data?: OmpSettings;
  error?: ApiError;
  loading: boolean;
  /** Re-read (`refresh` also re-reads omp's schema on the host). */
  reload: (refresh?: boolean) => void;
  /** Writes in order; the page shows the change at once and the host's answer once all writes are in. */
  save: (changes: OmpSettingChange[]) => Promise<void>;
}

/** `omp.settings` of one host, with queued `omp.settingsSet` writes. */
export function useOmpSettings(hostId: string | undefined): OmpSettingsState {
  const online = useHosts((s) => (hostId ? s.status[hostId]?.phase === "online" : false));
  const [state, setState] = useState<{ hostId?: string; data?: OmpSettings; error?: ApiError; loading: boolean }>({ loading: false });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);
  const hostRef = useRef(hostId);
  hostRef.current = hostId;

  const load = useCallback(
    (refresh = false) => {
      if (!hostId) return;
      setState((s) => ({ hostId, data: s.hostId === hostId ? s.data : undefined, loading: true }));
      core
        .host(hostId)
        .call("omp.settings", refresh ? { refresh: true } : {})
        .then(
          (data) => hostRef.current === hostId && setState({ hostId, data, loading: false }),
          (e: unknown) => hostRef.current === hostId && setState((s) => ({ hostId, data: s.hostId === hostId ? s.data : undefined, error: toApiError(e), loading: false })),
        );
    },
    [hostId],
  );

  useEffect(() => {
    if (online) load(false);
  }, [online, load]);

  const save = useCallback(
    (changes: OmpSettingChange[]) => {
      if (!hostId || changes.length === 0) return Promise.resolve();
      setState((s) => (s.data && s.hostId === hostId ? { ...s, data: applyLocal(s.data, changes) } : s));
      pending.current += 1;
      const run = async () => {
        try {
          const data = await core.host(hostId).call("omp.settingsSet", { changes });
          if (pending.current === 1 && !failed.current && hostRef.current === hostId) setState({ hostId, data, loading: false });
        } catch (e) {
          failed.current = true;
          const err = toApiError(e);
          toast({ title: `Couldn't save ${changes.map((c) => c.key).join(", ")}`, description: [err.message, err.hint].filter(Boolean).join(" — "), status: "error" });
        } finally {
          pending.current -= 1;
          if (pending.current === 0 && failed.current) {
            failed.current = false;
            if (hostRef.current === hostId) load(false);
          }
        }
      };
      queue.current = queue.current.then(run);
      return queue.current;
    },
    [hostId, load],
  );

  const current = state.hostId === hostId;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: current ? state.loading : !!hostId, reload: load, save };
}
