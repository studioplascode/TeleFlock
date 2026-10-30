/**
 * Demo background jobs (`jobs.*`) and services (`services.*`): the first omp agent that works runs
 * a test suite in the background (omp's widget counts the tests) and a subagent task, then waits
 * for them; its dev server and omp's shared browser run under the daemon broker.
 */
import type { Agent, Job, JobsSummary, JobsView, Service, ServiceList, ServiceLogs } from "../gen";
import { apiError } from "../errors";

const TOTAL_TESTS = 190;
const HOME = "/home/demo";

interface Env {
  now(): number;
  agents(): Agent[];
  /** Puts the summary on the agent's card (and marks it for the next patch). */
  setJobs(agentId: string, jobs: JobsSummary | undefined): void;
}

export class DemoJobs {
  private agentId?: string;
  private started = 0;
  private cancelled = new Map<string, number>();
  private stopped = new Map<string, number>();
  private last = "";

  constructor(private readonly env: Env) {}

  /** Advance the simulation; the card summary follows. */
  tick(): void {
    const now = this.env.now();
    if (!this.agentId) {
      const a = this.env.agents().find((x) => x.kind === "omp" && x.column === "running" && x.omp?.link === "live");
      if (!a) return;
      this.agentId = a.id;
      this.started = now;
    }
    const view = this.view(new Set());
    const running = view.jobs.filter((j) => j.status === "running");
    const live = running.find((j) => j.widget?.state === "live");
    const summary: JobsSummary | undefined =
      view.jobs.length === 0 && !view.waiting
        ? undefined
        : { running: running.length, recent: view.jobs.length - running.length, waiting: view.waiting, ...(live?.widget?.glance ? { glance: live.widget.glance, glanceJob: live.label } : {}) };
    const key = JSON.stringify(summary ?? null);
    if (key === this.last) return;
    this.last = key;
    this.env.setJobs(this.agentId, summary);
  }

  call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "jobs.list":
        if (p.agentId !== this.agentId) return { jobs: [], waiting: false, at: this.env.now() } satisfies JobsView;
        return this.view(new Set(p.inspectAll === true ? ["*"] : Array.isArray(p.inspect) ? (p.inspect as string[]) : []));
      case "jobs.cancel": {
        const job = this.view(new Set()).jobs.find((j) => j.id === p.jobId);
        if (!job || job.status !== "running") throw apiError("not_found", `job ${String(p.jobId)} is not running any more`);
        this.cancelled.set(job.id, this.env.now());
        this.tick();
        return this.view(new Set());
      }
      case "services.list":
        return this.services();
      case "services.logs":
        return { text: this.logOf(String(p.name)), state: this.services().scopes.flatMap((s) => s.services).find((s) => s.name === p.name)?.state, at: this.env.now() } satisfies ServiceLogs;
      case "services.stop":
      case "services.kill":
      case "services.restart": {
        const s = this.services().scopes.flatMap((x) => x.services).find((x) => x.name === p.name);
        if (!s) throw apiError("not_found", `Unknown daemon ${String(p.name)}`);
        if (method === "services.restart") this.stopped.delete(s.name);
        else this.stopped.set(s.name, this.env.now());
        return this.services().scopes.flatMap((x) => x.services).find((x) => x.name === p.name);
      }
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private view(inspect: ReadonlySet<string>): JobsView {
    const now = this.env.now();
    if (!this.agentId) return { jobs: [], waiting: false, at: now };
    const t = now - this.started;
    const passed = Math.min(TOTAL_TESTS, Math.floor(t / 400));
    const testsEnd = this.cancelled.get("bg_1") ?? (passed >= TOTAL_TESTS ? this.started + TOTAL_TESTS * 400 : undefined);
    const subEnd = this.cancelled.get("1-Bench") ?? (t > 150_000 ? this.started + 150_000 : undefined);
    const show = (id: string) => inspect.has("*") || inspect.has(id);
    const tests: Job = {
      id: "bg_1",
      kind: "bash",
      status: this.cancelled.has("bg_1") ? "cancelled" : testsEnd ? "completed" : "running",
      label: "bun test src/",
      command: "bun test src/ --reporter=dots",
      startedAt: this.started,
      endedAt: testsEnd,
      cancellable: !testsEnd,
      widget: {
        title: "bun test src/",
        glance: { text: `${passed}/${TOTAL_TESTS}`, label: "tests" },
        stage: `src/features/board/lane${passed % 12}.test.ts`,
        progress: passed / TOTAL_TESTS,
        progressText: `${passed}/${TOTAL_TESTS} tests`,
        state: "live",
        updatedAt: now,
      },
      ...(show("bg_1")
        ? { output: Array.from({ length: Math.min(passed, 14) }, (_, i) => `✓ test ${passed - Math.min(passed, 14) + i + 1}`).join("\n") + "\n", pids: testsEnd ? undefined : [41210, 41233], cwd: `${HOME}/flock/web`, exitCode: testsEnd && !this.cancelled.has("bg_1") ? 0 : undefined }
        : {}),
    };
    const sub: Job = {
      id: "1-Bench",
      kind: "task",
      status: this.cancelled.has("1-Bench") ? "cancelled" : subEnd ? "completed" : "running",
      label: "Benchmark pool sizes 8/16/32 against staging",
      startedAt: this.started + 2_000,
      endedAt: subEnd,
      agentId: "1-Bench",
      agentName: "Bench",
      cancellable: !subEnd,
      widget: { title: "pool bench", stage: "size=16 p99 18ms", state: "fallback", updatedAt: now },
      ...(show("1-Bench") ? { output: "size=8  p99 31ms\nsize=16 p99 18ms\n" } : {}),
    };
    const jobs = [tests, sub].sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running"));
    return { jobs, waiting: jobs.some((j) => j.status === "running") && t > 20_000, at: now };
  }

  private services(): ServiceList {
    const now = this.env.now();
    const svc = (name: string, extra: Partial<Service>): Service => {
      const stoppedAt = this.stopped.get(name);
      return {
        name,
        id: `demo-${name}`,
        state: stoppedAt ? "exited" : "ready",
        createdAt: now - 3_600_000,
        startedAt: now - 3_600_000,
        exitedAt: stoppedAt,
        exitCode: stoppedAt ? 143 : undefined,
        restartCount: 0,
        outputBytes: 4_096,
        persist: false,
        detached: false,
        supervised: true,
        ports: [],
        ...extra,
        ...(stoppedAt ? { pid: undefined, ports: [] } : {}),
      };
    };
    return {
      at: now,
      scopes: [
        {
          kind: "project",
          runtimeDir: `${HOME}/.omp/run/daemons/6d190fd66d150fe4`,
          projectDir: `${HOME}/flock/web`,
          brokerPid: 4100,
          services: [
            svc("web", { pid: 4122, owner: undefined, agentId: this.agentId, readyMatch: "  ➜  Local:   http://127.0.0.1:5173/", command: "/bin/bash -l -c bunx vite --host 127.0.0.1 --port 5173", cwd: `${HOME}/flock/web`, ports: [5173] }),
            svc("omp.browser.headless", { pid: 4130, command: `${HOME}/.omp/puppeteer/chrome --headless=new`, cwd: `${HOME}/flock/web`, ports: [42881] }),
          ],
        },
      ],
    };
  }

  private logOf(name: string): string {
    return name === "web" ? "  VITE v7.1.3  ready in 412 ms\n\n  ➜  Local:   http://127.0.0.1:5173/\n  ➜  press h + enter to show help\n" : "DevTools listening on ws://127.0.0.1:42881/devtools/browser/1126d2ab\n";
  }
}
