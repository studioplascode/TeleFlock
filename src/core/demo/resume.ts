import type { AutoResume, AutoResumeConfig, RetryResult } from "@/core/gen";
import { apiError } from "../errors";
import { lastTurnRetryable } from "../retryable";
import type { AgentSim } from "./agent";
import type { AgentDef } from "./data";
import { bash, read, say, type Step, think } from "./scripts";

/*
 * omp's retry (F5, `agent.retry`) and tf-hostd's auto-resume after provider limits on the demo
 * host: seeded agents whose last turn failed (with a failed subagent), one waiting for its usage
 * window (a subagent stopped on the same limit), one that won't resume by itself, and a live agent
 * cut off mid-turn (`restart`). Ended cards and their `restart` tickets live in `./parking`.
 */

const MIN = 60_000;
/** Resume now: "resuming" this long before the agents work again, then cleared this long after. */
const RESUME_MS = 1200;
const CLEAR_MS = 3500;
/** A retried subagent finishes after this long. */
const SUB_RETRY_MS = 8000;

const METHODS: Record<string, true> = { "agent.retry": true, "agent.autoResumeNow": true, "agent.autoResumeCancel": true, "host.autoResume": true, "host.autoResumeSet": true };

/** What the resume demo needs from its DemoHost (closures over the host's state). */
export interface ResumeHost {
  now(): number;
  after(ms: number, fn: () => void): () => void;
  /** This host's tf-hostd has them (studio-pc plays one that predates 0.7.0: `unknown_method`). */
  supported(): boolean;
  /** The live omp agent `agentId` names; throws like the host (not found, not omp, not connected). */
  ompSim(agentId: unknown): AgentSim;
  /** A seeded agent in a new pane of `workspaceId`. */
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
  changed(agentId: string): void;
  metaChanged(agentId: string): void;
}

interface Seed {
  def: AgentDef;
  steps: Step[];
  line: string;
  ticket?(now: number, stopped: string[]): AutoResume;
}

