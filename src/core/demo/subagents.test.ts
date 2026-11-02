import { describe, expect, test } from "bun:test";
import type { AppEvent, SessionMeta, SessionSnapshot, Subagent } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const events: AppEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  clock.advance(3000);
  return { clock, call, events };
}

describe("demo nested subagents", () => {
  // pool's task (running when the demo opens): PoolBench → PoolBench.Sweep → one bench per size, as omp names them.
  test("a subagent's subagents name it as their parent, three levels deep; a grandchild fails under a sweep that finishes", async () => {
    const r = rig();
    const open = async () => (await r.call<SessionSnapshot>("session.open", { agentId: "pool" })).meta;
    const named = (subs: Subagent[], name: string) => subs.find((s) => s.name === name);
    let meta = await open();
    const bench = named(meta.subagents, "PoolBench");
    expect(bench).toMatchObject({ status: "running", parentId: undefined });
    const sweep = named(meta.subagents, "PoolBench.Sweep");
    expect(sweep).toMatchObject({ id: `${bench?.id}.Sweep`, status: "running", parentId: bench?.id });
    for (const size of ["Size16", "Size32", "Size64"]) expect(named(meta.subagents, `PoolBench.Sweep.${size}`)).toMatchObject({ status: "running", parentId: sweep?.id });
    expect(named(meta.subagents, "PoolBench.Summary")).toBeUndefined(); // PoolBench starts it once the sweep is in

    r.clock.advance(40_000);
    meta = await open();
    expect(named(meta.subagents, "PoolBench.Sweep.Size64")?.status).toBe("failed");
    expect(named(meta.subagents, "PoolBench.Sweep")?.status).toBe("done");
    expect(named(meta.subagents, "PoolBench")?.status).toBe("done");
    expect(named(meta.subagents, "PoolBench.Summary")).toMatchObject({ status: "done", parentId: bench?.id });
    // The task card lists the subagents the call started, not theirs.
    const snap = await r.call<SessionSnapshot>("session.open", { agentId: "pool" });
    const card = snap.items.findLast((i) => i.kind === "tool" && i.tool === "task");
    const agents = card?.kind === "tool" && card.view?.type === "task" ? card.view.agents : [];
    expect(agents.map((a) => a.name)).toEqual(["QueryScout", "PoolBench", "LockAudit", "SchemaDiff", "ReplayTrace", "StaleProbe", "IndexScan"]);
  });

  // The app keeps the meta an event carried (`reduce.ts`) and the React Compiler memoizes on its lists' identity: a
  // list the demo went on changing in place left the Subagents and Todos cards as they were when the session opened.
  test("a meta event keeps what it carried, as over the wire: later progress and a Kill change only the next ones", async () => {
    const r = rig();
    const metas = (agentId: string) => r.events.flatMap((e): SessionMeta[] => (e.type === "session" && e.agentId === agentId && e.ev.k === "meta" ? [e.ev.meta] : []));
    const opened = (await r.call<SessionSnapshot>("session.open", { agentId: "pool" })).meta;
    await r.call("session.open", { agentId: "kanban" });
    r.clock.advance(5_000);
    const pool = metas("pool").at(-1);
    const kanban = metas("kanban").at(-1);
    const running = pool?.subagents.find((s) => s.status === "running");
    expect(running).toBeDefined();
    const asSent = structuredClone({ opened, pool, kanban });
    await r.call("agent.subagent", { agentId: "pool", subagentId: running?.id, action: "kill" });
    r.clock.advance(60_000);
    expect({ opened, pool, kanban }).toEqual(asSent);
    expect(metas("pool").at(-1)?.subagents.find((s) => s.id === running?.id)?.status).toBe("aborted");
    expect(metas("kanban").at(-1)?.todos).not.toEqual(kanban?.todos);
  });
});
