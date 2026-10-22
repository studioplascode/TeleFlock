import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SetupFocusState {
  /** Hosts whose Host setup should open (and scroll into view) the next time their card can show it. */
  pending: Record<string, true>;
  /** Hosts the Hosts view has already shown with their setup status; only unseen ones auto-expand. */
  seen: Record<string, true>;
  request(hostId: string): void;
  consume(hostId: string): void;
  markSeen(hostId: string): void;
}

export const useSetupFocus = create<SetupFocusState>()(
  persist(
    (set) => ({
      pending: {},
      seen: {},
      request: (id) => set((s) => ({ pending: { ...s.pending, [id]: true } })),
      consume: (id) =>
        set((s) => {
          const { [id]: _, ...pending } = s.pending;
          return { pending };
        }),
      markSeen: (id) => set((s) => (s.seen[id] ? s : { seen: { ...s.seen, [id]: true } })),
    }),
    { name: "tf.hostSetupSeen", partialize: ({ seen }) => ({ seen }) },
  ),
);

/** Open a host's Host setup the next time the Hosts view shows it (right after Add host). */
export function requestSetup(hostId: string): void {
  useSetupFocus.getState().request(hostId);
}

/** The deep link that opens Hosts with this host's setup expanded (`#/hosts?setup=<hostId>`). */
export function setupHash(hostId: string): string {
  return `#/hosts?setup=${encodeURIComponent(hostId)}`;
}

/** The host id a `#/hosts?setup=<hostId>` hash asks to expand, if any. */
export function setupFromHash(hash: string): string | null {
  const m = /^#\/?hosts\?(.*)$/.exec(hash);
  return m ? new URLSearchParams(m[1]).get("setup") || null : null;
}
