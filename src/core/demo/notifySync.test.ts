import { describe, expect, test } from "bun:test";
import type { Agent, AppEvent, HostState, NeedsYou, Notification } from "../gen";
import { NotifySync } from "./notifySync";

function agent(id: string, requestId?: string): Agent {
  const needs = requestId === undefined ? undefined : ({ kind: "ask", requestId, since: 0, title: "Q", question: "?", options: [], multi: false, allowOther: true, allowChat: false, answerable: true } as NeedsYou);
  return { id, name: id, kind: "omp", paneId: "p", tabId: "t", workspaceId: "w", state: "idle", stateSince: 0, column: needs ? "needs" : "running", archived: false, turns: 1, title: id, live: { streaming: false, thinking: false }, needs };
}

const note = (id: string, agentId: string, requestId?: string): Notification => ({
  id,
  at: 1,
  kind: requestId ? "needs" : "finished",
  agentId,
  title: "t",
  body: "b",
  requestId,
  actions: [],
});

function setup() {
  const out: AppEvent[] = [];
  const sync = new NotifySync((e) => out.push(e));
  const feed = (e: AppEvent) => sync.observe(e);
  const patch = (a: Agent | null, id = a?.id ?? "") => feed({ type: "hostPatch", hostId: "h", rev: 2, ops: [{ op: "agent", id, value: a }] });
  return { out, sync, feed, patch };
}

describe("demo notification sync", () => {
  test("needs-you resolves when its request leaves host state", () => {
    const { out, feed, patch } = setup();
    feed({ type: "hostSnapshot", hostId: "h", rev: 1, state: { agents: [agent("a", "r1"), agent("b", "r2")] } as unknown as HostState });
    feed({ type: "notify", hostId: "h", notification: note("n1", "a", "r1") });
    feed({ type: "notify", hostId: "h", notification: note("n2", "b", "r2") });
    patch(agent("a", "r1"));
    expect(out).toEqual([]);
    patch(agent("a"));
    patch(agent("b", "r3"));
    expect(out).toEqual([
      { type: "notifyDone", hostId: "h", ids: ["n1"], resolved: true },
      { type: "notifyDone", hostId: "h", ids: ["n2"], resolved: true },
    ]);
  });

  test("a notification before its request shows up waits for it; a removed agent resolves it", () => {
    const { out, feed, patch } = setup();
    feed({ type: "hostSnapshot", hostId: "h", rev: 1, state: { agents: [agent("a")] } as unknown as HostState });
    feed({ type: "notify", hostId: "h", notification: note("n1", "a", "r1") });
    patch(agent("a"));
    expect(out).toEqual([]);
    patch(null, "a");
    expect(out).toEqual([{ type: "notifyDone", hostId: "h", ids: ["n1"], resolved: true }]);
  });

  test("notifyRead marks an agent's (or the host's) unread notifications read once", () => {
    const { out, sync, feed } = setup();
    feed({ type: "notify", hostId: "h", notification: note("f1", "a") });
    feed({ type: "notify", hostId: "h", notification: note("f2", "b") });
    sync.read("h", "a");
    sync.read("h", "a");
    sync.read("h");
    expect(out).toEqual([
      { type: "notifyDone", hostId: "h", ids: ["f1"], resolved: false },
      { type: "notifyDone", hostId: "h", ids: ["f2"], resolved: false },
    ]);
  });
});
