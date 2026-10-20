import { describe, expect, test } from "bun:test";
import type { Agent, HostState, SessionSnapshot, TranscriptItem } from "../gen";
import { reduceEvents } from "./reduce";
import { type CoreState, initialCoreState } from "./state";

function agent(id: string, column: Agent["column"] = "running"): Agent {
  return {
    id,
    name: id,
    kind: "omp",
    paneId: `${id}:p1`,
    tabId: `${id}:t1`,
    workspaceId: "w1",
    state: column === "running" ? "working" : "idle",
    stateSince: 1000,
    column,
    archived: false,
    turns: 1,
    title: id,
    live: { streaming: false, thinking: false },
  };
}

function hostState(agents: Agent[]): HostState {
  return {
    info: {
      hostname: "h",
      os: "linux",
      arch: "x86_64",
      home: "/home/h",
      hostdVersion: "0.1.0",
      herdrSession: "default",
      herdrSessions: ["default"],
      relayPort: 47466,
      setup: { herdrIntegration: true, globalSharing: true, globalBridge: true, relay: true, issues: [] },
    },
    workspaces: [],
    agents,
    usage: { costUsd: 0, tokens: 0, input: 0, output: 0 },
  };
}

function snap(items: TranscriptItem[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    agentId: "a",
    meta: {
      fast: false,
      mode: "normal",
      todos: [],
      subagents: [],
      files: [],
      queue: { steering: [], followUp: [] },
      caps: { prompt: true, steer: true, followUp: true, abort: true, answer: true, model: true, thinking: true, fast: true, plan: true, goal: true, compact: true, rename: true, fork: true, branch: true, tree: true, btw: true, export: true, handoff: true, subagents: true, bridge: true },
    },
    items,
    hasMore: false,
    ...extra,
  };
}

const user = (id: string, text = "hi"): TranscriptItem => ({ kind: "user", id, at: 1, text, images: [], steering: false, synthetic: false });
const asst = (id: string, text = ""): TranscriptItem => ({ kind: "assistant", id, at: 2, text, streaming: true });

function base(): CoreState {
  return reduceEvents(initialCoreState("demo"), [{ type: "hostSnapshot", hostId: "h", rev: 5, state: hostState([agent("a"), agent("b", "review")]) }]).state;
}

