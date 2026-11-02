import { create } from "zustand";
import { type AgentRenameInput, type AgentView, core, getAgentViews, getTranscript, parseAgentKey, suggestAgentRename, useAgent, useHostStale } from "@/core";
import type { Agent, TranscriptItem } from "@/core/gen";
import { dismissToast, toast } from "@/design";
import { isFresh } from "@/features/shell/vocab";
import { currentRecap } from "./recap";
import { reportError } from "./agentActions";

/*
 * "Name it again": every agent menu's ✨ action. omp's tiny model names the agent from what it does NOW
 * (its latest task, last reply, recent tool calls, liveness line, recap, with the current names so only what
 * no longer fits changes), through the same two renames the Rename dialog makes: the herdr handle
 * (`agent.renameHandle`) and the omp session title (`agent.rename`). Toast with Undo.
 */

/** Tool lines, newest last, kept for the prompt. */
const TOOLS = 8;

/** A user prompt this short ("yes", "go on") says nothing about the task: an earlier one is preferred. */
const SUBSTANTIVE_WORDS = 4;

/** `tool: title` of a transcript tool row, on one line. */
function toolLine(it: Extract<TranscriptItem, { kind: "tool" }>): string {
  const what = (it.intent?.trim() || it.title.trim()).replace(/\s+/g, " ");
  return what ? `${it.tool}: ${what}` : it.tool;
}

/**
 * What the tiny model is told about an agent: the live facts of the agent, and, from its loaded transcript
 * (`rows`, oldest first; empty when its session was never opened), the latest task, the last reply and the last
 * tool calls. Nothing else of the transcript leaves the app.
 */
export function agentRenameInput(agent: Pick<Agent, "name" | "title" | "branch" | "column" | "omp" | "live">, rows: readonly TranscriptItem[]): AgentRenameInput {
  let task: string | undefined;
  let lastPrompt: string | undefined;
  let reply: string | undefined;
  const tools: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const it = rows[i];
    if (!it) continue;
    if (it.kind === "tool") {
      if (tools.length < TOOLS) tools.unshift(toolLine(it));
    } else if (it.kind === "assistant") {
      if (reply === undefined && it.text.trim()) reply = it.text.trim();
    } else if (it.kind === "user" && !it.synthetic && it.text.trim()) {
      lastPrompt ??= it.text.trim();
      if (it.text.trim().split(/\s+/).length >= SUBSTANTIVE_WORDS) {
        task = it.text.trim();
        break;
      }
    }
  }
  task ??= lastPrompt;
  const live = agent.live;
  const line = [live.tool && agent.column === "running" ? live.tool.label : undefined, live.line].filter((s, i, all): s is string => !!s?.trim() && all.indexOf(s) === i).join(" · ");
  return {
    name: agent.name,
    title: agent.title,
    ...(agent.branch ? { branch: agent.branch } : {}),
    ...(task ? { task } : {}),
    ...(reply ? { reply } : {}),
    ...(tools.length ? { tools } : {}),
    ...(line ? { line } : {}),
    ...(currentRecap(agent) ? { recap: currentRecap(agent)?.text } : {}),
  };
}

/** What a rename changes: each part with the value it replaces (for Undo). */
export interface RenameChange {
  name?: { from: string; to: string };
  title?: { from: string; to: string };
}

/**
 * The parts of the model's answer that differ from the current names. A title only where the session has one and
 * can be retitled: omp can't clear a title, so Undo couldn't take back a first one. A part the model repeated (it
 * still fits) or left out changes nothing.
 */
export function planRename(current: { name: string; title: string }, answer: { name: string | null; title: string | null }, canTitle: boolean): RenameChange {
  const change: RenameChange = {};
  if (answer.name && answer.name !== current.name) change.name = { from: current.name, to: answer.name };
  if (canTitle && current.title.trim() && answer.title && answer.title.trim() !== current.title.trim()) change.title = { from: current.title, to: answer.title.trim() };
  return change;
}

/**
 * Whether omp takes a new session title now: through its bridge any time; without it the host types `/rename`,
 * which only an idle session accepts (`agent.rename`).
 */
export function canRetitle(agent: Pick<Agent, "omp" | "column">): boolean {
  return !!agent.omp && (agent.omp.bridge || agent.column === "review" || agent.column === "done");
}

/** An agent with a pane (a parked one has none: Resume first), that is past "waiting for its first prompt", has something to name. */
export function canRenameAgain(agent: Pick<Agent, "paneId" | "parked" | "column" | "turns" | "title"> | undefined): boolean {
  return !!agent && !!agent.paneId && !agent.parked && !isFresh(agent);
}

/** What the flow touches outside itself (the app core), so tests can stand in for it. */
export interface Io {
  agents(): readonly AgentView[];
  transcript(key: string): readonly TranscriptItem[];
  /** herdr agent name (`agent.renameHandle`). */
  renameHandle(hostId: string, agentId: string, name: string): Promise<unknown>;
  /** omp session title (`agent.rename`). */
  renameTitle(hostId: string, agentId: string, title: string): Promise<unknown>;
  suggest: typeof suggestAgentRename;
}

