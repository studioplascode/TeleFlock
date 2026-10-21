import { getTranscript, openLink } from "@/core";
import type { Capabilities, CommandInfo, SessionMeta, ThinkingLevel, TranscriptItem } from "@/core/gen";
import { OMP_COMMANDS, type OmpCommand, type OmpCommandMode, type OmpSubcommand, ompCommandName } from "@/core/ompCommands";
import { toast } from "@/design";
import { hostCall } from "../api";
import { useSessionUi } from "../state";

export interface SlashContext {
  hostId: string;
  agentId: string;
  key: string;
  meta: SessionMeta | undefined;
  /** Desktop: the agent's terminal in the split pane. Mobile: the terminal view. */
  openTerminal(): void;
  /** Extension, prompt-template and skill commands of this session (`agent.commands`). */
  custom?: readonly CommandInfo[];
}

/**
 * How a command runs: `native` = a TeleFlock control; the omp modes (`OmpCommandMode`) inject the
 * command through `agent.slash` and, for `report`/`terminal`, open the agent's terminal.
 */
export type SlashMode = "native" | OmpCommandMode;

export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Argument hint shown after the name, e.g. `<level>`. */
  args?: string;
  description: string;
  /** Mode when run without arguments (palette badge). */
  mode: SlashMode;
  /** Capability a native control needs (greys the command out otherwise). */
  cap?: keyof Capabilities;
  /** Runs right away when picked (no arguments expected). */
  instant?: boolean;
  /** Argument choices offered once the name is typed. */
  subs?: OmpSubcommand[];
  /** `teleflock` (app-only), `omp` (builtin) or the custom command source (`skill`, `prompt`, `extension`). */
  source: string;
  /** Mode for a given argument string. */
  modeFor(args: string): SlashMode;
  /** Native implementation, used when `modeFor(args)` is `native`. */
  run?(ctx: SlashContext, args: string): Promise<boolean>;
  needsArgs?: boolean;
  confirm?: string;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

const ok = (r: { ok: boolean }) => r.ok;
const first = (args: string) => args.split(/\s+/, 1)[0] ?? "";

function inspector(c: SlashContext, tab: "overview" | "todos" | "agents" | "files" | "tree" | "btw"): Promise<boolean> {
  const ui = useSessionUi.getState();
  ui.setTab(c.key, tab);
  ui.setSheet(c.key, true);
  return Promise.resolve(true);
}

async function copyLocal(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: `Copied ${what}`, description: text.length > 90 ? `${text.slice(0, 90)}…` : text, status: "done", duration: 2600 });
    return true;
  } catch (e) {
    toast({ title: "Couldn't copy", description: e instanceof Error ? e.message : String(e), status: "error" });
    return false;
  }
}

const LINK_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