const SEEDS: Seed[] = [
  {
    def: { id: "bench", kind: "omp", workspace: "w2", column: "review", model: "sonnet-5", thinking: "medium", since: 420, age: 2400, ctxPct: 29, cost: 0.86, title: "Load-test the gateway at 2k RPS and find where p99 breaks", files: [] },
    line: "Connection error: socket hang up",
    steps: [
      { t: "user", text: "Load-test the gateway at 2k RPS and tell me where p99 breaks." },
      think("One subagent drives the load, one samples the pool while it runs; then I read both.", 3200),
      {
        t: "tool",
        spec: {
          tool: "task",
          title: "2 subagents load-testing the gateway",
          intent: "Drive load and watch the pool",
          args: { tasks: 2 },
          ms: 26_000,
          subagents: [
            { name: "PoolWatch", description: "Sample pgxpool stats every second during the run", ms: 24_000, model: "luna", lines: ["polling /debug/pool", "peak 61 of 64 connections at 1.8k RPS"] },
            { name: "LoadGen", description: "Drive 2k RPS at staging with k6 for 60 s", ms: 9_000, model: "luna", end: "failed", lines: ["starting k6", "k6: dial tcp staging:8443: connection refused"] },
          ],
        },
      },
      say("PoolWatch saw the pool saturate near **1.8k RPS**; LoadGen couldn't reach staging. Running the load from this host instead."),
      bash("k6 run --vus 400 --duration 60s bench/gateway.js", ["running (0m12s), 400/400 VUs, 24112 complete iterations", "http_req_duration: p(99)=212ms"], 14_000),
      { t: "fail", error: "Connection error: socket hang up (ECONNRESET) while streaming the response" },
    ],
  },
  {
    def: { id: "audit", kind: "omp", workspace: "w10", column: "review", model: "opus-5", thinking: "high", since: 1500, age: 3600, ctxPct: 44, cost: 2.74, title: "Move plain-text secrets in the Ansible roles to vault", files: [] },
    line: "Usage limit: the 5-hour window is used up",
    steps: [
      { t: "user", text: "Find secrets committed in plain text in the Ansible roles and move them to vault." },
      think("Scan the vars and templates here; a subagent searches the git history in parallel.", 3600),
      read("roles/tailscale/defaults/main.yml", 64),
      {
        t: "tool",
        spec: {
          tool: "task",
          title: "2 subagents hunting for plain-text secrets",
          intent: "Scan the files and the history",
          args: { tasks: 2 },
          ms: 30_000,
          subagents: [
            { name: "VarsScan", description: "Grep roles/ for tokens, keys and passwords", ms: 18_000, model: "sonnet-5", lines: ["scanning roles/*/defaults", "3 plain-text secrets in 2 roles"] },
            { name: "HistoryScan", description: "Search git history for secrets removed but never rotated", ms: 22_000, model: "sonnet-5", end: "failed", lines: ["git log -p -- roles/", "stopped: usage limit reached"] },
          ],
        },
      },
      say("VarsScan found **3 plain-text secrets** in `roles/tailscale` and `roles/herdr`. Moving them to vault next."),
      { t: "fail", error: "429 usage_limit_reached: the 5-hour usage limit of this Claude Max account is used up", status: 429 },
    ],
    ticket: (now, stopped) => ({ status: "waiting", kind: "usageLimit", reason: "Claude Max 5-hour limit reached", provider: "anthropic", model: "claude-opus-5", resumeAt: now + 120 * MIN, basis: "window", since: now - 25 * MIN, attempts: 0, root: true, subagentIds: stopped }),
  },
  {
    def: { id: "i18n", kind: "omp", workspace: "w12", column: "review", model: "luna", thinking: "medium", since: 10_800, age: 14_400, ctxPct: 23, cost: 0.32, title: "Translate the pricing page into German and French", files: [] },
    line: "Won't resume by itself: omp exited while waiting",
    steps: [
      { t: "user", text: "Translate the pricing page into German and French; keep the plan names in English." },
      think("Extract the strings first so both translations share one key list.", 2800),
      read("src/components/Pricing.tsx", 180),
      say("Extracted **42 strings**. German is done; starting French."),
      { t: "fail", error: "429 usage_limit_reached: the weekly usage limit of this ChatGPT Pro account is used up", status: 429 },
    ],
    ticket: (now) => ({ status: "manual", kind: "usageLimit", reason: "omp exited while waiting", provider: "openai-codex", model: "gpt-6-luna", since: now - 180 * MIN, attempts: 1, root: true, subagentIds: [] }),
  },
  {
    // its previous omp ended mid-turn and herdr's own restore brought it back (`restart` on a live
    // agent); Don't was pressed, so it waits for Continue, which goes on where it stopped
    def: { id: "schema", kind: "omp", workspace: "w1", column: "review", model: "opus-5", thinking: "high", since: 2400, age: 5400, ctxPct: 36, cost: 1.48, title: "Version the session cache schema with migrations", files: [] },
    line: "Cut off mid-turn: its previous omp ended",
    steps: [
      { t: "user", text: "Version the session cache schema and write a migration for the old layout." },
      think("Read the current cache layout, then write the v2 schema and a migration that keeps old entries.", 3000),
      read("crates/tf-client/src/sessions.rs", 160),
      bash("cargo test -p tf-client cache", ["running 14 tests", "test cache::migrates_v1 ... ok"], 9000),
    ],
    ticket: (now) => ({ status: "manual", kind: "restart", reason: "You asked not to continue it by itself", since: now - 40 * MIN, attempts: 0, root: true, subagentIds: [] }),
  },
];

/** The retried turn: no new user row, the agent picks the same request up again. */
function rerun(): Step[] {
  return [
    think("The last attempt stopped before it finished. Picking the same request up from the last step that completed.", 2400),
    say("Back on it: same request, nothing lost. Continuing from the last step that finished."),
  ];
}

export class DemoResume {
  private config: AutoResumeConfig = { enabled: true, bringBack: true };

  constructor(private readonly host: ResumeHost) {}

  /** The host's auto-resume setting (`host.autoResume`): ended cards get waiting tickets only while it is on (`./parking`). */
  enabled(): boolean {
    return this.config.enabled;
  }

  /** Seed the failed, waiting and manual agents (forge). */
  seed(): void {
    const now = this.host.now();
    for (const s of SEEDS) {
      const sim = this.host.seedSim(s.def, s.def.workspace);
      sim.seed(s.steps, now - s.def.age * 1000, now - s.def.since * 1000);
      sim.agent.live = { ...sim.agent.live, line: s.line };
      const stopped = sim.subagents.filter((x) => x.status === "failed").map((x) => x.id);
      if (s.ticket) sim.agent.autoResume = s.ticket(now, stopped);
      sim.refreshDerived();
    }
  }

