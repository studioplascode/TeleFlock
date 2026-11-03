import { useEffect, useMemo, useState } from "react";
import { core, useCore } from "@/core";
import { isChat, isChatRepo } from "@/core/chats";
import type { CommandInfo, HostState } from "@/core/gen";
import { type NotFirst, type OmpCommand, ompCommand } from "@/core/ompCommands";
import { findCommand, parseSlash, type SlashOffer } from "@/features/session/composer/slash";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";

/*
 * A Dispatch message that is a command (`/plan add a settings page`, `/skill:review`): its new agent
 * runs it as the session composer would (`AgentSpec.command`: the host types it into omp's composer
 * once the agent can take it) instead of getting it as text. Only what makes sense as a brand-new
 * agent's first message is offered and sent.
 */

/** A Dispatch message that is a command, as its new agent runs it. */
export interface FirstCommand {
  /** The command line (`AgentSpec.command`): as typed, except `/model <id>`, which switches the model in TeleFlock and is sent as `/switch <id>`. */
  line: string;
  /** It turns on one of omp's plan, vibe and goal modes: the agent starts without the Plan option. */
  replacesPlan: boolean;
}

/** What a new agent in a folder will have besides omp's builtins, as far as the app knows. */
export interface NewAgentCommands {
  /** The folder's skills (`skills.list`), and the prompt templates and extension commands a live session there lists. */
  commands: CommandInfo[];
  /** The folder's skills are listed. */
  skills: boolean;
  /** A live session in the folder listed its prompt templates and extension commands. */
  session: boolean;
}

const NOT_FIRST: Record<NotFirst, string> = {
  history: "It works on what a session already has: run it from the agent's session once it is going.",
  session: "It leaves or replaces the agent's session, and each Dispatch message starts a new one.",
  turn: "It acts on a turn in progress: run it from the agent's session while it works.",
  host: "It changes omp on the host for every agent: run it from any session.",
};
const REPORT = "omp shows its result in its own terminal only: run it from a session.";
const TERMINAL = "It opens omp's own UI in the terminal: run it from a session.";
const RUNNING = "It's a TeleFlock control for a running agent: use it in the agent's session.";
const AS_TEXT = "Start the message with a space to send it as text.";

/**
 * Why builtin `o` with arguments `args` is no first message for a new agent (it works on what a
 * session already has, leaves the session, acts on a turn or on the host; omp shows it in its TUI
 * only), or null when it is one.
 */
export function whyNotFirst(o: OmpCommand, args: string): string | null {
  // TeleFlock's `/model <provider/id>` switches the model (`/switch`); bare, and `roles`, open omp's hub.
  if (o.name === "model") return args && args !== "roles" ? null : TERMINAL;
  const word = args.split(/\s+/, 1)[0] ?? "";
  const sub = args ? o.subs?.find((s) => s.name === word) : undefined;
  const bar = sub?.notFirst ?? o.notFirst;
  if (bar) return NOT_FIRST[bar];
  const mode = args ? (sub?.mode ?? o.mode) : (o.bare ?? o.mode);
  return mode === "report" ? REPORT : mode === "terminal" ? TERMINAL : null;
}

/**
 * The Dispatch palette: builtins a new agent can run in some form (and only those argument
 * choices), every skill, prompt template and extension command; no TeleFlock controls of a
 * running agent (`/stop`, `/terminal`).
 */
export const NEW_AGENT_OFFER: SlashOffer = {
  command: (c) => {
    if (c.source === "teleflock") return false;
    const o = c.source === "omp" ? ompCommand(c.name) : undefined;
    if (!o) return c.source !== "omp";
    if (whyNotFirst(o, "") === null) return true;
    if (!c.args) return false;
    // With argument choices, one of them; else any argument text ("…" is no choice).
    return o.subs?.length ? o.subs.some((s) => whyNotFirst(o, s.name) === null) : whyNotFirst(o, "…") === null;
  },
  sub: (c, s) => {
    const o = c.source === "omp" ? ompCommand(c.name) : undefined;
    return !o || whyNotFirst(o, s.name) === null;
  },
};

/**
 * A Dispatch message that is a command (`isSlashDraft`, no attachments) as its new agent runs it,
 * or why it can't (the toast's words). Recognised as the session composer recognises commands
 * (`findCommand`): omp's builtins, then the folder's skills, prompt templates and extension
 * commands as far as `known` lists them (any `/skill:<name>` while the skills aren't listed). A
 * builtin must make sense as a new agent's first message (`whyNotFirst`); commands are one line.
 */