function lastOf<T>(items: readonly TranscriptItem[], pick: (i: TranscriptItem) => T | undefined): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const v = pick(items[i] as TranscriptItem);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** What `/copy [code|cmd|link]` and `/open` pick from the loaded transcript. */
export function pickFromTranscript(items: readonly TranscriptItem[], what: "text" | "code" | "cmd" | "link"): string | undefined {
  switch (what) {
    case "text":
      return lastOf(items, (i) => (i.kind === "assistant" && i.text.trim() ? i.text : undefined));
    case "code":
      return lastOf(items, (i) => {
        if (i.kind !== "assistant") return undefined;
        const blocks = [...i.text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
        return blocks.length ? (blocks[blocks.length - 1]?.[1] ?? "").replace(/\n$/, "") : undefined;
      });
    case "cmd":
      return lastOf(items, (i) => (i.kind === "tool" && i.view?.type === "bash" ? i.view.command : undefined));
    case "link":
      return lastOf(items, (i) => {
        const links = (i.kind === "assistant" || i.kind === "user" ? i.text : "").match(LINK_RE);
        return links?.length ? links[links.length - 1]?.replace(/[.,;:]+$/, "") : undefined;
      });
  }
}

/** The loaded transcript as Markdown (user + assistant turns). */
export function transcriptMarkdown(items: readonly TranscriptItem[]): string {
  return items
    .flatMap((i) => (i.kind === "user" ? [`## User\n\n${i.text}`] : i.kind === "assistant" && i.text.trim() ? [`## Assistant\n\n${i.text}`] : []))
    .join("\n\n");
}

function todosMarkdown(meta: SessionMeta | undefined): string {
  const mark: Record<string, string> = { pending: " ", inProgress: "~", completed: "x", abandoned: "-" };
  return (meta?.todos ?? []).map((p) => [`## ${p.name}`, ...p.tasks.map((t) => `- [${mark[t.status] ?? " "}] ${t.content}`)].join("\n")).join("\n\n");
}

interface Native {
  /** Which argument forms the native control covers; the rest go to omp. Default: all. */
  handles?(args: string): boolean;
  run(ctx: SlashContext, args: string): Promise<boolean>;
  cap?: keyof Capabilities;
  description?: string;
  /** Overrides omp's argument hint (`""` = no arguments). */
  args?: string;
  subs?: OmpSubcommand[];
}

async function switchModel(c: SlashContext, a: string): Promise<boolean> {
  if (!a) {
    useSessionUi.getState().openDialog(c.key, "model");
    return true;
  }
  const [model, level] = a.split(":");
  const thinking = THINKING_LEVELS.find((l) => l === level);
  return ok(await hostCall(c.hostId, "agent.setModel", { agentId: c.agentId, model: model ?? a, thinking }, { success: `Model → ${a}` }));
}

/** TeleFlock-native implementations layered over omp's builtins. */
const NATIVE: Record<string, Native> = {
  switch: { cap: "model", run: switchModel },
  model: {
    cap: "model",
    args: "[provider/id[:level] | roles]",
    description: "Switch model for this session (roles: omp's role-model hub)",
    subs: [{ name: "roles", description: "omp's role-model hub", mode: "terminal" }],
    handles: (a) => a !== "roles",
    run: switchModel,
  },
  effort: {
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
  fast: {
    cap: "fast",
    handles: (a) => !a || a === "on" || a === "off",
    run: async (c, a) => {
      const on = a === "on" ? true : a === "off" ? false : !c.meta?.fast;
      return ok(await hostCall(c.hostId, "agent.setFast", { agentId: c.agentId, on }, { success: `Fast ${on ? "on" : "off"}` }));
    },
  },
  plan: {
    cap: "plan",
    // `/plan <prompt>` enters plan mode and submits the prompt: omp.
    handles: (a) => !a,
    run: async (c) => {
      const on = (c.meta?.mode ?? "normal") === "normal";
      return ok(await hostCall(c.hostId, "agent.setPlan", { agentId: c.agentId, on }, { success: on ? "Plan mode on" : "Plan mode off" }));
    },
  },
  goal: {
    cap: "goal",
    handles: (a) => first(a) !== "show",
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
  compact: {
    cap: "compact",
    handles: (a) => !["soft", "remote", "snapcompact"].includes(first(a)),
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.compact", { agentId: c.agentId, instructions: a || undefined }, { success: "Compacting…" })),
  },
  handoff: {
    cap: "handoff",
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.handoff", { agentId: c.agentId, instructions: a || undefined }, { success: "Handoff started" })),
  },
  rename: {
    cap: "rename",
    run: async (c, a) => {
      if (!a) {
        useSessionUi.getState().openDialog(c.key, "rename");
        return true;
      }
      return ok(await hostCall(c.hostId, "agent.rename", { agentId: c.agentId, title: a }, { success: "Renamed" }));
    },
  },
  fork: {
    cap: "fork",
    // window / tab: omp opens the fork in a new herdr tab.
    handles: (a) => !a || a === "pane",
    run: async (c, a) => ok(await hostCall(c.hostId, "agent.fork", { agentId: c.agentId, placement: a === "pane" ? "pane" : "inPlace" }, { success: "Forked" })),
  },
  new: { run: async (c) => ok(await hostCall(c.hostId, "agent.newSession", { agentId: c.agentId }, { success: "New session" })) },
  export: {
    cap: "export",
    handles: (a) => !a,
    run: async (c) => {
      const r = await hostCall(c.hostId, "agent.export", { agentId: c.agentId });
      if (r.ok) toast({ title: "Session exported", description: r.value.path, status: "done" });
      return r.ok;
    },
  },
  btw: {
    cap: "btw",
    run: async (c, a) => {
      if (!a) return inspector(c, "btw");
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
  tree: { cap: "tree", description: "Session tree: navigate, branch or fork from any message", run: (c) => inspector(c, "tree") },
  branch: { cap: "tree", description: "Rewind: branch from an earlier message (session tree)", run: (c) => inspector(c, "tree") },
  todo: {
    handles: (a) => !a || a === "copy",
    run: (c, a) => {
      if (!a) return inspector(c, "todos");
      const md = todosMarkdown(c.meta);
      if (!md) {
        toast({ title: "No todos yet", status: "idle" });
        return Promise.resolve(false);
      }
      return copyLocal(md, "todos as Markdown");
    },
  },
  copy: {
    args: "[code|cmd|link]",
    description: "Copy the last reply, code block, command or link to this device",
    subs: [
      { name: "code", description: "Last code block" },
      { name: "cmd", description: "Last shell command the agent ran" },
      { name: "link", description: "Last link" },
    ],
    run: (c, a) => {
      const what = a === "code" || a === "cmd" || a === "link" ? a : "text";
      const value = pickFromTranscript(getTranscript(c.key).items, what);
      if (!value) {
        toast({ title: "Nothing to copy", description: `No ${what === "text" ? "reply" : what} in the loaded transcript.`, status: "idle" });
        return Promise.resolve(false);
      }
      return copyLocal(value, what === "text" ? "the last reply" : `the last ${what}`);
    },
  },
  open: {
    args: "",
    description: "Open the last link from the conversation on this device",
    run: async (c) => {
      const url = pickFromTranscript(getTranscript(c.key).items, "link");
      if (!url) {
        toast({ title: "No link in the loaded transcript", status: "idle" });
        return false;
      }
      await openLink(url);
      return true;
    },
  },
  dump: {
    // all / anon: a zip on the host.
    handles: (a) => !a,
    run: (c) => {
      const { items, hasMore } = getTranscript(c.key);
      const md = transcriptMarkdown(items);
      if (!md) {
        toast({ title: "Transcript is empty", status: "idle" });
        return Promise.resolve(false);
      }
      return copyLocal(md, hasMore ? "the loaded transcript (scroll up to load older turns)" : "the transcript");
    },
  },
  collab: {
    handles: (a) => !a || a === "start",
    run: async (c) => ok(await hostCall(c.hostId, "agent.connect", { agentId: c.agentId }, { success: "Sharing with TeleFlock" })),
  },
};

function fromOmp(o: OmpCommand): SlashCommand {
  const native = NATIVE[o.name];
  const subs = [...(native?.subs ?? []), ...(o.subs ?? []).filter((s) => !native?.subs?.some((n) => n.name === s.name))];
  const modeFor = (args: string): SlashMode => {
    if (native && (native.handles?.(args) ?? true)) return "native";
    if (!args) return o.bare ?? o.mode;
    return subs.find((s) => s.name === first(args))?.mode ?? o.mode;
  };
  const args = native?.args === "" ? undefined : (native?.args ?? o.args);
  return {
    name: o.name,
    aliases: o.aliases,
    args,
    description: native?.description ?? o.description,
    mode: modeFor(""),
    cap: native?.cap,
    instant: !args,
    subs: subs.length ? subs : undefined,
    source: "omp",
    modeFor,
    run: native?.run,
    needsArgs: o.needsArgs,
    confirm: o.confirm,
  };
}

const APP_ONLY: SlashCommand[] = [
  {
    name: "stop",
    aliases: ["abort"],
    description: "Abort the current turn (Esc)",
    mode: "native",
    cap: "abort",
    instant: true,
    source: "teleflock",
    modeFor: () => "native",
    run: async (c) => ok(await hostCall(c.hostId, "agent.abort", { agentId: c.agentId })),
  },
  {
    name: "terminal",
    aliases: ["term"],
    description: "Open the real terminal beside the session",
    mode: "native",
    instant: true,
    source: "teleflock",
    modeFor: () => "native",
    run: (c) => {
      c.openTerminal();
      return Promise.resolve(true);
    },
  },
];

export const SLASH_COMMANDS: SlashCommand[] = [...OMP_COMMANDS.map(fromOmp), ...APP_ONLY];

function customCommand(info: CommandInfo): SlashCommand {
  return {
    name: info.name,
    description: info.description ?? (info.source === "skill" ? "Skill" : info.source === "prompt" ? "Prompt template" : "Extension command"),
    args: "[args]",
    mode: "direct",
    source: info.source,
    modeFor: () => "direct",
  };
}

/** `/skill:<name>` when the session's skills aren't listed (no bridge): sent as typed. */
const SKILL_FALLBACK: SlashCommand = {
  name: "skill:",
  args: "<name> [args]",
  description: "Invoke a skill by name",
  mode: "direct",
  source: "skill",
  modeFor: () => "direct",
};

export function findCommand(name: string, custom: readonly CommandInfo[] = []): SlashCommand | undefined {
  const builtin = SLASH_COMMANDS.find((c) => c.name === name || c.aliases?.some((a) => a.replace(/:$/, "") === name));
  if (builtin) return builtin;
  const dyn = custom.find((c) => c.name === name);
  if (dyn) return customCommand(dyn);
  return name.startsWith("skill:") && name.length > 6 ? { ...SKILL_FALLBACK, name } : undefined;
}

/** Ranked prefix/substring/alias match for the palette: builtins, then the session's own commands. */
export function matchCommands(query: string, custom: readonly CommandInfo[] = []): SlashCommand[] {
  const q = query.toLowerCase();
  const all = [...SLASH_COMMANDS, ...custom.map(customCommand)];
  if (!custom.some((c) => c.source === "skill")) all.push(SKILL_FALLBACK);
  if (!q) return all;
  const scored: [number, SlashCommand][] = [];
  for (const c of all) {
    const n = c.name.toLowerCase();
    const score =
      n === q ? 0 : n.startsWith(q) ? 1 : c.aliases?.some((a) => a.startsWith(q)) ? 1.5 : n.includes(q) ? 2 : c.description.toLowerCase().includes(q) ? 3 : -1;
    if (score >= 0) scored.push([score, c]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** Argument choices once `/name ` is typed. */
export function matchSubs(cmd: SlashCommand, query: string): OmpSubcommand[] {
  const q = query.toLowerCase();
  return (cmd.subs ?? []).filter((s) => s.name.startsWith(q) || (q.length > 1 && s.description.toLowerCase().includes(q)));
}

export const MODE_BADGE: Record<SlashMode, string | null> = {
  native: null,
  direct: "omp",
  report: "output in terminal",
  terminal: "opens in terminal",
};

/** Splits `/name args` the way omp does (first whitespace or `:`; `/skill:<name>` keeps its prefix). */
export function parseSlash(input: string): { name: string; args: string } | null {
  const body = input.trim();
  if (!body.startsWith("/") || body.length < 2) return null;
  const name = ompCommandName(body);
  return { name, args: body.slice(1 + name.length).replace(/^:/, "").trim() };
}

/** Sends a command to omp. `report`/`terminal` show the agent's terminal, where omp renders that part. */
async function viaOmp(ctx: SlashContext, command: string, mode: OmpCommandMode): Promise<boolean> {
  const call = hostCall(ctx.hostId, "agent.slash", { agentId: ctx.agentId, command }, { failure: `${command} failed` });
  if (mode === "direct") {
    const r = await call;
    if (r.ok) toast({ title: `Sent ${command}`, status: "done", duration: 2200 });
    return r.ok;
  }
  // Panels and selectors may hold the call open until the user closes them: show the terminal now.
  ctx.openTerminal();
  toast({
    title: mode === "terminal" ? `${command} opens in the terminal` : `Sent ${command}`,
    description: mode === "terminal" ? "Continue in omp's own UI there; Esc closes it." : "omp shows the result in its terminal.",
    status: "running",
    duration: 3200,
  });
  return true;
}

/** Execute `/name args`: native controls first, then omp through `agent.slash`. */
export async function runSlash(ctx: SlashContext, input: string, opts: { confirmed?: boolean } = {}): Promise<boolean> {
  const parsed = parseSlash(input);
  if (!parsed) return false;
  const { name, args } = parsed;
  const cmd = findCommand(name, ctx.custom);
  if (!cmd) {
    toast({ title: `Unknown command /${name}`, description: "TeleFlock only sends commands omp knows. Start with a space to send it as text.", status: "error" });
    return false;
  }
  if (cmd.needsArgs && !args) {
    toast({ title: `/${cmd.name} needs arguments`, description: cmd.args ? `/${cmd.name} ${cmd.args}` : undefined, status: "error" });
    return false;
  }
  const command = `/${name}${args ? ` ${args}` : ""}`;
  if (cmd.confirm && !opts.confirmed) {
    toast({ title: cmd.confirm, description: command, status: "needs-you", duration: 8000, action: { label: "Run", onClick: () => void runSlash(ctx, input, { confirmed: true }) } });
    return true;
  }
  const mode = cmd.modeFor(args);
  if (mode === "native" && cmd.run) {
    if (cmd.cap && ctx.meta && !ctx.meta.caps[cmd.cap]) {
      toast({ title: `/${cmd.name} isn't available right now`, description: "This session doesn't expose that control (bridge missing or agent busy).", status: "error" });
      return false;
    }
    return cmd.run(ctx, args);
  }
  return viaOmp(ctx, cmd.name === "model" && args === "roles" ? "/model" : command, mode === "native" ? "direct" : mode);
}
