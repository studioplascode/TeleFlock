import { describe, expect, test } from "bun:test";
import type { AgentChatLog, AgentChatMessage, SessionSnapshot } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return { clock, call };
}

/** Direct messages from one agent to another (broadcasts aside). */
const between = (log: readonly AgentChatMessage[], from: string, to: string) => log.filter((m) => m.from === from && m.to.includes(to) && !m.broadcast);

describe("demo agent chat", () => {
  // pool's task runs when the demo opens: its tree talks while it does.
  test("pool's whole tree: nested orchestrators and their workers, scouts with each other, broadcasts (one that reached no one), replies, a refused send", async () => {
    const r = rig();
    const meta = async () => (await r.call<SessionSnapshot>("session.open", { agentId: "pool" })).meta;
    const first = (await meta()).agentChat;
    expect(first).toMatchObject({ live: true });

    r.clock.advance(45_000);
    const info = (await meta()).agentChat;
    expect(info?.epoch).toBe(first?.epoch);
    expect(info?.count).toBeGreaterThan(first?.count ?? Number.POSITIVE_INFINITY);
    const log = await r.call<AgentChatLog>("session.agentChat", { agentId: "pool" });
    expect(log).toMatchObject({ epoch: info?.epoch, rev: info?.rev, reset: true, truncated: false, live: true });
    expect(log.messages).toHaveLength(info?.count ?? -1);
    const all = log.messages;
    expect(all.map((m) => m.at)).toEqual([...all.map((m) => m.at)].sort((a, b) => a - b));

    // Main's own IRC (what its transcript shows) is in it, and so is everything it never saw.
    expect(between(all, "QueryScout", "Main")).toHaveLength(1);
    expect(between(all, "Main", "PoolBench")[0]?.replyTo).toBe(between(all, "PoolBench", "Main")[0]?.id);
    expect(between(all, "PoolBench", "PoolBench.Sweep")).toHaveLength(1);
    expect(between(all, "PoolBench.Sweep", "PoolBench.Sweep.Size64").length).toBe(2);
    expect(between(all, "QueryScout", "LockAudit")).toHaveLength(1);
    const answer = between(all, "LockAudit", "QueryScout")[0];
    expect(answer?.replyTo).toBe(between(all, "QueryScout", "LockAudit")[0]?.id);

    const [staleAll, broadcast, allClear] = all.filter((m) => m.broadcast);
    // StaleProbe was stopped while it announced its probe: the broadcast got out to no one.
    expect(staleAll).toMatchObject({ from: "StaleProbe", to: [], receipts: [] });
    expect(broadcast).toMatchObject({ from: "PoolBench", to: ["Main", "QueryScout", "LockAudit", "PoolBench.Sweep", "PoolBench.Sweep.Size16", "PoolBench.Sweep.Size32"] });
    // omp queued it for the busy ones; by now every one took it in (Size16 as it ended).
    expect(broadcast?.receipts.every((x) => x.outcome === "received")).toBe(true);
    // The all-clear reaches only who still runs: Main and the sweep.
    expect(allClear).toMatchObject({ from: "PoolBench", to: ["Main", "PoolBench.Sweep"] });

    // Size64 had failed by then: omp refused the sweep's retry.
    const [, retry] = between(all, "PoolBench.Sweep", "PoolBench.Sweep.Size64");
    expect(retry?.receipts).toEqual([{ to: "PoolBench.Sweep.Size64", outcome: "failed", error: "Failed: PoolBench.Sweep.Size64 is not running." }]);
    expect(all.find((m) => m.progress)).toMatchObject({ from: "PoolBench.Sweep", to: ["PoolBench"] });
    expect(all.find((m) => m.wakeRelay)?.replyTo).toBe(between(all, "Main", "PoolBench")[0]?.id);

    // Nothing new: an empty page at the same revision.
    expect(await r.call<AgentChatLog>("session.agentChat", { agentId: "pool", epoch: log.epoch, after: log.rev })).toMatchObject({ messages: [], reset: false, rev: log.rev });
  });

  test("pages: only what changed after a revision; another epoch gets the whole log", async () => {
    const r = rig();
    await r.call("session.open", { agentId: "pool" });
    r.clock.advance(7_000);
    const early = await r.call<AgentChatLog>("session.agentChat", { agentId: "pool" });
    expect(early.messages.length).toBeGreaterThan(0);
    const pending = early.messages.filter((m) => m.receipts.some((x) => x.outcome === "pending"));
    r.clock.advance(30_000);
    const next = await r.call<AgentChatLog>("session.agentChat", { agentId: "pool", epoch: early.epoch, after: early.rev });
    expect(next.reset).toBe(false);
    expect(next.messages.every((m) => m.rev > early.rev)).toBe(true);
    // New messages, and the ones that were in flight again with their receipt; ids stay.
    expect(next.messages.some((m) => !early.messages.some((e) => e.id === m.id))).toBe(true);
    for (const p of pending) expect(next.messages.find((m) => m.id === p.id)?.receipts.some((x) => x.outcome === "pending")).toBe(false);
    const fresh = await r.call<AgentChatLog>("session.agentChat", { agentId: "pool", epoch: "gone", after: early.rev });
    expect(fresh.reset).toBe(true);
    expect(fresh.messages.length).toBe(early.messages.length + next.messages.filter((m) => !early.messages.some((e) => e.id === m.id)).length);
  });

  test("Main's answer to QueryScout, busy with a long run, is queued until QueryScout takes it in", async () => {
    const r = rig();
    const open = () => r.call<SessionSnapshot>("session.open", { agentId: "pool" });
    const t0 = (await open()).meta.subagents.find((s) => s.name === "QueryScout")?.startedAt;
    if (t0 === undefined) throw new Error("pool's task did not start");
    const at = (ms: number) => r.clock.advance(t0 + ms - r.clock.now());
    const answer = async () => between((await r.call<AgentChatLog>("session.agentChat", { agentId: "pool" })).messages, "Main", "QueryScout")[0];

    // Sent 8.6 s into the task; omp settles it 0.7 s later.
    at(9_000);
    expect((await answer())?.receipts).toEqual([{ to: "QueryScout", outcome: "pending" }]);
    at(15_000);
    const queued = await answer();
    expect(queued?.receipts).toEqual([{ to: "QueryScout", outcome: "injected" }]);
    // Main's transcript row of the send and the log's message tell the same time (the bubble finds it by that).
    const row = (await open()).items.find((i) => i.kind === "tool" && i.view?.type === "irc" && i.view.peer === "QueryScout");
    expect(row?.at).toBe(queued?.at);
    const rev = (await open()).meta.agentChat?.rev ?? 0;
    at(22_000);
    const got = await answer();
    expect(got?.receipts).toEqual([{ to: "QueryScout", outcome: "received" }]);
    expect(got?.rev).toBeGreaterThan(rev);
    expect((await open()).meta.agentChat?.rev).toBeGreaterThanOrEqual(got?.rev ?? Number.POSITIVE_INFINITY);
  });

  test("the user's message to every running subagent is one message from user", async () => {
    const r = rig();
    r.clock.advance(4_000);
    const subs = (await r.call<SessionSnapshot>("session.open", { agentId: "pool" })).meta.subagents.filter((s) => s.status === "running");
    expect(subs.length).toBeGreaterThan(2);
    for (const s of subs) await r.call("agent.subagent", { agentId: "pool", subagentId: s.id, action: "chat", message: "Hold off on staging for a minute.", broadcast: true });
    await r.call("agent.subagent", { agentId: "pool", subagentId: subs[0]?.id, action: "chat", message: "Rank per request." });
    const log = await r.call<AgentChatLog>("session.agentChat", { agentId: "pool" });
    const mine = log.messages.filter((m) => m.from === "user");
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ broadcast: true, to: subs.map((s) => s.name), text: "Hold off on staging for a minute." });
    expect(mine[1]).toMatchObject({ broadcast: false, to: [subs[0]?.name], receipts: [{ to: subs[0]?.name, outcome: "injected" }] });
  });

  test("other sessions: the transcript's IRC rows", async () => {
    const r = rig();
    await r.call("session.open", { agentId: "push" });
    const log = await r.call<AgentChatLog>("session.agentChat", { agentId: "push" });
    expect(log.messages.map((m) => [m.from, m.to.join()])).toEqual([
      ["FcmScout", "Main"],
      ["Main", "FcmScout"],
      ["NtfyScout", "Main"],
    ]);
  });
});
