import { useEffect } from "react";
import { create } from "zustand";
import { core, toApiError } from "@/core";
import type { RefusalFallback, RefusalRule } from "@/core/gen";

/** The rules of one host as the app last heard them (`host.refusalFallback`). */
export interface HostRules {
  /** `old`: a tf-hostd before 0.9.0 (it answers `unknown_method`, or `unsupported`). */
  phase: "ready" | "old" | "error";
  rules: RefusalRule[];
  /** tf-hostd's own note: its settings file couldn't be read, so no rule applies until the rules are saved again. */
  notice?: string;
  error?: string;
  /** When it was asked. */
  at: number;
}

const useStore = create<{ hosts: Record<string, HostRules> }>(() => ({ hosts: {} }));
/** The question in flight per host, and how many saves had answered when it was asked. */
const asking = new Map<string, { p: Promise<HostRules>; saves: number }>();
/** Saves answered per host: an answer to a question asked before one is older than what that save showed. */
const saves = new Map<string, number>();
/** Per host, the end of the last change asked for (`changeRules`): the next one starts after it. */
const changing = new Map<string, Promise<unknown>>();

function put(hostId: string, state: HostRules): HostRules {
  useStore.setState((s) => ({ hosts: { ...s.hosts, [hostId]: state } }));
  return state;
}

function heard(fallback: RefusalFallback): HostRules {
  return { phase: "ready", rules: fallback.rules, notice: fallback.notice, at: Date.now() };
}

/**
 * Asks the host for its rules, unless an answer newer than `maxAgeMs` is in. One question at a time per host; a
 * question asked before the latest save is not shared, and its answer, older than that save's, changes nothing. A
 * host without the method is `old`; any other failure keeps the rules it knew and says what went wrong.
 */
export function loadRules(hostId: string, maxAgeMs = 0): Promise<HostRules> {
  const known = useStore.getState().hosts[hostId];
  if (known && known.phase !== "error" && Date.now() - known.at < maxAgeMs) return Promise.resolve(known);
  const gen = saves.get(hostId) ?? 0;
  const pending = asking.get(hostId);
  if (pending?.saves === gen) return pending.p;
  /** What a save answered since this question was asked (newer than its answer), else `state`. */
  const settle = (state: () => HostRules): HostRules => ((saves.get(hostId) ?? 0) !== gen && useStore.getState().hosts[hostId]) || put(hostId, state());
  const p = core
    .host(hostId)
    .call("host.refusalFallback", {})
    .then(
      (fallback) => settle(() => heard(fallback)),
      (e: unknown) => {
        const err = toApiError(e);
        if (err.code === "unknown_method" || err.code === "unsupported") return settle(() => ({ phase: "old", rules: [], at: Date.now() }));
        return settle(() => ({ phase: "error", rules: known?.rules ?? [], error: err.message, at: Date.now() }));
      },
    )
    .finally(() => {
      if (asking.get(hostId)?.p === p) asking.delete(hostId);
    });
  asking.set(hostId, { p, saves: gen });
  return p;
}

/** Saves the complete rule list; the host's answer is what the app shows. Rejects with the host's refusal (`invalid_params` …). */
async function saveRules(hostId: string, rules: readonly RefusalRule[]): Promise<HostRules> {
  const fallback = await core.host(hostId).call("host.refusalFallbackSet", { rules: [...rules] });
  saves.set(hostId, (saves.get(hostId) ?? 0) + 1);
  return put(hostId, heard(fallback));
}

/**
 * Changes a host's rules. One change at a time per host, in the order asked: `change` gets the rules the host has once
 * every earlier change is saved (asked again, not what a view showed) and returns the list to save, or nothing to
 * leave them; so no change saves over another. Resolves to what the host has then; rejects when its rules can't be
 * read (a tf-hostd before 0.9.0, a failure), with `change`'s own error, or with the host's refusal.
 */
export function changeRules(hostId: string, change: (rules: readonly RefusalRule[]) => readonly RefusalRule[] | undefined): Promise<HostRules> {
  const turn = async (): Promise<HostRules> => {
    const now = await loadRules(hostId);
    if (now.phase !== "ready") throw new Error(now.phase === "old" ? "This host needs TeleFlock 0.9.0 for refusal fallback" : (now.error ?? "The host's rules aren't available"));
    const next = change(now.rules);
    return next ? saveRules(hostId, next) : now;
  };
  const p = (changing.get(hostId) ?? Promise.resolve()).then(turn);
  const settled = p.then(
    () => undefined,
    () => undefined,
  );
  changing.set(hostId, settled);
  void settled.then(() => {
    if (changing.get(hostId) === settled) changing.delete(hostId);
  });
  return p;
}

/** The host's rules; `undefined` until it has answered. */
export function useHostRules(hostId: string): HostRules | undefined {
  return useStore((s) => s.hosts[hostId]);
}

/** `useHostRules`, asking again whenever the host comes online (`maxAgeMs`: an answer this fresh is kept). */
export function useEnsureRules(hostId: string, online: boolean, maxAgeMs = 0): HostRules | undefined {
  useEffect(() => {
    if (online) void loadRules(hostId, maxAgeMs);
  }, [hostId, online, maxAgeMs]);
  return useHostRules(hostId);
}
