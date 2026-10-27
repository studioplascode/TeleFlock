import type { ActivityKind, Capabilities, NotifyKind, PrunedAgent, SessionSnapshot, Started } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import { type AgentDef, WORKTREES } from "./data";
import { historyFor } from "./seeds";

/*
 * Demo of done agents' lifecycle (architecture §3, "Parked agents"): Mark done with `close` parks an
 * idle agent after a 10 s undo window (its pane leaves the workspace); `agent.resume`, unarchiving
 * or prompting brings it back under a new id with the same omp session; a parked agent whose
 * session file "gets deleted" is pruned (`HostInfo.pruned`).
 */

/** Undo window between Mark done and closing the pane (hostd: 10 s). */
export const PARK_GRACE_MS = 10_000;
/** The seeded parked agent whose session file is deleted, this long after the host starts. */
export const PRUNE_AFTER_MS = 60_000;

/** Where a parked agent ran, to reopen it there (or in a new workspace at its folder). */
export interface Place {
  workspaceId?: string;
  cwd: string;
  repo?: string;
  branch?: string;
  worktree: boolean;
}

/** What parking needs from its DemoHost (closures over the host's private state). */
export interface ParkingHost {
  now(): number;
  after(ms: number, fn: () => void): () => void;
  online(): boolean;
  sims: ReadonlyMap<string, AgentSim>;
  /** A seeded agent in a new pane of `workspaceId`. */
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
  /** Close the pane an agent left (its workspace with it when that was the last pane) and its terminals. */
  closePane(agentId: string, workspaceId: string, paneId: string): void;
  /**
   * The linked worktree `workspaceId` holds, as a parked card remembers it (hostd ≥ 0.5.2); its pull request
   * stays known by path, since the workspace may close with the pane.
   */
  parkWorktree(workspaceId: string): { path: string; repoRoot: string } | undefined;
  /** A pane for a resumed agent: in its workspace when that still exists, else in a new one at its folder. */
  openPane(agentId: string, place: Place): Omit<Started, "agentId"> & { tabId: string };
  /** Move an agent to a new id: the old id leaves and the new one arrives in the same patch. */
  rekey(sim: AgentSim, id: string): void;
  remove(agentId: string): void;
  /** Publish `HostInfo.pruned`. */
  setPruned(pruned: PrunedAgent[]): void;
  changed(agentId: string): void;
  activity(agentId: string, kind: ActivityKind, title: string, detail?: string): void;
  notify(agentId: string, kind: NotifyKind, title: string, body: string): void;
}

/** Seeded on forge: one parked agent to resume, one whose session gets deleted. */
const PARKED: { def: AgentDef; workspace: string; prune?: boolean }[] = [
  {
    workspace: "w3",
    def: {
      id: "tokens", kind: "omp", workspace: "w3", column: "done", model: "sonnet-5", thinking: "low", since: 10_800, age: 14_400, ctxPct: 27, cost: 1.12,
      title: "Dark and light theme tokens for the marketing site", line: "merged #31 · 3h ago", files: [],
    },
  },
  {
    workspace: "w12",
    prune: true,
    def: {
      id: "spike", kind: "omp", workspace: "w12", column: "done", model: "luna", thinking: "low", since: 26_000, age: 30_000, ctxPct: 8, cost: 0.21,
      title: "Spike: stream herdr events over SSE", line: "notes in scratch/sse-spike.md · 7h ago", files: [],
    },
  },
];

/** Agents `data.ts` seeds live that start out parked (Mark done closed their pane): gobump's worktree PR is merged. */
const PARK_SEEDED = ["gobump"];

export class DemoParking {
  private readonly places = new Map<string, Place>();
  /** Pending pane closes (agent id → cancel) during the undo window. */
  private readonly closing = new Map<string, () => void>();
  private pruned: PrunedAgent[] = [];
  private resumes = 0;

  constructor(private readonly host: ParkingHost) {}

  /** Seed the parked agents (forge) and schedule the deleted session. */
  seed(): void {
    const now = this.host.now();
    for (const { def, workspace, prune } of PARKED) {
      const sim = this.host.seedSim(def, workspace);
      sim.seed(historyFor(def), now - def.age * 1000, now - def.since * 1000);
      this.park(sim, now - def.since * 1000, false);
      if (!prune) continue;
      this.host.after(6_000, () => this.host.notify(def.id, "finished", `${def.id} finished`, def.title));
      this.host.after(PRUNE_AFTER_MS, () => this.prune(def.id));
    }
    for (const id of PARK_SEEDED) {
      const sim = this.host.sims.get(id);
      if (sim) this.park(sim, sim.agent.stateSince, false);
    }
  }

