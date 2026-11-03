import type { AgentSim } from "./agent";
import type { AgentDef } from "./data";
import { opt, say, type Step, think, type UiSpec } from "./scripts";

/*
 * omp's own dialogs on the demo host, as tf-hostd turns them into `Agent.needs`: not a question or a tool call of
 * the agent's, so no "Agent said" (`context: ""`), no Skip (Deny / No are the options) and no Decide for me.
 *   cfg: the approval of a settings change (kind approval, ⚙️ line with `inline code`, detail old → new)
 *   toolissue: the report_tool_issue consent (kind confirm, Yes / No, nothing recommended)
 *   revert: the same approval for an agent whose omp loaded TeleFlock bridge 2.2.0 before the host updated: it
 *     waits in omp's terminal, so tf-hostd reports the running `cfg://` write as Needs you `blocked`, answered
 *     in the terminal (Enter there allows it once, Esc denies)
 */

/** What the demo host gives these agents (closures over its state). */
export interface OmpPromptsHost {
  now(): number;
  /** A seeded agent in a new pane of `workspaceId`. */
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
}

const CFG: AgentDef = {
  id: "cfg",
  kind: "omp",
  workspace: "w10",
  column: "needs",
  model: "sonnet-5",
  thinking: "medium",
  since: 90,
  age: 900,
  ctxPct: 24,
  cost: 0.52,
  title: "Try a per-call model for subagent tasks",
  files: [],
};

const TOOL_ISSUE: AgentDef = {
  id: "toolissue",
  kind: "omp",
  workspace: "w11",
  column: "needs",
  model: "opus-5",
  thinking: "high",
  since: 150,
  age: 1200,
  ctxPct: 36,
  cost: 0.88,
  title: "Chase a flaky grep result in the transport tests",
  files: [],
};

const REVERT: AgentDef = {
  id: "revert",
  kind: "omp",
  workspace: "w10",
  column: "needs",
  model: "opus-5",
  thinking: "high",
  since: 80,
  age: 240,
  ctxPct: 73,
  cost: 3.12,
  title: "Turn the per-call model settings back off",
  files: [],
};

/** omp's approval of a `cfg` settings change: Always for this session / Allow once ★ / Deny. */
const CFG_APPROVAL: UiSpec = {
  kind: "select",
  needs: "approval",
  title: "Change task.perCallModel?",
  message: "⚙️ Your agent wants to change `task.perCallModel` for this session.",
  detail: "\"off\" → \"on\"",
  context: "",
  options: [opt("Always for this session"), opt("Allow once", { tone: "primary", recommended: true }), opt("Deny", { tone: "danger" })],
};

/** omp's consent before report_tool_issue sends anything to the devs. */
const TOOL_ISSUE_CONFIRM: UiSpec = {
  kind: "confirm",
  needs: "confirm",
  title: "Confirm",
  message: "🍿 Your agent just watched a tool pull a plot twist nobody asked for.",
  detail: "Send the devs a spoiler? Tool name + what happened, never anything personal.",
  context: "",
  options: [opt("Yes"), opt("No")],
};

const REVERT_WRITE = { path: "cfg://task/perCallModel", content: "off" };

/**
 * omp's cfg approval on an agent whose bridge is older than 2.3.0: what tf-hostd reports while the write runs
 * (`cfg_wait_needs`), and omp's dialog in the terminal (`"on" → "off"`, Allow once highlighted).
 */
const LEGACY_CFG_WAIT: UiSpec = {
  kind: "select",
  needs: "approval",
  title: "Change task.perCallModel?",
  message: "⚙️ Your agent wants to change `task.perCallModel` for this session.",
  detail:
    "New value: `off`\nomp asks in its terminal: this agent's omp runs TeleFlock bridge 2.2.0, which leaves omp's own prompts there. Mark the agent done, then Resume it, to answer them in TeleFlock.",
  context: "",
  options: [opt("Always for this session"), opt("Allow once", { tone: "primary", recommended: true }), opt("Deny", { tone: "danger" })],
  tool: { tool: "write", title: "cfg://task/perCallModel", intent: "Reverting perCallModel to off", args: REVERT_WRITE, ms: 0 },
  terminal: { initial: 1, shows: '"on" → "off"' },
};

const CFG_STEPS: Step[] = [
  { t: "user", text: "Let each subagent task pick its own model instead of inheriting mine. Turn it on and run the batch." },
  think("`task.perCallModel` is a session setting; changing it needs the user's approval.", 1800),
  {
    t: "ui",
    ui: CFG_APPROVAL,
    then: (a) =>
      !a.cancel && a.choices.some((c) => /^(Allow|Always)/.test(c))
        ? [{ t: "notice", level: "info", text: "task.perCallModel is now on for this session", source: "omp" }, say("`task.perCallModel` is on: every task call in this batch picks its own model.")]
        : [{ t: "notice", level: "warn", text: "Settings change denied: task.perCallModel", source: "omp" }, say("Leaving `task.perCallModel` off: the batch runs on your model.")],
  },
];

const TOOL_ISSUE_STEPS: Step[] = [
  { t: "user", text: "The transport tests flake on grep output. Find out which tool misbehaves." },
  think("`grep` returned the same file twice with different line numbers. That is a tool bug worth reporting.", 2400),
  {
    t: "ui",
    ui: TOOL_ISSUE_CONFIRM,
    then: (a) => (a.choices.includes("Yes") ? [say("Reported. The devs got the tool name and what happened, nothing else.")] : [say("Nothing was sent. I'll work around the duplicate lines.")]),
  },
];

const REVERT_STEPS: Step[] = [
  { t: "user", text: "Undo the settings now" },
  think("Both task settings were turned on earlier this session; writing them back.", 900),
  {
    t: "ui",
    ui: LEGACY_CFG_WAIT,
    then: (a) =>
      !a.cancel && a.choices.some((c) => /^(Allow|Always)/.test(c))
        ? [
            {
              t: "tool",
              spec: {
                tool: "write",
                title: "cfg://task/perCallModel",
                intent: "Reverting perCallModel to off",
                args: REVERT_WRITE,
                ms: 400,
                output: ['Set `task.perCallModel` = "off" for this session only (was "on"); NOT saved.'],
              },
            },
            say("`task.perCallModel` is off again: subagent tasks inherit your model."),
          ]
        : [{ t: "notice", level: "warn", text: "Settings change denied: task.perCallModel", source: "omp" }, say("Left `task.perCallModel` on.")],
  },
];

/** forge: three agents waiting on omp's own dialogs. */
export function seedOmpPrompts(host: OmpPromptsHost): void {
  const now = host.now();
  for (const [def, steps] of [[CFG, CFG_STEPS], [TOOL_ISSUE, TOOL_ISSUE_STEPS], [REVERT, REVERT_STEPS]] as const) {
    const sim = host.seedSim(def, def.workspace);
    sim.seed(steps, now - def.age * 1000, now - def.since * 1000);
    if (sim.agent.needs) {
      sim.agent.needs.since = now - def.since * 1000;
      sim.agent.stateSince = now - def.since * 1000;
    }
    sim.refreshDerived();
  }
}