  /** The director leaves these alone: a stop waiting for Resume, or an auto-resume ticket. */
  holds(sim: AgentSim): boolean {
    return sim.agent.autoResume != null || (!sim.busy && lastTurnRetryable(sim.items.length, (i) => sim.items[i]));
  }

  /** Handles the retry and auto-resume methods; `undefined` lets the host answer (`unknown_method`). */
  call(method: string, p: Record<string, unknown>): unknown {
    if (!METHODS[method] || !this.host.supported()) return undefined;
    switch (method) {
      case "host.autoResume":
        return { ...this.config };
      case "host.autoResumeSet": {
        const enabled = p.enabled ?? this.config.enabled;
        const bringBack = p.bringBack ?? this.config.bringBack ?? true;
        if (p.enabled === undefined && p.bringBack === undefined) throw apiError("invalid_params", "enabled or bringBack is required");
        if (typeof enabled !== "boolean" || typeof bringBack !== "boolean") throw apiError("invalid_params", "enabled and bringBack must be true or false");
        this.config = { ...this.config, enabled, bringBack };
        return { ...this.config };
      }
      case "agent.autoResumeCancel":
        this.ticket(this.host.ompSim(p.agentId), undefined);
        return {};
      case "agent.autoResumeNow":
        return this.resumeNow(this.host.ompSim(p.agentId));
      default:
        return this.retry(this.host.ompSim(p.agentId), typeof p.subagentId === "string" ? p.subagentId : undefined);
    }
  }

  /** omp's F5: a subagent alone; else, like hostd, the whole ticket when there is one, or the last turn. */
  private retry(sim: AgentSim, subagentId?: string): RetryResult {
    if (subagentId !== undefined) {
      const sub = sim.subagents.find((s) => s.id === subagentId);
      if (!sub) throw apiError("not_found", `subagent ${subagentId} not found`);
      if (sub.status !== "failed" && sub.status !== "aborted") return { started: false, via: "retry" };
      this.revive(sim, subagentId);
      return { started: true, via: "retry" };
    }
    if (sim.agent.autoResume) return this.resumeNow(sim);
    if (sim.busy || !lastTurnRetryable(sim.items.length, (i) => sim.items[i])) return { started: false, via: "retry" };
    sim.retryTurn(rerun());
    return { started: true, via: "retry" };
  }

  /** Resume now: "resuming", its stopped subagents first, then the agent; the ticket clears once it works. */
  private resumeNow(sim: AgentSim): RetryResult {
    const ar = sim.agent.autoResume;
    if (!ar || ar.status === "resuming" || sim.busy) return { started: false, via: "retry" };
    this.ticket(sim, { ...ar, status: "resuming", resumeAt: undefined, basis: undefined });
    for (const id of ar.subagentIds) this.revive(sim, id);
    this.host.after(RESUME_MS, () => {
      if (ar.root && !sim.busy) sim.retryTurn(rerun());
      this.host.after(CLEAR_MS, () => {
        if (sim.agent.autoResume?.status === "resuming") this.ticket(sim, undefined);
      });
    });
    return { started: true, via: ar.kind === "restart" ? "restore" : "retry" };
  }

  /** A failed or stopped subagent runs again and finishes after a while. */
  private revive(sim: AgentSim, id: string): void {
    const set = (patch: Partial<AgentSim["subagents"][number]>) => {
      const i = sim.subagents.findIndex((s) => s.id === id);
      const cur = sim.subagents[i];
      if (!cur) return false;
      sim.subagents[i] = { ...cur, ...patch };
      sim.refreshDerived();
      this.host.changed(sim.agent.id);
      this.host.metaChanged(sim.agent.id);
      return true;
    };
    if (!set({ status: "running", endedAt: undefined, completionPct: undefined, line: "retrying its stopped turn" })) return;
    this.host.after(SUB_RETRY_MS, () => {
      if (sim.subagents.find((s) => s.id === id)?.status === "running") set({ status: "done", endedAt: this.host.now(), line: "finished on retry" });
    });
  }

  private ticket(sim: AgentSim, ar: AutoResume | undefined): void {
    sim.agent.autoResume = ar;
    this.host.changed(sim.agent.id);
  }
}
