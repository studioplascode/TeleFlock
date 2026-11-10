import { describe, expect, test } from "bun:test";
import type { SessionSnapshot, ShellResult, ToolItem } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  const call = async <T = unknown>(method: string, params: unknown = {}, advance = 3000): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(advance);
    return (await p) as T;
  };
  const runs = async (agentId: string) => (await call<SessionSnapshot>("session.open", { agentId })).items.filter((i): i is ToolItem & { kind: "tool" } => i.kind === "tool" && i.userRun != null);
  clock.advance(3000);
  return { clock, engine, call, runs };
}

describe("omp's quick commands in the demo", () => {
  test("`!` and `!!` run the demo shell's commands and land as the user's rows", async () => {
    const r = rig();
    expect(await r.call<ShellResult>("agent.shell", { agentId: "kanban", text: "!ls" })).toEqual({ settled: true });
    expect(await r.call<ShellResult>("agent.shell", { agentId: "kanban", text: " !!git status " })).toEqual({ settled: true });
    const [ls, status] = await r.runs("kanban");
    expect(ls).toMatchObject({ tool: "bash", status: "ok", userRun: { python: false, excluded: false }, view: { type: "bash", command: "ls", exitCode: 0 } });
    expect(ls?.view?.type === "bash" && ls.view.output).toContain("package.json");
    expect(status).toMatchObject({ userRun: { python: false, excluded: true }, view: { type: "bash", command: "git status" } });
    expect(status?.view?.type === "bash" && status.view.output).toMatch(/^On branch/);
  });

  test("`$` and `$$` run the Python stand-in; a failing command keeps its exit code", async () => {
    const r = rig();
    await r.call("agent.shell", { agentId: "kanban", text: '$ print("hi")' });
    await r.call("agent.shell", { agentId: "kanban", text: "$$ print(2)" });
    await r.call("agent.shell", { agentId: "kanban", text: "!nope" });
    const [hi, two, nope] = await r.runs("kanban");
    expect(hi).toMatchObject({ tool: "python", userRun: { python: true, excluded: false }, view: { type: "bash", command: 'print("hi")', output: "hi\n" } });
    expect(two).toMatchObject({ userRun: { python: true, excluded: true }, view: { type: "bash", output: "2\n" } });
    expect(nope).toMatchObject({ status: "error", view: { type: "bash", exitCode: 127 } });
  });

  test("not a quick command, one at a time, and a session without the bridge's `shell`", async () => {
    const r = rig();
    for (const text of ["hello", "!", "$ git status", "$print(1)"]) {
      await expect(r.call("agent.shell", { agentId: "kanban", text })).rejects.toMatchObject({ code: "invalid_params" });
    }
    // `bun test` streams for ~2 s: a second shell command meanwhile is omp's "already running".
    const first = r.engine.callHost("forge", "agent.shell", { agentId: "kanban", text: "!bun test" });
    await expect(r.call("agent.shell", { agentId: "kanban", text: "!ls" }, 100)).rejects.toMatchObject({ code: "busy", retryable: true });
    r.clock.advance(3000);
    expect(await first).toEqual({ settled: true });
    // deps is a read-only collab link: its caps have no `shell`.
    await expect(r.call("agent.shell", { agentId: "deps", text: "!ls" })).rejects.toMatchObject({ code: "unsupported", hint: "Restart the agent to update its bridge" });
  });
});
