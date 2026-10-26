import { describe, expect, test } from "bun:test";
import type { Agent, AppEvent, HostState, Notification, PrunedAgent } from "../gen";
import { FOLLOW_WINDOW_MS, resolveSuccessor } from "./lifecycle";
import { reduceEvents } from "./reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "./state";

const T0 = 1_000_000;

function agent(id: string, session: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: "fix-ci",
    kind: "omp",
    paneId: `${id}:p1`,
    tabId: `${id}:t1`,
    workspaceId: "w1",
    state: "idle",
    stateSince: 1,
    column: "review",
    archived: false,
    turns: 3,
    title: "Fix CI",
    live: { streaming: false, thinking: false },
    omp: { sessionId: session, sessionFile: `/s/${session}.jsonl`, link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] } },
    ...extra,
  };
}

function parked(id: string, session: string): Agent {
  return agent(id, session, { paneId: "", tabId: "", workspaceId: "", column: "done", archived: true, parked: { at: 5, sessionFile: `/s/${session}.jsonl` } });
}

function hostState(agents: Agent[], pruned?: PrunedAgent[]): HostState {
  return {
    info: {
      hostname: "h",
      os: "linux",
      arch: "x86_64",
      home: "/home/h",
      hostdVersion: "0.5.0",
      herdrSession: "default",
      herdrSessions: ["default"],
      relayPort: 47466,
      setup: { herdrIntegration: true, globalSharing: true, globalBridge: true, relay: true, issues: [] },
      pruned,
    },
    workspaces: [],
    agents,
    usage: { costUsd: 0, tokens: 0, input: 0, output: 0 },
  };
}

function notification(id: string, agentId: string): Notification {
  return { id, at: 1, kind: "finished", agentId, title: "done", body: "", actions: [] };
}

let rev = 1;
function start(agents: Agent[]): CoreState {
  rev = 1;
  return reduceEvents(initialCoreState("demo"), [{ type: "hostSnapshot", hostId: "h", rev, state: hostState(agents) }], T0).state;
}

function patch(s: CoreState, ops: Extract<AppEvent, { type: "hostPatch" }>["ops"], now = T0): CoreState {
  return reduceEvents(s, [{ type: "hostPatch", hostId: "h", rev: ++rev, ops }], now).state;
}

