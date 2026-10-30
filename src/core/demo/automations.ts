import { cronError, describeSpec, nextRuns, parseCron } from "../cron";
import { apiError } from "../errors";
import type { Automation, AutomationDraft, AutomationList, AutomationRun, AutomationTrigger, SchedulePreview, Started, WorktreeCreated } from "../gen";
import { HOME, repoForPath, slug, WORKTREES } from "./data";
import { agentOmpOf } from "./roleModels";
import { checkPolicy } from "./autoAnswer";

/** What the simulated tf-hostd scheduler needs from its demo host. */
export interface AutomationHostEnv {
  /** false: the host's tf-hostd predates automations (every method answers `unknown_method`). */
  supported: boolean;
  now(): number;
  herdrSession: string;
  /** The host's own method dispatch (`worktree.create`, `agent.start`, `fs.list`). */
  call(method: string, params: Record<string, unknown>): unknown;
}

const DAY = 86_400_000;
const MAX_RUNS = 100;

/** Run times of `schedule` in the `days` before `now`, oldest first. */
function pastRuns(schedule: string, now: number, days: number): number[] {
  return nextRuns(schedule, now - days * DAY, 400).filter((t) => t <= now);
}

/** `yyyymmdd-hhmm` in local time, as hostd stamps automation branches. */
function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * tf-hostd's automations for the demo: a few seeded automations with run history, `automation.*`
 * methods (save / delete / preview validate like hostd), manual runs that really start an agent
 * through the host's own `worktree.create` / `agent.start`, and due schedules firing whenever the
 * app asks (it polls while the view is open).
 */
export class DemoAutomations {
  private readonly items: Automation[] = [];
  private runs: AutomationRun[] = [];
  private nextId = 1;
  private nextRun = 1;
  /** Next fire time per automation (absent while disabled). */
  private readonly due = new Map<string, number>();