describe("host state", () => {
  test("snapshot builds agent views keyed by host", () => {
    const s = base();
    expect(Object.keys(s.agents).sort()).toEqual(["h::a", "h::b"]);
    expect(s.agents["h::a"]?.hostId).toBe("h");
    expect(s.agents["h::a"]?.key).toBe("h::a");
    expect(s.hosts.h?.rev).toBe(5);
  });

  test("patch replaces only the touched agent (identity preserved for others)", () => {
    const s0 = base();
    const { state: s1, effects } = reduceEvents(s0, [{ type: "hostPatch", hostId: "h", rev: 6, ops: [{ op: "agent", id: "a", value: { ...agent("a"), column: "needs", state: "blocked" } }] }]);
    expect(s1.agents["h::a"]?.column).toBe("needs");
    expect(s1.agents["h::b"]).toBe(s0.agents["h::b"]);
    expect(s1.hosts.h?.rev).toBe(6);
    expect(s1.hosts.h?.state.agents.find((x) => x.id === "a")?.column).toBe("needs");
    expect(effects.some((e) => e.kind === "lanes")).toBe(true);
    expect(effects.some((e) => e.kind === "resync")).toBe(false);
  });

  test("agent deletion and insertion via patch", () => {
    const { state } = reduceEvents(base(), [
      { type: "hostPatch", hostId: "h", rev: 6, ops: [{ op: "agent", id: "b", value: null }] },
      { type: "hostPatch", hostId: "h", rev: 7, ops: [{ op: "agent", id: "c", value: agent("c") }] },
    ]);
    expect(Object.keys(state.agents).sort()).toEqual(["h::a", "h::c"]);
    expect(state.hosts.h?.state.agents.map((a) => a.id)).toEqual(["a", "c"]);
  });

  test("rev gap applies the patch and requests a resync", () => {
    const { state, effects } = reduceEvents(base(), [{ type: "hostPatch", hostId: "h", rev: 9, ops: [{ op: "usage", usage: { costUsd: 1, tokens: 2, input: 1, output: 1 } }] }]);
    expect(effects.filter((e) => e.kind === "resync")).toEqual([{ kind: "resync", hostId: "h" }]);
    expect(state.hosts.h?.rev).toBe(9);
    expect(state.hosts.h?.state.usage.costUsd).toBe(1);
  });

  test("stale or duplicate patches are ignored", () => {
    const s0 = base();
    const { state, effects } = reduceEvents(s0, [{ type: "hostPatch", hostId: "h", rev: 5, ops: [{ op: "agent", id: "a", value: null }] }]);
    expect(state).toBe(s0);
    expect(effects).toHaveLength(0);
  });

  test("patch for an unknown host requests a resync", () => {
    const { effects } = reduceEvents(initialCoreState("demo"), [{ type: "hostPatch", hostId: "x", rev: 1, ops: [] }]);
    expect(effects).toEqual([{ kind: "resync", hostId: "x" }]);
  });

  test("$stateGet replaces state but keeps the tracked rev", () => {
    const { state } = reduceEvents(base(), [{ type: "$stateGet", hostId: "h", state: hostState([agent("z")]) }]);
    expect(state.hosts.h?.rev).toBe(5);
    expect(Object.keys(state.agents)).toEqual(["h::z"]);
  });

  test("identical snapshot keeps agent identity", () => {
    const s0 = base();
    const { state } = reduceEvents(s0, [{ type: "hostSnapshot", hostId: "h", rev: 10, state: hostState([agent("a"), agent("b", "review")]) }]);
    expect(state.agents["h::a"]).toBe(s0.agents["h::a"]);
  });

  test("hostStatus → online after offline emits hostOnline", () => {
    let s = reduceEvents(initialCoreState("demo"), [{ type: "hostStatus", hostId: "h", status: { phase: "offline", since: 0, attempt: 0 } }]).state;
    const r = reduceEvents(s, [{ type: "hostStatus", hostId: "h", status: { phase: "online", since: 1, attempt: 0 } }]);
    s = r.state;
    expect(s.status.h?.phase).toBe("online");
    expect(r.effects).toEqual([{ kind: "hostOnline", hostId: "h" }]);
  });
});