export function firstCommand(input: string, known: NewAgentCommands): { ok: true; command: FirstCommand } | { ok: false; title: string; description?: string } {
  const body = input.trim();
  if (/[\r\n]/.test(body)) return { ok: false, title: "Commands are one line", description: `Put its arguments on the command's line. ${AS_TEXT}` };
  const parsed = parseSlash(body);
  if (!parsed?.name) return { ok: false, title: "Type a command after /", description: AS_TEXT };
  const { name, args } = parsed;
  const line = `/${name}${args ? ` ${args}` : ""}`;
  const builtin = ompCommand(name);
  if (builtin) {
    const why = whyNotFirst(builtin, args);
    if (why) return { ok: false, title: `/${name} doesn't fit a new agent`, description: why };
    if (builtin.needsArgs && !args) return { ok: false, title: `/${builtin.name} needs arguments`, description: builtin.args ? `/${builtin.name} ${builtin.args}` : undefined };
    return { ok: true, command: { line: builtin.name === "model" ? `/switch ${args}` : line, replacesPlan: builtin.sessionMode === true } };
  }
  const cmd = findCommand(name, known.commands);
  if (cmd?.source === "teleflock") return { ok: false, title: `/${name} doesn't fit a new agent`, description: RUNNING };
  const skill = name.startsWith("skill:");
  if (skill && known.skills && !known.commands.some((c) => c.name === name)) {
    return { ok: false, title: `No skill called ${name.slice(6)} here`, description: `It isn't one of this folder's skills on the host. ${AS_TEXT}` };
  }
  if (cmd) return { ok: true, command: { line, replacesPlan: false } };
  return {
    ok: false,
    title: `Unknown command /${name}`,
    description: known.session
      ? `TeleFlock only sends commands omp knows. ${AS_TEXT}`
      : `It isn't one of omp's commands or this folder's skills. Prompt templates and extension commands are known once an agent runs here. ${AS_TEXT}`,
  };
}

/**
 * The live session a new agent shares its prompt templates and extension commands with: one in
 * the repository (any of its worktrees), a chat for a chat. The first by id, so it stays put.
 */
function sessionIn(state: HostState | undefined, repo: string): string | undefined {
  if (!state) return undefined;
  const chat = isChatRepo(repo);
  const roots = new Map(state.workspaces.map((w) => [w.id, w.repo?.root]));
  let found: string | undefined;
  for (const a of state.agents) {
    if (a.omp?.link !== "live" || !a.omp.bridge || a.parked) continue;
    if (chat ? !isChat(a) : isChat(a) || roots.get(a.workspaceId) !== repo) continue;
    if (found === undefined || a.id < found) found = a.id;
  }
  return found;
}

/**
 * The skills, prompt templates and extension commands a new agent in `repo` on `hostId` will have
 * (a chat: in a chat folder): the folder's skills as the host lists them (`skills.list`, switched-off
 * ones left out), and the custom commands of a live session there (`agent.commands`), which shares
 * the repository's and the user's.
 */
export function useNewAgentCommands(hostId: string | undefined, repo: string | null | undefined): NewAgentCommands {
  const folder = hostId && repo ? repo : null;
  const skills = useHostQuery(hostId, "skills.list", folder === null ? null : isChatRepo(folder) ? {} : { cwd: folder });
  const donor = useCore((s) => (hostId && folder ? sessionIn(s.hosts[hostId]?.state, folder) : undefined));
  const [listed, setListed] = useState<{ agentId: string; commands: CommandInfo[] } | null>(null);
  useEffect(() => {
    if (!hostId || !donor) return;
    let live = true;
    core
      .host(hostId)
      .call("agent.commands", { agentId: donor })
      .then(
        (r) => live && setListed({ agentId: donor, commands: r.commands }),
        () => live && setListed(null),
      );
    return () => {
      live = false;
    };
  }, [hostId, donor]);
  const session = listed && listed.agentId === donor ? listed.commands : null;
  const list = skills.data;
  return useMemo(() => {
    const out = new Map<string, CommandInfo>();
    for (const s of list?.skills ?? []) if (s.enabled) out.set(`skill:${s.name}`, { name: `skill:${s.name}`, description: s.description, source: "skill" });
    for (const c of session ?? []) if (!out.has(c.name)) out.set(c.name, c);
    return { commands: [...out.values()], skills: list !== undefined, session: session !== null };
  }, [list, session]);
}
