/**
 * Demo per-agent loads (`HostHealth.agents`; tf-hostd measures them in `state/loads.rs`): every
 * agent with a pane has its process tree. Idle agents sit near zero; a working agent's own process
 * takes a slice of a core; a bash tool running tests or a build fans out over several cores and a
 * couple of GB until it ends. Figures glide toward those targets from one health tick to the next,
 * as measured ones do between samples.
 */
import type { Agent, AgentLoad } from "../gen";
import { hash, type Rng } from "./rng";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A command that keeps several cores busy. */
const HEAVY = /\b(test|bench|build|cargo|tsc|vitest|jest|pytest)\b/;

interface Load {
  cores: number;
  mem: number;
  procs: number;
}

/** What an agent's processes take right now: cores, bytes, processes. */
export function demoLoadTarget(a: Agent): Load {
  const seed = hash(a.id);
  const omp = a.kind === "omp";
  const idle: Load = { cores: 0.01 + (seed % 4) / 200, mem: (omp ? 360 : 190) * MB + (seed % 160) * MB, procs: omp ? 2 + (seed % 2) : 2 };
  if (a.state !== "working") return idle;
  const tool = a.live.tool;
  // A test run or build: workers on several cores, their heaps, a process each.
  if (tool?.name === "bash" && HEAVY.test(tool.label)) return { cores: 4.6 + (seed % 5) * 0.8, mem: idle.mem + 1.4 * GB + (seed % 8) * 0.2 * GB, procs: idle.procs + 6 + (seed % 9) };
  if (tool?.name === "bash") return { cores: 0.7, mem: idle.mem + 160 * MB, procs: idle.procs + 2 };
  // Streaming, thinking, reading files: the agent's own process.
  return { cores: 0.08 + (seed % 5) / 100, mem: idle.mem + 70 * MB, procs: idle.procs };
}

/** Each live agent's load from one health tick to the next. */
export class DemoAgentLoads {
  private readonly cur = new Map<string, Load>();

  /** The loads of `agents` with a pane on a host with `cores` cores, busiest first. */
  next(agents: readonly Agent[], cores: number, rng: Rng): AgentLoad[] {
    const out: AgentLoad[] = [];
    const live = new Set<string>();
    for (const a of agents) {
      if (!a.paneId || a.parked) continue;
      live.add(a.id);
      const want = demoLoadTarget(a);
      const was = this.cur.get(a.id) ?? want;
      // Up fast (a test run starts at once), down slower (workers wind down, heaps linger).
      const used = Math.max(0.005, was.cores + (want.cores - was.cores) * (want.cores > was.cores ? 0.75 : 0.45) + rng.range(-0.04, 0.04) * Math.max(0.2, want.cores));
      const mem = Math.round(Math.max(64 * MB, was.mem + (want.mem - was.mem) * (want.mem > was.mem ? 0.6 : 0.3) + rng.range(-8, 8) * MB));
      this.cur.set(a.id, { cores: used, mem, procs: want.procs });
      out.push({ agentId: a.id, cpuPct: Math.min(100, Math.round((used / Math.max(1, cores)) * 1000) / 10), mem, procs: want.procs });
    }
    for (const id of [...this.cur.keys()]) if (!live.has(id)) this.cur.delete(id);
    return out.sort((x, y) => y.cpuPct - x.cpuPct || y.mem - x.mem || x.agentId.localeCompare(y.agentId));
  }
}
