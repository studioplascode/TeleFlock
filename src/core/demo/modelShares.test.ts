import { describe, expect, test } from "bun:test";
import type { ModelShare, Spender } from "../gen";
import { agentKey } from "../keys";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** Engine + manual clock + a store fed through the real reducer. */
function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  return { clock, get state() { return state; } };
}

const named = (models: ModelShare[] | undefined, spender: Spender) => (models ?? []).filter((m) => m.spender === spender).map((m) => `${m.provider}/${m.model}`);

/** As tf-hostd sends them: each spender's shares, the largest first, add up to its figure. */
function expectShares(split: Record<Spender, number> & { models?: ModelShare[] }, tolerance: number) {
  for (const spender of ["main", "subagents", "advisor"] as const) {
    const values = (split.models ?? []).filter((m) => m.spender === spender).map((m) => m.value);
    if (values.length === 0) continue;
    expect(Math.abs(values.reduce((n, v) => n + v, 0) - split[spender])).toBeLessThanOrEqual(tolerance);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  }
}

describe("demo spend and throughput by model", () => {
  test("a session's spend splits by model: the main agent's model and side calls, each subagent's, the advisor's", () => {
    const r = rig();
    r.clock.advance(5_000);
    const split = r.state.agents[agentKey("forge", "pool")]?.omp?.cost?.split;
    expect(named(split?.models, "main")).toEqual(["openai/gpt-5.5", "openai-codex/gpt-6-luna"]);
    expect(named(split?.models, "subagents").sort()).toEqual(["anthropic/claude-sonnet-5", "openai-codex/gpt-6-luna"]);
    expect(named(split?.models, "advisor")).toEqual(["openai/gpt-5.5"]);
    if (split) expectShares(split, 1e-9);
  });

  test("while it works, each spender's rate splits by the models streaming", () => {
    const r = rig();
    let seen = 0;
    for (let i = 0; i < 160; i++) {
      r.clock.advance(250);
      const split = r.state.agents[agentKey("forge", "pool")]?.live.tpsSplit;
      if (!split) continue;
      expectShares(split, 0.3);
      if (named(split.models, "subagents").length > 0) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});
