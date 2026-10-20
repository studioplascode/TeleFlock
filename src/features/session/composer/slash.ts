import type { Capabilities, SessionMeta, ThinkingLevel } from "@/core/gen";
import { toast } from "@/design";
import { hostCall } from "../api";
import { useSessionUi } from "../state";

export interface SlashContext {
  hostId: string;
  agentId: string;
  key: string;
  meta: SessionMeta | undefined;
  openTerminal(): void;
}

export interface SlashCommand {
  name: string;
  /** Argument hint shown after the name, e.g. `<level>`. */
  args?: string;
  description: string;
  /** Capability that must be present (greys the command out otherwise). */
  cap?: keyof Capabilities;
  /** Raw commands are forwarded verbatim through `agent.slash`. */
  raw?: boolean;
  /** Runs without arguments right away when picked (no args expected). */
  instant?: boolean;
  /** Mapped commands: perform the native call. Resolves true on success. */
  run?(ctx: SlashContext, args: string): Promise<boolean>;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

const ok = (r: { ok: boolean }) => r.ok;

const MAPPED: SlashCommand[] = [
  {
    name: "model",
    args: "[provider/id[:level]]",
    description: "Switch model for this session",
    cap: "model",
    run: async (c, a) => {
      if (!a) {
        useSessionUi.getState().openDialog(c.key, "model");
        return true;
      }
      const [model, level] = a.split(":");
      const thinking = THINKING_LEVELS.find((l) => l === level);
      return ok(await hostCall(c.hostId, "agent.setModel", { agentId: c.agentId, model: model ?? a, thinking }, { success: `Model → ${a}` }));
    },
  },
  {
    name: "effort",
    args: "<off|minimal|low|medium|high|xhigh|max|auto>",
    description: "Set thinking level",
    cap: "thinking",
    run: async (c, a) => {
      const level = THINKING_LEVELS.find((l) => l === a.trim());
      if (!level) {
        toast({ title: "Pick a thinking level", description: THINKING_LEVELS.join(" · "), status: "error" });
        return false;
      }
      return ok(await hostCall(c.hostId, "agent.setThinking", { agentId: c.agentId, level }, { success: `Thinking → ${level}` }));
    },
  },
  {
    name: "fast",
    args: "[on|off]",
    description: "Toggle fast (priority) mode",
    cap: "fast",
    run: async (c, a) => {
      const on = a === "on" ? true : a === "off" ? false : !c.meta?.fast;
      return ok(await hostCall(c.hostId, "agent.setFast", { agentId: c.agentId, on }, { success: `Fast ${on ? "on" : "off"}` }));
    },
  },
  {
    name: "plan",
    description: "Toggle plan mode",
    cap: "plan",
    instant: true,
    run: async (c) => {
      const on = (c.meta?.mode ?? "normal") === "normal";
      return ok(await hostCall(c.hostId, "agent.setPlan", { agentId: c.agentId, on }, { success: on ? "Plan mode on" : "Plan mode off" }));
    },
  },
  {
    name: "goal",
    args: "[objective | pause | resume | drop | budget <N|off>]",
    description: "Set or manage the autonomous goal",
    cap: "goal",
    run: async (c, a) => {
      const [sub, ...rest] = a.split(/\s+/);
      if (!a) {
        useSessionUi.getState().openDialog(c.key, "goal");
        return true;
      }
      if (sub === "pause" || sub === "resume" || sub === "drop") return ok(await hostCall(c.hostId, "agent.goal", { agentId: c.agentId, op: sub }, { success: `Goal ${sub}d` }));
      if (sub === "budget") {
        const n = Number.parseInt(rest[0] ?? "", 10);
        return ok(await hostCall(c.hostId, "agent.goal", { agentId: c.agentId, op: "budget", budget: Number.isFinite(n) ? n : undefined }, { success: "Goal budget updated" }));
      }
      const objective = sub === "set" ? rest.join(" ") : a;
      return ok(await hostCall(c.hostId, "agent.goal", { agentId: c.agentId, op: "set", objective }, { success: "Goal set" }));
    },
  },
  {
    name: "compact",
    args: "[focus]",
    description: "Summarise and compact the context",
    cap: "compact",
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.compact", { agentId: c.agentId, instructions: a || undefined }, { success: "Compacting…" })),
  },
  {
    name: "handoff",
    args: "[focus]",
    description: "Hand off: summarise into a fresh context",
    cap: "handoff",
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.handoff", { agentId: c.agentId, instructions: a || undefined }, { success: "Handoff started" })),
  },
  {
    name: "rename",
    args: "[title]",
    description: "Rename the session",
    cap: "rename",
    run: async (c, a) => {
      if (!a) {
        useSessionUi.getState().openDialog(c.key, "rename");
        return true;
      }
      return ok(await hostCall(c.hostId, "agent.rename", { agentId: c.agentId, title: a }, { success: "Renamed" }));
    },
  },
  {
    name: "fork",
    args: "[pane]",
    description: "Fork the session (in place, or into a new pane)",
    cap: "fork",
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.fork", { agentId: c.agentId, placement: a === "pane" ? "pane" : "inPlace" }, { success: "Forked" })),
  },
  {
    name: "new",
    description: "Start a new session in this omp",
    instant: true,
    run: async (c) => ok(await hostCall(c.hostId, "agent.newSession", { agentId: c.agentId }, { success: "New session" })),
  },
  {
    name: "export",
    description: "Export the session to HTML on the host",
    cap: "export",
    instant: true,
    run: async (c) => {
      const r = await hostCall(c.hostId, "agent.export", { agentId: c.agentId });
      if (r.ok) toast({ title: "Session exported", description: r.value.path, status: "done" });
      return r.ok;
    },
  },
  {
    name: "btw",
    args: "<question>",
    description: "Ask a side question without touching the session",
    cap: "btw",
    run: async (c, a) => {
      if (!a) {
        useSessionUi.getState().setTab(c.key, "btw");
        return true;
      }
      const r = await hostCall(c.hostId, "agent.btw", { agentId: c.agentId, question: a });
      if (r.ok) {
        const ui = useSessionUi.getState();
        ui.addBtw(c.key, r.value.btwId, a);
        ui.setTab(c.key, "btw");
        ui.setSheet(c.key, true);
      }
      return r.ok;
    },
  },
  {
    name: "tree",
    description: "Show the session tree",
    cap: "tree",
    instant: true,
    run: async (c) => {
      useSessionUi.getState().setTab(c.key, "tree");
      useSessionUi.getState().setSheet(c.key, true);
      return true;
    },
  },
  {
    name: "stop",
    description: "Abort the current turn",
    cap: "abort",
    instant: true,
    run: async (c) => ok(await hostCall(c.hostId, "agent.abort", { agentId: c.agentId })),
  },
  {
    name: "terminal",
    description: "Open the real terminal beside the session",
    instant: true,
    run: async (c) => {
      c.openTerminal();
      return true;
    },
  },
];

/** omp builtins that are safe to inject verbatim (omp.md §1 "usable" column). */
const RAW: [string, string | undefined, string][] = [
  ["queue", "<message>", "Queue a follow-up for after the turn"],
  ["todo", "[append|start|done|drop …]", "Edit the todo list"],
  ["shake", "[elide|images|thinking]", "Drop heavy context"],
  ["clear", undefined, "Reset the context"],
  ["fresh", undefined, "Reset the provider stream"],
  ["retry", undefined, "Retry the last turn"],
  ["slow", "[on|off]", "Flex service tier"],
  ["tan", "<work>", "Background tangential agent"],
  ["loop", "[count|duration] [prompt]", "Re-submit a prompt after every yield"],
  ["vibe", "[prompt]", "Director mode with worker sessions"],
  ["guided-goal", "[rough objective]", "Interview, then set a goal"],
  ["force", "<tool> [prompt]", "Force the next tool"],
  ["skills", "<search|install|installed|update>", "Skill registry"],
  ["mcp", "<list|test|reload|…>", "MCP management"],
  ["memory", "[view|stats|sync|…]", "Memory backend"],
  ["advisor", "[on|off|status]", "Advisor toggle"],
  ["prewalk", "[restart|off]", "Switch to @smol at the first edit"],
  ["forget-approvals", undefined, "Clear remembered tool grants"],
  ["pin", "[id]", "Pin in the resume list"],
  ["resume", "<id>", "Switch to another session"],
  ["share", undefined, "Create an encrypted share link"],
  ["security", "<plan|scan|status>", "Security scans"],
  ["add-dir", "<path>", "Add a workspace root"],
];

export const SLASH_COMMANDS: SlashCommand[] = [
  ...MAPPED,
  ...RAW.map(([name, args, description]): SlashCommand => ({ name, args, description, raw: true, instant: args == null })),
];

/** Aliases users type out of habit; they map onto the canonical command. */
const ALIASES: Record<string, string> = { switch: "model", thinking: "effort", models: "model", abort: "stop", term: "terminal", "skill:": "skills" };

export function findCommand(name: string): SlashCommand | undefined {
  const n = ALIASES[name] ?? name;
  return SLASH_COMMANDS.find((c) => c.name === n) ?? (name.startsWith("skill:") ? { name, description: "Invoke a skill", raw: true } : undefined);
}

/** Ranked prefix/substring match for the palette. */
export function matchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const scored: [number, SlashCommand][] = [];
  for (const c of SLASH_COMMANDS) {
    const n = c.name;
    const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : c.description.toLowerCase().includes(q) ? 3 : -1;
    if (score >= 0) scored.push([score, c]);
  }
  for (const [alias, target] of Object.entries(ALIASES))
    if (alias.startsWith(q) && !scored.some(([, c]) => c.name === target)) {
      const c = SLASH_COMMANDS.find((x) => x.name === target);
      if (c) scored.push([1.5, c]);
    }
  return scored.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** Execute `/name args`. Raw commands go through `agent.slash`. */
export async function runSlash(ctx: SlashContext, input: string): Promise<boolean> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) return false;
  const name = m[1] ?? "";
  const args = (m[2] ?? "").trim();
  const cmd = findCommand(name);
  if (!cmd) {
    toast({ title: `Unknown command /${name}`, description: "TeleFlock only sends commands omp knows. Start with a space to send it as text.", status: "error" });
    return false;
  }
  if (cmd.cap && ctx.meta && !ctx.meta.caps[cmd.cap]) {
    toast({ title: `/${cmd.name} isn't available right now`, description: "This session doesn't expose that control (bridge missing or agent busy).", status: "error" });
    return false;
  }
  if (cmd.run) return cmd.run(ctx, args);
  const command = `/${name}${args ? ` ${args}` : ""}`;
  return ok(await hostCall(ctx.hostId, "agent.slash", { agentId: ctx.agentId, command }, { success: `Sent ${command}` }));
}
