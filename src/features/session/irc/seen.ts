import { create } from "zustand";
import { persist } from "zustand/middleware";

interface IrcSeenState {
  /** Per session key, per peer: `at` of the newest message the user has looked at. */
  seen: Record<string, Record<string, number>>;
  markSeen(key: string, peer: string, at: number): void;
}

/** What the user has read in each session's Chat tab (persisted, so unread survives reloads). */
export const useIrcSeen = create<IrcSeenState>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (key, peer, at) =>
        set((s) => {
          if ((s.seen[key]?.[peer] ?? 0) >= at) return s;
          return { seen: { ...s.seen, [key]: { ...s.seen[key], [peer]: at } } };
        }),
    }),
    { name: "tf.ircSeen" },
  ),
);
