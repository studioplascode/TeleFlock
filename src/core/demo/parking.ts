import type { ActivityKind, AgentEnded, Capabilities, NotifyKind, PrunedAgent, RetryResult, SessionSnapshot, Started } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import { type AgentDef, WORKTREES } from "./data";
import { bash, read, say, type Step, think } from "./scripts";
import { historyFor } from "./seeds";

/*
 * Demo of done agents' lifecycle (architecture §3, "Parked agents"): Mark done with `close` parks an
 * idle agent after a 10 s undo window (its pane leaves the workspace); `agent.resume`, unarchiving
 * or prompting brings it back under a new id with the same omp session; a parked agent whose
 * session file "gets deleted" is pruned (`HostInfo.pruned`).
 *
 * Ended cards (architecture §3.25: an agent's omp ended without anyone closing it) wait in Review with
 * `Parked.ended` and come back the way tf-hostd brings them back. soak ended when herdr stopped and
 * has no `restart` ticket (hostd makes them only while herdr runs: stop herdr in a demo shell, and
 * once herdr runs again it gets one and comes back by itself); a11y's ticket counts down and brings
 * it back by itself; invoices' waits for Continue (auto-resume is off). Continue
 * (`agent.autoResumeNow`) brings one back under a new id, and it goes on as hostd's plan says: idle,
 * nothing; a cut-off reply, omp's retry; mid-turn, one note. Don't makes a waiting ticket manual;
 * Dismiss or Mark done files the card in Done.
 */

/** Undo window between Mark done and closing the pane (hostd: 10 s). */
export const PARK_GRACE_MS = 10_000;
/** The seeded parked agent whose session file is deleted, this long after the host starts. */
export const PRUNE_AFTER_MS = 60_000;
/** The seeded ended card whose ticket counts down comes back this long after the host starts. */
export const BACK_AFTER_MS = 90_000;
/** Once herdr runs again, an ended card without a ticket comes back after this countdown. */
export const HERDR_BACK_MS = 5_000;
/** A ticket due while herdr is down waits this much longer (hostd: 15 s, not counted as a try). */
const HERDR_WAIT_MS = 15_000;
/** Back in its new pane, it goes on this long after (its bridge connects, then hostd's plan runs). */
const GO_ON_MS = 2_000;

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
  /** herdr's server runs (`HostInfo.herdrHealth`): hostd makes `restart` tickets only then. */
  herdrUp(): boolean;
  /** The host's auto-resume setting (`host.autoResume`). */
  autoResume(): boolean;
}

interface ParkedSeed {
  def: AgentDef;
  workspace: string;
  prune?: boolean;
  /** An ended card: how its omp ended (`at`: when its state began). */
  ended?: Omit<AgentEnded, "at">;
  /** Its `restart` ticket: due in `inMs`, or `manual` (why it waits for Continue). None: herdr was down. */
  ticket?: { inMs: number } | { manual: string };
  /** Its transcript (default: `historyFor`). */
  steps?: Step[];
}

/**
 * Seeded on forge: a parked agent to resume, one whose session gets deleted, and three ended cards,
 * the newest in Review (they ended minutes ago): herdr stopped mid-turn (no ticket), herdr crashed
 * while it was idle (a countdown), a reboot cut a reply off (manual).
 */