const realIo: Io = {
  agents: getAgentViews,
  transcript: (key) => getTranscript(key).items,
  renameHandle: (hostId, agentId, name) => core.host(hostId).call("agent.renameHandle", { agentId, name }),
  renameTitle: (hostId, agentId, title) => core.host(hostId).call("agent.rename", { agentId, title }),
  suggest: suggestAgentRename,
};

/**
 * Applies `change`: the handle first (a herdr name clash fails before the session title changes, as in the
 * Rename dialog), then the title. Resolves to what was applied; a failing step toasts and stops.
 */
async function applyRename(io: Io, hostId: string, agentId: string, change: RenameChange): Promise<RenameChange> {
  const applied: RenameChange = {};
  try {
    if (change.name) {
      await io.renameHandle(hostId, agentId, change.name.to);
      applied.name = change.name;
    }
    if (change.title) {
      await io.renameTitle(hostId, agentId, change.title.to);
      applied.title = change.title;
    }
  } catch (err) {
    reportError(applied.name ? "Renamed, but the session title didn't change" : "Couldn't rename it", err);
  }
  return applied;
}

/** Undo of {@link applyRename}: puts each part back unless it was changed again since (then it is left alone). */
export async function undoRename(key: string, applied: RenameChange, io: Io = realIo): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  const now = io.agents().find((a) => a.key === key);
  if (!now) return;
  const restore: RenameChange = {};
  if (applied.name && now.name === applied.name.to) restore.name = { from: applied.name.to, to: applied.name.from };
  if (applied.title && now.title.trim() === applied.title.to) restore.title = { from: applied.title.to, to: applied.title.from.trim() };
  if (!restore.name && !restore.title) {
    toast({ title: `${now.name} was renamed again since`, description: "Nothing to undo", status: "idle" });
    return;
  }
  const back = await applyRename(io, hostId, agentId, restore);
  if (back.name || back.title) toast({ title: `Restored ${back.name?.to ?? now.name}`, status: "done", duration: 2600 });
}

const useRenaming = create<{ busy: Readonly<Record<string, true>> }>(() => ({ busy: {} }));

function setBusy(key: string, on: boolean): void {
  useRenaming.setState((s) => {
    const busy = { ...s.busy };
    if (on) busy[key] = true;
    else delete busy[key];
    return { busy };
  });
}

/**
 * Ask the tiny model to name the agent again from what it does now and apply it, with an Undo toast. A model
 * that finds the names still fit changes nothing and says so; failures say why (AI naming off, no tiny role on
 * the host, host too old, no answer). Never rejects.
 */
export async function renameAgain(key: string, io: Io = realIo): Promise<void> {
  const agent = io.agents().find((a) => a.key === key);
  if (!agent || !canRenameAgain(agent) || useRenaming.getState().busy[key]) return;
  const { hostId, agentId } = parseAgentKey(key);
  setBusy(key, true);
  const waiting = toast({ title: `Naming ${agent.name}…`, description: "omp's tiny model reads what it is doing now", status: "running", duration: Number.POSITIVE_INFINITY });
  try {
    const taken = io
      .agents()
      .filter((a) => a.hostId === hostId && a.id !== agentId && !a.parked)
      .map((a) => a.name);
    const out = await io.suggest(hostId, agentRenameInput(agent, io.transcript(key)), taken);
    dismissToast(waiting);
    if (!out.ok) {
      toast({ title: out.failure.message, description: out.failure.hint, status: "error" });
      return;
    }
    // it may have been renamed, closed or marked done while the model thought
    const now = io.agents().find((a) => a.key === key);
    if (!now || !canRenameAgain(now)) return;
    // a name or title given meanwhile stays: the answer was made for the old ones
    if (now.name !== agent.name || now.title.trim() !== agent.title.trim()) {
      toast({ title: `${now.name} was renamed meanwhile`, description: "The model's names were for the old ones, so nothing changed. Name it again to ask anew.", status: "idle" });
      return;
    }
    const change = planRename(now, out.value, canRetitle(now));
    if (!change.name && !change.title) {
      toast({ title: `${now.name} still fits`, description: "Its name and title already match what it's doing", status: "idle" });
      return;
    }
    const applied = await applyRename(io, hostId, agentId, change);
    if (!applied.name && !applied.title) return;
    toast({
      title: applied.name ? `✨ ${applied.name.from} → ${applied.name.to}` : `✨ Retitled ${now.name}`,
      description: applied.title ? `Title: ${applied.title.to}` : undefined,
      status: "done",
      action: { label: "Undo", onClick: () => void undoRename(key, applied, io) },
      duration: 8000,
    });
  } finally {
    dismissToast(waiting);
    setBusy(key, false);
  }
}

/**
 * The menus' "Name it again": `available` (an agent with a pane on an online host, past its first prompt),
 * `busy` while the model answers, `run`.
 */
export function useRenameAgain(key: string): { available: boolean; busy: boolean; run: () => void } {
  const agent = useAgent(key);
  const stale = useHostStale(agent?.hostId ?? "");
  const busy = useRenaming((s) => key in s.busy);
  return { available: canRenameAgain(agent) && !stale, busy, run: () => void renameAgain(key) };
}
