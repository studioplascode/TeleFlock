import type { ActivityKind, AgentAutoAnswer, Answer, AutoAnswer, AutoAnswerCountdown, AutoAnswerSource, NotifyKind } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import type { AgentDef } from "./data";
import { opt, read, say, type Step, think, todo } from "./scripts";

/*
 * Decide for me (architecture §3.23) on the demo host, the way tf-hostd's `autoanswer` core does
 * it: the host default (forge on after 20 min, studio-pc off), agents' own policies (launch spec,
 * `agent.setAutoAnswer`), one countdown per agent whose pending question is an answerable omp ask
 * with a ★ recommended option, cancel and postpone, and the pick at the deadline ("Auto-answered ★ …"
 * in Activity, an info notification "<agent> · decided for you"). An app is always connected to an
 * online demo host, so a policy that counts only with no app connected stands (`waitingForNoApp`).
 * Seeded on forge: push's ★ ntfy question 12:40 from its pick, and flags' question waiting for no app.
 */

const MIN_SECS = 60;
const MAX_SECS = 86_400;
const DEFAULT_SECS = 1_200;
const MAX_MS = MAX_SECS * 1000;
/** The director leaves a question to decide for me once it picks within this long, or while it waits for no app. */
const HOLD_MS = 10 * 60_000;

/** The host defaults the demo hosts start with: forge on after 20 min, studio-pc off. */
export const AUTO_ANSWER_ON: AutoAnswer = { enabled: true, afterSecs: DEFAULT_SECS, onlyWhenNoApp: false };
export const AUTO_ANSWER_OFF: AutoAnswer = { enabled: false, afterSecs: DEFAULT_SECS, onlyWhenNoApp: false };

const METHODS: Record<string, true> = { "agent.setAutoAnswer": true, "agent.autoAnswerCancel": true, "agent.autoAnswerPostpone": true, "host.autoAnswerSet": true };

/** What the decide-for-me demo needs from its DemoHost (closures over the host's state). */
export interface AutoAnswerHost {
  now(): number;
  /** The default this host starts with (forge on, studio-pc off). */
  initial(): AutoAnswer;
  sims: ReadonlyMap<string, AgentSim>;
  /** An app is connected (the demo host is online). */
  apps(): boolean;
  /** A seeded agent in a new pane of `workspaceId`. */
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
  /** `HostInfo.autoAnswer` changed. */
  setDefault(policy: AutoAnswer): void;
  changed(agentId: string): void;
  activity(agentId: string, kind: ActivityKind, title: string, detail?: string): void;
  notify(agentId: string, kind: NotifyKind, title: string, body: string): void;
}

/** The countdown on one agent's pending question. */
interface Countdown {
  requestId: string;
  question: string;
  /** Option ids the answer sends, and how they read. */
  picks: string[];
  labels: string[];
  /** Added by postponing (ms; negative when a cancelled one restarted with less than the policy's wait). */
  extraMs: number;
  /** Time counted before the running stretch. */
  elapsedMs: number;
  /** Start of the running stretch; undefined while the clock stands. */
  runningSince?: number;
  cancelled: boolean;
  /** Cancelled or postponed: the director leaves the question to you. */
  touched: boolean;
}

interface Question {
  requestId: string;
  question: string;
  picks: string[];
  labels: string[];
}

/** The question decide for me may answer: an answerable omp ask with a ★ (a multi-select picks every ★). */
function qualifying(sim: AgentSim): Question | null {
  const a = sim.agent;
  const n = a.needs;
  if (a.kind !== "omp" || a.parked || !n || n.kind !== "ask" || !n.answerable || !n.requestId) return null;
  const rec = n.options.filter((o) => o.recommended).slice(0, n.multi ? undefined : 1);
  if (!rec.length) return null;
  return { requestId: n.requestId, question: n.question, picks: rec.map((o) => o.id), labels: rec.map((o) => o.label) };
}