  constructor(private readonly env: AutomationHostEnv) {
    if (env.supported) this.seed();
  }

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `Unknown method ${method}`);
    this.fireDue();
    switch (method) {
      case "automation.list":
        return this.list();
      case "automation.save":
        return this.save(p as unknown as AutomationDraft);
      case "automation.delete":
        return this.remove(this.byId(p.id));
      case "automation.run":
        return this.launch(this.byId(p.id), "manual", this.env.now());
      case "automation.preview":
        return this.preview(typeof p.schedule === "string" ? p.schedule : "");
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private seed(): void {
    const now = this.env.now();
    const audit = this.add({
      name: "Nightly dependency audit",
      enabled: true,
      schedule: "0 3 * * *",
      cwd: `${HOME}/code/infra`,
      worktree: true,
      prompt: "Audit every dependency manifest for outdated or vulnerable packages. Bump patch and minor versions that pass the test suite, and open a draft PR summarising anything that needs a human decision.",
      model: "anthropic/claude-sonnet-5",
      thinking: "medium",
      plan: false,
      // Its subagents on the cheaper model; Codex limits fall back to the API.
      roleModels: { task: "openai-codex/gpt-6-luna:medium" },
      fallbackChains: { "openai-codex/*": ["openai/*"] },
      catchUp: true,
    }, now - 21 * DAY);
    const standup = this.add({
      name: "Weekday standup summary",
      enabled: true,
      schedule: "30 8 * * 1-5",
      cwd: `${HOME}/code/teleflock`,
      worktree: false,
      prompt: "Summarise yesterday's merged pull requests, failing CI runs and new issues as a short standup note. Don't change any files.",
      model: "openai-codex/gpt-6-luna",
      thinking: "low",
      plan: false,
      catchUp: false,
    }, now - 40 * DAY);
    this.add({
      name: "Weekly flaky test triage",
      enabled: false,
      schedule: "0 14 * * 5",
      cwd: `${HOME}/code/api-gateway`,
      worktree: true,
      prompt: "Find the tests that failed intermittently on main this week, reproduce them and propose fixes in one branch.",
      plan: true,
      catchUp: false,
    }, now - 9 * DAY);

    // History, oldest first (unshift keeps `runs` newest first).
    const nights = pastRuns(audit.schedule, now, 4);
    nights.forEach((at, i) => {
      const last = i === nights.length - 1;
      const failed = i === nights.length - 2;
      const branch = `automation/${slug(audit.name)}-${stamp(at)}`;
      this.record(audit, {
        at,
        trigger: i === 0 ? "catchUp" : "schedule",
        status: failed ? "failed" : "started",
        ...(failed
          ? { error: "git fetch origin failed: ssh: Could not resolve hostname github.com: Temporary failure in name resolution" }
          : { agentId: last ? "deps" : `deps-${stamp(at).slice(4, 8)}`, workspaceId: last ? "w10" : undefined, branch, path: `${WORKTREES}/infra/${slug(branch)}` }),
      });
    });
    const mornings = pastRuns(standup.schedule, now, 5);
    mornings.forEach((at, i) => {
      const last = i === mornings.length - 1;
      if (i === 0) this.record(standup, { at, trigger: "schedule", status: "skipped", agentId: "standup", error: "standup from the previous run is still working" });
      else this.record(standup, { at, trigger: "schedule", status: "started", agentId: last ? "docs" : `standup-${i}`, path: standup.cwd, workspaceId: last ? "w1" : undefined });
    });
  }

  private add(d: Omit<AutomationDraft, "id">, createdAt: number): Automation {
    const a: Automation = { ...d, id: `auto-${this.nextId++}`, herdrSession: this.env.herdrSession, createdAt, updatedAt: createdAt };
    this.items.push(a);
    this.reschedule(a);
    return a;
  }

  private record(a: Automation, run: Omit<AutomationRun, "id" | "automationId">): AutomationRun {
    const r: AutomationRun = { id: `run-${this.nextRun++}`, automationId: a.id, ...run };
    this.runs = [r, ...this.runs].sort((x, y) => y.at - x.at).slice(0, MAX_RUNS);
    a.lastRun = this.runs.find((x) => x.automationId === a.id);
    return r;
  }

  private reschedule(a: Automation): void {
    const next = a.enabled ? nextRuns(a.schedule, this.env.now(), 1)[0] : undefined;
    if (next === undefined) this.due.delete(a.id);
    else this.due.set(a.id, next);
  }

  /** Schedules that came due since the last call start now (once each, like hostd after a stall). */
  private fireDue(): void {
    const now = this.env.now();
    for (const a of this.items) {
      const at = this.due.get(a.id);
      if (at === undefined || at > now) continue;
      this.launch(a, "schedule", at);
      this.reschedule(a);
    }
  }

  private list(): AutomationList {
    const automations = this.items.map((a) => ({ ...a, nextRunAt: this.due.get(a.id) }));
    return { automations, runs: this.runs, scheduler: { kind: "systemd", persistent: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
  }

  private byId(id: unknown): Automation {
    const a = this.items.find((x) => x.id === id);
    if (!a) throw apiError("not_found", `automation ${String(id)} not found`);
    return a;
  }

  private preview(schedule: string): SchedulePreview {
    const error = cronError(schedule);
    if (error) return { valid: false, error, next: [] };
    const spec = parseCron(schedule);
    const next = nextRuns(spec, this.env.now(), 5);
    if (next.length === 0) return { valid: false, error: "This schedule never runs.", next };
    return { valid: true, next, description: describeSpec(spec) };
  }

  /** hostd's `store::validate`, messages included. */
  private save(d: AutomationDraft): Automation {
    const name = (d.name ?? "").trim();
    const prompt = (d.prompt ?? "").trim();
    const schedule = (d.schedule ?? "").trim().split(/\s+/).join(" ");
    if (!name) throw apiError("invalid_params", "Give the automation a name.");
    if ([...name].length > 80) throw apiError("invalid_params", "Names are at most 80 characters.");
    const err = cronError(schedule);
    if (err) throw apiError("invalid_params", err);
    if (nextRuns(schedule, this.env.now(), 1).length === 0) throw apiError("invalid_params", `\`${schedule}\` never runs`);
    const raw = (d.cwd ?? "").trim();
    if (!raw) throw apiError("invalid_params", d.worktree ? "Pick a repository." : "Pick a folder.");
    const cwd = raw === "~" ? HOME : raw.startsWith("~/") ? `${HOME}/${raw.slice(2)}` : raw;
    if (!cwd.startsWith("/")) throw apiError("invalid_params", `\`${raw}\` is not an absolute path`);
    try {
      this.env.call("fs.list", { path: cwd });
    } catch {
      throw apiError("invalid_params", `${cwd} is not a folder on this host`);
    }
    if (d.worktree && !repoForPath(cwd)) throw apiError("invalid_params", `${cwd} is not inside a git repository (turn off “new worktree” to run in the folder itself)`);
    if (!prompt && !d.plan) throw apiError("invalid_params", "Write the prompt the agent starts with.");
    const own = agentOmpOf(d);
    const now = this.env.now();
    const fields = {
      name,
      enabled: d.enabled,
      schedule,
      cwd,
      worktree: d.worktree,
      prompt,
      model: d.model || undefined,
      thinking: d.thinking,
      plan: d.plan,
      roleModels: Object.keys(own.roles).length > 0 ? own.roles : undefined,
      fallbackChains: Object.keys(own.chains).length > 0 ? own.chains : undefined,
      catchUp: d.catchUp,
      autoAnswer: d.autoAnswer == null ? undefined : checkPolicy(d.autoAnswer),
    };
    let a: Automation;
    if (d.id) {
      a = this.byId(d.id);
      Object.assign(a, fields, { updatedAt: now });
    } else {
      a = { ...fields, id: `auto-${this.nextId++}`, herdrSession: this.env.herdrSession, createdAt: now, updatedAt: now };
      this.items.push(a);
    }
    this.reschedule(a);
    return { ...a, nextRunAt: this.due.get(a.id) };
  }

  private remove(a: Automation): Record<string, never> {
    this.items.splice(this.items.indexOf(a), 1);
    this.due.delete(a.id);
    this.runs = this.runs.filter((r) => r.automationId !== a.id);
    return {};
  }

  /** Start the agent the way hostd does; a failure is recorded as a failed run (not thrown). */
  private launch(a: Automation, trigger: AutomationTrigger, at: number): AutomationRun {
    const agent = { kind: "omp", model: a.model, thinking: a.thinking, plan: a.plan, prompt: a.prompt, roleModels: a.roleModels, fallbackChains: a.fallbackChains, autoAnswer: a.autoAnswer };
    try {
      if (a.worktree) {
        const branch = `automation/${slug(a.name).slice(0, 40)}-${stamp(at)}`;
        const made = this.env.call("worktree.create", { cwd: a.cwd, branch, label: a.name, existing: false, trust: false, agent }) as WorktreeCreated;
        return this.record(a, { at, trigger, status: "started", agentId: made.agent?.agentId, workspaceId: made.workspaceId, branch: made.branch, path: made.path });
      }
      const started = this.env.call("agent.start", { target: { kind: "cwd", cwd: a.cwd, label: a.name }, spec: agent }) as Started;
      return this.record(a, { at, trigger, status: "started", agentId: started.agentId, workspaceId: started.workspaceId, path: a.cwd });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return this.record(a, { at, trigger, status: "failed", error });
    }
  }
}
