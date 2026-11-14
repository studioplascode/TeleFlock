import { describe, expect, test } from "bun:test";
import type { Agent, AppEvent, HostHealth } from "../gen";
import { DemoAgentLoads, demoLoadTarget } from "./agentLoads";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { Rng } from "./rng";

const GB = 1024 ** 3;

const agent = (id: string, p: Partial<Agent> = {}): Agent => ({ id, kind: "omp", paneId: `w1:${id}`, state: "idle", live: { streaming: false, thinking: false }, ...p }) as Agent;
const testing = (id: string) => agent(id, { state: "working", live: { streaming: false, thinking: false, tool: { name: "bash", label: "bun test src/board", startedAt: 0 } } });

describe("demo agent loads", () => {
  test("a test run takes several cores and GBs; an idle agent next to nothing", () => {
    const run = demoLoadTarget(testing("a"));
    const idle = demoLoadTarget(agent("a"));
    expect(run.cores).toBeGreaterThan(3);
    expect(run.mem - idle.mem).toBeGreaterThan(1.3 * GB);
    expect(run.procs).toBeGreaterThan(idle.procs);
    expect(idle.cores).toBeLessThan(0.05);
  });

  test("loads glide toward the target, busiest first, only for agents with a pane", () => {
    const loads = new DemoAgentLoads();
    const rng = new Rng(7);
    const agents = [agent("idle"), agent("parked", { paneId: "" }), agent("away", { parked: { at: 0, sessionFile: "/s.jsonl" } })];
    loads.next(agents, 16, rng);
    const first = loads.next([...agents, testing("busy")], 16, rng);
    expect(first.map((l) => l.agentId)).toEqual(["busy", "idle"]);
    const busy = () => loads.next([...agents, testing("busy")], 16, rng).find((l) => l.agentId === "busy")?.cpuPct ?? 0;
    const later = [busy(), busy(), busy()].at(-1) ?? 0;
    // A notable share of a 16-core host while the tests run, near zero once they end.
    expect(later).toBeGreaterThan(18);
    let after = later;
    for (let i = 0; i < 8; i++) after = loads.next([...agents, agent("busy")], 16, rng).find((l) => l.agentId === "busy")?.cpuPct ?? 0;
    expect(after).toBeLessThan(1);
  });

  test("forge's health lists its live agents, and the host is never less busy than they are together", () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    let health: HostHealth | undefined;
    engine.subscribe((e: AppEvent) => {
      if (e.type === "hostSnapshot" && e.hostId === "forge") health = e.state.health;
      if (e.type === "hostPatch" && e.hostId === "forge") for (const op of e.ops) if (op.op === "health") health = op.health;
    });
    clock.advance(30_000);
    expect(health?.agents?.length).toBeGreaterThan(3);
    const sum = (health?.agents ?? []).reduce((n, a) => n + a.cpuPct, 0);
    expect(health?.cpuPct ?? 0).toBeGreaterThanOrEqual(sum);
  });
});
