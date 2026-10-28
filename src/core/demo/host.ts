import type {
  ActivityEvent,
  ActivityKind,
  Agent,
  AiCompleteResult,
  AppEvent,
  BranchInfo,
  BtwStatus,
  BtwThread,
  ChangedFile,
  CommandInfo,
  ConnPhase,
  ConnStatus,
  FsEntry,
  GitBadge,
  HistoryPage,
  HostHealth,
  HostInfo,
  HostProfile,
  HostState,
  Notification,
  NotifyKind,
  PastSession,
  PrInfo,
  PulseKind,
  SessionEvent,
  SetupIssue,
  SetupStatus,
  StatePatch,
  Tab,
  TranscriptItem,
  UiRequest,
  UsageTotals,
  Workspace,
  WorktreeEntry,
  WorktreeList,
} from "@/core/gen";
import { apiError } from "../errors";
import { ircOf } from "../irc";
import { OMP_COMMAND_NAMES, ompCommandName } from "../ompCommands";
import { AgentSim, type SimHost } from "./agent";
import { demoAiComplete, demoAiLatency } from "./ai";
import { DemoAutomations } from "./automations";
import { DemoAccounts } from "./accounts";
import { DemoAuthFlows } from "./auth";
import type { DemoClock } from "./clock";
import { fileBody, fileDiff } from "./codegen";
import { DemoOmpSettings } from "./ompSettings";
import { DemoMcp } from "./mcp";
import { demoFirstPrompt } from "./dispatchAuto";
import {
  AGENTS,
  type AgentDef,
  HOME,
  WORKTREES,
  MODELS,
  modelByRef,
  REPOS,
  type RepoDef,
  repoByName,
  repoForPath,
  slug,
  STUDIO_AGENTS,
  WORKSPACES,
  type WorkspaceDef,
} from "./data";
import { hash, Rng } from "./rng";
import {
  ciTurn,
  DIRECTOR_PROMPTS,
  injectedAsk,
  kanbanTurn,
  LIMITS_APPROVAL,
  limitsAfter,
  poolTurn,
  PUSH_ASK,
  pushAfter,
  renderTurn,
} from "./scripts";
import { historyFor, longHistory } from "./seeds";
import { demoProgram, seedDemoShells, withPaneProcesses } from "./shells";
import { DemoParking } from "./parking";
import { DemoTerm } from "./term";
import { DemoTools } from "./tools";
import { DemoUploads } from "./uploads";

export type HostVariant = "forge" | "studio";

/** What `pi.getCommands()` returns on the demo host: a prompt template, a skill, an extension command. */
const DEMO_CUSTOM_COMMANDS: CommandInfo[] = [
  { name: "review", description: "Review the current diff for bugs and risky changes", source: "prompt" },
  { name: "skill:release-notes", description: "Draft release notes from merged commits", source: "skill" },
  { name: "deploy-preview", description: "Deploy this branch to a preview environment", source: "extension" },
];

export interface HostEnv {
  clock: DemoClock;
  emit(e: AppEvent): void;
  seed: number;
  /** Extra rows seeded before pool's history (long-transcript perf knob). */
  longTranscript?: number;
  /** Is a same-port tunnel to `port` of this host open (sign-in callbacks)? */
  tunnelOpen?(hostId: string, port: number): boolean;
}

const OTHER_DEVICE = "Pixel 9";
const TICK = 100;
/** PTY grid of a demo pane nobody controls yet (the user's own herdr TUI sized it). */
const DEMO_PANE_GRID = { cols: 110, rows: 32 };
const OFFLINE: ConnPhase[] = ["offline", "error", "reconnecting", "authRequired", "hostKey", "idle"];
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Host setup fixes that install software: they run after the `host.setupApply` reply, like on a real host. */
const SETUP_INSTALLS: Record<string, true> = { "install-omp": true, "install-bun": true, "install-herdr": true, "install-git": true, "install-gh": true, "install-ffmpeg": true };
const SETUP_INSTALL_MS = 3500;

interface WsModel {
  ws: Workspace;
  repo?: RepoDef;
  /** Linked worktree path, when a worktree workspace. */
  path: string;
  shellPanes: string[];
}

/** One simulated `/btw` conversation (omp's BTW history topic). `stop` cancels the turn answering. */
interface DemoBtw {
  id: string;
  sessionId?: string;
  at: number;
  turns: { question: string; answer: string; status: BtwStatus; at: number }[];
  stop?: () => void;
}

/**
 * One simulated herdr host: board state, agent simulations, sessions, terminals, fs/git/gh,
 * connection lifecycle, and a director that keeps every lane alive.
 */
export class DemoHost implements SimHost {
  readonly id: string;
  readonly rng: Rng;
  status: ConnStatus;
  private rev = 0;
  private readonly sims = new Map<string, AgentSim>();
  private readonly wss = new Map<string, WsModel>();
  private readonly subscribed = new Set<string>();
  private readonly terms = new Map<string, DemoTerm>();
  /** Each pane's PTY grid: set by the controlling terminal, followed by observers (like hostd). */
  private readonly paneGrids = new Map<string, { cols: number; rows: number }>();
  private readonly dirtyAgents = new Set<string>();
  private readonly dirtyMeta = new Set<string>();
  private readonly removedAgents = new Set<string>();
  private readonly dirtyWs = new Set<string>();
  private readonly removedWs = new Set<string>();
  private pulses = new Map<string, { kind: PulseKind; n: number }>();
  private activityLog: ActivityEvent[] = [];
  private prs = new Map<string, PrInfo & { createdAt: number }>();
  /** Pull requests of linked worktrees whose workspace closed with a parked agent's pane, by worktree path. */
  private parkedPrs = new Map<string, PrInfo & { createdAt: number }>();
  private info: HostInfo;
  private health: HostHealth;
  private usageTotals: UsageTotals;
  private usageDirty = false;
  private setup: SetupStatus;
  /** gh's first demo install fails (github.com unreachable), to show a per-fix failure. */
  private ghInstallTried = false;
  private tickN = 0;
  private lastDirector = 0;
  private noNeedsSince: number;
  private askKind = 0;
  /** When the director first saw each pending request (auto-answer from "another device" after 4 min). */
  private readonly seenRequests = new Map<string, number>();
  /** Messages sent to each subagent (`agent.subagent` chat), replayed into its transcript. */
  private readonly subSteers = new Map<string, { at: number; text: string }[]>();
  /** `/btw` conversations per agent, oldest first (seeded with one asked "in the terminal"). */
  private readonly btws = new Map<string, DemoBtw[]>();
  private promptIdx = 0;
  private nextWs = 20;
  private nextPane = 2;
  private nextTerm = 1;
  private nextPr = 143;
  private nextNotif = 1;
  private nextAct = 1;
  private stopTick: (() => void) | null = null;
  private phaseTimer: (() => void) | null = null;
  private cycle = 0;
  /** studio-pc presents an unknown SSH host key until the user trusts it (`hosts.trustKey`). */
  private keyTrusted = false;
  private everOnline = false;
  private readonly tools: DemoTools;
  private readonly ompSettings = new DemoOmpSettings();
  /** Sign-ins (`auth.*`, `./auth`): account links here, MCP OAuth from the MCP demo. */
  readonly auth: DemoAuthFlows;
  /** omp's accounts and keys (`accounts.*`, `./accounts`); also answers `host.limits`. */
  private readonly accounts: DemoAccounts;
  /** Done agents' lifecycle (`./parking`): Mark done closes panes, parked agents resume, pruned ones go. */
  private readonly parking = new DemoParking({
    now: () => this.now(),
    after: (ms, fn) => this.env.clock.after(ms, fn),
    online: () => this.online,
    sims: this.sims,
    seedSim: (def, wsId) => this.addAgent(def, wsId, this.addPane(wsId, null)),
    closePane: (agentId, wsId, paneId) => {
      for (const t of [...this.terms.values()]) {
        if (t.agentId !== agentId) continue;
        t.close("pane closed");
        this.terms.delete(t.termId);
      }
      const m = this.wss.get(wsId);
      if (!m) return;
      for (const tab of m.ws.tabs) for (const p of tab.panes) if (p.id === paneId) p.agentId = undefined;
      try {
        this.closePaneIn(m, paneId);
      } catch {
        // a primary with linked worktrees keeps its last pane: it stays as a shell
        for (const tab of m.ws.tabs) for (const p of tab.panes) if (p.id === paneId) p.title = "zsh";
        m.shellPanes.push(paneId);
        this.dirtyWs.add(m.ws.id);
      }
    },
    parkWorktree: (wsId) => {
      const m = this.wss.get(wsId);
      if (!m?.ws.worktree) return undefined;
      const primary = m.ws.worktree.primaryWorkspaceId ? this.wss.get(m.ws.worktree.primaryWorkspaceId) : undefined;
      const pr = this.prs.get(m.ws.id);
      if (pr) this.parkedPrs.set(m.path, pr);
      return { path: m.path, repoRoot: primary?.path ?? m.repo?.root ?? m.path };
    },
    openPane: (agentId, place) => {
      const kept = place.workspaceId ? this.wss.get(place.workspaceId) : undefined;
      const m = kept ?? this.addWorkspace(place.repo, place.branch, place.worktree, this.wss.size, undefined, false, place.cwd);
      // a worktree reopened in a new workspace takes its pull request back
      const pr = kept ? undefined : this.parkedPrs.get(m.path);
      if (pr) {
        this.prs.set(m.ws.id, pr);
        this.parkedPrs.delete(m.path);
      }
      const paneId = kept ? this.addPane(m.ws.id, null) : (m.ws.tabs[0]?.panes[0]?.id as string);
      const tab = m.ws.tabs.find((t) => t.panes.some((p) => p.id === paneId));
      for (const p of tab?.panes ?? []) if (p.id === paneId) Object.assign(p, { agentId, title: "omp" });
      this.dirtyWs.add(m.ws.id);
      return { paneId, tabId: tab?.id ?? "", workspaceId: m.ws.id };
    },
    rekey: (sim, id) => {
      const old = sim.agent.id;
      this.sims.delete(old);
      this.removedAgents.add(old);
      this.dirtyAgents.delete(old);
      this.subscribed.delete(old);
      sim.agent.id = id;
      this.sims.set(id, sim);
      this.agentChanged(id);
    },
    remove: (id) => this.removeAgent(id),
    setPruned: (pruned) => {
      this.info = { ...this.info, pruned };
      if (!this.online) return;
      this.rev += 1;
      this.env.emit({ type: "hostPatch", hostId: this.id, rev: this.rev, ops: [{ op: "info", info: { ...this.info, setup: this.setup } }] });
    },
    changed: (id) => this.agentChanged(id),
    activity: (id, kind, title, detail) => this.activity(id, kind, title, detail),
    notify: (id, kind, title, body) => this.notify(id, kind, title, body),
  });
  /** tf-hostd's automations (`./automations`); studio-pc plays a host whose tf-hostd predates them. */
  private automations?: DemoAutomations;
  /** `upload.*` (videos for prompts, terminal pastes): offsets only, nothing stored. */
  private uploads?: DemoUploads;
  /** omp's MCP servers (`mcp.*`, `./mcp`); studio-pc plays a host whose tf-hostd predates them. */
  private mcp?: DemoMcp;

  constructor(
    private readonly env: HostEnv,
    readonly profile: HostProfile,
    readonly variant: HostVariant,
  ) {
    this.id = profile.id;
    this.auth = new DemoAuthFlows(env.clock, (port) => env.tunnelOpen?.(profile.id, port) ?? false);
    this.accounts = new DemoAccounts({ id: profile.id, now: () => this.now(), agents: () => this.agentsList(), auth: this.auth });
    this.rng = new Rng(env.seed ^ hash(`${variant}`));
    const now = this.now();
    this.noNeedsSince = now;
    const hostname = variant === "forge" ? "forge" : "studio-pc";
    this.setup =
      variant === "forge"
        ? {
            herdrIntegration: true,
            globalSharing: false,
            globalBridge: false,
            relay: true,
            issues: [
              { id: "install-global-bridge", severity: "warn", title: "Install the TeleFlock bridge for every session", detail: "Lets TeleFlock follow and control omp sessions it did not start (live transcript, questions and approvals, subagents, model and other controls), including sessions herdr restores.", fixable: true, recommended: true },
              { id: "enable-global-sharing", severity: "info", title: "Share every omp session with TeleFlock (fallback)", detail: "Sets collab.autoStart: control and collab.relayUrl: ws://127.0.0.1:47466 in ~/.omp/agent/config.yml. Only needed for sessions without the TeleFlock bridge.", fixable: true, recommended: false },
              {
                id: "move-herdr-out-of-login-session",
                severity: "warn",
                title: "Move herdr out of its login session",
                detail:
                  "The herdr server of session default (pid 4894) and 23 processes under it (pane shells, omp agents and their tools) run in login session c16 (session-c16.scope). When logind tears that session down (on logout with KillUserProcesses=yes, or when a restarted logind cleans up sessions that already ended), systemd stops the scope and every agent in it dies. Moves them, still running, into their own systemd scope (teleflock-herdr-…); nothing is stopped or restarted.",
                fixable: true,
                recommended: true,
              },
              {
                id: "install-gh",
                severity: "info",
                title: "Install the GitHub CLI (gh)",
                detail:
                  "Pull request status, checks and merges on the board come from the GitHub CLI. Downloads the latest GitHub CLI release for linux/amd64 from github.com, checks it against the release's checksums and installs gh in ~/.local/bin (no root). Then sign in once on the host: `gh auth login`.",
                fixable: true,
                recommended: false,
              },
              { id: "install-ffmpeg", severity: "info", title: "Install ffmpeg", detail: "omp reads video attachments with ffmpeg and ffprobe. Runs `sudo -n apt-get install -y -q --no-install-recommends ffmpeg` (passwordless sudo).", fixable: true, recommended: false },
            ],
          }
        : {
            herdrIntegration: false,
            globalSharing: false,
            globalBridge: false,
            relay: true,
            issues: [
              { id: "install-herdr-integration", severity: "error", title: "herdr omp integration missing", detail: "herdr can't tell when omp is working or blocked. Installs ~/.omp/agent/extensions/herdr-omp-agent-state.ts.", fixable: true, recommended: true },
              {
                id: "install-ffmpeg",
                severity: "info",
                title: "Install ffmpeg",
                detail: "omp reads video attachments with ffmpeg and ffprobe. TeleFlock installs system packages only as root or with passwordless sudo: run `sudo apt-get install -y -q --no-install-recommends ffmpeg` on the host.",
                fixable: false,
                recommended: false,
              },
            ],
          };
    this.tools = new DemoTools(variant, env.clock, (tools, installed) => {
      this.info = { ...this.info, tools, ...(installed === "omp" && this.info.omp ? { omp: { ...this.info.omp, version: tools.omp.current ?? this.info.omp.version } } : {}) };
      if (!this.online) return;
      this.rev += 1;
      this.env.emit({ type: "hostPatch", hostId: this.id, rev: this.rev, ops: [{ op: "info", info: { ...this.info, setup: this.setup } }] });
    });
    this.info = {
      hostname,
      os: "linux",
      arch: "x86_64",
      home: HOME,
      hostdVersion: "0.1.0",
      herdr: { version: "0.9.0", path: "/usr/local/bin/herdr", ok: true },
      omp: { version: "18.12.3", path: `${HOME}/.local/bin/omp`, ok: true },
      herdrSession: profile.herdrSession || "default",
      herdrSessions: ["default", "tf-lab"],
      relayPort: 47466,
      setup: this.setup,
      tools: this.tools.status(),
    };
    this.health = { at: now, cpuPct: 34, cores: variant === "forge" ? 16 : 24, load1: 2.1, memUsed: 21.4e9, memTotal: 64e9, diskFree: 412e9, diskTotal: 1000e9, uptimeS: 86400 * 12 + 3600 * 5 };
    this.usageTotals = { costUsd: 0, tokens: 0, input: 0, output: 0 };
    this.status = { phase: "idle", since: now, attempt: 0 };
    this.build();
  }

