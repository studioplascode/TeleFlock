import { create } from "zustand";
import { core, parseAgentKey, resumeAgent, whenAgent } from "@/core";
import type { AgentView } from "@/core";
import type { Agent, PrInfo, Workspace } from "@/core/gen";
import { describeError } from "../workspace/shared/errors";

/*
 * Make it green, and rebase and resolve (Review → ship panel, pull request stage). Failing checks:
 * the worktree's agent runs omp's bundled `/green` (it watches the CI runs of HEAD, reads the failing
 * logs, fixes, pushes and repeats until they pass). Conflicts, or a branch behind its base: the agent
 * is asked to rebase onto the base and resolve them. A parked agent is resumed first. Progress comes
 * from the board (the agent working or waiting on you) and the pull request the panel polls.
 */

export type FixKind = "green" | "rebase";
export type RebaseReason = "conflicts" | "behind";

/** What an open pull request needs from its agent. */
export interface FixOffer {
  /** Checks failed. */
  green: boolean;
  /** GitHub can't merge it as it is. */
  rebase?: RebaseReason;
}

export function fixOffer(pr: PrInfo | undefined): FixOffer {
  if (!pr || pr.state !== "OPEN") return { green: false };
  const conflicts = pr.mergeable === false || pr.mergeState === "DIRTY";
  return { green: (pr.checks?.failed ?? 0) > 0, rebase: conflicts ? "conflicts" : pr.mergeState === "BEHIND" ? "behind" : undefined };
}

/** The pull request stage in a few words: what the open PR needs next (ship stepper, board cards). */
export function prNext(pr: PrInfo): string {
  if (pr.state === "CLOSED") return `PR #${pr.number} closed`;
  if ((pr.checks?.pending ?? 0) > 0) return `#${pr.number} checks running`;
  const offer = fixOffer(pr);
  if (offer.green) return `Make #${pr.number} green`;
  if (offer.rebase) return `Rebase #${pr.number}`;
  return `Merge #${pr.number}`;
}

/** What a rebase goes onto: the pull request's base branch on origin, else the repo's default branch. */
export function rebaseOnto(pr: PrInfo | undefined, defaultBranch: string | undefined): string {
  return `origin/${pr?.baseRef ?? defaultBranch ?? "main"}`;
}

/** The prompt for "Rebase onto origin/main and resolve". */
export function rebasePrompt(onto: string, why: RebaseReason): string {
  const slash = onto.indexOf("/");
  const fetch = slash > 0 ? `git fetch ${onto.slice(0, slash)} ${onto.slice(slash + 1)}` : "git fetch";
  return [
    why === "conflicts"
      ? `GitHub reports merge conflicts between this branch's pull request and ${onto}.`
      : `This branch's pull request is behind ${onto}, and the repository requires it to be up to date before it can merge.`,
    `Run \`${fetch}\`, then rebase this branch onto ${onto} (\`git rebase ${onto}\`), resolve every conflict keeping the intent of both sides, and continue until the rebase completes.`,
    "Run the tests that cover what you touched, then push with `git push --force-with-lease`.",
    "If a conflict needs a product decision, stop and ask me instead of guessing.",
  ].join(" ");
}

/**
 * The agent to ask: an omp agent of the workspace (an idle one first, then the latest to change
 * state), else the most recently parked omp agent that ran in its checkout (it is resumed first).
 */
export function worktreeAgent<A extends Agent>(agents: readonly A[], ws: Pick<Workspace, "id" | "cwd" | "worktree">): A | undefined {
  const omp = agents.filter((a) => a.kind === "omp");
  const busy = (a: A) => (a.column === "running" || a.column === "needs" ? 1 : 0);
  const live = omp.filter((a) => !a.parked && a.workspaceId === ws.id).sort((a, b) => busy(a) - busy(b) || b.stateSince - a.stateSince);
  if (live[0]) return live[0];
  const dir = ws.worktree?.path ?? ws.cwd;
  const inside = (p: string | undefined) => !!p && (p === dir || p.startsWith(`${dir}/`) || p.startsWith(`${dir}\\`));
  return omp.filter((a) => a.parked && (a.parked.worktree?.path === dir || inside(a.cwd))).sort((a, b) => (b.parked?.at ?? 0) - (a.parked?.at ?? 0))[0];
}

/** Why the agent can't take the request now; undefined when it can (a parked agent is resumed first). */
export function fixBlocker(agent: Agent | undefined, kind: FixKind): string | undefined {
  if (!agent) return "No omp agent works in this worktree";
  if (agent.parked) return undefined;
  if (agent.column === "running") return `${agent.name} is working; ask again when its turn ends`;
  if (agent.column === "needs") return `${agent.name} is waiting on you first`;
  if (agent.omp?.link !== "live") return `${agent.name} isn't connected to TeleFlock`;
  if (kind === "green" && !agent.omp.bridge) return `${agent.name}'s omp runs without TeleFlock's bridge, which /green needs`;
  return undefined;
}

// ---------------------------------------------------------------- runs

