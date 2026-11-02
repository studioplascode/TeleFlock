import { describe, expect, test } from "bun:test";
import type { Job, JobsSummary, JobsView } from "@/core/gen";
import { DemoJobs } from "@/core/demo/jobs";
import { commandSummary, inspectIds, jobTitle, jobsPollMs, keepExpanded, meterText, summaryKey, waitingText, withoutSubagents } from "./jobsModel";

const summary = (running: number, extra: Partial<JobsSummary> = {}): JobsSummary => ({ running, recent: 0, waiting: false, ...extra });
const job = (id: string, extra: Partial<Job> = {}): Job => ({ id, kind: "bash", status: "running", label: id, startedAt: 1, cancellable: true, ...extra });
const view = (jobs: Job[]): JobsView => ({ jobs, waiting: false, at: 1 });

describe("jobs model", () => {
  test("subagent (task) jobs are not background jobs, at any nesting depth; a command a subagent started stays", () => {
    const v: JobsView = {
      jobs: [
        job("0-Build", { kind: "task", label: "baseline release", agentName: "Build" }),
        job("bg_1", { label: "bun test", ownerId: "0-Build", ownerName: "Build" }),
        job("0-Build.0-Nested", { kind: "task", ownerId: "0-Build", ownerName: "Build" }),
        job("bg_2", { kind: "eval", status: "completed" }),
      ],
      waiting: true,
      at: 5,
    };
    const shown = withoutSubagents(v);
    expect(shown.jobs.map((j) => j.id)).toEqual(["bg_1", "bg_2"]);
    expect(shown.waiting).toBe(true); // omp's wait also covers subagents: untouched
    expect(withoutSubagents(shown)).toBe(shown);
    expect(withoutSubagents(view([]))).toEqual(view([]));
  });

  test("the panel recounts the card summary from commands only, and drops a glance of a subagent", () => {
    const wire = summary(22, { recent: 3, waiting: true, glance: { text: "3/9" }, glanceJob: "baseline release" });
    const v = withoutSubagents(view([job("0-Build", { kind: "task", label: "baseline release" }), job("bg_1", { label: "bun test" }), job("bg_2", { status: "completed" })]));
    const counted = commandSummary(wire, v);
    expect(counted).toMatchObject({ running: 1, recent: 1, waiting: true });
    expect(counted.glance).toBeUndefined();
    expect(waitingText(counted)).toBe("Waiting for background work");
    expect(commandSummary(wire, withoutSubagents(view([job("bg_1", { label: "baseline release" })])))).toMatchObject({ glanceJob: "baseline release" });
    expect(commandSummary(wire, undefined)).toBe(wire); // before the first read
  });

  test("an open panel polls every second while a job runs, never otherwise", () => {
    expect(jobsPollMs(summary(2), true)).toBe(1_000);
    expect(jobsPollMs(summary(0, { recent: 3 }), true)).toBeNull();
    expect(jobsPollMs(summary(2), false)).toBeNull();
    expect(jobsPollMs(undefined, true)).toBeNull();
    expect(summaryKey(summary(2, { waiting: true }))).not.toBe(summaryKey(summary(2)));
  });

  test("words: the wait in omp's terms, the card meter with the widget's glance", () => {
    expect(waitingText(summary(1, { waiting: true, glanceJob: "bun test" }))).toBe("Waiting for background job bun test");
    expect(waitingText(summary(3, { waiting: true }))).toBe("Waiting for 3 background jobs");
    expect(waitingText(summary(0, { waiting: true }))).toBe("Waiting for background work");
    expect(meterText(summary(2, { glance: { text: "140/190", label: "tests" } }))).toBe("2 · 140/190 tests");
    expect(meterText(summary(1))).toBe("1");
    expect(jobTitle(job("t", { kind: "task", agentName: "Bench", label: "Benchmark pools" }))).toBe("Bench: Benchmark pools");
    expect(jobTitle(job("b", { command: "bun   test\n --watch" }))).toBe("bun test --watch");
  });

  test("expanded rows follow the jobs; the first running job is inspected by default", () => {
    const v = view([job("bg_1", { status: "completed" }), job("bg_2")]);
    expect([...keepExpanded(new Set(["bg_1", "gone"]), v)]).toEqual(["bg_1"]);
    expect(inspectIds(new Set(), v)).toEqual(["bg_2"]);
    expect(inspectIds(new Set(["bg_1"]), v)).toEqual(["bg_1"]);
    expect(inspectIds(new Set(), undefined)).toEqual([]);
  });
});

describe("demo jobs", () => {
  test("a working omp agent runs tests and a subagent, waits for them; Kill cancels; services list", () => {
    let now = 1_000;
    const cards: Array<JobsSummary | undefined> = [];
    const agent = { id: "a1", kind: "omp", column: "running", omp: { link: "live" } };
    const demo = new DemoJobs({ now: () => now, agents: () => [agent as never], setJobs: (_id, s) => cards.push(s) });
    demo.tick();
    now += 30_000;
    demo.tick();
    const last = cards.at(-1)!;
    expect(last).toMatchObject({ running: 1, waiting: true, glance: { text: "75/190", label: "tests" }, glanceJob: "bun test src/" });
    const listed = demo.call("jobs.list", { agentId: "a1", inspect: ["bg_1"] }) as JobsView;
    expect(listed.jobs[0]).toMatchObject({ id: "bg_1", status: "running", cwd: "/home/demo/flock/web" });
    expect(listed.jobs[0]!.output).toContain("✓ test 75");
    const after = demo.call("jobs.cancel", { agentId: "a1", jobId: "bg_1" }) as JobsView;
    expect(after.jobs.find((j) => j.id === "bg_1")?.status).toBe("cancelled");
    expect(() => demo.call("jobs.cancel", { agentId: "a1", jobId: "bg_1" })).toThrow();
    expect(cards.at(-1)).toMatchObject({ running: 0, recent: 1 });
    const services = demo.call("services.list", {}) as { scopes: Array<{ services: Array<{ name: string; ports: number[] }> }> };
    expect(services.scopes[0]!.services.map((s) => [s.name, s.ports])).toEqual([["web", [5173]], ["omp.browser.headless", [42881]]]);
    expect(demo.call("services.stop", { dir: "/home/demo/flock/web", name: "web" })).toMatchObject({ state: "exited" });
  });
});
