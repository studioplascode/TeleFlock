import { useEffect, useState } from "react";
import { core } from "@/core";
import type { ModelCatalog, RoleBinding } from "@/core/gen";
import { errorText } from "../api";

const cache = new Map<string, { at: number; p: Promise<ModelCatalog> }>();
const TTL_MS = 5 * 60_000;

/** The host's model catalog (`host.models`), shared by every picker; cached for five minutes. */
export function fetchModels(hostId: string): Promise<ModelCatalog> {
  const hit = cache.get(hostId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = core.host(hostId).call("host.models", {});
  cache.set(hostId, { at: Date.now(), p });
  p.catch(() => cache.delete(hostId));
  return p;
}

/** Forgets the cached catalog: the host's accounts changed, so may the models omp can use. */
export function forgetModels(hostId: string): void {
  cache.delete(hostId);
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

/**
 * The role bindings a session runs with: the host's (`catalog.roles`) with the agent's own over them
 * (`agent.getRoleModels`: the roles set for it at launch or in "Roles (this session)"), so a role row
 * names the model picking it really switches to. A host without the call, or an agent whose bridge
 * can't answer it, keeps the host's bindings.
 */
export function useSessionRoles(hostId: string, agentId: string, hostRoles: readonly RoleBinding[] | undefined): RoleBinding[] {
  const [own, setOwn] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    let alive = true;
    core
      .host(hostId)
      .call("agent.getRoleModels", { agentId })
      .then(
        (r) => alive && setOwn(r.session),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [hostId, agentId]);
  return mergeRoles(hostRoles ?? [], own);
}

/** `host` bindings with `own` replacing the model of a role it names; roles only `own` has come last. */
export function mergeRoles(host: readonly RoleBinding[], own: Readonly<Record<string, string>>): RoleBinding[] {
  const seen = new Set(host.map((r) => r.role));
  return [...host.map((r) => ({ role: r.role, model: own[r.role] ?? r.model })), ...Object.entries(own).filter(([role]) => !seen.has(role)).map(([role, model]) => ({ role, model }))];
}