/** `20 min`, `1 h 30 min`, `45 s` (tf-hostd's `wait_text`). */
function waitText(ms: number): string {
  const secs = Math.ceil(Math.max(0, ms) / 1000);
  if (secs < 60) return `${secs} s`;
  const mins = Math.ceil(secs / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const stars = (labels: readonly string[]) => labels.map((l) => `★ ${l}`).join(", ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A policy as tf-hostd validates it (`AutoAnswer::validate`): `invalid_params` otherwise. */
export function checkPolicy(v: unknown): AutoAnswer {
  const p = (v ?? {}) as Record<string, unknown>;
  if (typeof p.enabled !== "boolean" || typeof p.onlyWhenNoApp !== "boolean" || typeof p.afterSecs !== "number") {
    throw apiError("invalid_params", "autoAnswer needs enabled, afterSecs and onlyWhenNoApp");
  }
  const secs = p.afterSecs;
  if (!Number.isInteger(secs) || secs < MIN_SECS || secs > MAX_SECS) {
    throw apiError("invalid_params", `autoAnswer.afterSecs must be ${MIN_SECS}–${MAX_SECS} seconds (1 minute to 24 hours), not ${secs}`);
  }
  return { enabled: p.enabled, afterSecs: secs, onlyWhenNoApp: p.onlyWhenNoApp };
}

/** flags: a question whose own policy counts only with no app connected (an app is connected). */
const FLAGS: AgentDef = {
  id: "flags",
  kind: "omp",
  workspace: "w2",
  column: "needs",
  model: "sonnet-5",
  thinking: "medium",
  since: 300,
  age: 1500,
  ctxPct: 31,
  cost: 0.74,
  title: "Feature flags for the gateway's beta rollout",
  files: [],
};

const FLAGS_STEPS: Step[] = [
  { t: "user", text: "Add feature flags to the gateway so we can roll the new auth path out to beta tenants first." },
  think("Flags need a store the gateway reads at startup and on reload. Check how config loads today before picking one.", 2600),
  read("internal/config/load.go", 96),
  read("internal/http/router.go", 120),
  say("Config loads once at startup from `gateway.yaml`, with a SIGHUP reload. Before wiring flags in I need one decision."),
  {
    t: "ui",
    ui: {
      kind: "select",
      needs: "ask",
      title: "Question",
      message: "Where should the gateway read its feature flags from?",
      options: [
        opt("Config file in the repo", { recommended: true, tone: "primary", description: "Reviewed in pull requests and reloaded on SIGHUP. No new service to run." }),
        opt("Unleash", { description: "Self-hosted UI and gradual rollouts, one more container to run." }),
        opt("LaunchDarkly", { description: "Hosted with the richest targeting, priced per seat." }),
      ],
      allowOther: true,
      allowChat: true,
      tool: { tool: "ask", title: "Where should the gateway read its feature flags from?", args: {}, ms: 0 },
    },
    then: (a: Answer) => {
      const choice = a.text ?? a.choices[0] ?? "Config file in the repo";
      if (a.cancel) return [say("Leaving the flag store open for now; the rest of the rollout plan doesn't depend on it yet.")];
      return [say(`Going with **${choice}**.`), todo("Flag store", "completed"), todo("Beta tenant list", "inProgress"), say("Flags are wired; the beta tenant list is next.")];
    },
  },
];

export class DemoAutoAnswer {
  private hostPolicy?: AutoAnswer;
  /** Agent id → its own policy. */
  private readonly own = new Map<string, AutoAnswer>();
  /** Agent id → the countdown on its pending question. */
  private readonly pending = new Map<string, Countdown>();
  /** What each agent shows (`Agent.autoAnswer`), as compared JSON. */
  private readonly shown = new Map<string, string>();

  constructor(private readonly host: AutoAnswerHost) {}

  /** `HostInfo.autoAnswer`. */
  hostDefault(): AutoAnswer {
    return { ...(this.hostPolicy ??= this.host.initial()) };
  }

  /** forge: push's question 12:40 from its pick (the host default), flags' waiting for no app connected. */
  seed(): void {
    const now = this.host.now();
    const push = this.host.sims.get("push");
    const asked = now - 440_000;
    if (push?.agent.needs) {
      push.agent.needs.since = asked;
      push.agent.stateSince = asked;
    }
    const flags = this.host.seedSim(FLAGS, FLAGS.workspace);
    flags.seed(FLAGS_STEPS, now - FLAGS.age * 1000, now - FLAGS.since * 1000);
    if (flags.agent.needs) {
      flags.agent.needs.since = now - FLAGS.since * 1000;
      flags.agent.stateSince = now - FLAGS.since * 1000;
    }
    flags.refreshDerived();
    this.own.set("flags", { enabled: true, afterSecs: 1_800, onlyWhenNoApp: true });
    this.observeAll(now);
    // Time already waited counts: push's from when it asked, flags' 5 min before an app connected.
    const p = this.pending.get("push");
    if (p?.runningSince !== undefined) p.runningSince = asked;
    const f = this.pending.get("flags");
    if (f) f.elapsedMs = FLAGS.since * 1000;
    this.observeAll(now);
  }

  /** Starts, keeps or drops each omp agent's countdown, answers what fell due, refreshes `Agent.autoAnswer`. */
  tick(): void {
    this.observeAll(this.host.now());
  }

  /**
   * The director leaves this agent's question alone: decide for me picks it soon, it waits for no
   * app, or you cancelled or postponed its countdown (it is yours to answer).
   */
  holds(sim: AgentSim): boolean {
    const e = this.pending.get(sim.agent.id);
    const p = this.effective(sim.agent.id)?.policy;
    if (!e || e.requestId !== sim.agent.needs?.requestId) return false;
    if (e.touched) return true;
    if (!p?.enabled || e.cancelled) return false;
    if (e.runningSince === undefined) return true;
    return e.runningSince + this.left(e, p) - this.host.now() <= HOLD_MS;
  }

  /** The line a needs-you notification adds about the countdown its question starts. */
  needsNote(sim: AgentSim): string | null {
    const p = this.effective(sim.agent.id)?.policy;
    const q = qualifying(sim);
    if (!p?.enabled || !q) return null;
    const wait = waitText(p.afterSecs * 1000);
    return p.onlyWhenNoApp && this.host.apps() ? `Decide for me picks ${stars(q.labels)} after ${wait} with no app connected.` : `Decide for me picks ${stars(q.labels)} in ${wait} unless you answer.`;
  }

  /** A launch spec's `autoAnswer` (checked before the launch). */
  checkSpec(spec: Record<string, unknown>): AutoAnswer | undefined {
    return spec.autoAnswer == null ? undefined : checkPolicy(spec.autoAnswer);
  }

  /** The launched omp agent gets its own policy. */
  bind(sim: AgentSim, policy: AutoAnswer | undefined): void {
    if (!policy || sim.agent.kind !== "omp") return;
    this.own.set(sim.agent.id, policy);
    this.observe(sim, this.host.now());
  }

  /** A parked agent resumed under a new id: its own policy carries over, the old id keeps nothing. */
  rekey(oldId: string, newId: string): void {
    const p = this.own.get(oldId);
    this.own.delete(oldId);
    this.pending.delete(oldId);
    this.shown.delete(oldId);
    if (p) this.own.set(newId, p);
  }

  /** Handles the decide-for-me methods; `undefined` for any other method. */
  call(method: string, p: Record<string, unknown>): unknown {
    if (!METHODS[method]) return undefined;
    const now = this.host.now();
    if (method === "host.autoAnswerSet") {
      const policy = checkPolicy(p);
      this.hostPolicy = policy;
      this.host.setDefault({ ...policy });
      this.observeAll(now);
      return { ...policy };
    }
    const sim = this.ompAgent(p.agentId);
    const id = sim.agent.id;
    if (method === "agent.setAutoAnswer") {
      if (p.policy == null) this.own.delete(id);
      else this.own.set(id, checkPolicy(p.policy));
      this.observe(sim, now);
      return {};
    }
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (method === "agent.autoAnswerCancel") {
      const e = this.entry(id, requestId);
      if (!e.cancelled) {
        this.stop(e, now);
        e.cancelled = true;
      }
      e.touched = true;
      this.observe(sim, now);
      return {};
    }
    const secs = p.secs;
    if (typeof secs !== "number" || !Number.isInteger(secs) || secs < 1 || secs > MAX_SECS) throw apiError("invalid_params", `postpone by 1–${MAX_SECS} seconds`);
    const policy = this.effective(id)?.policy;
    if (!policy?.enabled) {
      this.entry(id, requestId);
      throw apiError("not_found", "decide for me is off for this agent");
    }
    const e = this.entry(id, requestId);
    const counted = e.elapsedMs + (e.runningSince === undefined ? 0 : Math.max(0, now - e.runningSince));
    const left = policy.afterSecs * 1000 + e.extraMs - counted;
    const base = e.cancelled ? 0 : Math.max(0, left);
    const want = Math.min(base + secs * 1000, MAX_MS);
    e.extraMs += want - left;
    e.cancelled = false;
    e.touched = true;
    this.observe(sim, now);
    return {};
  }

  private ompAgent(agentId: unknown): AgentSim {
    const sim = typeof agentId === "string" ? this.host.sims.get(agentId) : undefined;
    if (!sim) throw apiError("not_found", `no agent \`${String(agentId)}\``);
    if (sim.agent.kind !== "omp") throw apiError("unsupported", `\`${sim.agent.name}\` is a ${sim.agent.kind} agent: decide for me answers omp questions only`);
    return sim;
  }

  private entry(agentId: string, requestId: string): Countdown {
    const e = this.pending.get(agentId);
    if (!e || e.requestId !== requestId) throw apiError("not_found", "this question has no decide-for-me countdown (it was answered, or decide for me is off)");
    return e;
  }

  /** The policy in force: the agent's own, else the host default while it is on. */
  private effective(agentId: string): { policy: AutoAnswer; source: AutoAnswerSource } | undefined {
    const own = this.own.get(agentId);
    if (own) return { policy: own, source: "agent" };
    const d = this.hostDefault();
    return d.enabled ? { policy: d, source: "host" } : undefined;
  }

  /** What is left of the wait before the running stretch (ms). */
  private left(e: Countdown, p: AutoAnswer): number {
    return p.afterSecs * 1000 + e.extraMs - e.elapsedMs;
  }

  private stop(e: Countdown, now: number): void {
    if (e.runningSince === undefined) return;
    e.elapsedMs += Math.max(0, now - e.runningSince);
    e.runningSince = undefined;
  }

  private observeAll(now: number): void {
    for (const sim of [...this.host.sims.values()]) this.observe(sim, now);
  }

  private observe(sim: AgentSim, now: number): void {
    const id = sim.agent.id;
    if (sim.agent.kind !== "omp") return;
    const eff = this.effective(id);
    const q = qualifying(sim);
    let e = this.pending.get(id);
    if (eff?.policy.enabled && q) {
      if (!e || e.requestId !== q.requestId) {
        e = { ...q, extraMs: 0, elapsedMs: 0, cancelled: false, touched: false };
        this.pending.set(id, e);
      }
      const run = !e.cancelled && !(eff.policy.onlyWhenNoApp && this.host.apps());
      if (run && e.runningSince === undefined) e.runningSince = now;
      if (!run) this.stop(e, now);
      if (e.runningSince !== undefined && e.runningSince + this.left(e, eff.policy) <= now) {
        this.fire(sim, e, eff.policy);
        e = undefined;
      }
    } else if (e) {
      this.pending.delete(id);
      e = undefined;
    }
    const view: AgentAutoAnswer | undefined = eff ? { policy: { ...eff.policy }, source: eff.source, ...(e ? { countdown: this.view(e, eff.policy) } : {}) } : undefined;
    const json = view ? JSON.stringify(view) : "";
    if ((this.shown.get(id) ?? "") === json) return;
    this.shown.set(id, json);
    sim.agent.autoAnswer = view;
    this.host.changed(id);
  }

  /** Stable while nothing changes: a running clock shows its deadline, a standing one what is left. */
  private view(e: Countdown, p: AutoAnswer): AutoAnswerCountdown {
    const left = this.left(e, p);
    const base = { requestId: e.requestId, picks: [...e.labels] };
    if (e.cancelled) return { ...base, status: "cancelled", remainingMs: Math.max(0, left) };
    if (e.runningSince !== undefined) return { ...base, status: "counting", deadline: e.runningSince + left };
    return { ...base, status: "waitingForNoApp", remainingMs: Math.max(0, left) };
  }

  /** The wait ran out: answer with the ★ option(s), like tf-hostd. */
  private fire(sim: AgentSim, e: Countdown, p: AutoAnswer): void {
    const id = sim.agent.id;
    this.pending.delete(id);
    if (!sim.answer(e.requestId, { choices: e.picks, cancel: false, chat: false }, "Decide for me", false)) return;
    const picks = stars(e.labels);
    this.host.activity(id, "answered", `Auto-answered ${picks}`, `${clip(e.question, 200)} · nobody answered within ${waitText(p.afterSecs * 1000 + e.extraMs)}`);
    this.host.notify(id, "info", `${sim.agent.name} · decided for you`, clip(`${picks} — ${e.question}`, 240));
  }
}