const PARKED: ParkedSeed[] = [
  {
    workspace: "w3",
    def: {
      id: "tokens", kind: "omp", workspace: "w3", column: "done", model: "sonnet-5", thinking: "low", since: 10_800, age: 14_400, ctxPct: 27, cost: 1.12,
      title: "Dark and light theme tokens for the marketing site", line: "merged #31 · 3h ago", files: [],
    },
  },
  {
    workspace: "w10",
    ended: { cause: "herdrStopped", reason: "herdr stopped", turn: "working", lastAction: "bash: sleep 30; echo done >> /tmp/c.out" },
    def: {
      id: "soak", kind: "omp", workspace: "w10", column: "review", model: "sonnet-5", thinking: "medium", since: 150, age: 2_700, ctxPct: 18, cost: 0.38,
      title: "Soak-test the job runner's checkpoint file across restarts", line: "sleep 30; echo done >> /tmp/c.out", files: [],
    },
    steps: [
      { t: "user", text: "Soak-test the job runner's checkpoint file: append a line to /tmp/c.out at each step and check nothing is lost across a restart." },
      think("A start marker first, then the slow step, then check that both lines are there.", 2600),
      bash("echo start >> /tmp/c.out && wc -l < /tmp/c.out", ["1"], 1200),
      say("The start marker is in. Now the slow step: sleep 30, then append `done`."),
      bash("sleep 30; echo done >> /tmp/c.out", [], 30_000, 129),
    ],
  },
  {
    workspace: "w3",
    ended: { cause: "herdrCrashed", reason: "herdr crashed", turn: "idle" },
    ticket: { inMs: BACK_AFTER_MS },
    def: {
      id: "a11y", kind: "omp", workspace: "w3", column: "review", model: "opus-5", thinking: "high", since: 200, age: 3_600, ctxPct: 31, cost: 0.86,
      title: "Accessibility pass on the pricing page", line: "Contrast and focus rings fixed; axe finds nothing left on /pricing", files: [],
    },
  },
  {
    workspace: "w2",
    ended: { cause: "reboot", reason: "the host restarted", turn: "replying" },
    ticket: { manual: "Auto-resume is off on this host" },
    def: {
      id: "invoices", kind: "omp", workspace: "w2", column: "review", model: "opus-5", thinking: "high", since: 270, age: 12_600, ctxPct: 41, cost: 1.94,
      title: "Paginate the invoices endpoint with cursor tokens", line: "Cursor pagination works for /v1/invoices; what changes for clients:", files: [],
    },
    steps: [
      { t: "user", text: "Paginate GET /v1/invoices with opaque cursor tokens instead of offsets; keep ?page= working for one more release." },
      think("Find the handler and its query, then make the cursor (created_at, id) so rows with equal timestamps keep their order.", 3000),
      read("internal/http/invoices.go", 120),
      bash("go test ./internal/http/ -run Invoices", ["ok  \tgateway/internal/http\t0.412s"], 4000),
      say("Cursor pagination works for `/v1/invoices`: the cursor is `(created_at, id)`, base64 encoded, and the old `?page=` maps onto it for one more release. What changes for clients:"),
    ],
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

/** hostd's note to an agent that comes back mid-turn (`restart::decide`, exact text), whose last action may have run. */
function note(e: AgentEnded): string {
  const at = new Date(e.at);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const jobs = "background jobs started before are gone; their processes may still be running or may have finished — check processes and output files before re-running anything.";
  const rest = e.lastAction ? `Its last action (${e.lastAction}) may or may not have run, and handles of ${jobs}` : `Handles of ${jobs}`;
  return `Your previous process ended unexpectedly at ${hhmm} (${e.reason}). ${rest}`;
}

export class DemoParking {
  private readonly places = new Map<string, Place>();
  /** Pending pane closes (agent id → cancel) during the undo window. */
  private readonly closing = new Map<string, () => void>();
  private pruned: PrunedAgent[] = [];
  private resumes = 0;
  /** herdr was up at the last health change (the demo's herdr starts up). */
  private herdrWasUp = true;

  constructor(private readonly host: ParkingHost) {}

  /** Seed the parked and ended agents (forge) and schedule the deleted session. */
  seed(): void {
    const now = this.host.now();
    for (const { def, workspace, prune, ended, ticket, steps } of PARKED) {
      const sim = this.host.seedSim(def, workspace);
      const at = now - def.since * 1000;
      sim.seed(steps ?? historyFor(def), now - def.age * 1000, at);
      this.park(sim, at, false);
      if (ended) {
        sim.agent.live = { ...sim.agent.live, line: def.line };
        this.end(sim, { ...ended, at }, ticket);
      }
      if (!prune) continue;
      this.host.after(6_000, () => this.host.notify(def.id, "finished", `${def.id} finished`, def.title));
      this.host.after(PRUNE_AFTER_MS, () => this.prune(def.id));
    }
    for (const id of PARK_SEEDED) {
      const sim = this.host.sims.get(id);
      if (sim) this.park(sim, sim.agent.stateSince, false);
    }
  }

  /** herdr's health changed: once it runs again, every ended card without a ticket gets one, as hostd's ledger worker does. */
  herdrChanged(): void {
    const up = this.host.herdrUp();
    const back = up && !this.herdrWasUp;
    this.herdrWasUp = up;
    if (!back) return;
    for (const sim of this.host.sims.values()) {
      if (!sim.agent.parked?.ended || sim.agent.autoResume) continue;
      if (this.host.autoResume()) this.wait(sim, HERDR_BACK_MS);
      else this.manual(sim, "Auto-resume is off on this host");
    }
  }

  /**
   * Handles a call that concerns parking; `undefined` lets the host handle it as usual. Throws
   * `parked` for controls a parked agent can't take (no pane, no omp running).
   */
  call(method: string, p: Record<string, unknown>): unknown {
    const id = typeof p.agentId === "string" ? p.agentId : undefined;
    const sim = id ? this.host.sims.get(id) : undefined;
    if (sim?.agent.parked?.ended) {
      // F5 runs the ticket, as `agent.retry` does on hostd; Resume, a prompt and unarchiving bring it back without it
      if (method === "agent.autoResumeNow" || method === "agent.retry") return this.continueNow(sim);
      if (method === "agent.autoResumeCancel") return this.cancel(sim);
      if (method === "agent.archive" && p.archived) {
        this.file(sim, `${sim.agent.name} marked done`);
        return {};
      }
    }
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
      case "session.find":
        return undefined;
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
    if (a.omp) a.omp = { ...a.omp, link: "notShared", linkReason: "noRoom", linkVia: undefined, linkSince: this.host.now(), linkError: "omp isn't running in a pane: the session resumes with omp --resume when you need it.", bridge: false, pid: undefined };
    this.host.closePane(a.id, workspaceId, paneId);
    this.host.changed(a.id);
    if (live) this.host.activity(a.id, "stopped", `${a.name} pane closed (done)`, "Resumes with omp --resume when needed");
  }

  /** Its omp ended without anyone closing it: Review, not archived, `Parked.ended`, and the ticket hostd gave it (none while herdr was down). */
  private end(sim: AgentSim, ended: AgentEnded, ticket: ParkedSeed["ticket"]): void {
    const a = sim.agent;
    if (!a.parked) return;
    a.parked = { ...a.parked, ended };
    a.column = "review";
    a.archived = false;
    if (ticket && "inMs" in ticket) this.wait(sim, ticket.inMs);
    else if (ticket) this.manual(sim, ticket.manual);
    this.host.changed(a.id);
  }

  /** A waiting `restart` ticket, due in `ms` (its reason: the ended reason). */
  private wait(sim: AgentSim, ms: number): void {
    const ended = sim.agent.parked?.ended;
    if (!ended) return;
    const resumeAt = this.host.now() + ms;
    sim.agent.autoResume = { status: "waiting", kind: "restart", reason: ended.reason, resumeAt, since: ended.at, attempts: 0, root: true, subagentIds: [] };
    this.host.changed(sim.agent.id);
    this.host.after(ms, () => {
      const ar = sim.agent.autoResume;
      if (!sim.agent.parked?.ended || ar?.status !== "waiting" || ar.resumeAt !== resumeAt) return;
      // nothing starts while herdr is down: it waits for herdr, not counted as a try
      if (this.host.herdrUp()) this.continueEnded(sim);
      else this.wait(sim, HERDR_WAIT_MS);
    });
  }

  /** A `restart` ticket that waits for Continue; `reason` says why. */
  private manual(sim: AgentSim, reason: string): void {
    const ended = sim.agent.parked?.ended;
    if (!ended) return;
    sim.agent.autoResume = { status: "manual", kind: "restart", reason, since: ended.at, attempts: 0, root: true, subagentIds: [] };
    this.host.changed(sim.agent.id);
  }

  /** Continue on an ended card: its ticket brings it back now (none: hostd's `not_found`; herdr down: it waits for herdr). */
  private continueNow(sim: AgentSim): RetryResult {
    const ar = sim.agent.autoResume;
    if (ar?.kind !== "restart") throw apiError("not_found", "nothing to resume for this agent");
    if (ar.status === "resuming") throw apiError("busy", "it is being resumed right now", { retryable: true });
    if (!this.host.herdrUp()) {
      this.wait(sim, HERDR_WAIT_MS);
      throw apiError("rescheduled", "herdr isn't running; it comes back once herdr runs again");
    }
    return this.continueEnded(sim);
  }

  /** Brings an ended card back: omp --resume in a new pane, under a new id; once its bridge is up it goes on (`goOn`). */
  private continueEnded(sim: AgentSim): RetryResult {
    const a = sim.agent;
    const ended = a.parked?.ended;
    const ticket = a.autoResume;
    if (!ended) return { started: false, via: "restore" };
    const started = this.resume(sim);
    if (ticket) {
      a.autoResume = { ...ticket, status: "resuming", resumeAt: undefined };
      this.host.changed(a.id);
    }
    this.host.after(GO_ON_MS, () => {
      if (this.host.sims.get(started.agentId ?? "") !== sim) return;
      if (!sim.busy) this.goOn(sim, ended);
      a.autoResume = undefined;
      this.host.changed(a.id);
    });
    return { started: true, via: "restore" };
  }

  /** How it goes on once it is back (hostd's plan): idle, nothing; a cut-off reply, omp's retry; mid-turn, one note (its last action may have run). */
  private goOn(sim: AgentSim, ended: AgentEnded): void {
    if (ended.turn === "replying") {
      sim.retryTurn([think("My reply was cut off when the process ended. Writing it again in full.", 1800), say("Here is the whole reply again, nothing cut off this time.")]);
    } else if (ended.turn === "working") {
      sim.startTurn(note(ended), {
        author: "TeleFlock",
        steps: [
          think("The note says my last step may or may not have run. Checking what it left before running anything again.", 2400),
          say("Checked: that step never finished, so I'm running it again and going on from there."),
        ],
      });
    }
  }

  /** Don't (a waiting ticket waits for Continue) or Dismiss (it won't come back: Done), as hostd's `agent.autoResumeCancel`. */
  private cancel(sim: AgentSim): Record<string, never> {
    const ar = sim.agent.autoResume;
    if (ar?.kind !== "restart") throw apiError("not_found", "nothing to resume for this agent");
    if (ar.status === "resuming") throw apiError("busy", "it is being resumed right now", { retryable: true });
    if (ar.status === "waiting") this.manual(sim, "You asked not to continue it by itself");
    else this.file(sim, `${sim.agent.name} will not be brought back`, "Moved to Done; resume it from there");
    return {};
  }

  /** Not brought back (Dismiss, Mark done): an ordinary parked card in Done, its ticket gone. */
  private file(sim: AgentSim, title: string, detail?: string): void {
    const a = sim.agent;
    if (!a.parked) return;
    const { ended: _ended, ...parked } = a.parked;
    a.parked = parked;
    a.autoResume = undefined;
    a.column = "done";
    a.archived = true;
    this.host.changed(a.id);
    this.host.activity(a.id, "archived", title, detail);
  }

  /** omp --resume in a new pane, under a new id; `prompt` runs once omp is up. An ended card's ticket goes with the card. */
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
    if (a.autoResume?.kind === "restart") a.autoResume = undefined;
    a.archived = false;
    a.column = "review";
    a.state = "done";
    a.stateSince = this.host.now();
    if (a.omp) a.omp = { ...a.omp, link: "connecting", linkReason: "starting", linkVia: undefined, linkSince: this.host.now(), linkError: undefined, pid: 41_000 + this.resumes };
    this.host.changed(id);
    this.host.activity(id, "started", `${a.name} resumed`, a.omp?.sessionFile);
    this.host.after(1400, () => {
      if (this.host.sims.get(id) !== sim || !a.omp) return;
      a.omp = { ...a.omp, link: "live", bridge: true, linkReason: undefined, linkVia: "bridge", linkSince: this.host.now() };
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