  /**
   * Handles a call that concerns parking; `undefined` lets the host handle it as usual. Throws
   * `parked` for controls a parked agent can't take (no pane, no omp running).
   */
  call(method: string, p: Record<string, unknown>): unknown {
    const id = typeof p.agentId === "string" ? p.agentId : undefined;
    const sim = id ? this.host.sims.get(id) : undefined;
    if (method === "agent.resume") {
      if (!sim) throw apiError("not_found", `agent ${String(id)} not found`);
      if (!sim.agent.parked) throw apiError("invalid_params", `${sim.agent.name} is running; only a parked agent resumes`, { hint: "Open it instead" });
      return this.resume(sim);
    }
    if (method === "term.open") {
      const target = (p.target ?? {}) as Record<string, unknown>;
      const t = target.kind === "agent" && typeof target.agentId === "string" ? this.host.sims.get(target.agentId) : undefined;
      if (t?.agent.parked) throw parkedError(t);
      return undefined;
    }
    if (!sim) return undefined;
    if (method === "agent.archive") {
      if (sim.agent.parked) return p.archived ? {} : (this.resume(sim), {});
      this.closing.get(sim.agent.id)?.();
      this.closing.delete(sim.agent.id);
      if (p.archived && p.close) this.closeLater(sim);
      return undefined;
    }
    if (!sim.agent.parked) return undefined;
    switch (method) {
      case "session.open":
        return this.readOnly(sim, typeof p.limit === "number" ? p.limit : 200);
      case "session.close":
        return {};
      case "agent.prompt": {
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (!text) throw apiError("invalid_params", "Empty prompt");
        this.resume(sim, text);
        return {};
      }
      default:
        throw parkedError(sim);
    }
  }

  /** Mark done with close: after the undo window, park it if it is still done and idle. */
  private closeLater(sim: AgentSim): void {
    const id = sim.agent.id;
    const cancel = this.host.after(PARK_GRACE_MS, () => {
      this.closing.delete(id);
      const a = sim.agent;
      if (this.host.sims.get(id) !== sim || !a.archived || a.parked || !sim.omp || !a.omp?.sessionFile) return;
      if (a.state === "working" || a.state === "blocked" || a.needs) return;
      this.park(sim, this.host.now(), true);
    });
    this.closing.set(id, cancel);
  }

  private park(sim: AgentSim, at: number, live: boolean): void {
    const a = sim.agent;
    const { workspaceId, paneId } = a;
    this.places.set(a.id, { workspaceId, cwd: a.cwd ?? "", repo: a.repo, branch: a.branch, worktree: (a.cwd ?? "").startsWith(`${WORKTREES}/`) });
    const worktree = this.host.parkWorktree(workspaceId);
    a.paneId = "";
    a.tabId = "";
    a.workspaceId = "";
    a.parked = { at, sessionFile: a.omp?.sessionFile ?? "", ...(worktree ? { worktree } : {}) };
    a.state = "idle";
    a.stateSince = at;
    a.column = "done";
    a.archived = true;
    a.needs = undefined;
    a.live = { ...a.live, streaming: false, thinking: false, tool: undefined, tps: undefined, tpsSplit: undefined };
    if (a.omp) a.omp = { ...a.omp, link: "notShared", bridge: false, pid: undefined };
    this.host.closePane(a.id, workspaceId, paneId);
    this.host.changed(a.id);
    if (live) this.host.activity(a.id, "stopped", `${a.name} pane closed (done)`, "Resumes with omp --resume when needed");
  }

  /** omp --resume in a new pane, under a new id; `prompt` runs once omp is up. */
  private resume(sim: AgentSim, prompt?: string): Started {
    const a = sim.agent;
    const old = a.id;
    const place = this.places.get(old) ?? { cwd: a.cwd ?? "", repo: a.repo, branch: a.branch, worktree: false };
    let id = `${a.name}-r${++this.resumes}`;
    while (this.host.sims.has(id)) id = `${a.name}-r${++this.resumes}`;
    const pane = this.host.openPane(id, place);
    this.host.rekey(sim, id);
    this.places.delete(old);
    a.paneId = pane.paneId;
    a.tabId = pane.tabId;
    a.workspaceId = pane.workspaceId;
    a.parked = undefined;
    a.archived = false;
    a.column = "review";
    a.state = "done";
    a.stateSince = this.host.now();
    if (a.omp) a.omp = { ...a.omp, link: "connecting", pid: 41_000 + this.resumes };
    this.host.changed(id);
    this.host.activity(id, "started", `${a.name} resumed`, a.omp?.sessionFile);
    this.host.after(1400, () => {
      if (this.host.sims.get(id) !== sim || !a.omp) return;
      a.omp = { ...a.omp, link: "live", bridge: true };
      this.host.changed(id);
      if (prompt) sim.startTurn(prompt);
    });
    return { agentId: id, paneId: pane.paneId, workspaceId: pane.workspaceId };
  }

  /** The last transcript rows from the session file: nothing runs, only a prompt (it resumes) is allowed. */
  private readOnly(sim: AgentSim, limit: number): SessionSnapshot {
    const snap = sim.snapshot(limit);
    const caps = { ...snap.meta.caps };
    for (const k of Object.keys(caps) as (keyof Capabilities)[]) caps[k] = k === "prompt";
    return { agentId: snap.agentId, meta: { ...snap.meta, caps }, items: snap.items, hasMore: false };
  }

  /** Its omp session file was deleted: the agent goes, and the host says so in `HostInfo.pruned`. */
  private prune(id: string): void {
    const sim = this.host.sims.get(id);
    if (!sim?.agent.parked) return;
    this.host.remove(id);
    this.places.delete(id);
    this.pruned = [{ agentId: id, sessionId: sim.agent.omp?.sessionId, at: this.host.now() }, ...this.pruned].slice(0, 200);
    this.host.setPruned(this.pruned);
  }
}

function parkedError(sim: AgentSim): Error {
  return apiError("parked", `${sim.agent.name} is done and its pane is closed`, { hint: "Resume it first" });
}
