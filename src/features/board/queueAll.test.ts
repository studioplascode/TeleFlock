import { describe, expect, test } from "bun:test";
import type { AgentView, CoreState } from "@/core";
import type { Capabilities, ConnPhase, HerdrHealth } from "@/core/gen";
import { type QueueResult, queueBlock, queueSummary, runningKeys, type SendState, settleSend } from "./queueAll";

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  const hostId = over.hostId ?? "forge";
  return {
    id,
    hostId,
    key: `${hostId}::${id}`,
    name: id,
    kind: "omp",
    paneId: "p",
    tabId: "t",
    workspaceId: "w",
    state: "working",
    stateSince: 0,
    column: "running",
    archived: false,
    turns: 3,
    title: `${id} task`,
    repo: "teleflock",
    live: { streaming: true, thinking: false },
    omp: { link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] } },
    ...over,
  } as unknown as AgentView;
}

const CAPS_OFF = { prompt: false, steer: false, followUp: false } as Capabilities;

function state(agents: AgentView[], opts: { phase?: Record<string, ConnPhase>; herdr?: Record<string, HerdrHealth>; caps?: Record<string, Capabilities> } = {}): CoreState {
  const ids = ["forge", "studio"];
  return {
    profiles: ids.map((id) => ({ id, name: id === "studio" ? "studio-pc" : id })),
    status: Object.fromEntries(ids.map((id) => [id, { phase: opts.phase?.[id] ?? "online" }])),
    hosts: Object.fromEntries(ids.map((id) => [id, { state: { info: { herdrHealth: opts.herdr?.[id] } } }])),
    agents: Object.fromEntries(agents.map((a) => [a.key, a])),
    sessions: Object.fromEntries(Object.entries(opts.caps ?? {}).map(([key, caps]) => [key, { meta: { caps } }])),
  } as unknown as CoreState;
}

describe("who the message goes to", () => {
  test("the running agents of the board's host and repo filters, longest running first", () => {
    const s = state([
      agent("kanban", { stateSince: 300 }),
      agent("pool", { stateSince: 100, repo: "api-gateway" }),
      agent("hero", { column: "review", state: "done" }),
      agent("render", { hostId: "studio", stateSince: 200 }),
    ]);
    expect(runningKeys(s, { hostId: "all", repo: null })).toEqual(["forge::pool", "studio::render", "forge::kanban"]);
    expect(runningKeys(s, { hostId: "forge", repo: null })).toEqual(["forge::pool", "forge::kanban"]);
    expect(runningKeys(s, { hostId: "all", repo: "teleflock" })).toEqual(["studio::render", "forge::kanban"]);
  });
});

describe("why an agent can't take it", () => {
  test("an omp agent linked live takes it; other kinds and links say why", () => {
    const s = state([
      agent("kanban"),
      agent("copy", { kind: "claude", omp: undefined }),
      agent("flaky", { omp: { ...agent("x").omp, link: "notShared" } as AgentView["omp"] }),
      agent("watch", { omp: { ...agent("x").omp, link: "notShared", linkReason: "viewOnly" } as AgentView["omp"] }),
      agent("fresh", { omp: { ...agent("x").omp, link: "connecting" } as AgentView["omp"] }),
    ]);
    expect(queueBlock(s, "forge::kanban")).toBeNull();
    expect(queueBlock(s, "forge::copy")).toBe("claude agent: only its terminal takes input");
    expect(queueBlock(s, "forge::flaky")).toBe("Not connected to TeleFlock: Connect it first");
    expect(queueBlock(s, "forge::watch")).toBe("Shared read-only: Connect it again with control");
    expect(queueBlock(s, "forge::fresh")).toBe("Connecting to its session…");
  });

  test("an open session's capabilities tell a read-only link", () => {
    const s = state([agent("deps"), agent("pool")], { caps: { "forge::deps": CAPS_OFF, "forge::pool": { ...CAPS_OFF, followUp: true } } });
    expect(queueBlock(s, "forge::deps")).toBe("Read-only session: it takes no messages");
    expect(queueBlock(s, "forge::pool")).toBeNull();
  });

  test("a host that isn't online, or whose herdr isn't up, comes first", () => {
    const down = { state: "down", since: 0 } as unknown as HerdrHealth;
    const s = state([agent("render", { hostId: "studio" }), agent("kanban"), agent("copy", { kind: "claude" })], { phase: { studio: "offline" }, herdr: { forge: down, studio: down } });
    expect(queueBlock(s, "studio::render")).toBe("studio-pc is offline");
    expect(queueBlock(s, "forge::kanban")).toBe("herdr isn't running on forge");
    expect(queueBlock(s, "forge::copy")).toBe("herdr isn't running on forge");
  });

  test("an agent whose turn ended meanwhile still takes it; one asking, closed or gone doesn't", () => {
    const s = state([
      agent("hero", { column: "review", state: "done" }),
      agent("push", { column: "needs", state: "blocked" }),
      agent("docs", { column: "done", state: "idle", parked: { at: 0, sessionFile: "/s.jsonl" } as AgentView["parked"] }),
    ]);
    expect(queueBlock(s, "forge::hero")).toBeNull();
    expect(queueBlock(s, "forge::push")).toBe("Waiting for your answer");
    expect(queueBlock(s, "forge::docs")).toBe("Closed: a message would resume it");
    expect(queueBlock(s, "forge::gone")).toBe("It closed");
  });
});

