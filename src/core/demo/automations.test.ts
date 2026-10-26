import { describe, expect, test } from "bun:test";
import type { Automation, AutomationList, AutomationRun, SchedulePreview } from "../gen";
import { DemoAutomations } from "./automations";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(5000);
  const call = async <T,>(hostId: string, method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  return { clock, call };
}

describe("demo automations", () => {
  test("seeded automations, runs and scheduler", async () => {
    const r = rig();
    const list = await r.call<AutomationList>("forge", "automation.list");
    expect(list.automations.map((a) => a.name)).toEqual(["Nightly dependency audit", "Weekday standup summary", "Weekly flaky test triage"]);
    expect(list.scheduler).toMatchObject({ kind: "systemd", persistent: true });
    expect(list.runs.map((x) => x.status)).toContain("failed");
    expect(list.runs.map((x) => x.status)).toContain("skipped");
    expect(list.runs.some((x) => x.agentId === "deps")).toBe(true);
    const disabled = list.automations.find((a) => !a.enabled);
    expect(disabled?.nextRunAt).toBeUndefined();
    for (const a of list.automations.filter((x) => x.enabled)) expect(a.nextRunAt).toBeGreaterThan(r.clock.now());
  });

  test("save validates, run starts an agent, delete removes", async () => {
    const r = rig();
    const draft = { name: "Docs sweep", enabled: true, schedule: "0 9 * * 1-5", cwd: "/home/demo/code/teleflock", worktree: true, prompt: "Fix stale docs", plan: false, catchUp: false };
    await expect(r.call("forge", "automation.save", { ...draft, schedule: "0 25 * * *" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("forge", "automation.save", { ...draft, prompt: " " })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(r.call("forge", "automation.save", { ...draft, cwd: "/home/demo/nowhere" })).rejects.toMatchObject({ code: "invalid_params" });
    const saved = await r.call<Automation>("forge", "automation.save", draft);
    expect(saved.nextRunAt).toBeGreaterThan(r.clock.now());
    const run = await r.call<AutomationRun>("forge", "automation.run", { id: saved.id });
    expect(run).toMatchObject({ status: "started", trigger: "manual" });
    expect(run.branch?.startsWith("automation/docs-sweep-")).toBe(true);
    expect(run.agentId).toBeTruthy();
    await r.call("forge", "automation.delete", { id: saved.id });
    const list = await r.call<AutomationList>("forge", "automation.list");
    expect(list.automations.some((a) => a.id === saved.id)).toBe(false);
  });

  test("due schedules fire; preview reads the schedule", async () => {
    const r = rig();
    const saved = await r.call<Automation>("forge", "automation.save", { name: "Notes", enabled: true, schedule: "* * * * *", cwd: "/home/demo/scratch", worktree: false, prompt: "Tidy notes", plan: false, catchUp: false });
    r.clock.advance(61_000);
    const list = await r.call<AutomationList>("forge", "automation.list");
    expect(list.runs.find((x) => x.automationId === saved.id)).toMatchObject({ trigger: "schedule", status: "started" });
    const preview = await r.call<SchedulePreview>("forge", "automation.preview", { schedule: "30 8 * * 1-5" });
    expect(preview).toMatchObject({ valid: true, description: "At 08:30, Monday through Friday" });
    expect(preview.next).toHaveLength(5);
    expect(await r.call<SchedulePreview>("forge", "automation.preview", { schedule: "nope" })).toMatchObject({ valid: false });
  });

  test("a host whose tf-hostd predates automations answers unknown_method", async () => {
    const old = new DemoAutomations({ supported: false, now: () => 0, herdrSession: "default", call: () => ({}) });
    await expect(Promise.resolve().then(() => old.call("automation.list", {}))).rejects.toMatchObject({ code: "unknown_method" });
  });
});