describe("following a resumed parked agent", () => {
  test("old id removed and new agent added in one patch, either order", () => {
    const s0 = start([parked("old", "S1"), agent("other", "S2")]);
    const removeFirst = patch(s0, [
      { op: "agent", id: "old", value: null },
      { op: "agent", id: "new", value: agent("new", "S1") },
    ]);
    expect(removeFirst.successors).toEqual({ "h::old": "h::new" });
    expect(removeFirst.departed).toEqual([]);
    const addFirst = patch(start([parked("old", "S1")]), [
      { op: "agent", id: "new", value: agent("new", "S1") },
      { op: "agent", id: "old", value: null },
    ]);
    expect(addFirst.successors).toEqual({ "h::old": "h::new" });
  });

  test("the new agent may show up later, and get its omp session even later", () => {
    let s = patch(start([parked("old", "S1")]), [{ op: "agent", id: "old", value: null }]);
    expect(s.departed.map((d) => d.key)).toEqual(["h::old"]);
    s = patch(s, [{ op: "agent", id: "new", value: agent("new", "S1", { omp: undefined }) }], T0 + 2000);
    expect(s.successors).toEqual({});
    // matched by session file alone
    const file = agent("new", "S9");
    file.omp = file.omp && { ...file.omp, sessionId: undefined, sessionFile: "/s/S1.jsonl" };
    s = patch(s, [{ op: "agent", id: "new", value: file }], T0 + 4000);
    expect(s.successors).toEqual({ "h::old": "h::new" });
    expect(s.departed).toEqual([]);
  });

  test("nothing links after the follow window, nor to another session or a parked agent", () => {
    const gone = patch(start([parked("old", "S1")]), [{ op: "agent", id: "old", value: null }]);
    expect(patch(gone, [{ op: "agent", id: "late", value: agent("late", "S1") }], T0 + FOLLOW_WINDOW_MS + 1).successors).toEqual({});
    expect(patch(gone, [{ op: "agent", id: "x", value: agent("x", "S2") }], T0 + 1000).successors).toEqual({});
    expect(patch(gone, [{ op: "agent", id: "p", value: parked("p", "S1") }], T0 + 1000).successors).toEqual({});
    // a live agent leaving is just gone
    expect(patch(start([agent("live", "S1")]), [{ op: "agent", id: "live", value: null }]).departed).toEqual([]);
  });

  test("a full snapshot swapping the agents links them too", () => {
    const s = reduceEvents(start([parked("old", "S1")]), [{ type: "$stateGet", hostId: "h", state: hostState([agent("new", "S1")]) }], T0).state;
    expect(s.successors).toEqual({ "h::old": "h::new" });
  });

  test("Started.agentId links at once, and resume after resume resolves to the latest", () => {
    let s = reduceEvents(start([parked("a", "S1")]), [{ type: "$successor", hostId: "h", from: "a", to: "b" } satisfies CoreEvent], T0).state;
    s = reduceEvents(s, [{ type: "$successor", hostId: "h", from: "b", to: "c" }], T0).state;
    expect(resolveSuccessor(s.successors, "h::a")).toBe("h::c");
    expect(resolveSuccessor(s.successors, "h::b")).toBe("h::c");
    expect(resolveSuccessor(s.successors, "h::c")).toBeUndefined();
  });
});

describe("pruned agents", () => {
  test("their notifications and sessions go, earlier ids included; late notifications are dropped", () => {
    let s = start([parked("old", "S1"), agent("keep", "S2")]);
    s = reduceEvents(
      s,
      [
        { type: "notify", hostId: "h", notification: notification("n1", "old") },
        { type: "notify", hostId: "h", notification: notification("n2", "keep") },
        { type: "notify", hostId: "other", notification: notification("n3", "new") },
        { type: "$successor", hostId: "h", from: "old", to: "new" },
        { type: "$sessionLoading", hostId: "h", agentId: "new" },
      ],
      T0,
    ).state;
    s = patch(s, [{ op: "agent", id: "new", value: agent("new", "S1") }, { op: "agent", id: "old", value: null }]);
    s = reduceEvents(s, [{ type: "notify", hostId: "h", notification: notification("n4", "new") }], T0).state;
    expect(s.notifications.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3", "n4"]);

    const info = { ...hostState([]).info, pruned: [{ agentId: "new", sessionId: "S1", at: 9 }] };
    s = patch(s, [{ op: "info", info }, { op: "agent", id: "new", value: null }]);
    expect(s.notifications.map((n) => n.id).sort()).toEqual(["n2", "n3"]);
    expect(s.sessions["h::new"]).toBeUndefined();
    expect(Object.keys(s.agents)).toEqual(["h::keep"]);

    s = reduceEvents(s, [{ type: "notify", hostId: "h", notification: notification("n5", "new") }], T0).state;
    expect(s.notifications.some((n) => n.id === "n5")).toBe(false);
  });

  test("entries already known are not pruned again; a first snapshot prunes all it lists", () => {
    let s = reduceEvents(initialCoreState("demo"), [{ type: "notify", hostId: "h", notification: notification("n1", "gone") }], T0).state;
    s = reduceEvents(s, [{ type: "hostSnapshot", hostId: "h", rev: 1, state: hostState([], [{ agentId: "gone", at: 3 }]) }], T0).state;
    expect(s.notifications).toEqual([]);
    const before = s;
    s = patch(s, [{ op: "info", info: hostState([], [{ agentId: "gone", at: 3 }]).info }]);
    expect(s.notifications).toBe(before.notifications);
  });
});