describe("the toast after Send", () => {
  const ok = (name: string) => ({ key: `forge::${name}`, name });
  const failed = (name: string) => ({ key: `forge::${name}`, name, error: "the agent is waiting for an answer" });

  test("counts what went through and keeps who failed", () => {
    expect(queueSummary(["a", "b", "c", "d", "e"].map(ok), "followUp")).toEqual({ title: "Queued for 5 agents", failed: [] });
    expect(queueSummary([ok("kanban")], "followUp").title).toBe("Queued for kanban");
    const partial = queueSummary([ok("a"), failed("b"), ok("c"), failed("d"), ok("e")], "followUp");
    expect(partial.title).toBe("Queued for 3 of 5 agents");
    expect(partial.failed.map((r) => r.name)).toEqual(["b", "d"]);
    expect(queueSummary([failed("a"), failed("b")], "followUp").title).toBe("Couldn't queue the message");
  });

  test("Steer now sends rather than queues", () => {
    expect(queueSummary([ok("a"), ok("b")], "auto").title).toBe("Sent to 2 agents");
    expect(queueSummary([failed("a")], "auto").title).toBe("Couldn't send the message");
  });
});

describe("a send that answers late", () => {
  const ok = (name: string): QueueResult => ({ key: `forge::${name}`, name });
  const failed = (name: string): QueueResult => ({ key: `forge::${name}`, name, error: "the agent is waiting for an answer" });

  /** A send the test answers when it likes, settled as the dialog does: against the dialog as it is by then. */
  function deferredSend(dialog: SendState) {
    const sent = { ...dialog };
    let answer: (results: QueueResult[]) => void = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const answered = new Promise<QueueResult[]>((resolve) => {
      answer = resolve;
    });
    const settled = answered.then((results) => settleSend(sent, dialog, results.filter((r) => r.error !== undefined).length));
    return { answer: (results: QueueResult[]) => answer(results), settled };
  }

  test("text edited before it answers stays, and the dialog stays open over it", async () => {
    const dialog = { gen: 1, draft: "Run the tests" };
    const send = deferredSend(dialog);
    dialog.draft = "Run the tests, then commit";
    send.answer([ok("kanban"), ok("pool")]);
    expect(await send.settled).toBe("keep");
  });

  test("closed and opened again before it answers: the new dialog keeps its draft, stays open, and keeps its picks", async () => {
    const dialog = { gen: 1, draft: "Run the tests" };
    const all = deferredSend(dialog);
    const some = deferredSend(dialog);
    dialog.gen = 2;
    all.answer([ok("kanban")]);
    some.answer([ok("kanban"), failed("pool")]);
    expect(await all.settled).toBe("elsewhere");
    expect(await some.settled).toBe("elsewhere");
  });

  test("the same text still in the box: everyone got it clears and closes, a failure stays open for a retry", async () => {
    const dialog = { gen: 3, draft: "Run the tests" };
    const done = deferredSend(dialog);
    const retry = deferredSend(dialog);
    done.answer([ok("kanban"), ok("pool")]);
    retry.answer([ok("kanban"), failed("pool")]);
    expect(await done.settled).toBe("done");
    expect(await retry.settled).toBe("retry");
  });
});
