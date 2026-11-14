import { describe, expect, test } from "bun:test";
import type { AppEvent, SessionSnapshot } from "../gen";
import { agentKey } from "../keys";
import { subagentEstimate, timeLeft, timeLeftOfAll } from "../progress";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { lastAsk, nextAsk, PROGRESS_ASKS } from "./progress";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e: AppEvent) => {
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const call = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
  const agent = (id: string) => state.agents[agentKey("forge", id)];
  /** Advances a second at a time until `done` holds (at most `ms`). */
  const until = (done: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !done(); t += 1000) clock.advance(1000);
    expect(done()).toBe(true);
  };
  // forge comes online
  clock.advance(3000);
  return { clock, call, agent, until };
}

describe("demo ask schedule", () => {
  test("the bridge's 2, 5, 10, 30, 60 minutes ten times faster, then every 6 minutes", () => {
    expect(PROGRESS_ASKS).toEqual([12_000, 30_000, 60_000, 180_000, 360_000]);
    expect([0, 12_000, 59_999, 360_000, 724_000].map(nextAsk)).toEqual([12_000, 30_000, 60_000, 720_000, 1_080_000]);
    expect([5_000, 12_000, 100_000, 392_000, 1_631_000].map(lastAsk)).toEqual([undefined, 12_000, 60_000, 360_000, 1_440_000]);
  });
});

describe("demo main-agent progress", () => {
  test("agents seeded mid-turn open with the answer to the bridge's last ask, enough to tell time left", () => {
    const r = rig();
    const now = r.clock.now();
    for (const id of ["kanban", "pool", "ci", "quota"]) {
      const p = r.agent(id)?.omp?.progress;
      if (!p) throw new Error(`${id} has no progress`);
      // made at one of the asks, the latest one so far
      expect(nextAsk(p.at - p.since - 1)).toBe(p.at - p.since);
      expect(p.at).toBeLessThanOrEqual(now);
      expect(nextAsk(p.at - p.since)).toBeGreaterThan(now - p.since);
      expect(p.pct).toBeGreaterThanOrEqual(5);
      expect(p.pct).toBeLessThanOrEqual(99);
      expect(timeLeft(p, now)).toBeDefined();
    }
    // Its current step in its words: a tool's intent, or the todo it is on while omp waits out a 429.
    expect(r.agent("kanban")?.omp?.progress?.stage).toBe("Run the board suite after the persistence change");
    expect(r.agent("quota")?.omp?.progress?.stage).toBe("Write per-tenant totals");
  });

  test("a new turn: nothing until the first ask, time left from the 60 s answer on, gone when the turn ends", async () => {
    const r = rig();
    // the scripted "tests + CI" reply: about two minutes, most of it waiting for CI
    await r.call("agent.prompt", { agentId: "scratch", text: "Add tests for the edge cases and get CI green", images: [], delivery: "auto" });
    const started = r.agent("scratch")?.omp?.turnStartedAt;
    expect(r.agent("scratch")?.column).toBe("running");
    expect(r.agent("scratch")?.omp?.progress).toBeUndefined();
    r.until(() => r.agent("scratch")?.omp?.progress !== undefined, 13_000);
    const first = r.agent("scratch")?.omp?.progress;
    expect(first).toMatchObject({ since: started, stage: expect.any(String) });
    expect(timeLeft(first ?? { pct: 0, at: 0, since: 0 }, r.clock.now())).toBeUndefined(); // 12 s in: too early
    r.until(() => (r.agent("scratch")?.omp?.progress?.at ?? 0) - (started ?? 0) >= 60_000, 50_000);
    const minute = r.agent("scratch")?.omp?.progress;
    expect(minute?.pct).toBeGreaterThan(first?.pct ?? 100);
    expect(timeLeft(minute ?? { pct: 0, at: 0, since: 0 }, r.clock.now())?.kind).toBe("left");
    r.until(() => r.agent("scratch")?.column !== "running", 120_000);
    expect(r.agent("scratch")?.omp?.progress).toBeUndefined();
  }, 30_000);
});

describe("demo subagent estimates", () => {
  test("completionAt: when the percentage last changed, only while it runs; the pool's load test tells time left", async () => {
    const r = rig();
    const subs = async () => (await r.call<SessionSnapshot>("session.open", { agentId: "pool" })).meta.subagents;
    r.clock.advance(8000);
    for (const s of await subs()) {
      if (s.status !== "running" || s.completionPct == null) {
        expect(s.completionAt).toBeUndefined();
        continue;
      }
      expect(s.completionAt).toBeGreaterThan(s.startedAt ?? Number.POSITIVE_INFINITY);
      expect(s.completionAt).toBeLessThanOrEqual(r.clock.now());
    }
    // The 26–33 s explorers never have a minute behind an estimate; once pool's question is answered,
    // its two-minute load test does.
    r.until(() => r.agent("pool")?.needs !== undefined, 60_000);
    const ask = r.agent("pool")?.needs;
    await r.call("agent.answer", { agentId: "pool", requestId: ask?.requestId, answer: { choices: ["/v1/search", "/v1/tenants"], cancel: false, chat: false } });
    r.clock.advance(100_000);
    const load = (await subs()).filter((s) => s.status === "running");
    expect(load.map((s) => s.name)).toEqual(["LoadTest", "PoolWatch"]);
    expect(timeLeftOfAll(load.map(subagentEstimate), r.clock.now())?.kind).toBe("left");
  }, 30_000);
});