/** One request from this device, per worktree (in memory). */
export interface FixRun {
  kind: FixKind;
  /** The agent asked; a parked one's new key once it is back. */
  agentKey: string;
  agentName: string;
  /** Where the request stands here: being resumed, being sent, in, or failed. */
  step: "resuming" | "sending" | "sent" | "failed";
  error?: string;
  /** Rebase target (`origin/main`). */
  onto?: string;
  /** When it was asked for, and when the agent took it. */
  at: number;
  sentAt?: number;
  /** The agent was seen working since it took the request. */
  worked?: boolean;
}

export const useFixRuns = create<{ runs: Record<string, FixRun> }>()(() => ({ runs: {} }));

export function fixKey(hostId: string, cwd: string): string {
  return `${hostId}\n${cwd}`;
}

function patchRun(key: string, patch: Partial<FixRun>): void {
  useFixRuns.setState((s) => {
    const cur = s.runs[key];
    return cur ? { runs: { ...s.runs, [key]: { ...cur, ...patch } } } : s;
  });
}

/** The agent's turn for the request showed up on the board. */
export function noteWorking(key: string): void {
  const run = useFixRuns.getState().runs[key];
  if (run?.step === "sent" && !run.worked) patchRun(key, { worked: true });
}

export function dismissFix(key: string): void {
  useFixRuns.setState((s) => {
    if (!(key in s.runs)) return s;
    const runs = { ...s.runs };
    delete runs[key];
    return { runs };
  });
}

/** A request the agent took but whose turn hasn't shown up after this long counts as stopped. */
export const START_GRACE_MS = 30_000;
/** A resumed agent gets this long to come up (omp, its session, TeleFlock's bridge). */
const READY_MS = 120_000;

export type FixPhase =
  | "resuming"
  | "sending"
  | "failed"
  /** The agent took it; its turn hasn't shown up yet. */
  | "starting"
  | "working"
  | "needsYou"
  /** The agent's turn ended; CI runs on its push. */
  | "checksRunning"
  /** The agent's turn ended; GitHub is computing mergeability again. */
  | "recheck"
  | "done"
  /** The agent's turn ended and the pull request still needs it. */
  | "stopped";

/** Where a run stands, from the request, the agent on the board and the pull request now. */
export function fixPhase(run: FixRun, agent: Pick<Agent, "column"> | undefined, pr: PrInfo | undefined, now: number): FixPhase {
  if (run.step !== "sent") return run.step;
  if (agent?.column === "running") return "working";
  if (agent?.column === "needs") return "needsYou";
  if (pr?.state === "MERGED") return "done";
  if (run.kind === "green") {
    const c = pr?.checks;
    if (c && c.failed === 0 && c.pending === 0) return "done";
    if (c && c.pending > 0) return "checksRunning";
  } else {
    if (pr?.mergeable === true && pr.mergeState !== "BEHIND" && pr.mergeState !== "DIRTY") return "done";
    if (pr && pr.mergeable == null) return "recheck";
  }
  return !run.worked && now - (run.sentAt ?? run.at) < START_GRACE_MS ? "starting" : "stopped";
}

/** Phases with work in flight: no new request then. */
export function fixActive(phase: FixPhase | undefined): boolean {
  return phase !== undefined && phase !== "done" && phase !== "stopped" && phase !== "failed";
}

/**
 * Sends the request to `agent` for the worktree at `cwd`: `/green` through omp's own command
 * (`agent.slash`), or the rebase prompt (`agent.prompt`). A parked agent is resumed first and asked
 * once it is connected (and, for `/green`, once TeleFlock's bridge is up).
 */
export async function startFix(hostId: string, cwd: string, kind: FixKind, agent: AgentView, rebase?: { onto: string; why: RebaseReason }): Promise<void> {
  const key = fixKey(hostId, cwd);
  const cur = useFixRuns.getState().runs[key];
  if (cur && (cur.step === "resuming" || cur.step === "sending")) return;
  const run: FixRun = { kind, agentKey: agent.key, agentName: agent.name, step: agent.parked ? "resuming" : "sending", onto: rebase?.onto, at: Date.now() };
  useFixRuns.setState((s) => ({ runs: { ...s.runs, [key]: run } }));
  try {
    let target: AgentView = agent;
    if (agent.parked) {
      const next = await resumeAgent(agent.key);
      if (!next) throw new Error(`${agent.name} didn't come back after resuming`);
      patchRun(key, { agentKey: next, step: "sending" });
      const ready = await whenAgent(next, (a) => a.omp?.link === "live" && a.column !== "running" && a.column !== "needs" && (kind === "rebase" || a.omp.bridge), READY_MS);
      if (!ready) {
        throw new Error(
          kind === "green" ? `${agent.name} is back, but TeleFlock's bridge in its omp didn't connect: run /green in its terminal` : `${agent.name} is back, but its session didn't connect`,
        );
      }
      target = ready;
    }
    const { agentId } = parseAgentKey(target.key);
    if (kind === "green") await core.host(hostId).call("agent.slash", { agentId, command: "/green" });
    else await core.host(hostId).call("agent.prompt", { agentId, text: rebasePrompt(rebase?.onto ?? "origin/main", rebase?.why ?? "conflicts"), images: [], delivery: "auto" });
    patchRun(key, { step: "sent", sentAt: Date.now() });
  } catch (e) {
    const d = describeError(e);
    patchRun(key, { step: "failed", error: d.hint ? `${d.title}. ${d.hint}` : d.title });
  }
}