  now(): number {
    return this.env.clock.now();
  }

  // ---------------------------------------------------------------- world construction

  private build(): void {
    const now = this.now();
    const wsDefs: WorkspaceDef[] = this.variant === "forge" ? WORKSPACES : [{ id: "w1", repo: "teleflock", branch: "main", worktree: false, order: 0 }];
    for (const d of wsDefs) this.addWorkspace(d.repo, d.branch, d.worktree, d.order, d.id, d.shellPane, d.cwd);
    seedDemoShells(this.variant, this.wss.values());
    const defs = this.variant === "forge" ? AGENTS : STUDIO_AGENTS;
    for (const def of defs) {
      const sim = this.addAgent(def, def.workspace);
      if (!sim.omp || def.fresh) continue;
      const to = now - (def.column === "running" ? 2000 : def.since * 1000);
      const from = now - def.age * 1000;
      const steps = historyFor(def);
      if (def.id === "push") steps.push({ t: "ui", ui: PUSH_ASK, then: pushAfter });
      if (def.id === "limits") steps.push({ t: "ui", ui: LIMITS_APPROVAL, then: limitsAfter });
      const long = def.id === "pool" ? (this.env.longTranscript ?? 0) : 0;
      if (long > 0) sim.seed(longHistory(long), from - long * 15_000, from);
      sim.seed(steps, from, to);
      if (def.id === "pool") sim.seedCompaction(from + (to - from) * 0.55, 142_000);
      if (def.column === "needs" && sim.agent.needs) {
        sim.agent.needs.since = now - def.since * 1000;
        sim.agent.stateSince = now - def.since * 1000;
      }
      if (def.column === "running") sim.agent.stateSince = now - def.since * 1000;
    }
    if (this.variant === "forge") {
      this.sims.get("kanban")?.resume(kanbanTurn(), 2500);
      this.sims.get("pool")?.resume(poolTurn(), 4000);
      this.sims.get("ci")?.resume(ciTurn(), 75_000);
      this.prs.set("w6", { number: 142, url: "https://github.com/demo/teleflock/pull/142", title: "Auto-reconnect SSH and resume herdr attach", state: "OPEN", draft: true, mergeable: true, checks: { passed: 9, failed: 0, pending: 0 }, createdAt: now - 1_500_000 });
      // gobump's branch was merged: pushed (nothing ahead), so Done offers "Delete worktree"
      this.prs.set("w13", { number: 91, url: "https://github.com/demo/api-gateway/pull/91", title: "Bump Go to 1.25 and drop deprecated helpers", state: "MERGED", draft: false, createdAt: now - 3_000_000 });
      const gobump = this.wss.get("w13")?.ws.repo;
      if (gobump) gobump.ahead = 0;
      this.seedActivity(defs);
      this.usageTotals = { costUsd: 18.42, tokens: 2_310_000, input: 2_080_000, output: 230_000 };
      this.parking.seed();
    } else {
      this.usageTotals = { costUsd: 1.31, tokens: 160_000, input: 140_000, output: 20_000 };
      this.sims.get("render")?.resume(renderTurn());
    }
    for (const id of this.sims.keys()) this.dirtyAgents.delete(id);
    this.dirtyMeta.clear();
  }

  private addWorkspace(repoName: string | undefined, branch: string | undefined, worktree: boolean, order: number, id?: string, shellPane = false, cwdOverride?: string, label?: string): WsModel {
    const repo = repoName ? repoByName(repoName) : undefined;
    const wsId = id ?? `w${this.nextWs++}`;
    const path = cwdOverride ?? (repo ? (worktree ? `${WORKTREES}/${repo.name}/${slug(branch ?? "main")}` : repo.root) : `${HOME}`);
    const primary = worktree && repo ? [...this.wss.values()].find((m) => m.repo === repo && !m.ws.worktree) : undefined;
    const panes = [`${wsId}:p1`];
    const shellPanes: string[] = [];
    if (shellPane) {
      panes.push(`${wsId}:p2`);
      shellPanes.push(`${wsId}:p2`);
    }
    const tab: Tab = { id: `${wsId}:t1`, label: "main", panes: panes.map((p, i) => ({ id: p, terminalId: `term-${p.replace(":", "-")}`, title: i === 0 ? "omp" : "zsh", cwd: path, focused: i === 0 })) };
    const ws: Workspace = {
      id: wsId,
      label: label ?? (worktree ? slug(branch ?? "") : (repo?.name ?? path.split("/").pop() ?? "workspace")),
      cwd: path,
      repo: repo ? { root: repo.root, name: repo.name, branch, head: new Rng(hash(path)).hex(7), dirty: 0, ahead: worktree ? 3 : 0, behind: 0, remoteUrl: repo.remote } : undefined,
      worktree: worktree ? { path, branch, primaryWorkspaceId: primary?.ws.id } : undefined,
      tabs: [tab],
      rollup: "idle",
      order,
    };
    const model: WsModel = { ws, repo, path, shellPanes };
    this.wss.set(wsId, model);
    if (repo && branch && !this.branchesOf(repo).includes(branch)) this.newBranches.push(`${repo.name}\u0000${branch}`);
    this.dirtyWs.add(wsId);
    return model;
  }

  /** Branches created on this host (the static repo data is shared and never mutated). */
  private readonly newBranches: string[] = [];

  private branchesOf(repo: RepoDef): string[] {
    const extra = this.newBranches.filter((b) => b.startsWith(`${repo.name}\u0000`)).map((b) => b.slice(repo.name.length + 1));
    return [...repo.branches, ...extra];
  }

  private addAgent(def: AgentDef, wsId: string, paneId?: string): AgentSim {
    const m = this.wss.get(wsId);
    if (!m) throw apiError("not_found", `workspace ${wsId} not found`);
    const pane = paneId ?? (m.ws.tabs[0]?.panes[0]?.id as string);
    const sim = new AgentSim(this, def, pane, pane.split(":")[0] + ":t1", { id: wsId, cwd: m.path, repo: m.repo?.name, branch: m.ws.repo?.branch });
    this.sims.set(def.id, sim);
    for (const tab of m.ws.tabs) for (const p of tab.panes) if (p.id === pane) p.agentId = def.id;
    this.dirtyWs.add(wsId);
    this.agentChanged(def.id);
    return sim;
  }

  private seedActivity(defs: AgentDef[]): void {
    const now = this.now();
    const add = (agentId: string, kind: ActivityKind, title: string, ago: number, detail?: string) =>
      this.activityLog.push({ id: `act-${this.nextAct++}`, at: now - ago * 1000, agentId, agentName: agentId, kind, title, detail });
    for (const d of defs) {
      add(d.id, "started", `${d.id} started`, d.age, d.title);
      if (d.column === "done") {
        add(d.id, "finished", `${d.id} finished`, d.since + 600);
        add(d.id, "committed", `${d.id}: ${d.line ?? "merged"}`, d.since + 120);
        add(d.id, "archived", `${d.id} archived`, d.since);
      }
      if (d.column === "review") add(d.id, "finished", `${d.id} finished`, d.since, d.line);
      if (d.column === "needs") add(d.id, "asked", `${d.id} asked a question`, d.since);
    }
    add("pool", "compacted", "pool compacted", 1400, "142k → 38k tokens");
    add("pool", "modelChanged", "pool switched to gpt-5.5 · xhigh", 1700);
    add("kanban", "toolError", "kanban: bun test src/board failed", 30, "9 failing");
    add("reconnect", "committed", "reconnect committed", 1600, "resume herdr attach after network change");
    // Older history for paging.
    const older: [ActivityKind, string][] = [
      ["finished", "finished a turn"],
      ["prompted", "prompted"],
      ["committed", "committed"],
      ["answered", "answered"],
    ];
    for (let i = 0; i < 60; i++) {
      const d = defs[i % defs.length] as AgentDef;
      const [kind, verb] = older[i % older.length] as [ActivityKind, string];
      add(d.id, kind, `${d.id} ${verb}`, 90_000 + i * 2400);
    }
    this.activityLog.sort((a, b) => b.at - a.at);
  }

  // ---------------------------------------------------------------- SimHost

  session(agentId: string, ev: SessionEvent): void {
    if (!this.online || !this.subscribed.has(agentId)) return;
    this.env.emit({ type: "session", hostId: this.id, agentId, ev });
  }

  agentChanged(agentId: string): void {
    this.dirtyAgents.add(agentId);
  }

  metaChanged(agentId: string): void {
    this.dirtyMeta.add(agentId);
  }

  pulse(agentId: string, kind: PulseKind, n: number): void {
    const cur = this.pulses.get(agentId);
    const rank: Record<PulseKind, number> = { state: 4, token: 3, tool: 2, thinking: 1, event: 0 };
    if (!cur) this.pulses.set(agentId, { kind, n });
    else this.pulses.set(agentId, { kind: rank[kind] > rank[cur.kind] ? kind : cur.kind, n: cur.n + n });
  }

  notify(agentId: string, kind: NotifyKind, title: string, body: string, ui?: UiRequest): void {
    if (!this.online) return;
    const notification: Notification = {
      id: `n-${this.id}-${this.nextNotif++}`,
      at: this.now(),
      kind,
      agentId,
      title,
      body,
      requestId: ui?.id,
      actions: ui
        ? ui.options.slice(0, 3).map((o) => ({ id: o.id, label: o.label, answer: { choices: [o.id], cancel: false, chat: false } }))
        : [{ id: "open", label: "Open" }],
    };
    this.env.emit({ type: "notify", hostId: this.id, notification });
  }

  activity(agentId: string, kind: ActivityKind, title: string, detail?: string): void {
    const name = this.sims.get(agentId)?.agent.name ?? agentId;
    this.activityLog.unshift({ id: `act-${this.nextAct++}`, at: this.now(), agentId, agentName: name, kind, title, detail });
    if (this.activityLog.length > 600) this.activityLog.length = 600;
  }

  usage(tokensIn: number, tokensOut: number, usd: number): void {
    this.usageTotals = {
      costUsd: this.usageTotals.costUsd + usd,
      tokens: this.usageTotals.tokens + tokensIn + tokensOut,
      input: this.usageTotals.input + tokensIn,
      output: this.usageTotals.output + tokensOut,
    };
    this.usageDirty = true;
  }


  termWrite(agentId: string, text: string): void {
    for (const t of this.terms.values()) if (t.agentId === agentId) t.agentOutput(text);
  }

  repoFiles(agentId: string): { repo: string; files: string[] } {
    const sim = this.sims.get(agentId);
    const repo = sim?.agent.repo ? repoByName(sim.agent.repo) : undefined;
    return { repo: repo?.name ?? "workspace", files: repo?.files ?? [] };
  }

  // ---------------------------------------------------------------- state

  get online(): boolean {
    return this.status.phase === "online";
  }

  private agentsList(): Agent[] {
    return [...this.sims.values()].map((s) => structuredClone(s.agent));
  }

  private rollup(wsId: string): Workspace["rollup"] {
    const states = [...this.sims.values()].filter((s) => s.agent.workspaceId === wsId).map((s) => s.agent.state);
    if (states.includes("blocked")) return "blocked";
    if (states.includes("working")) return "working";
    if (states.includes("done")) return "done";
    return "idle";
  }

  private workspace(m: WsModel): Workspace {
    const dirty = [...this.sims.values()].filter((s) => s.agent.workspaceId === m.ws.id).reduce((n, s) => n + s.files.length, 0);
    return withPaneProcesses(structuredClone({ ...m.ws, rollup: this.rollup(m.ws.id), repo: m.ws.repo ? { ...m.ws.repo, dirty } : undefined }));
  }

