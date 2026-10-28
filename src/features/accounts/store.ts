import { useEffect } from "react";
import { create } from "zustand";
import { core, refreshLimits, toApiError, useHosts } from "@/core";
import type { AccountsSnapshot, ApiError, LinkedAccount } from "@/core/gen";
import { fetchModels, forgetModels } from "@/features/session/header/useModels";

/**
 * `accounts.*` per host, shared by the Accounts page and the link-account nudges: a link, unlink
 * or preference anywhere shows everywhere at once.
 */
export interface HostAccounts {
  snapshot?: AccountsSnapshot;
  error?: ApiError;
  loading: boolean;
  /** `host.models` count from the last check (no models: omp has nothing to sign in with). */
  models?: number;
}

interface AccountsState {
  hosts: Record<string, HostAccounts>;
}

export const useAccountsStore = create<AccountsState>(() => ({ hosts: {} }));

const EMPTY: HostAccounts = { loading: false };
/** Latest request per host: an older answer never replaces a newer one. */
const seq: Record<string, number> = {};
/** When the nudge last checked a host's models (once per app session unless accounts change). */
const checkedAt: Record<string, number> = {};
const RECHECK_MS = 10 * 60_000;

function patch(hostId: string, p: Partial<HostAccounts>): void {
  useAccountsStore.setState((s) => ({ hosts: { ...s.hosts, [hostId]: { ...(s.hosts[hostId] ?? EMPTY), ...p } } }));
}

/** `accounts.list` (`refresh`: omp's store and usage are read again now). */
export async function loadAccounts(hostId: string, refresh = false): Promise<void> {
  const n = (seq[hostId] = (seq[hostId] ?? 0) + 1);
  patch(hostId, { loading: true });
  try {
    const snapshot = await core.host(hostId).call("accounts.list", refresh ? { refresh: true } : {});
    if (seq[hostId] === n) patch(hostId, { snapshot, error: undefined, loading: false });
  } catch (e) {
    if (seq[hostId] === n) patch(hostId, { error: toApiError(e), loading: false });
  }
}

/** Takes the snapshot a change answered with (newer than any read still in flight). */
function settle(hostId: string, snapshot: AccountsSnapshot): void {
  seq[hostId] = (seq[hostId] ?? 0) + 1;
  patch(hostId, { snapshot, error: undefined, loading: false });
  changed(hostId);
}

/** What changed accounts change elsewhere: the models omp can use, the quota report. */
function changed(hostId: string): void {
  forgetModels(hostId);
  delete checkedAt[hostId];
  void refreshLimits(hostId).catch(() => {});
  void checkModels(hostId);
}

/** Removes the credential from omp (rejects with the host's reason). */
export async function unlinkAccount(hostId: string, a: LinkedAccount): Promise<void> {
  if (a.credentialId == null) throw toApiError({ code: "unsupported", message: "This account isn't stored on this host.", retryable: false });
  settle(hostId, await core.host(hostId).call("accounts.unlink", { provider: a.provider, credentialId: a.credentialId }));
}

/** Makes omp try `a` first for new sessions of its provider (or stops preferring it). */
export async function preferAccount(hostId: string, a: LinkedAccount, preferred: boolean): Promise<void> {
  settle(hostId, await core.host(hostId).call("accounts.prefer", { key: a.key, preferred }));
}

/** A link finished on the host: read the accounts again. */
export function accountLinked(hostId: string): void {
  void loadAccounts(hostId, true).then(() => changed(hostId));
}

async function checkModels(hostId: string): Promise<void> {
  checkedAt[hostId] = Date.now();
  try {
    const cat = await fetchModels(hostId);
    patch(hostId, { models: cat.models.length });
    // No model: omp has nothing to sign in with, unless the store says otherwise.
    if (cat.models.length === 0 && !useAccountsStore.getState().hosts[hostId]?.snapshot) await loadAccounts(hostId);
  } catch {
    patch(hostId, { models: undefined });
  }
}

/** The accounts of `hostId`, read when it is online (again on `reload`). */
export function useHostAccounts(hostId: string | undefined): HostAccounts & { reload(refresh?: boolean): void } {
  const up = useHosts((s) => (hostId ? s.status[hostId]?.phase === "online" : false));
  const state = useAccountsStore((s) => (hostId ? (s.hosts[hostId] ?? EMPTY) : EMPTY));
  useEffect(() => {
    if (hostId && up) void loadAccounts(hostId);
  }, [hostId, up]);
  return {
    ...state,
    reload: (refresh = false) => {
      if (hostId) void loadAccounts(hostId, refresh);
    },
  };
}

/** Why a host needs an account linked: none at all, or only logins omp stopped using. */
export interface AccountsNeed {
  /** Logins omp stopped using (expired refresh token, revoked): linking them again fixes it. */
  expired: LinkedAccount[];
}

/**
 * Does omp on this host lack anything to run agents with? Both must hold: omp lists no model it
 * can use (so not even an API key in the environment works), and its store holds no active
 * credential. `null`: it has something, or it can't be told yet.
 */
export function accountsNeed(h: HostAccounts | undefined): AccountsNeed | null {
  if (!h || h.models === undefined || h.models > 0 || !h.snapshot) return null;
  const { accounts } = h.snapshot;
  if (accounts.some((a) => !a.disabled)) return null;
  return { expired: accounts.filter((a) => a.disabled) };
}

/** {@link accountsNeed} for an online host (checks its models once per app session). */
export function useAccountsNeeded(hostId: string): AccountsNeed | null {
  const up = useHosts((s) => s.status[hostId]?.phase === "online");
  const h = useAccountsStore((s) => s.hosts[hostId]);
  useEffect(() => {
    if (!up) return;
    const at = checkedAt[hostId];
    if (at === undefined || Date.now() - at > RECHECK_MS) void checkModels(hostId);
  }, [hostId, up]);
  if (!up) return null;
  return accountsNeed(h);
}
