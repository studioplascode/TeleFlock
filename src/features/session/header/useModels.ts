import { useEffect, useState } from "react";
import { core } from "@/core";
import type { ModelCatalog } from "@/core/gen";
import { errorText } from "../api";

const cache = new Map<string, { at: number; p: Promise<ModelCatalog> }>();
const TTL_MS = 5 * 60_000;

function fetchModels(hostId: string): Promise<ModelCatalog> {
  const hit = cache.get(hostId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = core.host(hostId).call("host.models", {});
  cache.set(hostId, { at: Date.now(), p });
  p.catch(() => cache.delete(hostId));
  return p;
}

export interface ModelsState {
  catalog: ModelCatalog | null;
  error: string | null;
  loading: boolean;
}

/** Host model catalog (`host.models`), cached per host for five minutes. Loads when `enabled`. */
export function useModels(hostId: string, enabled = true): ModelsState {
  const [state, setState] = useState<ModelsState>({ catalog: null, error: null, loading: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fetchModels(hostId).then(
      (catalog) => alive && setState({ catalog, error: null, loading: false }),
      (e: unknown) => alive && setState({ catalog: null, error: errorText(e).title, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [hostId, enabled]);
  return state;
}