  hostState(): HostState {
    return {
      info: { ...this.info, setup: this.setup },
      health: this.health,
      workspaces: [...this.wss.values()].sort((a, b) => a.ws.order - b.ws.order).map((m) => this.workspace(m)),
      agents: this.agentsList(),
      usage: { ...this.usageTotals, costUsd: Math.round(this.usageTotals.costUsd * 100) / 100 },
    };
  }

  private emitSnapshot(): void {
    this.rev += 1;
    this.dirtyAgents.clear();
    this.removedAgents.clear();
    this.dirtyWs.clear();
    this.removedWs.clear();
    this.env.emit({ type: "hostSnapshot", hostId: this.id, rev: this.rev, state: this.hostState() });
  }

  private setPhase(phase: ConnPhase, extra: Partial<ConnStatus> = {}): void {
    const now = this.now();
    const prevOnline = this.online;
    this.status = {
      phase,
      since: now,
      attempt: extra.attempt ?? 0,
      latencyMs: phase === "online" ? 38 + this.rng.int(0, 30) : undefined,
      lastOnlineAt: phase === "online" ? undefined : prevOnline ? now : this.status.lastOnlineAt,
      hostdVersion: "0.1.0",
      ...extra,
    };
    this.env.emit({ type: "hostStatus", hostId: this.id, status: this.status });
    if (phase === "online") {
      this.everOnline = true;
      this.emitSnapshot();
      // Reopened sessions get fresh snapshots via the client's session.open.
    }
    if (prevOnline && phase !== "online") {
      for (const t of this.terms.values()) t.close("connection lost");
      this.terms.clear();
      this.subscribed.clear();
    }
  }

  private schedule(ms: number, fn: () => void): void {
    this.phaseTimer?.();
    this.phaseTimer = this.env.clock.after(ms, fn);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.stopTick = this.env.clock.every(TICK, () => this.tick());
    if (this.variant === "forge") this.connectSequence(false);
    else {
      // Cached snapshot shown stale while the host is unreachable.
      this.status = { phase: "offline", since: this.now(), attempt: 0, lastOnlineAt: this.now() - 3 * 3600_000, message: "studio-pc is offline (last seen 3h ago)" };
      this.env.emit({ type: "hostStatus", hostId: this.id, status: this.status });
      this.rev += 1;
      this.env.emit({ type: "hostSnapshot", hostId: this.id, rev: this.rev, state: this.hostState() });
      this.schedule(9000, () => this.studioCycle());
    }
  }

  dispose(): void {
    this.stopTick?.();
    this.phaseTimer?.();
    for (const t of this.terms.values()) t.close("host removed");
    this.tools.stop();
  }

  private connectSequence(withAuth: boolean): void {
    this.setPhase("connecting", { message: `Connecting to ${this.info.hostname}…` });
    this.schedule(350, () => {
      this.setPhase("authenticating", { message: "Tailscale SSH (tailnet identity)" });
      this.schedule(withAuth ? 300 : 350, () => {
        this.setPhase("starting", { message: "tf-hostd attach --session default" });
        this.schedule(400, () => {
          this.setPhase("online");
          if (this.variant === "studio") {
            this.schedule(90_000, () => {
              this.setPhase("reconnecting", { attempt: 1, nextRetryAt: this.now() + 4000, message: "Network changed; reconnecting", error: { code: "not_connected", message: "SSH channel closed (network changed)", retryable: true } });
              this.schedule(4000, () => this.studioCycle());
            });
          }
        });
      });
    });
  }

  /**
   * studio-pc: offline → reconnecting → connecting → hostKey (odd cycles, until trusted) or
   * authenticating → authRequired → error → …
   */
  private studioCycle(): void {
    this.cycle++;
    const attempt = this.cycle;
    this.setPhase("reconnecting", { attempt, nextRetryAt: this.now() + 6000, message: `Retrying in 6s (attempt ${attempt})` });
    this.schedule(6000, () => {
      this.setPhase("connecting", { attempt, message: "Connecting to studio-pc…" });
      this.schedule(1500, () => {
        if (!this.keyTrusted && attempt % 2 === 1) {
          this.askHostKey(attempt);
          return;
        }
        this.setPhase("authenticating", { attempt, message: "Tailscale SSH" });
        this.schedule(1500, () => {
          this.setPhase("authRequired", {
            attempt,
            authUrl: `https://login.tailscale.com/a/${new Rng(this.cycle).hex(12)}`,
            message: "Tailscale SSH check mode: approve this device in your browser",
          });
          this.schedule(25_000, () => {
            this.setPhase("error", { attempt, error: { code: "auth_required", message: "Tailscale check-mode approval timed out", hint: "Open the approval link again, or retry", retryable: true } });
            this.schedule(6000, () => {
              this.setPhase("offline", { attempt, message: "studio-pc is offline" });
              this.schedule(12_000, () => this.studioCycle());
            });
          });
        });
      });
    });
  }

  /** First connection over a non-tailnet address: wait for the user to confirm the key fingerprint. */
  private askHostKey(attempt: number): void {
    const rng = new Rng(hash(`${this.id}:hostkey`));
    let b64 = "";
    for (let i = 0; i < 43; i++) b64 += B64[rng.int(0, 63)];
    this.setPhase("hostKey", {
      attempt,
      message: "Unknown host key for studio-pc.example.net",
      hostKey: { address: "203.0.113.42:22", algorithm: "ssh-ed25519", fingerprint: `SHA256:${b64}` },
    });
    this.schedule(20_000, () => {
      this.setPhase("error", { attempt, error: { code: "transport.hostKeyUnconfirmed", message: "The host key wasn't confirmed", hint: "Reconnect and verify the fingerprint", retryable: true } });
      this.schedule(6000, () => {
        this.setPhase("offline", { attempt, message: "studio-pc is offline" });
        this.schedule(12_000, () => this.studioCycle());
      });
    });
  }

  /** `hosts.trustKey`: pins the presented key and finishes the connection. */
  trustKey(fingerprint: string): void {
    if (this.status.phase !== "hostKey" || this.status.hostKey?.fingerprint !== fingerprint) {
      throw apiError("invalid_params", "That fingerprint isn't the key waiting for confirmation", { hint: "Reconnect and verify the fingerprint again" });
    }
    this.keyTrusted = true;
    this.connectSequence(true);
  }

  connect(): void {
    // Already online or mid-handshake: a repeated connect must not restart the sequence.
    if (this.online || ["connecting", "authenticating", "hostKey", "deploying", "starting"].includes(this.status.phase)) return;
    if (this.variant === "studio" && !this.keyTrusted && this.status.phase !== "authRequired") {
      this.setPhase("connecting", { message: "Connecting to studio-pc…" });
      this.schedule(900, () => this.askHostKey(this.status.attempt));
      return;
    }
    this.connectSequence(this.status.phase === "authRequired");
  }

  /** The user opened the Tailscale approval link. */
  completeAuth(url: string): boolean {
    if (this.status.phase !== "authRequired" || this.status.authUrl !== url) return false;
    this.schedule(1800, () => this.connectSequence(true));
    return true;
  }

  disconnect(): void {
    this.phaseTimer?.();
    this.setPhase("offline", { message: "Disconnected" });
  }

  // ---------------------------------------------------------------- tick

  private tick(): void {
    if (!this.online) return;
    this.tickN++;
    for (const sim of this.sims.values()) sim.tick(TICK);
    const now = this.now();
    // Pulses every tick (≤ 10 Hz).
    if (this.pulses.size) {
      const pulses = [...this.pulses].map(([agentId, p]) => ({ agentId, kind: p.kind, n: p.n }));
      this.pulses = new Map();
      this.env.emit({ type: "pulse", hostId: this.id, at: now, pulses });
    }
    // State patches at 5 Hz.
    if (this.tickN % 2 === 0) this.flushPatch();
    // Session meta at 2.5 Hz.
    if (this.tickN % 4 === 0) {
      for (const id of this.dirtyMeta) {
        const sim = this.sims.get(id);
        if (sim && this.subscribed.has(id)) this.session(id, { k: "meta", meta: sim.meta() });
      }
      this.dirtyMeta.clear();
    }
    if (this.tickN % 20 === 0) this.jitterHealth();
    if (now - this.lastDirector >= 5000) {
      this.lastDirector = now;
      this.direct();
    }
    if (this.tickN % 10 === 0) this.copyAgent();
  }

  private flushPatch(): void {
    const ops: StatePatch[] = [];
    for (const id of this.removedWs) ops.push({ op: "workspace", id, value: null });
    for (const id of this.dirtyWs) {
      const m = this.wss.get(id);
      if (m) ops.push({ op: "workspace", id, value: this.workspace(m) });
    }
    for (const id of this.removedAgents) ops.push({ op: "agent", id, value: null });
    const touchedWs = new Set<string>();
    for (const id of this.dirtyAgents) {
      const sim = this.sims.get(id);
      if (!sim) continue;
      ops.push({ op: "agent", id, value: structuredClone(sim.agent) });
      touchedWs.add(sim.agent.workspaceId);
    }
    for (const wsId of touchedWs) {
      const m = this.wss.get(wsId);
      if (!m || this.dirtyWs.has(wsId)) continue;
      const rollup = this.rollup(wsId);
      if (rollup !== m.ws.rollup) {
        m.ws.rollup = rollup;
        ops.push({ op: "workspace", id: wsId, value: this.workspace(m) });
      }
    }
    if (this.usageDirty) {
      this.usageDirty = false;
      ops.push({ op: "usage", usage: { ...this.usageTotals, costUsd: Math.round(this.usageTotals.costUsd * 1000) / 1000 } });
    }
    this.dirtyAgents.clear();
    this.removedAgents.clear();
    this.dirtyWs.clear();
    this.removedWs.clear();
    if (!ops.length) return;
    this.rev += 1;
    this.env.emit({ type: "hostPatch", hostId: this.id, rev: this.rev, ops });
  }

  private jitterHealth(): void {
    const h = this.health;
    const working = [...this.sims.values()].filter((s) => s.agent.state === "working").length;
    const target = 18 + working * 11;
    const cpu = Math.max(3, Math.min(97, h.cpuPct + (target - h.cpuPct) * 0.3 + this.rng.range(-6, 6)));
    this.health = {
      ...h,
      at: this.now(),
      cpuPct: Math.round(cpu * 10) / 10,
      load1: Math.round(Math.max(0.1, (cpu / 100) * h.cores * 0.6 + this.rng.range(-0.3, 0.3)) * 100) / 100,
      memUsed: Math.round(Math.max(8e9, Math.min(h.memTotal * 0.9, h.memUsed + this.rng.range(-4e8, 4e8)))),
      diskFree: h.diskFree - this.rng.int(0, 2_000_000),
      uptimeS: h.uptimeS + 2,
    };
    this.rev += 1;
    this.env.emit({ type: "hostPatch", hostId: this.id, rev: this.rev, ops: [{ op: "health", health: this.health }] });
  }

  /** Non-omp agent: herdr-only state flips between working and done. */
  private copyAgent(): void {
    const sim = this.sims.get("copy");
    if (!sim) return;
    const now = this.now();
    const a = sim.agent;
    const elapsed = now - a.stateSince;
    if (a.state === "working") {
      a.live = { ...a.live, lastEventAt: now, line: undefined };
      this.pulse("copy", "event", 1);
      this.agentChanged("copy");
      if (elapsed > 70_000) sim.setState("done");
    } else if (a.state === "done" && !a.archived && elapsed > 45_000) {
      sim.setState("working");
    }
  }

  /** Keeps the board alive: re-prompt idle agents, inject questions, resolve stale ones. */
  private direct(): void {
    const now = this.now();
    const sims = [...this.sims.values()].filter((s) => s.omp && s.agent.omp?.link === "live");
    const running = sims.filter((s) => s.agent.state === "working");
    const needs = sims.filter((s) => s.agent.state === "blocked");
    if (needs.length) this.noNeedsSince = now;
    if (running.length < 2) {
      // an agent whose pull request is merged is finished: it keeps showing "Delete worktree"
      const idle = sims
        .filter((s) => (s.agent.state === "done" || s.agent.state === "idle") && s.caps.prompt && s.agent.turns > 0 && now - s.agent.stateSince > 20_000 && this.prs.get(s.agent.workspaceId)?.state !== "MERGED")
        .sort((a, b) => Number(a.agent.archived) - Number(b.agent.archived) || a.agent.stateSince - b.agent.stateSince)[0];
      if (idle) idle.startTurn(DIRECTOR_PROMPTS[this.promptIdx++ % DIRECTOR_PROMPTS.length] as string, { author: OTHER_DEVICE });
    }
    if (!needs.length && now - this.noNeedsSince > 40_000) {
      const target = running.find((s) => s.acceptsInjection);
      if (target) {
        target.injectNext(injectedAsk(this.askKind++, target.agent.name));
        this.noNeedsSince = now;
      }
    }
    for (const s of needs) {
      const p = s.pending;
      if (p && !this.seenRequests.has(p.request.id)) this.seenRequests.set(p.request.id, now);
      if (p && now - (this.seenRequests.get(p.request.id) ?? now) > 240_000) {
        const rec = p.request.options.find((o) => o.recommended) ?? p.request.options[0];
        s.answer(p.request.id, { choices: rec ? [rec.id] : [], text: rec ? undefined : "Looks good, go ahead.", cancel: false, chat: false }, OTHER_DEVICE);
      }
    }
    const review = sims.filter((s) => s.agent.column === "review" && s.agent.turns > 0).sort((a, b) => a.agent.stateSince - b.agent.stateSince);
    if (review.length > 3) {
      const oldest = review[0] as AgentSim;
      if (now - oldest.agent.stateSince > 60_000) this.archive(oldest, true, OTHER_DEVICE);
    }
  }

