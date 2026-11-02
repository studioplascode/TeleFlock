import type { RefusalFallback, RetryResult, ThinkingLevel } from "@/core/gen";
import { apiError } from "../errors";
import { lastRefusalRowId, modelName, validateRules } from "../refusal";
import type { AgentSim } from "./agent";
import { type AgentDef, modelByRef } from "./data";
import { bash, edit, read, say, type Step, think } from "./scripts";

/*
 * Refusal fallback on the demo host (tf-hostd's `refusal.rs`, architecture §3.22): the host's rules
 * (`host.refusalFallback`, `host.refusalFallbackSet`, saved as tf-hostd saves them: normalised, or refused whole), and
 * `authbug`, an agent in Review whose last turn Opus refused as a cyber request that was a plain bug fix. Retry with
 * (`agent.refusalRetry`) switches it to the model asked for and goes on with the same turn, with a notice row; the
 * refusal row's "Always do this" saves a rule first. studio-pc plays a tf-hostd before 0.9.0: `unknown_method`.
 */

const METHODS: Record<string, true> = { "host.refusalFallback": true, "host.refusalFallbackSet": true, "agent.refusalRetry": true };

/** What the demo host gives the refusal demo (closures over its state). */
export interface RefusalHost {
  /** This host's tf-hostd has it (studio-pc plays one that predates 0.9.0: `unknown_method`). */
  supported(): boolean;
  /** The live omp agent `agentId` names; throws like the host (not found, not omp, not connected). */
  ompSim(agentId: unknown): AgentSim;
  /** A seeded agent in a new pane of `workspaceId`. */
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
  now(): number;
  changed(agentId: string): void;
  metaChanged(agentId: string): void;
  activity(agentId: string, title: string, detail?: string): void;
}

const EXPLANATION = "The request asks for working code that exploits an authentication bypass.";

const SEED: { def: AgentDef; steps: Step[] } = {
  def: { id: "authbug", kind: "omp", workspace: "w2", column: "review", model: "opus-5", thinking: "high", since: 420, age: 1500, ctxPct: 31, cost: 1.12, title: "Reproduce the alg=none bug in the gateway with a failing test", files: [] },
  steps: [
    { t: "user", text: "The gateway accepts JWTs signed with alg=none. Reproduce that with a failing test in internal/auth, then fix it." },
    think("The verifier is in internal/auth. Read how it picks the key and the algorithm before writing the test.", 4200),
    read("internal/auth/refresh.go", 96),
    {
      t: "fail",
      error: `Refusal (cyber): ${EXPLANATION}`,
      refusal: { kind: "refusal", category: "cyber", explanation: EXPLANATION },
    },
  ],
};

/** The same turn, picked up where the refusal stopped it: the failing test, then the fix. */
function continuation(notice: string): Step[] {
  return [
    { t: "notice", level: "warn", text: notice, source: "refusal" },
    think("Picking the request up where it stopped: a regression test that signs a token with alg=none and expects it to be rejected, then pin the accepted algorithms.", 3000),
    edit({ path: "internal/auth/refresh_test.go", added: 38, removed: 0, status: "modified" }, "Failing test: a token with alg=none is rejected"),
    bash("go test ./internal/auth/...", ["--- FAIL: TestRejectsAlgNone (0.00s)", "    refresh_test.go:71: token with alg=none was accepted", "FAIL"], 5200, 1),
    edit({ path: "internal/auth/refresh.go", added: 14, removed: 3, status: "modified" }, "Pin the accepted algorithms"),
    bash("go test ./internal/auth/...", ["ok  \tgateway/internal/auth\t0.412s"], 4200),
    say("Reproduced and fixed. `TestRejectsAlgNone` failed first (the verifier took the token's own `alg`), and passes now that `refresh.go` accepts only the algorithms it is configured with. **internal/auth** is green."),
  ];
}

export class DemoRefusal {
  private rules: RefusalFallback["rules"] = [];

  constructor(private readonly host: RefusalHost) {}

  /** Seeds the refused agent (forge). */
  seed(): void {
    const now = this.host.now();
    const sim = this.host.seedSim(SEED.def, SEED.def.workspace);
    sim.seed(SEED.steps, now - SEED.def.age * 1000, now - SEED.def.since * 1000);
    sim.agent.live = { ...sim.agent.live, line: "Refused · cyber" };
    sim.refreshDerived();
  }

  /** Handles the refusal fallback methods; `undefined` lets the host answer (`unknown_method`). */
  call(method: string, p: Record<string, unknown>): unknown {
    if (!METHODS[method] || !this.host.supported()) return undefined;
    switch (method) {
      case "host.refusalFallback":
        return { rules: structuredClone(this.rules) } satisfies RefusalFallback;
      case "host.refusalFallbackSet": {
        const checked = validateRules(p.rules);
        if (!checked.ok) throw apiError("invalid_params", checked.message);
        this.rules = checked.rules;
        return { rules: structuredClone(this.rules) } satisfies RefusalFallback;
      }
      default:
        return this.retry(p);
    }
  }

  /** `agent.refusalRetry`: the agent (or one of its subagents) goes on with its refused turn on `model`, once. */
  private retry(p: Record<string, unknown>): RetryResult {
    const sim = this.host.ompSim(p.agentId);
    if (!sim.caps.refusalRetry) {
      throw apiError("unsupported", `${sim.agent.name}'s omp has no TeleFlock bridge that switches models after a refusal`, {
        hint: "Restart the agent so its omp loads the current TeleFlock bridge: Mark done, then Resume it, or start a new agent",
      });
    }
    const ref = typeof p.model === "string" ? p.model : "";
    if (!/^[^\s/]+\/\S+$/.test(ref)) throw apiError("invalid_params", `model must be \`provider/id\`, got \`${ref}\``);
    const model = modelByRef(ref);
    if (!model) throw apiError("invalid_params", `Unknown model ${ref}`, { hint: "Pick one from host.models" });
    if (typeof p.subagentId === "string") {
      if (!sim.subagents.some((s) => s.id === p.subagentId)) throw apiError("not_found", `subagent ${p.subagentId} not found`);
      return { started: false, via: "retry" };
    }
    const rowId = lastRefusalRowId(sim.items.length, (i) => sim.items[i]);
    if (sim.busy || rowId === undefined) return { started: false, via: "retry" };
    const row = sim.items.find((x) => x.id === rowId);
    const refusal = row?.kind === "assistant" ? row.refusal : undefined;
    const from = sim.model ? modelName({ id: sim.model.id, label: sim.model.label }) : "The model";
    const to = modelName({ id: model.id, label: model.label });
    const why = refusal?.kind === "sensitive" ? "was flagged by the safety filters" : `refused${refusal?.category ? ` (${refusal.category})` : ""}`;
    const notice = `${from} ${why}; switched to ${to} and continued`;
    // the switch as omp records it (a model row), then the notice and the turn going on
    sim.model = { provider: model.provider, id: model.id, label: model.label };
    if (typeof p.thinking === "string") sim.thinking = p.thinking as ThinkingLevel;
    else if (sim.thinking && !model.thinking.includes(sim.thinking)) sim.thinking = model.thinking.at(-1);
    sim.note("mode", `Model: ${model.label}${sim.thinking ? ` · ${sim.thinking}` : ""}`);
    sim.refreshDerived();
    this.host.activity(sim.agent.id, notice);
    sim.retryTurn(continuation(notice));
    this.host.changed(sim.agent.id);
    this.host.metaChanged(sim.agent.id);
    return { started: true, via: "retry" };
  }
}
