import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { parseAgentKey } from "@/core/keys";
import { deviceStorage } from "@/core/deviceStorage";
import { sessionScope } from "../inspector/cards";

/** Sessions whose read marker is kept on this device; the least recently read go first. */
export const MAX_SEEN_SESSIONS = 200;

interface IrcSeenState {
  /** Per session (`seenScope`): `at` of the newest agent chat message the user has looked at (the message board). */
  board: Record<string, number>;
  /** `from`: the agent key a mark kept before the session id was known moves from. */
  markSeen(scope: string, at: number, from?: string): void;
}

/**
 * Where a session's read mark is kept: host and omp session id once known, so a parked agent resumed
 * under a new agent id keeps it (`sessionScope`, as the inspector's marks); else the agent key.
 */
export function seenScope(agentKey: string, sessionId: string | undefined): string {
  if (!sessionId) return agentKey;
  const { hostId, agentId } = parseAgentKey(agentKey);
  return sessionScope(hostId, agentId, sessionId);
}

/** The newest `at` read in `scope`; a mark still kept under the agent key (before the session id was known, older apps) counts. */
export function readMark(board: Readonly<Record<string, number>>, scope: string, agentKey: string): number {
  return board[scope] ?? board[agentKey] ?? 0;
}

/**
 * `board` with `scope` read up to `at` (or what `from`, the agent key, held when more), as the newest
 * scope; `from`'s own mark goes (it moved). The oldest scopes beyond the cap go.
 */
export function markRead(board: Record<string, number>, scope: string, at: number, from?: string): Record<string, number> {
  const moving = from !== undefined && from !== scope && from in board;
  const prev = readMark(board, scope, from ?? scope);
  if (prev >= at && !moving) return board;
  const rest = { ...board };
  delete rest[scope];
  if (moving) delete rest[from];
  const keys = Object.keys(rest);
  for (const k of keys.slice(0, Math.max(0, keys.length + 1 - MAX_SEEN_SESSIONS))) delete rest[k];
  return { ...rest, [scope]: Math.max(prev, at) };
}

/** What the user has read of each session's agent chat (persisted on this device, so unread survives reloads). */
export const useIrcSeen = create<IrcSeenState>()(
  persist(
    (set) => ({
      board: {},
      markSeen: (scope, at, from) =>
        set((s) => {
          const board = markRead(s.board, scope, at, from);
          return board === s.board ? s : { board };
        }),
    }),
    {
      name: "tf.ircSeen",
      version: 1,
      storage: createJSONStorage(() => deviceStorage),
      // Version 0 kept a mark per peer of the Chat card's threads: the board reads up to the newest of them.
      migrate: (old, version) => {
        const prev = (old ?? {}) as { seen?: Record<string, Record<string, number>>; board?: Record<string, number> };
        if (version >= 1) return { board: prev.board ?? {} } as IrcSeenState;
        const board: Record<string, number> = {};
        for (const [key, peers] of Object.entries(prev.seen ?? {})) board[key] = Math.max(0, ...Object.values(peers));
        return { board } as IrcSeenState;
      },
      partialize: ({ board }) => ({ board }),
    },
  ),
);