  private archive(sim: AgentSim, archived: boolean, author = "You"): void {
    sim.agent.archived = archived;
    if (sim.agent.state !== "working" && sim.agent.state !== "blocked") {
      sim.agent.column = archived ? "done" : "review";
      sim.agent.stateSince = this.now();
    }
    this.pulse(sim.agent.id, "state", 1);
    this.agentChanged(sim.agent.id);
    this.activity(sim.agent.id, archived ? "archived" : "unarchived", `${author} ${archived ? "archived" : "unarchived"} ${sim.agent.name}`);
  }

  // ---------------------------------------------------------------- methods

  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.online) {
      throw apiError("not_connected", `${this.info.hostname} is ${this.status.phase}`, { hint: this.status.phase === "authRequired" ? "Approve the Tailscale check-mode link, then retry" : "Reconnect the host and retry", retryable: true });
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "ai.complete") return this.aiComplete(p);
    const out = this.dispatch(method, p);
    // Small, realistic latency so spinners show briefly (creating a worktree takes a moment).
    const latency = method === "worktree.create" ? 350 : method.startsWith("git.") || method.startsWith("gh.") ? 180 : 40;
    await new Promise<void>((resolve) => this.env.clock.after(latency, resolve));
    return out;
  }

  /** `ai.complete`: deterministic answers after 600–1400 ms (`./ai`). */
  private async aiComplete(p: Record<string, unknown>): Promise<AiCompleteResult> {
    const task = this.str(p, "task");
    const prompt = this.str(p, "prompt");
    this.str(p, "system");
    const ms = demoAiLatency(prompt);
    await new Promise<void>((resolve) => this.env.clock.after(ms, resolve));
    return { ...demoAiComplete(task, prompt), ms };
  }

  private sim(agentId: unknown): AgentSim {
    const s = typeof agentId === "string" ? this.sims.get(agentId) : undefined;
    if (!s) throw apiError("not_found", `agent ${String(agentId)} not found`);
    return s;
  }

  private ompSim(agentId: unknown): AgentSim {
    const s = this.sim(agentId);
    if (!s.omp) throw apiError("unsupported", `${s.agent.name} is a ${s.agent.kind} agent; only the terminal is available`, { hint: "Open the terminal" });
    if (s.agent.omp?.link !== "live") throw apiError("not_connected", "This omp session isn't shared with TeleFlock", { hint: "Connect it to enable the transcript and controls" });
    return s;
  }

  private str(p: Record<string, unknown>, key: string): string {
    const v = p[key];
    if (typeof v !== "string") throw apiError("invalid_params", `missing ${key}`);
    return v;
  }

  private dispatch(method: string, p: Record<string, unknown>): unknown {
    const parked = this.parking.call(method, p);
    if (parked !== undefined) return parked;
    if (method.startsWith("automation.")) return (this.automations ??= new DemoAutomations({ supported: this.variant === "forge", now: () => this.now(), herdrSession: this.info.herdrSession, call: (m, q) => this.dispatch(m, q) })).call(method, p);
    if (method.startsWith("upload.")) return (this.uploads ??= new DemoUploads(this.env.clock, HOME)).call(method, p);
    if (method.startsWith("auth.")) return this.auth.call(method, p);
    if (method.startsWith("accounts.")) return this.accounts.call(method, p);
    if (method.startsWith("mcp."))
      return (this.mcp ??= new DemoMcp({
        supported: this.variant === "forge",
        clock: this.env.clock,
        home: HOME,
        agents: () => this.agentsList(),
        auth: this.auth,
        ompVersion: () => this.info.omp?.version,
        folderExists: (path) => this.isDir(path),
      })).call(method, p);
    switch (method) {
      case "state.get":
        return this.hostState();
      case "session.open": {
        const sim = this.ompSim(p.agentId);
        this.subscribed.add(sim.agent.id);
        return sim.snapshot(typeof p.limit === "number" ? p.limit : 200);
      }
      case "session.close":
        if (typeof p.agentId === "string") this.subscribed.delete(p.agentId);
        return {};
      case "session.history":
        return this.ompSim(p.agentId).history(this.str(p, "cursor"), typeof p.limit === "number" ? p.limit : 100);
      case "session.subagentTranscript":
        return this.subagentTranscript(this.ompSim(p.agentId), this.str(p, "subagentId"));
      case "agent.prompt":
        return this.prompt(p);
      case "agent.abort":
        this.ompSim(p.agentId).abort();
        return {};
      case "agent.answer": {
        const sim = this.ompSim(p.agentId);
        const answer = p.answer as { choices?: string[]; text?: string; cancel?: boolean; chat?: boolean } | undefined;
        const ok = sim.answer(this.str(p, "requestId"), { choices: answer?.choices ?? [], text: answer?.text, cancel: answer?.cancel ?? false, chat: answer?.chat ?? false });
        if (!ok) throw apiError("not_found", "That question was already answered", { hint: "Refresh the card" });
        return {};
      }
      case "agent.setModel": {
        const sim = this.ompSim(p.agentId);
        const m = modelByRef(this.str(p, "model"));
        if (!m) throw apiError("invalid_params", `Unknown model ${String(p.model)}`, { hint: "Pick one from host.models" });
        sim.model = { provider: m.provider, id: m.id, label: m.label };
        if (typeof p.thinking === "string") sim.thinking = p.thinking as AgentSim["thinking"];
        this.control(sim, `Model: ${m.label}${sim.thinking ? ` · ${sim.thinking}` : ""}`);
        this.activity(sim.agent.id, "modelChanged", `${sim.agent.name} switched to ${m.label}`);
        return {};
      }
      case "agent.setThinking": {
        const sim = this.ompSim(p.agentId);
        sim.thinking = this.str(p, "level") as AgentSim["thinking"];
        this.control(sim, `Thinking: ${sim.thinking}`);
        return {};
      }
      case "agent.setFast": {
        const sim = this.ompSim(p.agentId);
        sim.fast = Boolean(p.on);
        this.control(sim, `Fast mode ${sim.fast ? "on" : "off"}`);
        return {};
      }
      case "agent.setPlan": {
        const sim = this.ompSim(p.agentId);
        sim.mode = p.on ? "plan" : "normal";
        this.control(sim, p.on ? "Plan mode on" : "Plan mode off");
        return {};
      }
      case "agent.goal":
        return this.goal(p);
      case "agent.compact":
        this.ompSim(p.agentId).compact(typeof p.instructions === "string" ? p.instructions : undefined);
        return {};
      case "agent.rename": {
        const sim = this.ompSim(p.agentId);
        sim.agent.title = this.str(p, "title");
        this.control(sim, `Renamed: ${sim.agent.title}`);
        return {};
      }
      case "agent.fork":
        return this.fork(p);
      case "agent.branch":
      case "agent.navigate": {
        const sim = this.ompSim(p.agentId);
        this.control(sim, method === "agent.branch" ? `Branched from ${String(p.entryId)}` : `Moved to ${String(p.entryId)} in the session tree`);
        return {};
      }
      case "agent.newSession": {
        const sim = this.ompSim(p.agentId);
        if (sim.busy) throw apiError("busy", "The agent is working", { hint: "Stop it first", retryable: true });
        sim.newSession();
        sim.note("mode", "New session");
        return {};
      }
      case "agent.handoff": {
        const sim = this.ompSim(p.agentId);
        sim.compact(typeof p.instructions === "string" ? p.instructions : "Handoff summary");
        sim.note("mode", "Handed off to a fresh session with the summary");
        return {};
      }
      case "agent.export":
        return { path: `${HOME}/.omp/agent/exports/${this.ompSim(p.agentId).agent.id}-${this.now()}.html` };
      case "agent.btw":
        return this.btw(p);
      case "agent.btwCancel":
        return this.btwCancel(p);
      case "agent.btwHistory": {
        const sim = this.ompSim(p.agentId);
        const threads: BtwThread[] = this.btwsOf(sim).map((b) => ({ btwId: b.id, at: b.at, turns: b.turns.map((t) => ({ ...t })) }));
        return { threads };
      }
      case "agent.slash":
        return this.slash(p);
      case "agent.commands": {
        const sim = this.ompSim(p.agentId);
        if (!sim.caps.bridge) throw apiError("unsupported", "Listing custom commands needs the TeleFlock bridge extension in this omp session");
        return { commands: DEMO_CUSTOM_COMMANDS };
      }
      case "agent.dequeue": {
        const sim = this.ompSim(p.agentId);
        if (!sim.caps.bridge) throw apiError("unsupported", "Pulling back queued messages needs the TeleFlock bridge extension in this omp session");
        return { text: sim.dequeue() };
      }
      case "agent.keys": {
        const sim = this.sim(p.agentId);
        const keys = Array.isArray(p.keys) ? (p.keys as string[]) : [];
        if (keys.some((k) => k === "esc" || k === "ctrl+c")) sim.abort("Interrupted (keys)");
        return {};
      }
      case "agent.subagent":
        return this.subagentCmd(p);
      case "agent.archive": {
        const sim = this.sim(p.agentId);
        this.archive(sim, Boolean(p.archived));
        return {};
      }
      case "agent.connect": {
        const sim = this.sim(p.agentId);
        if (!sim.agent.omp) throw apiError("unsupported", "Not an omp agent");
        if (sim.agent.omp.link === "live") return {};
        sim.agent.omp = { ...sim.agent.omp, link: "connecting", linkReason: "joining", linkVia: "collab", linkSince: this.env.clock.now(), linkError: undefined };
        this.agentChanged(sim.agent.id);
        this.env.clock.after(1600, () => {
          if (!sim.agent.omp) return;
          sim.agent.omp = { ...sim.agent.omp, link: "live", bridge: true, linkReason: undefined, linkVia: "collab", linkSince: this.env.clock.now() };
          sim.caps = { ...sim.caps, prompt: true, steer: true, followUp: true, abort: true, answer: true, model: true, thinking: true, fast: true, plan: true, goal: true, compact: true, rename: true, fork: true, branch: true, tree: true, btw: true, export: true, handoff: true, subagents: true, bridge: true };
          this.agentChanged(sim.agent.id);
        });
        return {};
      }
      case "agent.start":
        return this.startAgent(p);
      case "agent.stop":
        return this.stopAgent(p);
      case "agent.renameHandle": {
        const sim = this.sim(p.agentId);
        const name = this.str(p, "name");
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw apiError("invalid_params", "Agent names are lowercase letters, digits, - and _ (max 32), starting with a letter");
        if ([...this.sims.values()].some((s) => s !== sim && s.agent.name === name)) throw apiError("herdr_error", `agent name '${name}' is already taken`);
        sim.agent.name = name;
        this.agentChanged(sim.agent.id);
        return {};
      }
      case "workspace.create":
        return this.workspaceCreate(p);
      case "workspace.rename": {
        const m = this.wsModel(p.workspaceId);
        m.ws.label = this.str(p, "label");
        this.dirtyWs.add(m.ws.id);
        return {};
      }
      case "workspace.close":
        return this.workspaceClose(p);
      case "tab.rename": {
        const { tab, m } = this.findTab(this.str(p, "tabId"));
        const label = this.str(p, "label").trim();
        if (!label) throw apiError("invalid_params", "Tab label can't be empty");
        tab.label = label;
        this.dirtyWs.add(m.ws.id);
        return {};
      }
      case "tab.close": {
        const { tab, m } = this.findTab(this.str(p, "tabId"));
        // Validate before touching anything: a refused close must leave every pane in place.
        const others = m.ws.tabs.filter((t) => t !== tab).reduce((n, t) => n + t.panes.length, 0);
        const linked = this.linkedOf(m);
        if (others === 0 && linked.length) {
          throw apiError("herdr_error", `workspace_group_close_required: closing the last tab closes ${m.ws.label}, which has ${linked.length} linked worktree workspace(s)`, { hint: "Close the whole workspace group instead" });
        }
        if (others === 0) this.closeWs(m);
        else for (const pane of [...tab.panes]) this.closePaneIn(m, pane.id);
        return {};
      }
      case "pane.close": {
        const paneId = this.str(p, "paneId");
        const m = [...this.wss.values()].find((x) => x.ws.tabs.some((t) => t.panes.some((pp) => pp.id === paneId)));
        if (!m) throw apiError("not_found", `pane ${paneId} not found`);
        this.closePaneIn(m, paneId);
        return {};
      }
      case "worktree.list":
        return this.worktreeList(this.str(p, "cwd"));
      case "worktree.create":
        return this.worktreeCreate(p);
      case "worktree.remove":
        return this.worktreeRemove(p);
      case "fs.home":
        return { path: HOME };
      case "fs.list":
        return this.fsList(this.str(p, "path"), Boolean(p.hidden));
      case "fs.search":
        return this.fsSearch(this.str(p, "root"), this.str(p, "query"), typeof p.limit === "number" ? p.limit : 50);
      case "fs.read":
        return this.fsRead(this.str(p, "path"));
      case "git.status":
        return this.gitStatus(this.str(p, "cwd"));
      case "git.branches":
        return this.gitBranches(this.str(p, "cwd"));
      case "git.diff":
        return this.gitDiff(this.str(p, "cwd"), typeof p.path === "string" ? p.path : undefined);
      case "git.commit":
        return this.gitCommit(this.str(p, "cwd"), this.str(p, "message"));
      case "git.push":
        return this.gitPush(this.str(p, "cwd"));
      case "gh.prStatus":
        return this.prStatus(this.str(p, "cwd"));
      case "gh.prCreate":
        return this.prCreate(p);
      case "gh.prMerge":
        return this.prMerge(this.str(p, "cwd"));
      case "term.open":
        return this.termOpen(p);
      case "term.resize": {
        const t = this.term(p.termId);
        const grid = { cols: Number(p.cols) || t.cols, rows: Number(p.rows) || t.rows };
        t.resize(grid.cols, grid.rows);
        if (t.mode === "control") {
          this.paneGrids.set(t.paneId, grid);
          for (const o of this.terms.values()) if (o.paneId === t.paneId && o.mode === "observe" && !o.isClosed) o.resize(grid.cols, grid.rows);
        }
        return {};
      }
      case "term.scroll":
        this.term(p.termId);
        return {};
      case "term.close": {
        const t = this.terms.get(String(p.termId));
        if (t) {
          t.close("closed");
          this.terms.delete(t.termId);
        }
        return {};
      }
      case "host.health":
        return this.health;
      case "host.usage":
        return this.usageReport(typeof p.days === "number" ? p.days : 14);
      case "host.limits":
        return this.accounts.limits(true);
      case "host.models":
        // Like omp: no usable credential (every account unlinked or expired), no model.
        return { models: this.accounts.usable() ? MODELS.map(({ inPerM: _i, outPerM: _o, ...m }) => m) : [], roles: this.ompSettings.roles() };
      case "omp.settings":
        return this.ompSettings.get();
      case "omp.settingsSet":
        return this.ompSettings.set(p.changes);
      case "host.sessions":
        return { sessions: this.pastSessions(typeof p.cwd === "string" ? p.cwd : undefined, typeof p.limit === "number" ? p.limit : 50) };
      case "host.resume":
        return this.resume(p);
      case "host.setup":
        return this.setup;
      case "host.setupApply":
        return this.setupApply(Array.isArray(p.fixes) ? (p.fixes as string[]) : []);
      case "host.activity":
        return this.activityPage(p);
      case "host.toolsUpdate":
      case "host.toolsConfig":
        return this.tools.call(method, p);
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private control(sim: AgentSim, text: string): void {
    sim.note("mode", text);
    sim.refreshDerived();
    this.agentChanged(sim.agent.id);
    this.metaChanged(sim.agent.id);
  }

  private prompt(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    if (!sim.caps.prompt) throw apiError("permission_denied", "Prompting is disabled for this session (read-only link)", { hint: "Open the terminal to type directly" });
    const text = this.str(p, "text").trim();
    if (!text) throw apiError("invalid_params", "Empty prompt");
    const delivery = typeof p.delivery === "string" ? p.delivery : "auto";
    if (sim.agent.state === "blocked") throw apiError("agent_blocked", `${sim.agent.name} is waiting for an answer`, { hint: "Answer the pending question first" });
    if (sim.agent.state === "working") {
      if (delivery === "followUp") sim.followUp(text);
      else sim.steer(text);
    } else sim.startTurn(text);
    return {};
  }

  private goal(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    const op = this.str(p, "op");
    const budget = typeof p.budget === "number" ? p.budget : undefined;
    if (op === "set") sim.goal = { objective: this.str(p, "objective"), status: "active", tokensUsed: 0, budget };
    else if (op === "drop") sim.goal = undefined;
    else if (!sim.goal) throw apiError("invalid_params", "No goal set");
    else if (op === "pause") sim.goal = { ...sim.goal, status: "paused" };
    else if (op === "resume") sim.goal = { ...sim.goal, status: "active" };
    else if (op === "budget") sim.goal = { ...sim.goal, budget };
    this.control(sim, sim.goal ? `Goal ${op}: ${sim.goal.objective}` : "Goal dropped");
    if (op === "set" && !sim.busy) sim.startTurn(`/goal ${sim.goal?.objective ?? ""}`);
    return {};
  }

  private fork(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    if (p.placement === "pane") {
      const name = this.uniqueName(`${sim.agent.name}-fork`);
      const pane = this.addPane(sim.agent.workspaceId, "right");
      const def: AgentDef = { id: name, kind: "omp", workspace: sim.agent.workspaceId, title: `${sim.agent.title} (fork)`, column: "review", model: sim.model?.label, thinking: sim.thinking, since: 0, age: 0, ctxPct: 30 };
      const fork = this.addAgent(def, sim.agent.workspaceId, pane);
      fork.seed([{ t: "mode", text: `Forked from ${sim.agent.name}${p.entryId ? ` at ${String(p.entryId)}` : ""}` }], this.now(), this.now());
      this.activity(name, "started", `${name} forked from ${sim.agent.name}`);
    } else this.control(sim, `Forked session in place${p.entryId ? ` from ${String(p.entryId)}` : ""}`);
    return {};
  }

  /** This session's `/btw` conversations; the first look seeds one asked earlier in omp's TUI. */
  private btwsOf(sim: AgentSim): DemoBtw[] {
    const sessionId = sim.agent.omp?.sessionId;
    let all = this.btws.get(sim.agent.id);
    if (!all) {
      const at = this.now() - 6 * 60_000;
      const file = this.repoFiles(sim.agent.id).files[0] ?? "src";
      all = [
        {
          id: `btw-${this.rng.hex(6)}`,
          sessionId,
          at,
          turns: [{ question: "Which file does this change start from?", answer: `\`${file}\`: everything else in the diff follows from it.`, status: "complete", at }],
        },
      ];
      this.btws.set(sim.agent.id, all);
    }
    return all.filter((b) => b.sessionId === sessionId);
  }

  /** omp's `/btw`: one side question at a time; `btwId` continues a conversation (omp's `f`). */
  private btw(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    const question = this.str(p, "question").trim();
    if (!question) throw apiError("invalid_params", "empty question");
    const mine = this.btwsOf(sim);
    if (mine.some((b) => b.stop)) throw apiError("busy", "a /btw question is still running; wait for it or cancel it");
    let th: DemoBtw;
    if (typeof p.btwId === "string") {
      const found = mine.find((b) => b.id === p.btwId);
      if (!found) throw apiError("not_found", `no side conversation ${p.btwId}`);
      th = found;
    } else {
      th = { id: `btw-${this.rng.hex(6)}`, sessionId: sim.agent.omp?.sessionId, at: this.now(), turns: [] };
      this.btws.get(sim.agent.id)!.push(th);
    }
    const turn = th.turns.length;
    const answer =
      turn === 0
        ? `Quick side answer (doesn't interrupt the main turn): ${question.endsWith("?") ? "yes — " : ""}the ${sim.agent.repo ?? "repo"} keeps that in \`${this.repoFiles(sim.agent.id).files[2] ?? "src"}\`, and nothing in the current change touches it.`
        : `Following up on "${th.turns[turn - 1]!.question}": same place — and the tests next to it cover that case too.`;
    const entry = { question, answer: "", status: "running" as BtwStatus, at: this.now() };
    th.turns.push(entry);
    const thread = th;
    this.session(sim.agent.id, { k: "btw", btwId: thread.id, turn, question, text: "", done: false });
    const step = () => {
      const chunk = answer.slice(entry.answer.length, entry.answer.length + 12 + this.rng.int(0, 10));
      entry.answer += chunk;
      const done = entry.answer.length >= answer.length;
      if (done) {
        entry.status = "complete";
        thread.stop = undefined;
      } else thread.stop = this.env.clock.after(90, step);
      this.session(sim.agent.id, { k: "btw", btwId: thread.id, turn, text: chunk, done });
    };
    thread.stop = this.env.clock.after(400, step);
    return { btwId: thread.id, turn };
  }

  private btwCancel(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    const th = this.btwsOf(sim).find((b) => b.id === p.btwId && b.stop);
    if (!th?.stop) throw apiError("not_found", `no running btw ${String(p.btwId)}`);
    th.stop();
    th.stop = undefined;
    const turn = th.turns.length - 1;
    th.turns[turn]!.status = "cancelled";
    this.session(sim.agent.id, { k: "btw", btwId: th.id, turn, text: "\n\n⚠ cancelled", done: true });
    return {};
  }

  private slash(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    const command = this.str(p, "command").trim();
    if (!command.startsWith("/") || /[\r\n]/.test(command)) throw apiError("invalid_params", "slash commands are one line and start with `/`");
    // Same acceptance as hostd: builtins, `/skill:<name>`, and the session's own commands.
    const name = ompCommandName(command);
    const custom = DEMO_CUSTOM_COMMANDS.some((c) => c.name === name) || (name.startsWith("skill:") && name.length > 6);
    if (!OMP_COMMAND_NAMES.has(name) && !custom) {
      throw apiError("unsupported", `\`/${name}\` is not a known omp command`, { hint: "Unknown commands would be sent to the model as a prompt" });
    }
    const arg = command.slice(1 + name.length).replace(/^:/, "").trim();
    switch (custom ? "" : name) {
      case "model":
      case "switch": {
        if (!arg) {
          this.control(sim, `Opened /${name} in the terminal`);
          break;
        }
        const m = modelByRef(arg);
        if (!m) throw apiError("invalid_params", `Unknown model ${arg}`);
        sim.model = { provider: m.provider, id: m.id, label: m.label };
        const level = arg.split(":")[1];
        if (level) sim.thinking = level as AgentSim["thinking"];
        this.control(sim, `Model: ${m.label}`);
        break;
      }
      case "effort":
        if (!arg) {
          this.control(sim, "Opened /effort in the terminal");
          break;
        }
        sim.thinking = arg as AgentSim["thinking"];
        this.control(sim, `Thinking: ${arg}`);
        break;
      case "fast":
        sim.fast = arg !== "off";
        this.control(sim, `Fast mode ${sim.fast ? "on" : "off"}`);
        break;
      case "plan":
        sim.mode = sim.mode === "plan" ? "planPaused" : sim.mode === "planPaused" ? "normal" : "plan";
        this.control(sim, `Plan mode: ${sim.mode}`);
        if (arg && sim.mode === "plan") sim.startTurn(arg);
        break;
      case "compact":
        sim.compact(arg || undefined);
        break;
      case "rename":
        sim.agent.title = arg;
        this.control(sim, `Renamed: ${arg}`);
        break;
      case "goal": {
        const [sub = "", ...rest] = arg.split(/\s+/);
        if (!arg || ["show", "pause", "resume", "drop", "budget"].includes(sub)) {
          this.control(sim, `Ran ${command}`);
          break;
        }
        const objective = sub === "set" ? rest.join(" ") : arg;
        sim.goal = { objective, status: "active", tokensUsed: 0 };
        this.control(sim, `Goal: ${objective}`);
        break;
      }
      case "new":
        sim.newSession();
        break;
      case "queue":
        if (!arg) throw apiError("invalid_params", "/queue needs a message");
        if (sim.busy) sim.followUp(arg);
        else sim.startTurn(arg);
        break;
      case "":
        // Prompt templates, skills and extension commands expand into a prompt.
        if (sim.busy) sim.steer(command);
        else sim.startTurn(command);
        break;
      default:
        this.control(sim, `Ran ${command}`);
    }
    return {};
  }

  private subagentCmd(p: Record<string, unknown>): unknown {
    const sim = this.ompSim(p.agentId);
    const id = this.str(p, "subagentId");
    const i = sim.subagents.findIndex((s) => s.id === id);
    if (i < 0) throw apiError("not_found", `subagent ${id} not found`);
    const sub = sim.subagents[i] as AgentSim["subagents"][number];
    const action = this.str(p, "action");
    if (action === "kill") sim.subagents[i] = { ...sub, status: "aborted", endedAt: this.now() };
    else if (action === "revive") {
      sim.subagents[i] = { ...sub, status: "running", endedAt: undefined, completionPct: undefined, line: "revived" };
      this.env.clock.after(20_000, () => {
        const j = sim.subagents.findIndex((s) => s.id === id);
        if (j >= 0) sim.subagents[j] = { ...(sim.subagents[j] as typeof sub), status: "done", endedAt: this.now(), completionPct: undefined, line: "done" };
        sim.refreshDerived();
        this.agentChanged(sim.agent.id);
        this.metaChanged(sim.agent.id);
      });
    } else {
      sim.subagents[i] = { ...sub, line: `↳ ${String(p.message ?? "")}` };
      this.subSteers.set(id, [...(this.subSteers.get(id) ?? []), { at: this.now(), text: String(p.message ?? "") }]);
    }
    sim.refreshDerived();
    this.agentChanged(sim.agent.id);
    this.metaChanged(sim.agent.id);
    return {};
  }

  private subagentTranscript(sim: AgentSim, subagentId: string): HistoryPage {
    const sub = sim.subagents.find((s) => s.id === subagentId);
    if (!sub) throw apiError("not_found", `subagent ${subagentId} not found`);
    const now = this.now();
    const t0 = sub.startedAt ?? now;
    const running = sub.status === "running";
    const files = this.repoFiles(sim.agent.id).files;
    // The transcript grows while the subagent runs: one tool call every ~2.5 s, a note every 4 calls.
    const calls = Math.min(60, Math.floor(((running ? now : (sub.endedAt ?? now)) - t0) / 2500) + 1);
    const items: TranscriptItem[] = [
      { kind: "user", id: `${subagentId}-u`, at: t0, text: sub.description ?? sub.name, images: [], steering: false, synthetic: true },
      { kind: "thinking", id: `${subagentId}-t`, at: t0 + 500, text: "Scoping the task and picking files to read.", streaming: false, durationMs: 2100, redacted: false },
    ];
    for (let i = 0; i < calls; i++) {
      const at = t0 + 2600 + i * 2500;
      const live = running && i === calls - 1;
      const tool = ["read", "grep", "read", "bash"][i % 4] as string;
      const file = files[(i + 3) % Math.max(1, files.length)] ?? "README.md";
      items.push({
        kind: "tool",
        id: `${subagentId}-tool${i}`,
        at,
        callId: `c${i}`,
        tool,
        title: tool === "bash" ? `go test ./... -run ${sub.name}` : file,
        args: {},
        status: live ? "running" : "ok",
        durationMs: live ? undefined : 600 + (i % 5) * 200,
        output: tool === "bash" && !live ? `ok  \tgithub.com/acme/api-gateway/internal/db\t${(0.4 + i / 10).toFixed(2)}s` : undefined,
        truncated: false,
      });
      if (i % 4 === 3 && !live) items.push({ kind: "assistant", id: `${subagentId}-n${i}`, at: at + 1200, text: `Checked \`${file}\`: ${i + 1} of the hot paths covered so far.`, streaming: false });
    }
    for (const [i, s] of (this.subSteers.get(subagentId) ?? []).entries()) items.push({ kind: "user", id: `${subagentId}-steer${i}`, at: s.at, text: s.text, images: [], steering: true, synthetic: false });
    // The parent's IRC with this subagent, seen from the subagent: its sends to `Main`, Main's answers.
    for (const row of sim.items) {
      const e = ircOf(row);
      if (!e || e.message.peer !== sub.name || e.message.wakeRelay || (e.status != null && e.status !== "ok")) continue;
      const id = `${subagentId}-irc-${row.id}`;
      const text = e.message.text;
      if (e.message.direction === "out") {
        items.push({ kind: "irc", id, at: e.at, message: { ...e.message, direction: "in", peer: "Main", fromParent: true, receipts: [] } });
      } else {
        const view = { type: "irc" as const, direction: "out" as const, peer: "Main", text, broadcast: false, wakeRelay: false, fromParent: false, receipts: [{ to: "Main", outcome: "injected" }] };
        items.push({ kind: "tool", id, at: e.at, callId: id, tool: "write", title: "agent://Main", args: { path: "agent://Main", content: text }, status: "ok", durationMs: 40, output: "Delivered to Main.", truncated: false, view });
      }
    }
    if (!running) items.push({ kind: "assistant", id: `${subagentId}-a`, at: Math.max(sub.endedAt ?? now, t0 + 2600 + calls * 2500), text: `Result: ${sub.line ?? "done"}.`, streaming: false });
    items.sort((a, b) => a.at - b.at);
    return { items, hasMore: false };
  }

  private uniqueName(base: string): string {
    const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "a").slice(0, 28);
    let name = clean;
    for (let i = 2; this.sims.has(name) || [...this.sims.values()].some((s) => s.agent.name === name); i++) name = `${clean}-${i}`;
    return name;
  }

  private wsModel(id: unknown): WsModel {
    const m = typeof id === "string" ? this.wss.get(id) : undefined;
    if (!m) throw apiError("not_found", `workspace ${String(id)} not found`);
    return m;
  }

  private addPane(wsId: string, split: string | null): string {
    const m = this.wsModel(wsId);
    const pane = `${wsId}:p${this.nextPane++ + 10}`;
    const info = { id: pane, terminalId: `term-${pane.replace(":", "-")}`, title: "omp", cwd: m.path, focused: true };
    if (split === "tab") m.ws.tabs.push({ id: `${wsId}:t${m.ws.tabs.length + 1}`, label: `tab ${m.ws.tabs.length + 1}`, panes: [info] });
    else m.ws.tabs[0]?.panes.push(info);
    this.dirtyWs.add(wsId);
    return pane;
  }

  private newAgentFromSpec(spec: Record<string, unknown>, wsId: string, pane: string, fallbackName: string): AgentSim {
    const kind = typeof spec.kind === "string" ? spec.kind : "omp";
    const requested = typeof spec.name === "string" && spec.name ? spec.name : undefined;
    if (requested && !/^[a-z][a-z0-9_-]{0,31}$/.test(requested)) throw apiError("invalid_params", "Agent names are lowercase letters, digits, - and _ (max 32), starting with a letter");
    if (requested && [...this.sims.values()].some((s) => s.agent.name === requested)) throw apiError("herdr_error", `agent name '${requested}' is already taken`);
    const name = requested ?? this.uniqueName(fallbackName);
    const model = typeof spec.model === "string" ? modelByRef(spec.model)?.label : undefined;
    const prompt = demoFirstPrompt(spec);
    // A just-started session: zero turns until its first prompt runs (the UI shows "Ready" / "Starting").
    const def: AgentDef = { id: name, kind, workspace: wsId, title: prompt?.slice(0, 80) ?? name, column: "review", model: model ?? "opus-5", thinking: (spec.thinking as AgentDef["thinking"]) ?? "high", since: 0, age: 0, ctxPct: 2, cost: 0, files: [], todos: [], fresh: true };
    const sim = this.addAgent(def, wsId, pane);
    sim.agent.state = "idle";
    sim.agent.stateSince = this.now();
    sim.agent.live = { streaming: false, thinking: false, lastEventAt: this.now() };
    if (sim.agent.omp) {
      sim.agent.omp = { ...sim.agent.omp, link: "connecting", linkReason: "starting", linkVia: undefined, linkSince: this.env.clock.now(), linkError: undefined };
      if (spec.plan) sim.mode = "plan";
      this.env.clock.after(1400, () => {
        if (!sim.agent.omp) return;
        sim.agent.omp = { ...sim.agent.omp, link: "live", linkReason: undefined, linkVia: "bridge", linkSince: this.env.clock.now() };
        sim.refreshDerived();
        this.agentChanged(sim.agent.id);
        if (prompt) sim.startTurn(prompt);
      });
    }
    this.activity(name, "started", `${name} started`, prompt);
    return sim;
  }

  private startAgent(p: Record<string, unknown>): unknown {
    const target = (p.target ?? {}) as Record<string, unknown>;
    const spec = (p.spec ?? {}) as Record<string, unknown>;
    let wsId: string;
    let pane: string;
    if (target.kind === "workspace") {
      wsId = this.wsModel(target.workspaceId).ws.id;
      pane = this.addPane(wsId, typeof target.split === "string" ? target.split : null);
    } else if (target.kind === "pane") {
      const paneId = this.str(target, "paneId");
      const m = [...this.wss.values()].find((x) => x.ws.tabs.some((t) => t.panes.some((pp) => pp.id === paneId)));
      if (!m) throw apiError("not_found", `pane ${paneId} not found`);
      if ([...this.sims.values()].some((s) => s.agent.paneId === paneId)) throw apiError("busy", `pane ${paneId} already runs an agent`, { hint: "Pick a shell pane or split a new one" });
      wsId = m.ws.id;
      pane = paneId;
    } else if (target.kind === "cwd") {
      const cwd = this.resolve(this.str(target, "cwd"));
      if (!this.isDir(cwd)) throw apiError("not_found", `${cwd} does not exist`);
      const repo = repoForPath(cwd);
      const m = this.addWorkspace(repo?.name, repo ? "main" : undefined, false, this.wss.size, undefined, false, cwd, typeof target.label === "string" ? target.label : undefined);
      wsId = m.ws.id;
      pane = m.ws.tabs[0]?.panes[0]?.id as string;
    } else throw apiError("invalid_params", "target.kind must be workspace, pane or cwd");
    const sim = this.newAgentFromSpec(spec, wsId, pane, (this.wss.get(wsId)?.ws.label ?? "agent").split(/[·/]/).pop() ?? "agent");
    return { agentId: sim.agent.id, paneId: pane, workspaceId: wsId };
  }

  private removeAgent(id: string): void {
    this.sims.delete(id);
    this.removedAgents.add(id);
    this.dirtyAgents.delete(id);
    this.subscribed.delete(id);
    for (const t of [...this.terms.values()]) {
      if (t.agentId === id) {
        t.close("agent exited");
        this.terms.delete(t.termId);
      }
    }
  }

  private stopAgent(p: Record<string, unknown>): unknown {
    const sim = this.sim(p.agentId);
    const mode = this.str(p, "mode");
    if (mode === "interrupt") {
      sim.abort();
      return {};
    }
    const id = sim.agent.id;
    const m = this.wss.get(sim.agent.workspaceId);
    this.removeAgent(id);
    this.activity(id, "stopped", `${sim.agent.name} ${mode === "exit" ? "exited" : "pane closed"}`);
    if (m) {
      for (const tab of m.ws.tabs) {
        for (const pane of tab.panes) if (pane.agentId === id) pane.agentId = undefined;
        if (mode === "closePane") tab.panes = tab.panes.filter((pp) => pp.id !== sim.agent.paneId);
        else for (const pane of tab.panes) if (pane.id === sim.agent.paneId) pane.title = "zsh";
      }
      if (mode === "exit") m.shellPanes.push(sim.agent.paneId);
      this.dirtyWs.add(m.ws.id);
    }
    return {};
  }

  private workspaceCreate(p: Record<string, unknown>): unknown {
    const cwd = this.resolve(this.str(p, "cwd"));
    if (!this.isDir(cwd)) throw apiError("not_found", `${cwd} does not exist`, { hint: "Pick an existing folder" });
    const repo = repoForPath(cwd);
    const m = this.addWorkspace(repo && cwd === repo.root ? repo.name : undefined, repo ? "main" : undefined, false, this.wss.size, undefined, true, cwd, typeof p.label === "string" ? p.label : undefined);
    m.shellPanes.push(m.ws.tabs[0]?.panes[0]?.id as string);
    if (m.ws.tabs[0]?.panes[0]) m.ws.tabs[0].panes[0].title = "zsh";
    return { workspaceId: m.ws.id };
  }

  private linkedOf(m: WsModel): WsModel[] {
    return [...this.wss.values()].filter((x) => x.ws.worktree?.primaryWorkspaceId === m.ws.id);
  }

  private closeWs(m: WsModel): void {
    for (const s of [...this.sims.values()]) if (s.agent.workspaceId === m.ws.id) this.removeAgent(s.agent.id);
    this.wss.delete(m.ws.id);
    this.removedWs.add(m.ws.id);
    this.dirtyWs.delete(m.ws.id);
  }

  private findTab(tabId: string): { tab: WsModel["ws"]["tabs"][number]; m: WsModel } {
    for (const m of this.wss.values()) {
      const tab = m.ws.tabs.find((t) => t.id === tabId);
      if (tab) return { tab, m };
    }
    throw apiError("not_found", `tab ${tabId} not found`);
  }

  /**
   * herdr semantics: closing a pane kills its process (agent included); an emptied tab goes away,
   * and closing the last pane of a workspace closes the workspace (refused for a primary with
   * linked worktrees, like `workspace.close` without `group`).
   */
  private closePaneIn(m: WsModel, paneId: string): void {
    const total = m.ws.tabs.reduce((n, t) => n + t.panes.length, 0);
    if (total <= 1) {
      const linked = this.linkedOf(m);
      if (linked.length) {
        throw apiError("herdr_error", `workspace_group_close_required: closing the last pane closes ${m.ws.label}, which has ${linked.length} linked worktree workspace(s)`, { hint: "Close the whole workspace group instead" });
      }
      this.closeWs(m);
      return;
    }
    const sim = [...this.sims.values()].find((s) => s.agent.paneId === paneId);
    if (sim) {
      this.removeAgent(sim.agent.id);
      this.activity(sim.agent.id, "stopped", `${sim.agent.name} pane closed`);
    }
    for (const t of [...this.terms.values()]) {
      if (t.paneId === paneId) {
        t.close("pane closed");
        this.terms.delete(t.termId);
      }
    }
    for (const tab of m.ws.tabs) tab.panes = tab.panes.filter((pp) => pp.id !== paneId);
    m.ws.tabs = m.ws.tabs.filter((t) => t.panes.length > 0);
    m.shellPanes = m.shellPanes.filter((x) => x !== paneId);
    this.dirtyWs.add(m.ws.id);
  }

  private workspaceClose(p: Record<string, unknown>): unknown {
    const m = this.wsModel(p.workspaceId);
    const linked = this.linkedOf(m);
    if (linked.length && !p.group) {
      throw apiError("herdr_error", `workspace_group_close_required: ${m.ws.label} has ${linked.length} linked worktree workspace(s)`, { hint: "Close the whole group, or close the linked worktrees first" });
    }
    for (const l of linked) this.closeWs(l);
    this.closeWs(m);
    return {};
  }

  private wsDirty(wsId: string): number {
    return [...this.sims.values()].filter((s) => s.agent.workspaceId === wsId).reduce((n, s) => n + s.files.length, 0);
  }

  private worktreeList(cwd: string): WorktreeList {
    const repo = repoForPath(this.resolve(cwd));
    if (!repo) throw apiError("git_error", `fatal: not a git repository: ${cwd}`);
    const worktrees: WorktreeEntry[] = [...this.wss.values()]
      .filter((m) => m.repo === repo)
      .map((m) => ({ path: m.path, branch: m.ws.repo?.branch, head: m.ws.repo?.head, primary: !m.ws.worktree, workspaceId: m.ws.id, dirty: this.wsDirty(m.ws.id) }));
    // A linked worktree on disk that no herdr workspace shows.
    if (repo.name === "teleflock") worktrees.push({ path: `${WORKTREES}/teleflock/spike-collab-relay`, branch: "spike/collab-relay", head: "9d0e4c1", primary: false, dirty: 0 });
    return { worktrees };
  }

  private worktreeCreate(p: Record<string, unknown>): unknown {
    const cwd = this.resolve(this.str(p, "cwd"));
    const branch = this.str(p, "branch").trim();
    if (cwd.includes("untrusted") && !p.trust) {
      throw apiError("herdr_error", `fatal: detected dubious ownership in repository at '${cwd}'`, { hint: "Confirm that you trust this repository to continue" });
    }
    const repo = repoForPath(cwd);
    if (!repo) throw apiError("git_error", `fatal: not a git repository (or any of the parent directories): ${cwd}`);
    if (!/^[\w./-]+$/.test(branch) || branch.endsWith("/") || branch.includes("..")) throw apiError("git_error", `fatal: '${branch}' is not a valid branch name`);
    const inUse = [...this.wss.values()].find((m) => m.repo === repo && m.ws.repo?.branch === branch);
    if (inUse) throw apiError("git_error", `fatal: '${branch}' is already used by worktree at '${inUse.path}'`, { hint: "Pick another branch, or open the existing workspace" });
    const known = this.branchesOf(repo);
    if (p.existing && !known.includes(branch)) throw apiError("git_error", `fatal: invalid reference: ${branch}`);
    if (!p.existing && known.includes(branch)) throw apiError("git_error", `fatal: a branch named '${branch}' already exists`, { hint: "Use the existing branch instead" });
    const path = typeof p.path === "string" && p.path ? this.resolve(p.path) : `${WORKTREES}/${repo.name}/${slug(branch)}`;
    if (this.isDir(path)) throw apiError("git_error", `fatal: '${path}' already exists`);
    const primary = [...this.wss.values()].find((m) => m.repo === repo && !m.ws.worktree);
    const order = primary ? primary.ws.order + 0.5 + this.linkedOf(primary).length * 0.01 : this.wss.size;
    const m = this.addWorkspace(repo.name, branch, true, order, undefined, false, path, typeof p.label === "string" && p.label ? p.label : undefined);
    this.activity("", "started", `Worktree ${branch} created`, path);
    let agent: unknown;
    if (p.agent && typeof p.agent === "object") {
      const pane = m.ws.tabs[0]?.panes[0]?.id as string;
      const sim = this.newAgentFromSpec(p.agent as Record<string, unknown>, m.ws.id, pane, branch.split("/").pop() ?? "agent");
      agent = { agentId: sim.agent.id, paneId: pane, workspaceId: m.ws.id };
    } else {
      m.shellPanes.push(m.ws.tabs[0]?.panes[0]?.id as string);
      if (m.ws.tabs[0]?.panes[0]) m.ws.tabs[0].panes[0].title = "zsh";
    }
    return { workspaceId: m.ws.id, path, branch, agent };
  }

  private worktreeRemove(p: Record<string, unknown>): unknown {
    if (!p.workspaceId && typeof p.path === "string") return this.worktreeRemovePath(this.resolve(p.path), Boolean(p.force), Boolean(p.trust));
    const m = this.wsModel(p.workspaceId);
    if (!m.ws.worktree) throw apiError("invalid_params", "Not a linked worktree workspace", { hint: "Close the workspace instead" });
    if (m.path.includes("untrusted") && !p.trust) throw apiError("herdr_error", `fatal: detected dubious ownership in repository at '${m.path}'`, { hint: "Confirm that you trust this repository to continue" });
    const dirty = [...this.sims.values()].filter((s) => s.agent.workspaceId === m.ws.id).reduce((n, s) => n + s.files.length, 0);
    if (dirty > 0 && !p.force) throw apiError("herdr_error", `dirty_worktree_requires_force: ${m.path} has ${dirty} uncommitted change(s)`, { hint: "Commit or discard the changes, or remove with force" });
    this.closeWs(m);
    // PRs are keyed by workspace here: drop it with the workspace
    this.prs.delete(m.ws.id);
    this.forgetParkedWorktree(m.path);
    return {};
  }

  /** `worktree.remove {path}`: a parked agent's worktree, whose workspace closed with its pane (hostd ≥ 0.5.2). */
  private worktreeRemovePath(path: string, force: boolean, trust: boolean): unknown {
    const held = [...this.wss.values()].find((m) => m.ws.worktree && m.path === path);
    if (held) return this.worktreeRemove({ workspaceId: held.ws.id, force, trust });
    const owners = [...this.sims.values()].filter((s) => s.agent.parked?.worktree?.path === path);
    if (path.includes("untrusted") && !trust) throw apiError("untrusted_repo", `detected dubious ownership in repository at '${path}'`, { hint: "Retry with “Trust repository”" });
    const dirty = owners.reduce((n, s) => n + s.files.length, 0);
    if (dirty > 0 && !force) throw apiError("dirty_worktree", `'${path}' contains modified or untracked files, use --force to delete it`, { hint: "Remove it with “force” to discard them (the branch is kept)." });
    this.parkedPrs.delete(path);
    this.forgetParkedWorktree(path);
    return {};
  }

  /** The checkout is gone: parked cards that ran there stop offering to delete it. */
  private forgetParkedWorktree(path: string): void {
    for (const s of this.sims.values()) {
      const parked = s.agent.parked;
      if (parked?.worktree?.path !== path) continue;
      s.agent.parked = { at: parked.at, sessionFile: parked.sessionFile };
      this.agentChanged(s.agent.id);
    }
  }

  // ---------------------------------------------------------------- fs

  private resolve(path: string): string {
    let p = path.trim();
    if (p === "~" || p === "") p = HOME;
    else if (p.startsWith("~/")) p = `${HOME}/${p.slice(2)}`;
    if (!p.startsWith("/")) p = `${HOME}/${p}`;
    const parts: string[] = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join("/")}`;
  }

  /** Directory → children names (dirs end with `/`). */
  private tree(): Map<string, Set<string>> {
    const t = new Map<string, Set<string>>();
    const addPath = (full: string, isDir: boolean) => {
      const parts = full.split("/").filter(Boolean);
      let cur = "";
      for (let i = 0; i < parts.length; i++) {
        const parent = cur || "/";
        cur = `${cur}/${parts[i]}`;
        const last = i === parts.length - 1;
        if (!t.has(parent)) t.set(parent, new Set());
        (t.get(parent) as Set<string>).add(last && !isDir ? (parts[i] as string) : `${parts[i]}/`);
      }
      if (isDir && !t.has(cur)) t.set(cur, new Set());
    };
    for (const d of ["code/dotfiles", "code/sandbox", "notes", ".config/herdr", ".omp/agent/sessions", ".teleflock/bin", "Downloads"]) addPath(`${HOME}/${d}`, true);
    for (const f of ["notes/ideas.md", "notes/todo.md", "code/dotfiles/.zshrc", "code/dotfiles/install.sh", "code/sandbox/scratch.ts", ".config/herdr/config.toml", ".zshrc", ".gitconfig"]) addPath(`${HOME}/${f}`, false);
    for (const r of REPOS) {
      addPath(r.root, true);
      for (const f of r.files) addPath(`${r.root}/${f}`, false);
    }
    for (const m of this.wss.values()) {
      addPath(m.path, true);
      if (m.ws.worktree && m.repo) for (const f of m.repo.files) addPath(`${m.path}/${f}`, false);
    }
    return t;
  }

  private isDir(path: string): boolean {
    return this.tree().has(this.resolve(path));
  }

  private badge(path: string): GitBadge | undefined {
    const ws = [...this.wss.values()].find((m) => m.path === path);
    if (ws?.repo) return { repoRoot: true, worktree: Boolean(ws.ws.worktree), branch: ws.ws.repo?.branch, dirty: this.wsDirty(ws.ws.id) };
    const repo = REPOS.find((r) => r.root === path);
    if (repo) return { repoRoot: true, worktree: false, branch: "main", dirty: repo.name === "infra" ? 2 : 0 };
    return undefined;
  }

  private fsList(path: string, hidden: boolean): unknown {
    const abs = this.resolve(path);
    const tree = this.tree();
    const kids = tree.get(abs);
    if (!kids) {
      const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
      if (tree.get(parent)?.has(abs.split("/").pop() ?? "")) throw apiError("invalid_params", `${abs} is not a directory`);
      throw apiError("not_found", `No such directory: ${abs}`);
    }
    const rng = new Rng(hash(abs));
    const entries: FsEntry[] = [...kids]
      .map((k) => {
        const dir = k.endsWith("/");
        const name = dir ? k.slice(0, -1) : k;
        const full = abs === "/" ? `/${name}` : `${abs}/${name}`;
        return { name, path: full, kind: dir ? ("dir" as const) : ("file" as const), hidden: name.startsWith("."), git: dir ? this.badge(full) : undefined, size: dir ? undefined : rng.int(200, 48_000), modified: this.now() - rng.int(60, 86400 * 30) * 1000 };
      })
      .filter((e) => hidden || !e.hidden)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    const containing = [...this.wss.values()].find((m) => abs === m.path || abs.startsWith(`${m.path}/`));
    const repo = repoForPath(abs);
    const git = containing?.repo ? this.badge(containing.path) : repo ? this.badge(repo.root) : undefined;
    return { path: abs, parent: abs === "/" ? undefined : abs.slice(0, abs.lastIndexOf("/")) || "/", entries, git };
  }

  private fsSearch(root: string, query: string, limit: number): unknown {
    const abs = this.resolve(root);
    const repo = repoForPath(abs);
    const files = repo ? repo.files : [];
    const q = query.toLowerCase();
    const score = (f: string): number => {
      const s = f.toLowerCase();
      if (!q) return 1;
      if (s.includes(q)) return 100 - s.indexOf(q) - s.length * 0.1;
      let i = 0;
      for (const ch of s) if (ch === q[i]) i++;
      return i === q.length ? 10 - s.length * 0.01 : -1;
    };
    const ranked = files.map((f) => [f, score(f)] as const).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]);
    return { files: ranked.slice(0, limit).map(([f]) => f), truncated: ranked.length > limit };
  }

  private fsRead(path: string): unknown {
    const abs = this.resolve(path);
    const tree = this.tree();
    const parent = abs.slice(0, abs.lastIndexOf("/")) || "/";
    const name = abs.split("/").pop() ?? "";
    if (tree.has(abs)) throw apiError("invalid_params", `${abs} is a directory`);
    if (!tree.get(parent)?.has(name)) throw apiError("not_found", `No such file: ${abs}`);
    if (name.endsWith(".png")) return { path: abs, size: 48_211, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", mime: "image/png", truncated: false };
    const text = name === "README.md" ? `# ${repoForPath(abs)?.name ?? "project"}\n\n${fileBody(abs, 30)}` : fileBody(abs, 80);
    return { path: abs, size: text.length, text, truncated: false };
  }

  // ---------------------------------------------------------------- git / gh

  private wsForCwd(cwd: string): WsModel {
    const abs = this.resolve(cwd);
    const m = [...this.wss.values()].sort((a, b) => b.path.length - a.path.length).find((x) => abs === x.path || abs.startsWith(`${x.path}/`));
    if (!m?.repo) throw apiError("git_error", `fatal: not a git repository: ${abs}`);
    return m;
  }

  private wsFiles(m: WsModel): ChangedFile[] {
    return [...this.sims.values()].filter((s) => s.agent.workspaceId === m.ws.id).flatMap((s) => s.files);
  }

  private gitStatus(cwd: string): unknown {
    const m = this.wsForCwd(cwd);
    const branch = m.ws.repo?.branch ?? "main";
    return {
      root: m.path,
      branch,
      upstream: m.ws.worktree ? `origin/${branch}` : "origin/main",
      ahead: m.ws.repo?.ahead ?? 0,
      behind: m.ws.worktree ? 0 : 0,
      defaultBranch: "main",
      base: new Rng(hash(`${m.path}base`)).hex(7),
      files: this.wsFiles(m),
    };
  }

  private gitBranches(cwd: string): unknown {
    const repo = repoForPath(this.resolve(cwd));
    if (!repo) throw apiError("git_error", `fatal: not a git repository: ${cwd}`);
    const now = this.now();
    const rng = new Rng(hash(repo.name));
    const current = this.wsForCwd(cwd).ws.repo?.branch;
    const branches: BranchInfo[] = [];
    const all = this.branchesOf(repo);
    for (const b of all) {
      const ws = [...this.wss.values()].find((m) => m.repo === repo && m.ws.repo?.branch === b);
      branches.push({ name: b, current: b === current, remote: false, upstream: `origin/${b}`, worktreePath: ws?.path, lastCommitAt: now - rng.int(5, 3000) * 60_000 });
    }
    for (const b of all.slice(0, 4)) branches.push({ name: `origin/${b}`, current: false, remote: true, lastCommitAt: now - rng.int(5, 3000) * 60_000 });
    branches.push({ name: "origin/release/1.0", current: false, remote: true, lastCommitAt: now - 9 * 86400_000 });
    return { branches, defaultBranch: "main", defaultBase: "origin/main" };
  }

  private gitDiff(cwd: string, path?: string): unknown {
    const m = this.wsForCwd(cwd);
    // Like real hostd: merge-base with the default branch, committed work included.
    const files = [...this.sims.values()].filter((s) => s.agent.workspaceId === m.ws.id).flatMap((s) => s.branchFiles()).filter((f) => !path || f.path === path);
    const patch = files.map((f) => fileDiff(f).patch).join("\n");
    return { base: `origin/main (${new Rng(hash(`${m.path}base`)).hex(7)})`, patch, files, truncated: false };
  }

  private gitCommit(cwd: string, message: string): unknown {
    const m = this.wsForCwd(cwd);
    const sims = [...this.sims.values()].filter((s) => s.agent.workspaceId === m.ws.id);
    const count = sims.reduce((n, s) => n + s.files.length, 0);
    if (!count) throw apiError("git_error", "nothing to commit, working tree clean");
    for (const s of sims) {
      s.commit();
      this.agentChanged(s.agent.id);
      this.metaChanged(s.agent.id);
    }
    if (m.ws.repo) m.ws.repo.ahead = (m.ws.repo.ahead ?? 0) + 1;
    this.dirtyWs.add(m.ws.id);
    const sha = this.rng.hex(40);
    const summary = message.split("\n")[0] ?? message;
    this.activity(sims[0]?.agent.id ?? "", "committed", `Committed on ${m.ws.repo?.branch ?? "main"}`, summary);
    return { sha, summary };
  }

  private gitPush(cwd: string): unknown {
    const m = this.wsForCwd(cwd);
    const branch = m.ws.repo?.branch ?? "main";
    if (m.ws.repo) m.ws.repo.ahead = 0;
    this.dirtyWs.add(m.ws.id);
    return { code: 0, stdout: "", stderr: `To ${m.repo?.remote}\n   ${this.rng.hex(7)}..${this.rng.hex(7)}  ${branch} -> ${branch}\nbranch '${branch}' set up to track 'origin/${branch}'.` };
  }

  private prView(pr: PrInfo & { createdAt: number }): PrInfo {
    const { createdAt, ...rest } = pr;
    if (rest.state !== "OPEN") return rest;
    const age = this.now() - createdAt;
    const checks = age > 10_000 ? { passed: 9, failed: 0, pending: 0 } : { passed: Math.floor(age / 1200), failed: 0, pending: 9 - Math.floor(age / 1200) };
    return { ...rest, checks, mergeable: age > 10_000 };
  }

  private prStatus(cwd: string): unknown {
    const abs = this.resolve(cwd);
    const parked = this.parkedPrs.get(abs);
    // a parked agent's worktree has no workspace any more: its PR is known by path
    if (parked && ![...this.wss.values()].some((m) => m.path === abs)) return { pr: this.prView(parked) };
    const m = this.wsForCwd(cwd);
    const pr = this.prs.get(m.ws.id);
    return pr ? { pr: this.prView(pr) } : {};
  }

  private prCreate(p: Record<string, unknown>): unknown {
    const m = this.wsForCwd(this.str(p, "cwd"));
    if (!m.ws.worktree) throw apiError("gh_error", "pull request create failed: head branch is the default branch", { hint: "Create the PR from a feature branch" });
    if (this.prs.has(m.ws.id)) throw apiError("gh_error", `a pull request for branch "${m.ws.repo?.branch}" already exists`);
    const num = this.nextPr++;
    const pr = { number: num, url: `${m.repo?.remote.replace("git@github.com:", "https://github.com/").replace(/\.git$/, "")}/pull/${num}`, title: this.str(p, "title"), state: "OPEN", draft: Boolean(p.draft), mergeable: false, createdAt: this.now() };
    this.prs.set(m.ws.id, pr);
    const agent = [...this.sims.values()].find((s) => s.agent.workspaceId === m.ws.id);
    this.activity(agent?.agent.id ?? "", "committed", `PR #${num} opened`, pr.title);
    return this.prView(pr);
  }

  private prMerge(cwd: string): unknown {
    const m = this.wsForCwd(cwd);
    const pr = this.prs.get(m.ws.id);
    if (!pr) throw apiError("gh_error", "no pull requests found for this branch");
    if (this.now() - pr.createdAt < 10_000) throw apiError("gh_error", "Pull request is not mergeable: required checks are pending", { retryable: true });
    pr.state = "MERGED";
    const agent = [...this.sims.values()].find((s) => s.agent.workspaceId === m.ws.id);
    this.activity(agent?.agent.id ?? "", "committed", `PR #${pr.number} merged`, pr.title);
    return {};
  }

  // ---------------------------------------------------------------- terminals

  private term(id: unknown): DemoTerm {
    const t = typeof id === "string" ? this.terms.get(id) : undefined;
    if (!t || t.isClosed) throw apiError("not_found", `terminal ${String(id)} is not open`);
    return t;
  }

  private termOpen(p: Record<string, unknown>): unknown {
    const target = (p.target ?? {}) as Record<string, unknown>;
    let paneId: string;
    let agentId: string | undefined;
    let ws: WsModel | undefined;
    if (target.kind === "agent") {
      const sim = this.sim(target.agentId);
      paneId = sim.agent.paneId;
      agentId = sim.omp ? sim.agent.id : undefined;
      ws = this.wss.get(sim.agent.workspaceId);
    } else if (target.kind === "pane") {
      paneId = this.str(target, "paneId");
      ws = [...this.wss.values()].find((m) => m.ws.tabs.some((t) => t.panes.some((pp) => pp.id === paneId)));
      if (!ws) throw apiError("not_found", `pane ${paneId} not found`);
      const sim = [...this.sims.values()].find((s) => s.agent.paneId === paneId);
      agentId = sim?.omp ? sim.agent.id : undefined;
    } else if (target.kind === "shell") {
      const wsId = typeof target.workspaceId === "string" ? target.workspaceId : undefined;
      ws = wsId ? this.wsModel(wsId) : [...this.wss.values()][0];
      if (!ws) throw apiError("not_found", "no workspace to open a shell in");
      paneId = this.addPane(ws.ws.id, typeof target.split === "string" ? target.split : "right");
      ws.shellPanes.push(paneId);
      for (const tab of ws.ws.tabs) for (const pp of tab.panes) if (pp.id === paneId) pp.title = "zsh";
    } else throw apiError("invalid_params", "target.kind must be pane, agent or shell");
    const mode = p.mode === "observe" ? "observe" : "control";
    if (mode === "control") {
      const holder = [...this.terms.values()].find((t) => t.paneId === paneId && t.mode === "control" && !t.isClosed);
      if (holder) {
        if (!p.takeover) throw apiError("busy", "Another client holds the input lease for this pane", { hint: "Open with takeover, or watch read-only", retryable: true });
        holder.close("terminal attach taken over");
        this.terms.delete(holder.termId);
      }
    }
    // Control sizes the pane; an observer is framed at the pane's grid (the user's herdr TUI by default).
    const asked = { cols: Number(p.cols) || 100, rows: Number(p.rows) || 30 };
    const grid = mode === "control" ? asked : (this.paneGrids.get(paneId) ?? DEMO_PANE_GRID);
    if (mode === "control") {
      this.paneGrids.set(paneId, grid);
      for (const o of this.terms.values()) if (o.paneId === paneId && o.mode === "observe" && !o.isClosed) o.resize(grid.cols, grid.rows);
    }
    const termId = `t${this.nextTerm++}-${this.id}`;
    const wsm = ws as WsModel;
    const sim = agentId ? this.sims.get(agentId) : undefined;
    const term = new DemoTerm(
      termId,
      paneId,
      agentId,
      mode,
      grid.cols,
      grid.rows,
      {
        hostname: this.info.hostname,
        cwd: wsm.path,
        branch: wsm.ws.repo?.branch,
        agents: () => [...this.sims.values()].map((s) => ({ name: s.agent.name, state: s.agent.state, pane: s.agent.paneId })),
        gitStatus: () => {
          const files = this.wsFiles(wsm);
          return files.length ? [`On branch ${wsm.ws.repo?.branch ?? "main"}`, "Changes not staged for commit:", ...files.map((f) => `  \x1b[31m${f.status === "added" ? "new file" : "modified"}:   ${f.path}\x1b[0m`)] : [`On branch ${wsm.ws.repo?.branch ?? "main"}`, "nothing to commit, working tree clean"];
        },
        prompt: sim ? (text) => (sim.busy ? (sim.agent.state === "working" ? sim.steer(text) : undefined) : sim.startTurn(text)) : undefined,
        abort: sim ? () => sim.abort("Interrupted (Esc)") : undefined,
        render: sim ? (rows) => sim.renderTui(rows) : undefined,
        program: agentId ? undefined : demoProgram(wsm, paneId, () => this.dirtyWs.add(wsm.ws.id)),
        after: (ms, cb) => {
          this.env.clock.after(ms, cb);
        },
      },
      (ev) => this.env.emit({ type: "term", hostId: this.id, termId, ev }),
    );
    this.terms.set(termId, term);
    this.env.clock.after(20, () => term.start());
    return { termId, paneId, title: term.title };
  }

  termInput(termId: string, data: string): void {
    this.terms.get(termId)?.input(data);
  }

  // ---------------------------------------------------------------- host.*

  private usageReport(days: number): unknown {
    const now = new Date(this.now());
    const rng = new Rng(hash(`${this.id}usage`));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400_000);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const cost = i === 0 ? this.usageTotals.costUsd : (weekend ? 3 : 14) + rng.range(-3, 12);
      out.push({ day: d.toISOString().slice(0, 10), costUsd: Math.round(cost * 100) / 100, tokens: i === 0 ? this.usageTotals.tokens : Math.round(cost * 120_000 + rng.range(0, 200_000)) });
    }
    const total = out.reduce((n, d) => n + d.costUsd, 0);
    const share = [0.46, 0.27, 0.19, 0.05, 0.03];
    return {
      today: { ...this.usageTotals, costUsd: Math.round(this.usageTotals.costUsd * 100) / 100 },
      days: out,
      models: MODELS.map((m, i) => ({ model: `${m.provider}/${m.id}`, costUsd: Math.round(total * (share[i] ?? 0.01) * 100) / 100, tokens: Math.round(total * (share[i] ?? 0.01) * 110_000) })),
    };
  }

  private pastSessions(cwd: string | undefined, limit: number): PastSession[] {
    const now = this.now();
    const live: PastSession[] = [...this.sims.values()]
      .filter((s) => s.agent.omp)
      .map((s) => ({ file: s.agent.omp?.sessionFile ?? "", id: s.agent.omp?.sessionId ?? s.agent.id, title: s.agent.title, cwd: s.agent.cwd, updatedAt: s.agent.live.lastEventAt ?? now, messages: s.items.length, live: true, agentId: s.agent.id }));
    const titles = ["Spike: collab relay in Rust", "Investigate herdr pane resize flicker", "Draft pricing page copy", "Port settings to Radix", "Profile cold start on Android", "Fix WSL path translation", "Write release notes 0.9", "Evaluate xterm WebGL fallback", "Audit notification permissions", "Clean up dead feature flags", "Benchmark russh vs ssh2", "Explore offline snapshot cache"];
    const rng = new Rng(hash(`${this.id}sessions`));
    const old: PastSession[] = titles.map((title, i) => {
      const repo = REPOS[i % REPOS.length] as RepoDef;
      return { file: `${HOME}/.omp/agent/sessions/${repo.name}-${i}.jsonl`, id: `01JOLD${i}${rng.hex(6).toUpperCase()}`, title, cwd: repo.root, updatedAt: now - (i + 1) * rng.int(3, 20) * 3600_000, messages: rng.int(8, 240), live: false };
    });
    return [...live, ...old].filter((s) => !cwd || s.cwd?.startsWith(this.resolve(cwd))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  private resume(p: Record<string, unknown>): unknown {
    const file = this.str(p, "sessionFile");
    const session = this.pastSessions(undefined, 100).find((s) => s.file === file);
    if (!session) throw apiError("not_found", `session file ${file} not found`);
    if (session.live) throw apiError("busy", "That session is open in a running omp", { hint: `Open agent ${session.agentId ?? ""} instead` });
    const res = this.startAgent({ target: p.target, spec: { kind: "omp" } }) as { agentId: string; paneId: string; workspaceId: string };
    const sim = this.sims.get(res.agentId);
    if (sim) {
      sim.agent.title = session.title ?? sim.agent.title;
      const t = this.now();
      sim.seed([{ t: "user", text: session.title ?? "Resume" }, { t: "say", text: "Earlier work restored from the session file." }, { t: "mode", text: `Resumed ${file.split("/").pop()}` }], t - 60_000, t);
      this.agentChanged(sim.agent.id);
    }
    return res;
  }

  /**
   * Like tf-hostd, every fix runs on its own: config fixes apply at once, installs one after
   * another (~3.5 s each) after the reply, which lists them in `applying`; `HostInfo.setup` follows
   * each outcome (a failed install stays open with `failed`).
   */
  private setupApply(fixes: string[]): SetupStatus {
    const known = new Set(this.setup.issues.map((i) => i.id));
    for (const f of fixes) if (!known.has(f)) throw apiError("invalid_params", `Unknown fix ${f}`);
    const installs = fixes.filter((f) => SETUP_INSTALLS[f]);
    const issues: SetupIssue[] = this.setup.issues.filter((i) => installs.includes(i.id) || !fixes.includes(i.id));
    this.setup = {
      herdrIntegration: this.setup.herdrIntegration || fixes.includes("install-herdr-integration"),
      globalSharing: this.setup.globalSharing || fixes.includes("enable-global-sharing"),
      globalBridge: this.setup.globalBridge || fixes.includes("install-global-bridge"),
      relay: true,
      issues,
      applying: [...(this.setup.applying ?? []), ...installs],
      failed: (this.setup.failed ?? []).filter((f) => !fixes.includes(f.id)),
    };
    installs.forEach((id, i) => this.env.clock.after((i + 1) * SETUP_INSTALL_MS, () => this.finishInstall(id)));
    this.publishSetup();
    return this.setup;
  }

  private finishInstall(id: string): void {
    const applying = (this.setup.applying ?? []).filter((f) => f !== id);
    const offline = id === "install-gh" && !this.ghInstallTried;
    if (id === "install-gh") this.ghInstallTried = true;
    const error = { code: "install_failed", message: "couldn't download https://api.github.com/repos/cli/cli/releases/latest: curl: (6) Could not resolve host: api.github.com", retryable: false };
    this.setup = offline
      ? { ...this.setup, applying, failed: [...(this.setup.failed ?? []), { id, error }] }
      : { ...this.setup, applying, issues: this.setup.issues.filter((i) => i.id !== id) };
    this.publishSetup();
  }

  private publishSetup(): void {
    this.info = { ...this.info, setup: this.setup };
    if (!this.online) return;
    this.rev += 1;
    this.env.emit({ type: "hostPatch", hostId: this.id, rev: this.rev, ops: [{ op: "info", info: this.info }] });
  }

  private activityPage(p: Record<string, unknown>): unknown {
    const before = typeof p.before === "number" ? p.before : Number.POSITIVE_INFINITY;
    const limit = typeof p.limit === "number" ? p.limit : 50;
    const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
    const all = this.activityLog.filter((e) => e.at < before && (!agentId || e.agentId === agentId));
    return { events: all.slice(0, limit), hasMore: all.length > limit };
  }

  /** For tests: whether the host ever reached online. */
  get wasOnline(): boolean {
    return this.everOnline;
  }

  /** For tests / director: the agent simulations. */
  agentSims(): AgentSim[] {
    return [...this.sims.values()];
  }

  /** True when the phase means "show stale". */
  get offlineLike(): boolean {
    return OFFLINE.includes(this.status.phase);
  }
}
