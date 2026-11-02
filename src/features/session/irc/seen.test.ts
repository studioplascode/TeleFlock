import { describe, expect, test } from "bun:test";

// The store persists to localStorage, which bun doesn't provide: an in-memory stand-in, installed
// before the store module loads (it hydrates at load). It holds what an app before the board saved.
const mem: Record<string, string> = {
  "tf.ircSeen": JSON.stringify({ state: { seen: { "forge/pool": { QueryScout: 500, PoolBench: 900 }, "forge/push": { FcmScout: 40 } } }, version: 0 }),
};
globalThis.localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
  clear: () => {},
  key: () => null,
  length: 0,
} as Storage;
const { MAX_SEEN_SESSIONS, markRead, readMark, seenScope, useIrcSeen } = await import("./seen");
const { agentKey } = await import("@/core/keys");

describe("read marks of the message board", () => {
  test("the Chat card's per-peer marks carry over as the newest one of each session", () => {
    expect(useIrcSeen.getState().board).toEqual({ "forge/pool": 900, "forge/push": 40 });
  });

  test("a mark only moves forward, and survives a reload", async () => {
    useIrcSeen.getState().markSeen("forge/pool", 800);
    expect(useIrcSeen.getState().board["forge/pool"]).toBe(900);
    useIrcSeen.getState().markSeen("forge/pool", 1200);
    expect(JSON.parse(mem["tf.ircSeen"] as string).state).toEqual({ board: { "forge/push": 40, "forge/pool": 1200 } });
    await useIrcSeen.persist.rehydrate();
    expect(useIrcSeen.getState().board["forge/pool"]).toBe(1200);
  });

  test("the least recently read sessions go beyond the cap", () => {
    let board: Record<string, number> = {};
    for (let i = 0; i < MAX_SEEN_SESSIONS + 3; i++) board = markRead(board, `h/a${i}`, 1);
    expect(Object.keys(board)).toHaveLength(MAX_SEEN_SESSIONS);
    expect(board["h/a2"]).toBeUndefined();
    // Read again, a3 becomes the newest: the next session pushes out a4 instead.
    board = markRead(board, "h/a3", 5);
    board = markRead(board, "h/new", 1);
    expect(Object.keys(board)).toHaveLength(MAX_SEEN_SESSIONS);
    expect(board["h/a3"]).toBe(5);
    expect(board["h/a4"]).toBeUndefined();
  });

  test("a session's mark is kept under host + omp session id, so a parked agent resumed under a new agent id keeps it; one kept under the agent key moves there", () => {
    const pool = agentKey("forge", "pool");
    const resumed = agentKey("forge", "pool-2");
    const scope = seenScope(pool, "S1");
    expect(seenScope(resumed, "S1")).toBe(scope);
    expect(seenScope(agentKey("studio", "pool"), "S1")).not.toBe(scope);
    expect(seenScope(pool, undefined)).toBe(pool);
    let board: Record<string, number> = { [pool]: 900 };
    expect(readMark(board, scope, pool)).toBe(900);
    board = markRead(board, scope, 1200, pool);
    expect(board).toEqual({ [scope]: 1200 });
    expect(readMark(board, seenScope(resumed, "S1"), resumed)).toBe(1200);
    // Moving never loses the newer mark.
    expect(markRead({ [pool]: 500 }, scope, 100, pool)).toEqual({ [scope]: 500 });
  });
});
