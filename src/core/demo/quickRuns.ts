import type { ShellResult } from "@/core/gen";
import { apiError } from "../errors";
import { quickCommand } from "../quickCommand";
import type { AgentSim } from "./agent";
import type { DemoClock } from "./clock";
import { type CannedRun, cannedShell, type TermContext } from "./term";

/** The demo shell's view of an agent's folder: what its canned commands read. */
export type ShellContext = Pick<TermContext, "cwd" | "branch" | "agents" | "gitStatus">;

/**
 * omp's quick commands in the demo (`agent.shell`, or typed in an agent's terminal), run as omp runs
 * them: `!` and `!!` the demo shell's canned commands, `$` and `$$` a small Python stand-in. The run
 * lands as the agent's row once it ends, and the call answers then (`settled`). One shell command
 * and one Python run at a time per agent, as in omp.
 */
export class DemoQuickRuns {
  private readonly running = new Set<string>();

  constructor(private readonly clock: DemoClock) {}

  /** `typed`: in omp's own terminal, which runs it whatever TeleFlock's bridge can do. */
  run(sim: AgentSim, text: string, ctx: ShellContext, typed = false): Promise<ShellResult> {
    if (!typed && !sim.caps.shell) {
      throw apiError("unsupported", `${sim.agent.name} runs a TeleFlock bridge older than 2.5.0, without omp's \`!\` and \`$\` commands`, { hint: "Restart the agent to update its bridge" });
    }
    const q = quickCommand(text);
    if (!q) throw apiError("invalid_params", "not one of omp's quick commands: `!cmd`, `!!cmd`, `$ code` or `$$ code`");
    const slot = `${sim.agent.id}:${q.python ? "python" : "bash"}`;
    if (this.running.has(slot)) throw apiError("busy", q.python ? "A Python execution is already running" : "A bash command is already running", { retryable: true });
    this.running.add(slot);
    const ran = q.python ? fakePython(q.body, ctx.cwd) : cannedShell(q.body, ctx);
    const ms = ran.everyMs ? ran.everyMs * ran.lines.length : 350;
    // Executor form: the app's TS lib (ES2023) predates `Promise.withResolvers`.
    return new Promise((resolve) => {
      this.clock.after(ms, () => {
        this.running.delete(slot);
        sim.ran({ python: q.python, excluded: q.excluded, body: q.body, output: ran.lines.length ? `${ran.lines.join("\n")}\n` : "", exitCode: ran.exitCode });
        resolve({ settled: true });
      });
    });
  }
}

/** A stand-in for omp's Python kernel: `print` of a string, a whole number or the working folder prints it; the rest runs quietly. */
function fakePython(code: string, cwd: string): CannedRun {
  const lines = code.split("\n").flatMap((line) => {
    const arg = /^\s*print\((.*)\)\s*$/.exec(line)?.[1]?.trim();
    if (arg === undefined) return [];
    const quoted = /^(["'])(.*)\1$/.exec(arg);
    if (quoted) return [quoted[2] ?? ""];
    if (/^-?\d+$/.test(arg)) return [arg];
    return arg === "os.getcwd()" ? [cwd] : [];
  });
  return { lines, exitCode: 0 };
}