describe("sessions", () => {
  const open = (s: CoreState, items: TranscriptItem[], extra: Partial<SessionSnapshot> = {}) =>
    reduceEvents(s, [{ type: "session", hostId: "h", agentId: "a", ev: { k: "reset", snapshot: snap(items, extra) } }]).state;

  test("events for sessions that were never opened are ignored", () => {
    const s0 = base();
    const { state } = reduceEvents(s0, [{ type: "session", hostId: "h", agentId: "a", ev: { k: "upsert", item: user("u1") } }]);
    expect(state.sessions["h::a"]).toBeUndefined();
  });

  test("reset, upsert, append, remove keep an ordered itemIds", () => {
    let s = open(base(), [user("u1")]);
    expect(s.sessions["h::a"]?.status).toBe("live");
    expect(s.sessions["h::a"]?.ui).toBeNull();
    s = reduceEvents(s, [
      { type: "session", hostId: "h", agentId: "a", ev: { k: "upsert", item: asst("a1") } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "append", id: "a1", field: "text", text: "Hel" } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "append", id: "a1", field: "text", text: "lo" } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "upsert", item: user("u2") } },
    ]).state;
    const sess = s.sessions["h::a"];
    expect(sess?.itemIds).toEqual(["u1", "a1", "u2"]);
    const a1 = sess?.items.a1;
    expect(a1?.kind === "assistant" ? a1.text : "").toBe("Hello");
    s = reduceEvents(s, [{ type: "session", hostId: "h", agentId: "a", ev: { k: "remove", id: "u1" } }]).state;
    expect(s.sessions["h::a"]?.itemIds).toEqual(["a1", "u2"]);
    expect(s.sessions["h::a"]?.items.u1).toBeUndefined();
  });

  test("append keeps itemIds and other rows identical (per-row subscriptions)", () => {
    const s0 = open(base(), [user("u1"), asst("a1")]);
    const s1 = reduceEvents(s0, [{ type: "session", hostId: "h", agentId: "a", ev: { k: "append", id: "a1", field: "text", text: "x" } }]).state;
    expect(s1.sessions["h::a"]?.itemIds).toBe(s0.sessions["h::a"]?.itemIds);
    expect(s1.sessions["h::a"]?.items.u1).toBe(s0.sessions["h::a"]?.items.u1);
    expect(s1.sessions["h::a"]?.items.a1).not.toBe(s0.sessions["h::a"]?.items.a1);
    expect(s1.agents).toBe(s0.agents);
  });

  test("tool output append", () => {
    const tool: TranscriptItem = { kind: "tool", id: "t1", at: 3, callId: "c", tool: "bash", title: "ls", args: {}, status: "running", truncated: false };
    let s = open(base(), [tool]);
    s = reduceEvents(s, [{ type: "session", hostId: "h", agentId: "a", ev: { k: "append", id: "t1", field: "output", text: "a\n" } }]).state;
    const t = s.sessions["h::a"]?.items.t1;
    expect(t?.kind === "tool" ? t.output : undefined).toBe("a\n");
  });

  test("meta, ui, btw, ended", () => {
    let s = open(base(), []);
    const ui = { id: "r1", kind: "select" as const, title: "Q", options: [], allowOther: false, allowChat: false };
    s = reduceEvents(s, [
      { type: "session", hostId: "h", agentId: "a", ev: { k: "meta", meta: { ...snap([]).meta, fast: true } } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "ui", request: ui } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "btw", btwId: "b1", text: "Hi ", done: false } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "btw", btwId: "b1", text: "there", done: true } },
    ]).state;
    expect(s.sessions["h::a"]?.meta?.fast).toBe(true);
    expect(s.sessions["h::a"]?.ui?.id).toBe("r1");
    expect(s.sessions["h::a"]?.btw.b1).toEqual({ text: "Hi there", done: true });
    s = reduceEvents(s, [
      { type: "session", hostId: "h", agentId: "a", ev: { k: "ui", request: null } },
      { type: "session", hostId: "h", agentId: "a", ev: { k: "ended", reason: "pane closed" } },
    ]).state;
    expect(s.sessions["h::a"]?.ui).toBeNull();
    expect(s.sessions["h::a"]?.status).toBe("ended");
    expect(s.sessions["h::a"]?.endedReason).toBe("pane closed");
  });

  test("history prepends older rows and updates the cursor", () => {
    let s = open(base(), [user("u3")], { hasMore: true, cursor: "3" });
    s = reduceEvents(s, [{ type: "$history", hostId: "h", agentId: "a", page: { items: [user("u1"), user("u2")], hasMore: false } }]).state;
    expect(s.sessions["h::a"]?.itemIds).toEqual(["u1", "u2", "u3"]);
    expect(s.sessions["h::a"]?.hasMore).toBe(false);
  });

  test("loading, error, drop", () => {
    let s = reduceEvents(base(), [{ type: "$sessionLoading", hostId: "h", agentId: "a" }]).state;
    expect(s.sessions["h::a"]?.status).toBe("loading");
    s = reduceEvents(s, [{ type: "$sessionError", hostId: "h", agentId: "a", error: { code: "not_found", message: "x", retryable: false } }]).state;
    expect(s.sessions["h::a"]?.status).toBe("error");
    expect(s.sessions["h::a"]?.error?.code).toBe("not_found");
    s = reduceEvents(s, [{ type: "$sessionDrop", hostId: "h", agentId: "a" }]).state;
    expect(s.sessions["h::a"]).toBeUndefined();
  });
});

describe("notifications & misc", () => {
  test("notify dedupes by id and prepends", () => {
    const n = (id: string) => ({ id, at: 1, kind: "needs" as const, agentId: "a", title: "t", body: "b", actions: [] });
    const { state } = reduceEvents(base(), [
      { type: "notify", hostId: "h", notification: n("1") },
      { type: "notify", hostId: "h", notification: n("2") },
      { type: "notify", hostId: "h", notification: n("1") },
    ]);
    expect(state.notifications.map((x) => x.id)).toEqual(["2", "1"]);
    expect(state.notifications.every((x) => !x.read && x.hostId === "h")).toBe(true);
  });

  test("openAgent and answerNext become effects", () => {
    const { effects } = reduceEvents(base(), [{ type: "openAgent", hostId: "h", agentId: "a" }, { type: "answerNext" }]);
    expect(effects).toEqual([{ kind: "openAgent", hostId: "h", agentId: "a" }, { kind: "answerNext" }]);
  });
});
