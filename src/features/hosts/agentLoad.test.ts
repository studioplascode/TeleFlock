import { describe, expect, test } from "bun:test";
import type { AgentLoad, HostHealth } from "@/core/gen";
import { describeLoad, formatCores, formatShare, loadLevel, nextSeries } from "./agentLoad";

const GB = 1024 ** 3;

const health = (agents: AgentLoad[], p: Partial<HostHealth> = {}): HostHealth => ({
  at: 1,
  cpuPct: 40,
  cores: 16,
  load1: 2,
  memUsed: 20 * GB,
  memTotal: 64 * GB,
  diskFree: 1e11,
  diskTotal: 1e12,
  uptimeS: 100,
  agents,
  ...p,
});

const load = (agentId: string, cpuPct: number, mem = GB / 2): AgentLoad => ({ agentId, cpuPct, mem, procs: 3 });

describe("agent loads", () => {
  test("notable from a quarter of the host's CPU when that is a core, or 2 GB (a quarter of a small host's memory)", () => {
    expect(loadLevel(load("a", 25), { cores: 16, memTotal: 64 * GB }).cpu).toBeCloseTo(1);
    // A quarter of a 2-core host is half a core: not enough to single an agent out.
    expect(loadLevel(load("a", 25), { cores: 2, memTotal: 64 * GB }).cpu).toBeCloseTo(0.5);
    expect(loadLevel(load("a", 1, 2 * GB), { cores: 16, memTotal: 64 * GB }).mem).toBeCloseTo(1);
    expect(loadLevel(load("a", 1, 1 * GB), { cores: 4, memTotal: 4 * GB }).mem).toBeCloseTo(1);
  });

  test("a card keeps its chip until the load falls well below the threshold", () => {
    let s = nextSeries(undefined, health([load("a", 30), load("b", 20)]));
    expect([s.agents.a?.notable, s.agents.b?.notable]).toEqual([true, false]);
    s = nextSeries(s, health([load("a", 20), load("b", 20)], { at: 2 }));
    expect([s.agents.a?.notable, s.agents.b?.notable]).toEqual([true, false]);
    s = nextSeries(s, health([load("a", 15)], { at: 3 }));
    expect(s.agents.a?.notable).toBe(false);
    // Agents without a running process drop out; each keeps its CPU history, newest last.
    expect(Object.keys(s.agents)).toEqual(["a"]);
    expect(s.agents.a?.cpu).toEqual([30, 20, 15]);
  });

  test("history is bounded", () => {
    let s = nextSeries(undefined, health([load("a", 0)]));
    for (let i = 1; i <= 50; i++) s = nextSeries(s, health([load("a", i)], { at: i + 1 }));
    expect(s.agents.a?.cpu.length).toBe(36);
    expect(s.agents.a?.cpu.at(-1)).toBe(50);
  });

  test("words", () => {
    expect([0, 0.3, 0.6, 38.4].map(formatShare)).toEqual(["0%", "<1%", "1%", "38%"]);
    expect([0.42, 6.08, 12.4].map(formatCores)).toEqual(["0.4", "6.1", "12"]);
    expect(describeLoad({ agentId: "a", cpuPct: 38, mem: 2.4 * GB, procs: 12 }, { cores: 16, memTotal: 64 * GB }, "forge")).toBe(
      "38% of forge's CPU (6.1 of 16 cores) and 2.4 GB of memory (4% of 64 GB), in 12 processes",
    );
  });
});
