import { create } from "zustand";
import { core } from "@/core";
import type { TunnelInfo } from "@/core/gen";
import { toast } from "@/design";
import { describeError } from "../workspace/shared/errors";

/** A tunnel that isn't open yet: being opened, or the last attempt failed. */
export type PendingTunnel =
  | { key: string; hostId: string; port: number; state: "opening"; since: number }
  | { key: string; hostId: string; port: number; state: "error"; title: string; hint?: string; since: number };

interface PreviewState {
  pending: Record<string, PendingTunnel>;
}

/** Opening / failed tunnels (live ones come from `useTunnels()`), shared by every PreviewButton and PreviewList. */
export const usePreviewStore = create<PreviewState>(() => ({ pending: {} }));

export const tunnelKey = (hostId: string, port: number) => `${hostId}:${port}`;

function setPending(key: string, p: PendingTunnel | null) {
  usePreviewStore.setState((s) => {
    const pending = { ...s.pending };
    if (p) pending[key] = p;
    else delete pending[key];
    return { pending };
  });
}

/** Forget a failed attempt (PreviewList "dismiss"). */
export function dismissPending(hostId: string, port: number) {
  setPending(tunnelKey(hostId, port), null);
}

/**
 * Open (or reuse) the tunnel to `port` on `hostId`, tracking the opening/error state for the UI.
 * Resolves to the tunnel, or `null` when it failed (toasted; the error stays in the store until
 * dismissed or retried) or an open for this port is already in flight.
 */
export async function openTunnel(hostId: string, port: number): Promise<TunnelInfo | null> {
  const key = tunnelKey(hostId, port);
  const cur = usePreviewStore.getState().pending[key];
  if (cur?.state === "opening") return null;
  setPending(key, { key, hostId, port, state: "opening", since: Date.now() });
  try {
    const tunnel = await core.app("tunnel.open", { hostId, port });
    setPending(key, null);
    return tunnel;
  } catch (e) {
    const d = describeError(e);
    setPending(key, { key, hostId, port, state: "error", title: d.title, hint: d.hint, since: Date.now() });
    toast({ title: `Couldn't open preview for :${port}`, description: d.hint ?? d.title, status: "error" });
    return null;
  }
}

/** Launch a live tunnel in the system browser (desktop). */
export function openExternal(tunnel: TunnelInfo) {
  void core.app("app.openExternal", { url: tunnel.url }).catch(() => {});
}
