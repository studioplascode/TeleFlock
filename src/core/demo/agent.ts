import type {
  AgentChatInfo,
  Agent,
  Answer,
  AskStep,
  Capabilities,
  ChangedFile,
  HistoryPage,
  NeedsOption,
  NeedsYou,
  NotifyAction,
  NotifyKind,
  PulseKind,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  Subagent,
  ThinkingLevel,
  TodoPhase,
  ToolItem,
  ToolStatus,
  TranscriptItem,
  TreeInfo,
  TpsSplit,
  UiRequest,
  ActivityKind,
  OmpMode,
  GoalInfo,
  ModelRef,
} from "@/core/gen";
import { apiError } from "../errors";
import { chatTurn } from "./chats";
import { fileDiff } from "./codegen";
import { MODELS, type AgentDef } from "./data";
import { boardReportSteps, PRESENT_KIND_WORD } from "./presented";
import type { Rng } from "./rng";
import { replyTurn, type Step, subagentRow, type TaskSub, taskSubs, think, type ToolSpec, type UiSpec } from "./scripts";

/** What an agent simulation needs from its host. */
export interface SimHost {
  now(): number;
  rng: Rng;
  /** Session event for subscribers of this agent (dropped when nobody listens). */
  session(agentId: string, ev: SessionEvent): void;
  agentChanged(agentId: string): void;
  metaChanged(agentId: string): void;
  pulse(agentId: string, kind: PulseKind, n: number): void;
  notify(agentId: string, kind: NotifyKind, title: string, body: string, ui?: UiRequest, actions?: NotifyAction[]): void;
  activity(agentId: string, kind: ActivityKind, title: string, detail?: string): void;
  usage(tokensIn: number, tokensOut: number, usd: number): void;
  /** Mirror text into terminals attached to this agent (omp-like TUI). */
  termWrite(agentId: string, text: string): void;
  repoFiles(agentId: string): { repo: string; files: string[] };
}

type Active =
  | { k: "think"; itemId: string; start: number; ms: number; text: string; shown: number }
  | { k: "say"; itemId: string; text: string; shown: number; rate: number }
  | { k: "tool"; itemId: string; start: number; spec: ToolSpec; outShown: number; output: string; subs: TaskSub[]; irc: Map<string, string> }
  | { k: "retry"; until: number }
  | { k: "wait"; until: number };

interface PendingUi {
  request: UiRequest;
  spec: UiSpec;
  then: Extract<Step, { t: "ui" }>["then"];
  toolItemId?: string;
  /** What the agent wrote before asking (asks), the same for every question of the ask. */
  context?: string;
  /** A multi-question ask (`spec.questions`): the open question and the answers given before it. */
  ask?: { index: number; answers: Answer[] };
}

const CHARS_PER_SEC = 160; // ≈ 40 tok/s
/** A queued steer waits at least this long for a step boundary (omp delivers between steps). */
const STEER_LAND_MS = 2500;
/** The advisor reviews each finished reply/tool with a reviewer model (omp `modelRoles.advisor`). */
const ADVISOR_MODEL = MODELS.find((m) => m.id === "gpt-5.5");
type Spender = keyof TpsSplit;
const TODO_STATUS_LABEL: Record<string, string> = { completed: "✓", inProgress: "●", pending: "○", blocked: "◆", abandoned: "✗" };

export class AgentSim {
  readonly agent: Agent;
  readonly omp: boolean;
  items: TranscriptItem[] = [];
  private readonly byId = new Map<string, TranscriptItem>();
  private seq = 0;
  private queue: Step[] = [];
  private cur: Active | null = null;
  pending: PendingUi | null = null;
  private tokenLog: { at: number; n: number; src: Spender }[] = [];
  private ctxTokens: number;
  private window: number;
  files: ChangedFile[];
  todos: TodoPhase[];
  subagents: Subagent[] = [];
  queueSteer: string[] = [];
  /** Who sent each `queueSteer` entry (other devices' steers carry their name). */
  private steerAuthors: (string | undefined)[] = [];
  /** When the oldest queued steer was sent. */
  private steerSince = 0;
  queueFollow: string[] = [];
  model?: ModelRef;
  thinking?: ThinkingLevel;
  fast = false;
  mode: OmpMode = "normal";
  goal?: GoalInfo;
  caps: Capabilities;
  /** USD billed by the main agent's own calls and by its advisor; subagents bill through their rows. */
  mainUsd: number;
  advisorUsd: number;
  /** The advisor is reviewing (streaming its notes) until then, at `advisorRate` tok/s. */
  private advisorUntil = 0;
  private advisorRate = 0;
  tokensIn = 0;
  tokensOut = 0;
  private lastPulseTool = 0;
  /** Simulates a quiet stretch (no events) while still working. */
  private silentSince: number | null = null;
  /** Main-agent output this turn, and the last finished turn's average (`SessionMeta.tps`). */
  private turnOut = 0;
  private lastTurnTps: number | undefined;
  /** `SessionMeta.agentChat`: the host's agent chat log of this session (set by the host; absent on a host before 0.9.0). */
  chatInfo?: () => AgentChatInfo | undefined;

  constructor(
    private readonly host: SimHost,
    def: AgentDef,
    paneId: string,
    tabId: string,
    workspace: { id: string; cwd: string; repo?: string; branch?: string },
  ) {
    const now = host.now();
    this.omp = def.kind === "omp";
    const m = def.model ? MODELS.find((x) => x.label === def.model) : undefined;
    this.model = m ? { provider: m.provider, id: m.id, label: m.label } : undefined;
    this.thinking = def.thinking;
    this.window = m?.contextWindow ?? 200_000;
    this.ctxTokens = Math.round(((def.ctxPct ?? 10) / 100) * this.window);
    // Seeded history: a slice of the def's spend went to the advisor (omp agents only).
    this.advisorUsd = this.omp ? (def.cost ?? 0) * 0.07 : 0;
    this.mainUsd = (def.cost ?? 0) - this.advisorUsd;
    // Changed files accumulate from the seeded history's edit calls (see seeds.ts), not from the def.
    this.files = [];
    this.todos = structuredClone(def.todos ?? []);
    const state = def.fresh ? "idle" : def.column === "running" ? "working" : def.column === "needs" ? "blocked" : def.column === "review" ? "done" : "idle";
    this.caps = capsFor(this.omp && def.link !== "notShared", def.id === "deps");
    this.agent = {
      id: def.id,
      name: def.id,
      kind: def.kind,
      paneId,
      tabId,
      workspaceId: workspace.id,
      state,
      stateSince: now - def.since * 1000,
      column: def.column,
      archived: def.column === "done",
      turns: def.fresh ? 0 : Math.max(1, Math.round(def.age / 600)),
      title: def.title,
      cwd: workspace.cwd,
      repo: workspace.repo,
      branch: workspace.branch,
      startedAt: now - def.age * 1000,
      live: { lastEventAt: now - (def.column === "running" ? 0 : def.since * 1000), streaming: false, thinking: false, line: def.line },
    };
    if (this.omp) {
      this.agent.omp = {
        sessionId: `01J${def.id.toUpperCase().padEnd(8, "X")}${(def.age % 9973).toString(36).toUpperCase()}`,
        sessionFile: `/home/demo/.omp/agent/sessions/${def.id}.jsonl`,
        pid: 40_000 + (def.age % 9000),
        version: "18.12.3",
        link: def.link ?? "live",
        linkReason: def.link === "notShared" ? "noRoom" : undefined,
        linkVia: def.link === "notShared" ? undefined : def.id === "deps" ? "collab" : "bridge",
        linkError: def.link === "notShared" ? "omp runs without the TeleFlock bridge and isn't sharing a room on TeleFlock's relay (started by hand before the bridge was installed)." : undefined,
        bridge: def.link !== "notShared" && def.id !== "deps",
        fast: false,
        mode: "normal",
        queue: { steering: [], followUp: [] },
      };
      if (def.recap) this.agent.omp.recap = { text: def.recap, at: now - Math.max(0, def.since - 240) * 1000 };
    }
    this.refreshDerived();
  }

  // ---------------------------------------------------------------- derived state

  private get state() {
    return this.agent.state;
  }

  refreshDerived(): void {
    const a = this.agent;
    const branch = this.branchFiles();
    const added = branch.reduce((n, f) => n + f.added, 0);
    const removed = branch.reduce((n, f) => n + f.removed, 0);
    a.diff = branch.length ? { added, removed, files: branch.length } : undefined;
    if (!a.omp) return;
    const tasks = this.todos.flatMap((p) => p.tasks);
    const live = this.subagents.filter((s) => s.status === "running").length;
    a.omp = {
      ...a.omp,
      model: this.model,
      thinking: this.thinking,
      fast: this.fast,
      mode: this.mode,
      goal: this.goal,
      context: { tokens: this.ctxTokens, window: this.window, pct: Math.min(100, Math.round((this.ctxTokens / this.window) * 100)) },
      cost: this.costInfo(),
      todos: tasks.length
        ? { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length, current: tasks.find((t) => t.status === "inProgress")?.content }
        : undefined,
      subagents: this.subagents.length ? { live, total: this.subagents.length, completionPct: meanCompletion(this.subagents) } : undefined,
      queue: { steering: [...this.queueSteer], followUp: [...this.queueFollow] },
    };
  }

  /** omp's subagent spend: every subagent row's own bill. */
  private subagentUsd(): number {
    return this.subagents.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  }

  private costInfo(): NonNullable<NonNullable<Agent["omp"]>["cost"]> {
    const subagents = this.subagentUsd();
    return {
      usd: round3(this.mainUsd + subagents + this.advisorUsd),
      input: this.tokensIn + 380_000,
      output: this.tokensOut + 36_000,
      cacheRead: 1_240_000,
      cacheWrite: 88_000,
      split: { main: round3(this.mainUsd), subagents: round3(subagents), advisor: round3(this.advisorUsd) },
    };
  }

  /**
   * The session's meta as an event carries it: copies of the lists this sim goes on changing in place (todos' statuses,
   * subagent rows, changed files), as the wire's JSON would be. The app keeps what an event carried and the React
   * Compiler memoizes on those lists' identity, so a shared list left the inspector's cards as they were first sent.
   */
  meta(): SessionMeta {
    const a = this.agent;
    return {
      sessionId: a.omp?.sessionId,
      sessionFile: a.omp?.sessionFile,
      title: a.title,
      cwd: a.cwd,
      model: this.model,
      thinking: this.thinking,
      fast: this.fast,
      mode: this.mode,
      goal: this.goal,
      context: a.omp?.context,
      cost: a.omp?.cost,
      tps: this.lastTurnTps,
      todos: structuredClone(this.todos),
      subagents: [...this.subagents],
      // Hosts before 0.9.0 also listed omp's own `local://` writes here; the inspector drops them.
      files: this.agent.id === "kanban" ? [...this.branchFiles(), { path: "local://PLAN.md", added: 38, removed: 0, status: "added" }, { path: "local://reports/scan.md", added: 64, removed: 0, status: "added" }] : [...this.branchFiles()],
      queue: { steering: [...this.queueSteer], followUp: [...this.queueFollow] },
      tree: this.tree(),
      caps: this.caps,
      startedAt: a.startedAt,
      agentChat: this.chatInfo?.(),
    };
  }

  private tree(): TreeInfo {
    const nodes: TreeInfo["nodes"] = [];
    let parent: string | undefined;
    for (const it of this.items) {
      if (it.kind !== "user" && !(it.kind === "assistant" && !it.streaming)) continue;
      nodes.push({ id: it.id, parentId: parent, kind: it.kind, label: it.text.slice(0, 64), at: it.at, onPath: true, children: 1 });
      parent = it.id;
    }
    const last = nodes[nodes.length - 1];
    if (last) last.children = 0;
    if (this.agent.id === "push" && nodes.length > 2) {
      const forkFrom = nodes[1] as TreeInfo["nodes"][number];
      forkFrom.children = 2;
      nodes.push({ id: "push-fork-1", parentId: forkFrom.id, kind: "user", label: "try-unifiedpush: what would UnifiedPush need?", at: forkFrom.at + 60_000, onPath: false, children: 1 });
      nodes.push({ id: "push-fork-2", parentId: "push-fork-1", kind: "assistant", label: "A distributor app per device plus…", at: forkFrom.at + 90_000, onPath: false, children: 0 });
    }
    return { nodes, leafId: last?.id };
  }

  snapshot(limit: number): SessionSnapshot {
    const start = Math.max(0, this.items.length - limit);
    return {
      agentId: this.agent.id,
      meta: this.meta(),
      items: this.items.slice(start),
      hasMore: start > 0,
      cursor: start > 0 ? String(start) : undefined,
      // a prompt only the terminal answers has no dialog in the app
      ui: this.pending?.spec.terminal ? undefined : this.pending?.request,
    };
  }

  history(cursor: string, limit: number): HistoryPage {
    const end = Math.max(0, Math.min(this.items.length, Number(cursor) || 0));
    const start = Math.max(0, end - limit);
    return { items: this.items.slice(start, end), hasMore: start > 0, cursor: start > 0 ? String(start) : undefined };
  }

  // ---------------------------------------------------------------- transcript primitives

  private id(): string {
    return `${this.agent.id}-${(++this.seq).toString(36)}`;
  }

  private put(item: TranscriptItem, emit = true): void {
    const isNew = !this.byId.has(item.id);
    this.byId.set(item.id, item);
    if (isNew) this.items.push(item);
    else this.items[this.items.findIndex((x) => x.id === item.id)] = item;
    if (emit) {
      this.host.session(this.agent.id, { k: "upsert", item });
      this.touch("event", 1);
    }
  }

  private append(id: string, field: "text" | "output", text: string): void {
    const item = this.byId.get(id);
    if (!item) return;
    let next: TranscriptItem;
    if (field === "text" && (item.kind === "assistant" || item.kind === "thinking")) next = { ...item, text: item.text + text };
    else if (field === "output" && item.kind === "tool") next = { ...item, output: (item.output ?? "") + text };
    else return;
    this.byId.set(id, next);
    this.items[this.items.findIndex((x) => x.id === id)] = next;
    this.host.session(this.agent.id, { k: "append", id, field, text });
  }

  private touch(kind: PulseKind, n: number): void {
    const now = this.host.now();
    this.agent.live = { ...this.agent.live, lastEventAt: now };
    this.host.pulse(this.agent.id, kind, n);
    this.host.agentChanged(this.agent.id);
  }

  private tokens(n: number, src: Spender = "main"): void {
    const now = this.host.now();
    this.tokenLog.push({ at: now, n, src });
    this.tokensOut += n;
    if (src === "main") this.ctxTokens = Math.min(this.window * 0.97, this.ctxTokens + n);
    const m = src === "advisor" ? ADVISOR_MODEL : MODELS.find((x) => x.id === this.model?.id);
    const usd = (n * (m?.outPerM ?? 10)) / 1e6;
    if (src === "advisor") this.advisorUsd += usd;
    else if (src === "main") {
      this.mainUsd += usd;
      this.turnOut += n;
    }
    // Subagent output is billed by their rows (`subagentRow` cost), counted in `tick`.
    if (src !== "subagents") this.host.usage(0, n, usd);
  }

  private inputTokens(n: number): void {
    this.tokensIn += n;
    this.ctxTokens = Math.min(this.window * 0.97, this.ctxTokens + Math.round(n * 0.15));
    const m = MODELS.find((x) => x.id === this.model?.id);
    const usd = (n * (m?.inPerM ?? 3) * 0.25) / 1e6; // mostly cache reads
    this.mainUsd += usd;
    this.host.usage(n, 0, usd);
  }

  /** The advisor starts reviewing the latest step: it reads the context and streams a short note. */
  private advise(now: number): void {
    const rng = this.host.rng;
    const read = 6000 + rng.int(0, 6000);
    const usd = (read * (ADVISOR_MODEL?.inPerM ?? 3) * 0.25) / 1e6;
    this.advisorUsd += usd;
    this.tokensIn += read;
    this.host.usage(read, 0, usd);
    this.advisorUntil = now + rng.range(1500, 3200);
    this.advisorRate = rng.range(45, 75);
  }

  /** Rolling output tok/s over the last 3 s, per spender (same window as tf-hostd's main rate). */
  private tps(now: number): { tps?: number; split?: TpsSplit } {
    this.tokenLog = this.tokenLog.filter((x) => now - x.at <= 3000);
    const split: TpsSplit = { main: 0, subagents: 0, advisor: 0 };
    for (const x of this.tokenLog) split[x.src] += x.n / 3;
    const total = split.main + split.subagents + split.advisor;
    if (total <= 0) return {};
    const r = (v: number) => Math.round(v * 10) / 10;
    return { tps: r(total), split: { main: r(split.main), subagents: r(split.subagents), advisor: r(split.advisor) } };
  }

  // ---------------------------------------------------------------- seeding (instant)

  /** Runs steps instantly to build history, spreading timestamps across [from, to]. */
  seed(steps: Step[], from: number, to: number): void {
    const flat = steps.length;
    let i = 0;
    for (const step of steps) {
      const at = Math.round(from + ((to - from) * i++) / Math.max(1, flat));
      if (step.t === "ui") {
        this.openUi(step.ui, step.then, at, false);
        return;
      }
      this.instant(step, at);
    }
  }

  private instant(step: Exclude<Step, { t: "ui" }>, at: number): void {
    switch (step.t) {
      case "user":
        this.put({ kind: "user", id: this.id(), at, text: step.text, images: [], author: step.author, steering: step.steering ?? false, synthetic: step.synthetic ?? false }, false);
        break;
      case "think":
        this.put({ kind: "thinking", id: this.id(), at, text: step.text, streaming: false, durationMs: step.ms, redacted: false }, false);
        break;
      case "say":
        this.put({ kind: "assistant", id: this.id(), at, text: step.text, streaming: false, model: this.model?.label, usage: usageFor(step.text.length) }, false);
        break;
      case "tool": {
        const spec = step.spec;
        const output = spec.output?.join("\n");
        if (spec.subagents) {
          // The call's own subagents end with it; theirs start `after` into their parent's run.
          for (const t of taskSubs(spec.subagents, () => `${this.agent.id}-sub-${(++this.seq).toString(36)}`)) {
            let root = t;
            while (root.parent) root = root.parent;
            this.subagents.push(subagentRow(t, at - root.spec.ms + t.at, at));
          }
        }
        this.put(this.finishedTool(this.id(), at, spec, output ?? "", spec.error ? "error" : "ok", at), false);
        this.emitIrc(spec, at - spec.ms, Number.POSITIVE_INFINITY, new Map(), false);
        for (const f of spec.files ?? []) this.addFile(f);
        break;
      }
      case "todo":
        this.setTodo(step.task, step.status);
        break;
      case "notice":
        this.put({ kind: "notice", id: this.id(), at, level: step.level, text: step.text, source: step.source ?? "omp" }, false);
        break;
      case "fail":
        this.put(this.failRow(step, at), false);
        break;
      case "mode":
        this.put({ kind: "mode", id: this.id(), at, text: step.text }, false);
        break;
      case "retry":
      case "wait":
        break;
    }
  }

  /** Adds a compaction row to history. */
  seedCompaction(at: number, before: number): void {
    this.put({ kind: "compaction", id: this.id(), at, summary: "Compacted earlier exploration: profiling notes, hot-path list, benchmark setup.", tokensBefore: before }, false);
  }

  // ---------------------------------------------------------------- live run

  /** Runs `step` right after the current one (director-injected questions). */
  injectNext(step: Step): void {
    this.queue.unshift(step);
  }

  get busy(): boolean {
    return this.state === "working" || this.state === "blocked";
  }

  /** Whether the director may inject a question into the current turn. */
  get acceptsInjection(): boolean {
    return !this.noInject && !this.pending && !this.queue.some((s) => s.t === "ui");
  }

  private noInject = false;

  /** Starts a new turn: user row + scripted work. */
  startTurn(text: string, opts: { author?: string; steps?: Step[] } = {}): void {
    const now = this.host.now();
    this.put({ kind: "user", id: this.id(), at: now, text, images: [], author: opts.author, steering: false, synthetic: false });
    this.termLine(`\r\n\x1b[1;35m❯\x1b[0m ${text}\r\n`);
    if (this.agent.archived) {
      this.agent.archived = false;
      this.host.activity(this.agent.id, "unarchived", `${this.agent.name} started working again`);
    }
    this.host.activity(this.agent.id, "prompted", `${this.agent.name} prompted${opts.author ? ` from ${opts.author}` : ""}`, text);
    // Single-answer turns (commit messages) must not get director-injected dialogs or retitle the task; a chat gets no injected dialogs either.
    const single = /commit message/i.test(text);
    this.noInject = single || this.agent.chat === true;
    if (!single && (this.agent.title === "" || this.agent.title === this.agent.name)) this.agent.title = text.slice(0, 80);
    const { repo, files } = this.host.repoFiles(this.agent.id);
    this.queue =
      opts.steps ??
      (this.agent.chat
        ? chatTurn(text, this.host.rng)
        : /\breport\b/i.test(text) && this.mode !== "plan"
          ? [think("Writing the latest results up as a report you can open.", 2400), ...boardReportSteps(this.nextReportVersion())]
          : replyTurn(text, { repo, files, rng: this.host.rng, plan: this.mode === "plan", title: this.agent.title, branch: this.agent.branch, changed: this.files }));
    this.cur = null;
    this.setState("working");
    // A new turn makes the idle recap out of date (the host stops sending it).
    if (this.agent.omp) this.agent.omp = { ...this.agent.omp, turnStartedAt: now, recap: undefined };
    this.turnOut = 0;
    this.inputTokens(4000 + this.host.rng.int(0, 9000));
    this.host.metaChanged(this.agent.id);
  }

  /** Resume the scripted work of an agent seeded mid-turn; the first step starts `backdateMs` in the past. */
  resume(steps: Step[], backdateMs = 0): void {
    this.queue = steps;
    this.cur = null;
    this.backdate = backdateMs;
  }

  private backdate = 0;

  /** omp's retry (F5, `agent.retry`): the failed or stopped last turn runs again, without a new user row. */
  retryTurn(steps: Step[]): void {
    const now = this.host.now();
    this.termLine("\r\n\x1b[2m↻ retrying the last turn\x1b[0m\r\n");
    this.host.activity(this.agent.id, "prompted", `${this.agent.name} retried its last turn`);
    this.queue = steps;
    this.cur = null;
    this.setState("working");
    if (this.agent.omp) this.agent.omp = { ...this.agent.omp, turnStartedAt: now };
    this.turnOut = 0;
    this.inputTokens(4000 + this.host.rng.int(0, 9000));
    this.host.metaChanged(this.agent.id);
  }

  /** Queued like omp's steering queue: listed in `queue.steering` until the next step boundary. */
  steer(text: string, author?: string): void {
    if (!this.queueSteer.length) this.steerSince = this.host.now();
    this.queueSteer.push(text);
    this.steerAuthors.push(author);
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
    this.host.metaChanged(this.agent.id);
  }

  /** The queued steers reach the model: they land as user rows and the agent folds them in. */
  private landSteers(now: number): void {
    const steers = this.queueSteer.map((text, i) => ({ text, author: this.steerAuthors[i] }));
    this.queueSteer = [];
    this.steerAuthors = [];
    for (const s of steers) this.put({ kind: "user", id: this.id(), at: now, text: s.text, images: [], author: s.author, steering: true, synthetic: false });
    const text = steers.map((s) => s.text).join(" / ");
    this.queue.unshift(
      { t: "think", ms: 1800, text: `The user wants me to adjust course: "${text}". Folding that in before continuing.` },
      { t: "say", text: `Got it: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}. Adjusting.` },
    );
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
    this.host.metaChanged(this.agent.id);
  }

  followUp(text: string): void {
    this.queueFollow.push(text);
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
    this.host.metaChanged(this.agent.id);
  }

  /** Alt+Up in omp: pull the last queued message back out (last steer first, then last follow-up). */
  dequeue(): string | undefined {
    const text = this.queueSteer.length ? this.queueSteer.pop() : this.queueFollow.pop();
    if (this.steerAuthors.length > this.queueSteer.length) this.steerAuthors.pop();
    if (text === undefined) return undefined;
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
    this.host.metaChanged(this.agent.id);
    return text;
  }

  setState(state: Agent["state"]): void {
    const a = this.agent;
    const now = this.host.now();
    const prevColumn = a.column;
    a.state = state;
    a.stateSince = now;
    a.column = state === "blocked" ? "needs" : state === "working" ? "running" : a.archived ? "done" : "review";
    if (state !== "blocked") a.needs = undefined;
    if (state !== "working") {
      a.live = { ...a.live, streaming: false, thinking: false, tool: undefined, tps: undefined, tpsSplit: undefined };
    }
    if (prevColumn !== a.column) this.host.pulse(a.id, "state", 1);
    this.refreshDerived();
    this.host.agentChanged(a.id);
  }

  private openUi(spec: UiSpec, then: PendingUi["then"], at: number, live: boolean): void {
    let toolItemId: string | undefined;
    if (spec.tool) {
      toolItemId = this.id();
      const t = spec.tool;
      const questions = spec.questions?.map((q) => ({ question: q.message, options: q.options.map((o) => o.label) })) ?? [{ question: spec.message ?? spec.title, options: spec.options.map((o) => o.label) }];
      const item: ToolItem & { kind: "tool" } = {
        kind: "tool",
        id: toolItemId,
        at,
        callId: `call_${toolItemId}`,
        tool: t.tool,
        title: t.title,
        intent: t.intent,
        args: t.args,
        // a gated call waits to start; a call omp asks about in its terminal runs meanwhile
        status: spec.needs === "approval" && !spec.terminal ? "pending" : "running",
        truncated: false,
        view: t.tool === "ask" ? { type: "ask", questions } : undefined,
      };
      this.put(item, live);
    }
    // As tf-hostd fills an ask's `context`: the agent's latest text this turn (its own message here).
    const asks = spec.needs === "ask" || (!spec.needs && (spec.kind === "select" || spec.kind === "multiSelect"));
    const context = spec.context ?? (asks ? this.latestText() : undefined);
    this.raise({ spec, then, toolItemId, context, ask: spec.questions ? { index: 0, answers: [] } : undefined }, at, live, true);
  }

  /** The agent's latest assistant text since the last prompt; never thinking. */
  private latestText(): string {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it?.kind === "user" && !it.synthetic) break;
      if (it?.kind === "assistant" && it.text.trim()) return it.text.trim();
    }
    return "";
  }

  /**
   * Opens `p`'s dialog as a new request: a multi-question ask's current question, with its place, Back
   * and the answer it already has (`step`). `first`: the ask itself (notified, logged, Needs-you since
   * now); its later questions keep that `since`, so the agent keeps its place in the oldest-first Inbox.
   */
  private raise(p: Omit<PendingUi, "request">, at: number, live: boolean, first: boolean): void {
    const { spec, ask } = p;
    const q = ask ? spec.questions?.[ask.index] : undefined;
    const kind = q?.kind ?? spec.kind;
    const message = q ? q.message : spec.message;
    const options = q?.options ?? spec.options;
    const allowOther = (q ? q.allowOther : spec.allowOther) ?? false;
    const had = ask?.answers[ask.index];
    const step: AskStep | undefined =
      ask && spec.questions
        ? { index: ask.index, total: spec.questions.length, canBack: ask.index > 0, ...(had?.choices.length ? { choices: had.choices } : {}), ...(had?.text ? { text: had.text } : {}) }
        : undefined;
    const reqId = `ui-${this.agent.id}-${(++this.seq).toString(36)}`;
    const request: UiRequest = {
      id: reqId,
      kind,
      title: spec.title,
      message,
      options,
      allowOther,
      allowChat: spec.allowChat ?? false,
      initial: spec.initial,
      plan: spec.plan,
      callId: p.toolItemId ? `call_${p.toolItemId}` : undefined,
      context: p.context,
      step,
    };
    this.pending = { ...p, request };
    // A prompt only the terminal answers: Needs you `blocked`, nothing to answer in the app (tf-hostd's
    // wait it infers for omp's own dialog on an older bridge), the call running while omp asks.
    const terminal = spec.terminal !== undefined;
    if (terminal) this.terminalPick = spec.terminal?.initial ?? 0;
    const needs: NeedsYou = terminal
      ? {
          kind: "blocked",
          since: first ? at : (this.agent.needs?.since ?? at),
          title: "Waiting in the terminal",
          question: message ?? spec.title,
          detail: spec.detail,
          options: [],
          multi: false,
          allowOther: false,
          allowChat: false,
          answerable: false,
          context: "",
        }
      : {
          kind: spec.needs ?? (kind === "planReview" ? "planReview" : kind === "confirm" ? "confirm" : kind === "editor" || kind === "input" ? "input" : "ask"),
          requestId: reqId,
          since: first ? at : (this.agent.needs?.since ?? at),
          title: spec.title,
          question: message ?? spec.title,
          detail: spec.detail ?? spec.plan?.content.split("\n")[0],
          options,
          multi: kind === "multiSelect",
          allowOther,
          allowChat: spec.allowChat ?? false,
          command: spec.command,
          answerable: true,
          context: p.context,
          step,
        };
    const a = this.agent;
    a.state = "blocked";
    if (first) a.stateSince = at;
    a.column = "needs";
    a.needs = needs;
    const tool = terminal && spec.tool ? { name: spec.tool.tool, label: `${spec.tool.tool} ${spec.tool.title}`, startedAt: at } : undefined;
    a.live = { ...a.live, streaming: false, thinking: false, tool, tps: undefined, tpsSplit: undefined, line: message?.split("\n")[0] ?? spec.title };
    if (!live) return;
    if (!terminal) this.host.session(a.id, { k: "ui", request });
    if (first) this.host.pulse(a.id, "state", 1);
    this.host.agentChanged(a.id);
    this.host.metaChanged(a.id);
    if (first) {
      this.host.notify(a.id, "needs", `${a.name} needs you`, needs.question, terminal ? undefined : request);
      if (!terminal) this.host.activity(a.id, "asked", `${a.name} asked: ${needs.title}`, needs.question);
    }
    this.termLine(terminal ? `\r\n${this.terminalDialog()}\r\n` : `\r\n\x1b[38;5;208m◆ ${needs.title}${step ? ` ${step.index + 1}/${step.total}` : ""}\x1b[0m ${needs.question.split("\n")[0]}\r\n`);
  }

  /**
   * Resolves the pending dialog. Returns false if `requestId` doesn't match. `logged: false`: the caller records the activity (decide for me).
   * A multi-question ask moves to its next question (or back to the previous one: `answer.back`, only where `step.canBack`, else
   * `invalid_params` as tf-hostd answers) as a new request; its tool row completes with every answer after the last one.
   */
  answer(requestId: string, answer: Answer, author?: string, logged = true): boolean {
    const p = this.pending;
    if (!p || p.request.id !== requestId) return false;
    const now = this.host.now();
    const questions = p.spec.questions;
    if (answer.back) {
      if (!p.ask || !p.request.step?.canBack) throw apiError("invalid_params", "This question has no previous question to go back to");
      this.host.session(this.agent.id, { k: "ui", request: null });
      this.raise({ ...p, ask: { index: p.ask.index - 1, answers: p.ask.answers } }, now, true, false);
      return true;
    }
    if (p.ask && questions && !answer.cancel && !answer.chat && p.ask.index < questions.length - 1) {
      const answers = [...p.ask.answers];
      answers[p.ask.index] = answer;
      this.host.session(this.agent.id, { k: "ui", request: null });
      if (logged) this.host.activity(this.agent.id, "answered", `${author ?? "You"} answered ${this.agent.name}`, answerText(p.request.options, answer));
      this.raise({ ...p, ask: { index: p.ask.index + 1, answers } }, now, true, false);
      return true;
    }
    this.pending = null;
    const all = p.ask ? [...p.ask.answers.slice(0, p.ask.index), answer] : [answer];
    const approval = p.spec.needs === "approval";
    const allowed = approval && !answer.cancel && answer.choices.some((c) => c.startsWith("Allow") || c.startsWith("Always"));
    if (p.toolItemId) {
      const item = this.byId.get(p.toolItemId);
      if (item?.kind === "tool") {
        if (approval) {
          if (allowed) {
            this.items = this.items.filter((x) => x.id !== item.id);
            this.byId.delete(item.id);
            this.host.session(this.agent.id, { k: "remove", id: item.id });
          } else {
            this.put({ ...item, status: "denied", durationMs: now - item.at });
          }
        } else {
          // One entry per question; questions a cancel or chat never reached stay unanswered.
          const asked = questions ?? [{ message: p.request.message ?? p.request.title, options: p.request.options }];
          this.put({
            ...item,
            status: answer.cancel ? "aborted" : "ok",
            durationMs: now - item.at,
            view: { type: "ask", questions: asked.map((q, i) => ({ question: q.message, options: q.options.map((o) => o.label), answer: all[i] && answerText(q.options, all[i]) })) },
          });
        }
      }
    }
    this.host.session(this.agent.id, { k: "ui", request: null });
    const kind: ActivityKind = approval ? (allowed ? "approved" : "denied") : "answered";
    const detail = answer.text ?? (answer.choices.join(", ") || (answer.chat ? "Chat about this" : answer.cancel ? "Skipped" : ""));
    if (logged) this.host.activity(this.agent.id, kind, `${author ?? "You"} ${kind} ${this.agent.name}`, detail);
    if (answer.chat) this.put({ kind: "user", id: this.id(), at: now, text: "Let's chat about this first.", images: [], author, steering: false, synthetic: false });
    this.queue = [...p.then(answer, all), ...this.queue];
    this.cur = null;
    this.setState("working");
    this.host.metaChanged(this.agent.id);
    return true;
  }

  /** The highlighted option of a pending prompt only the terminal answers (`UiSpec.terminal`). */
  private terminalPick = 0;

  /** omp's dialog of a pending prompt only the terminal answers, as its TUI draws it; "" when none is pending. */
  private terminalDialog(): string {
    const p = this.pending;
    if (!p?.spec.terminal) return "";
    const rows = [`\x1b[38;5;208m╭─ ${p.request.message ?? p.request.title}\x1b[0m`, `│ ${p.spec.terminal.shows}`];
    p.spec.options.forEach((o, i) => rows.push(i === this.terminalPick ? `│ \x1b[1;36m❯ ${o.label}\x1b[0m` : `│   ${o.label}`));
    rows.push("│ \x1b[2m↑/↓ navigate  ⏎ select  ⎋ cancel\x1b[0m", "╰─");
    return rows.join("\r\n");
  }

  /**
   * A key typed into the agent's terminal while a prompt only the terminal answers is pending: ↑/↓ move
   * the highlight, Enter answers with the highlighted option, Esc cancels it (omp denies a dismissed
   * approval). False when no such prompt is pending (the terminal handles the key itself).
   */
  terminalKey(data: string): boolean {
    const p = this.pending;
    if (!p?.spec.terminal) return false;
    const n = p.spec.options.length;
    // xterm sends ↑/↓ as CSI or, in application cursor mode, SS3
    const up = data === "\x1b[A" || data === "\x1bOA";
    if (up || data === "\x1b[B" || data === "\x1bOB") {
      this.terminalPick = (this.terminalPick + (up ? n - 1 : 1)) % n;
      this.termLine(`\r\n${this.terminalDialog()}\r\n`);
    } else if (data === "\r" || data === "\n") {
      const o = p.spec.options[this.terminalPick];
      if (o) this.answer(p.request.id, { choices: [o.id], cancel: false, chat: false, back: false });
    } else if (data === "\x1b") {
      this.answer(p.request.id, { choices: [], cancel: true, chat: false, back: false });
    }
    return true;
  }

  /**
   * `use_user_browser` (bridge tool): the agent asks to use the user's TeleFlock Browser and waits. hostd
   * raises no dialog for it: the card carries the request (`Agent.browser.request`, `needs` with
   * `browser`), and the app with the browser answers it (`browserAnswered`).
   */
  askBrowser(needs: NeedsYou & { requestId: string }, then: (allowed: boolean) => Step[], live = true): void {
    const at = needs.since;
    const toolItemId = this.id();
    this.put({ kind: "tool", id: toolItemId, at, callId: `call_${toolItemId}`, tool: "use_user_browser", title: "Use my browser", intent: needs.question, args: { reason: needs.question }, status: "running", truncated: false }, live);
    this.browserAsk = { id: needs.requestId, toolItemId, then };
    const a = this.agent;
    a.state = "blocked";
    a.stateSince = at;
    a.column = "needs";
    a.needs = needs;
    a.browser = { ...a.browser, request: { id: needs.requestId, reason: needs.question, at } };
    a.live = { ...a.live, streaming: false, thinking: false, tool: undefined, tps: undefined, tpsSplit: undefined, line: needs.title };
    if (!live) return;
    this.host.pulse(a.id, "state", 1);
    this.host.agentChanged(a.id);
    this.host.metaChanged(a.id);
    this.termLine(`\r\n\x1b[38;5;208m◆ ${needs.title}\x1b[0m ${needs.question}\r\n`);
  }

  /** The pending `use_user_browser` request's id. */
  get browserRequest(): string | undefined {
    return this.browserAsk?.id;
  }

  /** The user answered the browser request `id`: its tool row ends with `output` and the turn goes on. False: not pending here. */
  browserAnswered(id: string, allowed: boolean, output: string): boolean {
    const ask = this.browserAsk;
    if (!ask || ask.id !== id) return false;
    this.browserAsk = null;
    const item = this.byId.get(ask.toolItemId);
    if (item?.kind === "tool") this.put({ ...item, status: "ok", durationMs: this.host.now() - item.at, output });
    this.agent.browser = this.agent.browser?.attached ? { attached: this.agent.browser.attached } : undefined;
    this.queue = [...ask.then(allowed), ...this.queue];
    this.cur = null;
    this.setState("working");
    this.host.metaChanged(this.agent.id);
    return true;
  }

  private browserAsk: { id: string; toolItemId: string; then: (allowed: boolean) => Step[] } | null = null;

  abort(reason = "Interrupted by user"): void {
    if (!this.busy) return;
    const now = this.host.now();
    const c = this.cur;
    if (c?.k === "tool") {
      const item = this.byId.get(c.itemId);
      if (item?.kind === "tool") this.put({ ...item, status: "aborted", durationMs: now - c.start });
      this.endSubagents("aborted");
    } else if (c?.k === "say" || c?.k === "think") {
      const item = this.byId.get(c.itemId);
      if (item && (item.kind === "assistant" || item.kind === "thinking")) this.put({ ...item, streaming: false, ...(item.kind === "assistant" ? { stopReason: "aborted" } : { durationMs: now - item.at }) });
    }
    if (this.pending) {
      if (this.pending.toolItemId) {
        const item = this.byId.get(this.pending.toolItemId);
        if (item?.kind === "tool") this.put({ ...item, status: "aborted", durationMs: now - item.at });
      }
      this.pending = null;
      this.host.session(this.agent.id, { k: "ui", request: null });
    }
    if (this.browserAsk) {
      const item = this.byId.get(this.browserAsk.toolItemId);
      if (item?.kind === "tool") this.put({ ...item, status: "aborted", durationMs: now - item.at });
      this.browserAsk = null;
      this.agent.browser = this.agent.browser?.attached ? { attached: this.agent.browser.attached } : undefined;
    }
    this.cur = null;
    this.queue = [];
    this.queueSteer = [];
    this.steerAuthors = [];
    this.put({ kind: "notice", id: this.id(), at: now, level: "warn", text: reason, source: "omp" });
    this.host.activity(this.agent.id, "stopped", `${this.agent.name} stopped`, reason);
    this.termLine(`\r\n\x1b[33m■ ${reason}\x1b[0m\r\n`);
    this.endTurn(false);
  }

  private endTurn(notify: boolean): void {
    const now = this.host.now();
    this.agent.turns += 1;
    const started = this.agent.omp?.turnStartedAt;
    if (started !== undefined && now - started > 200 && this.turnOut > 0) this.lastTurnTps = Math.round((this.turnOut / ((now - started) / 1000)) * 10) / 10;
    if (this.agent.omp) this.agent.omp = { ...this.agent.omp, lastTurnEndedAt: now, retry: undefined };
    const lastSay = [...this.items].reverse().find((x) => x.kind === "assistant");
    const summary = lastSay?.kind === "assistant" ? firstSentence(lastSay.text) : "Turn finished";
    this.agent.live = { ...this.agent.live, line: summary };
    this.setState("done");
    this.host.metaChanged(this.agent.id);
    if (notify) {
      this.host.notify(this.agent.id, "finished", `${this.agent.name} finished`, summary);
      this.host.activity(this.agent.id, "finished", `${this.agent.name} finished`, summary);
    }
    const next = this.queueFollow.shift();
    if (next !== undefined) {
      this.refreshDerived();
      this.startTurn(next);
    }
  }

  /** Advance the simulation; `dt` is the tick length (ms). */
  tick(dt: number): void {
    if (!this.omp) return;
    if (this.state !== "working") return;
    const now = this.host.now();
    const subBefore = this.subagentUsd();
    const costBefore = this.mainUsd + subBefore + this.advisorUsd;
    if (now < this.advisorUntil) this.tokens(Math.max(1, Math.round((this.advisorRate * dt) / 1000)), "advisor");
    let budget = 4; // steps that may complete within one tick
    while (budget-- > 0) {
      if (!this.cur) {
        // Queued steers reach the model at a step boundary (after a beat, so the queue shows).
        if (this.queueSteer.length && (this.queue.length === 0 || now - this.steerSince >= STEER_LAND_MS)) this.landSteers(now);
        const step = this.queue.shift();
        if (!step) {
          this.endTurn(true);
          return;
        }
        const startAt = now - this.backdate;
        this.backdate = 0;
        if (!this.begin(step, startAt)) continue; // instant step done
        if (this.pending) return; // blocked on a dialog
      }
      if (!this.advance(now, dt)) break; // still running
      this.cur = null;
    }
    const subAfter = this.subagentUsd();
    if (subAfter > subBefore) this.host.usage(0, 0, subAfter - subBefore);
    if (Math.round((this.mainUsd + subAfter + this.advisorUsd) * 1000) !== Math.round(costBefore * 1000)) {
      // Cost/context tick visibly on the card (rounded to a tenth of a cent).
      this.refreshDerived();
      this.host.agentChanged(this.agent.id);
    }
    const live = this.agent.live;
    const { tps, split } = this.tps(now);
    const c = this.cur as Active | null;
    const nextLive = {
      ...live,
      streaming: c?.k === "say",
      thinking: c?.k === "think" || c?.k === "wait",
      tool: c?.k === "tool" ? { name: c.spec.tool, label: c.spec.title, startedAt: c.start } : undefined,
      tps,
      tpsSplit: split,
      lastEventAt: this.silentSince !== null ? this.silentSince : live.lastEventAt,
    };
    if (
      nextLive.streaming !== live.streaming ||
      nextLive.thinking !== live.thinking ||
      nextLive.tool?.label !== live.tool?.label ||
      nextLive.tps !== live.tps ||
      JSON.stringify(nextLive.tpsSplit) !== JSON.stringify(live.tpsSplit) ||
      nextLive.line !== live.line ||
      nextLive.lastEventAt !== live.lastEventAt
    ) {
      this.agent.live = nextLive;
      this.host.agentChanged(this.agent.id);
    }
  }

  /** Starts a step. Returns false for instant steps (already done). */
  private begin(step: Step, now: number): boolean {
    switch (step.t) {
      case "ui":
        this.openUi(step.ui, step.then, now, true);
        return true;
      case "think": {
        const itemId = this.id();
        this.put({ kind: "thinking", id: itemId, at: now, text: "", streaming: true, redacted: false });
        this.cur = { k: "think", itemId, start: now, ms: step.ms, text: step.text, shown: 0 };
        this.agent.live = { ...this.agent.live, line: "thinking…" };
        return true;
      }
      case "say": {
        const itemId = this.id();
        this.put({ kind: "assistant", id: itemId, at: now, text: "", streaming: true, model: this.model?.label });
        this.cur = { k: "say", itemId, text: step.text, shown: 0, rate: CHARS_PER_SEC * this.host.rng.range(0.8, 1.25) * (this.fast ? 1.6 : 1) };
        this.termLine("\r\n\x1b[35m●\x1b[0m ");
        return true;
      }
      case "tool": {
        const spec = step.spec;
        const itemId = this.id();
        this.put({
          kind: "tool",
          id: itemId,
          at: now,
          callId: `call_${itemId}`,
          tool: spec.tool,
          title: spec.title,
          intent: spec.intent,
          args: spec.args,
          status: "running",
          truncated: false,
          view: spec.view?.type === "bash" ? { ...spec.view, output: "" } : spec.subagents ? { type: "task", agents: [] } : undefined,
        });
        const subs = spec.subagents ? taskSubs(spec.subagents, () => `${this.agent.id}-sub-${(++this.seq).toString(36)}`) : [];
        this.cur = { k: "tool", itemId, start: now, spec, outShown: 0, output: "", subs, irc: new Map() };
        this.agent.live = { ...this.agent.live, line: spec.title };
        this.termLine(`\r\n\x1b[36m⏺ ${spec.tool}\x1b[0m ${spec.title}\r\n`);
        if (spec.silent) this.silentSince = now;
        if (spec.subagents) {
          // Nested ones appear once their parent spawns them (`advanceTool`).
          for (const t of subs) if (t.at === 0) this.subagents.push(subagentRow(t, now, now));
          this.refreshDerived();
          this.host.metaChanged(this.agent.id);
        }
        return true;
      }
      case "retry": {
        const retryAt = now + step.ms;
        this.put({ kind: "notice", id: this.id(), at: now, level: "warn", text: `Retrying (${step.attempt}/${step.max}) in ${(step.ms / 1000).toFixed(1)}s: ${step.error}`, source: "retry" });
        if (this.agent.omp) this.agent.omp = { ...this.agent.omp, retry: { kind: step.kind, attempt: step.attempt, maxAttempts: step.max, since: now, retryAt, error: step.error } };
        this.agent.live = { ...this.agent.live, line: `Retrying (${step.attempt}/${step.max})…` };
        this.cur = { k: "retry", until: retryAt };
        this.host.agentChanged(this.agent.id);
        return true;
      }
      case "wait":
        this.cur = { k: "wait", until: now + step.ms };
        return true;
      default:
        this.instantLive(step, now);
        return false;
    }
  }

  /** The error row of a turn that failed without text (as tf-hostd builds it: `a<ts>.e`). */
  private failRow(step: Extract<Step, { t: "fail" }>, at: number): TranscriptItem {
    return { kind: "assistant", id: this.id(), at, text: "", streaming: false, model: this.model?.label, stopReason: "error", error: step.error, errorStatus: step.status, refusal: step.refusal };
  }

  private instantLive(step: Extract<Step, { t: "user" | "todo" | "notice" | "mode" | "fail" }>, now: number): void {
    switch (step.t) {
      case "user":
        this.put({ kind: "user", id: this.id(), at: now, text: step.text, images: [], author: step.author, steering: step.steering ?? false, synthetic: step.synthetic ?? false });
        break;
      case "todo":
        this.setTodo(step.task, step.status);
        this.touch("event", 1);
        this.host.metaChanged(this.agent.id);
        this.termLine(`\x1b[2m  ${TODO_STATUS_LABEL[step.status] ?? "·"} ${step.task}\x1b[0m\r\n`);
        break;
      case "fail": {
        this.put(this.failRow(step, now));
        const title = step.refusal ? `${this.agent.name}: ${step.refusal.kind === "sensitive" ? "Flagged by safety filters" : "Refused"}${step.refusal.category ? ` · ${step.refusal.category}` : ""}` : `${this.agent.name} hit an error`;
        this.host.notify(this.agent.id, "error", title, step.refusal?.explanation ?? step.error);
        this.host.activity(this.agent.id, "error", step.refusal ? title : "Turn failed", step.refusal?.explanation ?? step.error);
        break;
      }
      case "notice":
        this.put({ kind: "notice", id: this.id(), at: now, level: step.level, text: step.text, source: step.source ?? "omp" });
        if (step.level === "error") {
          this.host.notify(this.agent.id, "error", `${this.agent.name}: error`, step.text);
          this.host.activity(this.agent.id, "error", `${this.agent.name} hit an error`, step.text);
        }
        break;
      case "mode":
        this.put({ kind: "mode", id: this.id(), at: now, text: step.text });
        break;
    }
  }

  /** Advances the active step; true when it finished. */
  private advance(now: number, dt: number): boolean {
    const c = this.cur;
    if (!c) return true;
    switch (c.k) {
      case "retry":
        if (now < c.until) return false;
        if (this.agent.omp) this.agent.omp = { ...this.agent.omp, retry: undefined };
        this.host.agentChanged(this.agent.id);
        return true;
      case "wait":
        return now >= c.until;
      case "think": {
        const target = Math.min(c.text.length, Math.ceil((c.text.length * (now - c.start)) / c.ms));
        if (target > c.shown) {
          const chunk = c.text.slice(c.shown, target);
          c.shown = target;
          this.append(c.itemId, "text", chunk);
          this.tokens(Math.ceil(chunk.length / 4));
          this.touch("thinking", Math.max(1, Math.round(chunk.length / 16)));
        }
        if (now - c.start < c.ms) return false;
        const item = this.byId.get(c.itemId);
        if (item?.kind === "thinking") this.put({ ...item, text: c.text, streaming: false, durationMs: now - c.start });
        return true;
      }
      case "say": {
        const n = Math.max(1, Math.round((c.rate * dt) / 1000 * this.host.rng.range(0.6, 1.4)));
        const chunk = c.text.slice(c.shown, c.shown + n);
        if (chunk) {
          c.shown += chunk.length;
          this.append(c.itemId, "text", chunk);
          this.tokens(Math.max(1, Math.round(chunk.length / 4)));
          this.touch("token", Math.max(1, Math.round(chunk.length / 16)));
          this.termLine(chunk.replace(/\n/g, "\r\n"));
          const shown = c.text.slice(0, c.shown);
          this.agent.live = { ...this.agent.live, line: lastFragment(shown) };
        }
        if (c.shown < c.text.length) return false;
        const item = this.byId.get(c.itemId);
        if (item?.kind === "assistant") this.put({ ...item, text: c.text, streaming: false, usage: usageFor(c.text.length), stopReason: "stop" });
        this.advise(now);
        this.termLine("\r\n");
        return true;
      }
      case "tool":
        return this.advanceTool(c, now, dt);
    }
  }

  private advanceTool(c: Extract<Active, { k: "tool" }>, now: number, dt: number): boolean {
    const spec = c.spec;
    const elapsed = now - c.start;
    const lines = spec.output ?? [];
    if (!spec.silent && lines.length) {
      const target = Math.min(lines.length, Math.floor((lines.length * elapsed) / Math.max(1, spec.ms)) + 1);
      while (c.outShown < target) {
        const line = `${lines[c.outShown] ?? ""}\n`;
        c.outShown++;
        c.output += line;
        this.append(c.itemId, "output", line);
        this.termLine(line.replace(/\n/g, "\r\n"));
        this.touch("tool", 1);
      }
    }
    if (spec.subagents) {
      // Each running subagent streams its own replies; their bill shows on their rows.
      const running = this.subagents.filter((s) => s.status === "running" && c.subs.some((t) => t.id === s.id)).length;
      if (running) this.tokens(Math.max(1, Math.round((running * this.host.rng.range(28, 46) * dt) / 1000)), "subagents");
      let changed = false;
      for (const t of c.subs) {
        if (elapsed < t.at) continue;
        const row = subagentRow(t, c.start + t.at, now);
        const idx = this.subagents.findIndex((s) => s.id === t.id);
        if (idx < 0) {
          // Its parent spawns it now, unless the parent no longer runs (killed).
          if (t.parent && this.subagents.find((s) => s.id === t.parent?.id)?.status !== "running") continue;
          this.subagents.push(row);
          changed = true;
          continue;
        }
        const prev = this.subagents[idx] as Subagent;
        if (prev.status !== "running") continue;
        if (row.line !== prev.line || row.status !== prev.status || row.completionPct !== prev.completionPct || Math.abs((row.context?.pct ?? 0) - (prev.context?.pct ?? 0)) >= 0.5) {
          this.subagents[idx] = row;
          changed = true;
          if (row.status === "done" && !t.parent) this.host.activity(this.agent.id, "finished", `${t.name} (subagent of ${this.agent.name}) finished`, t.spec.description);
        }
      }
      if (changed) {
        const item = this.byId.get(c.itemId);
        // The call's card lists the subagents it started; theirs are in the Subagents panel.
        if (item?.kind === "tool") this.put({ ...item, view: { type: "task", agents: this.subagents.filter((s) => c.subs.some((t) => !t.parent && t.id === s.id)) } });
        this.refreshDerived();
        this.host.metaChanged(this.agent.id);
      }
      this.emitIrc(spec, c.start, elapsed, c.irc, true);
    } else if (!spec.silent && now - this.lastPulseTool > 450) {
      this.lastPulseTool = now;
      this.touch("tool", 1);
    }
    if (elapsed < spec.ms) return false;
    // Finished.
    if (spec.silent) {
      this.silentSince = null;
      for (const l of lines) {
        c.output += `${l}\n`;
        this.termLine(`${l}\r\n`);
      }
    }
    if (spec.subagents) {
      this.emitIrc(spec, c.start, Number.POSITIVE_INFINITY, c.irc, true);
      this.endSubagents("done");
    }
    for (const f of spec.files ?? []) this.addFile(f);
    const status: ToolStatus = spec.error ? "error" : "ok";
    this.put(this.finishedTool(c.itemId, c.start, spec, c.output.replace(/\n$/, ""), status, now));
    // A document presented live (tf-hostd's `presented` notification; seeded history never notifies).
    const doc = status === "ok" ? spec.artifact : undefined;
    if (doc) {
      const body = doc.version > 1 ? `${PRESENT_KIND_WORD[doc.kind]} · version ${doc.version}` : PRESENT_KIND_WORD[doc.kind];
      this.host.notify(this.agent.id, "presented", `${this.agent.name} presented ${doc.title}`, body, undefined, [{ id: `open:${doc.name}`, label: "View" }]);
    }
    this.inputTokens(1500 + this.host.rng.int(0, 5000));
    this.advise(now);
    if (spec.files?.length) this.host.metaChanged(this.agent.id);
    if (spec.error) this.host.activity(this.agent.id, "toolError", `${this.agent.name}: ${spec.title} failed`, spec.error);
    if (spec.tool === "bash" && /git commit/.test(spec.title)) this.host.activity(this.agent.id, "committed", `${this.agent.name} committed`, spec.title);
    return true;
  }

  private endSubagents(status: "done" | "aborted"): void {
    const now = this.host.now();
    let changed = false;
    this.subagents = this.subagents.map((s) => {
      if (s.status !== "running") return s;
      changed = true;
      // omp only reports the completion estimate while a subagent runs.
      return { ...s, status, endedAt: now, completionPct: undefined };
    });
    if (changed) {
      this.refreshDerived();
      this.host.metaChanged(this.agent.id);
    }
  }

  /**
   * The subagents' scripted IRC `elapsed` ms into a task call that started at `start`: their
   * messages as inbound rows, the parent's answers as `write agent://<name>` sends (running, then
   * delivered). `sent` remembers what was emitted (key → row id) across ticks.
   */
  private emitIrc(spec: ToolSpec, start: number, elapsed: number, sent: Map<string, string>, live: boolean): void {
    spec.subagents?.forEach((sub, i) =>
      sub.irc?.forEach((m, j) => {
        const key = `${i}.${j}`;
        if (elapsed >= m.at && !sent.has(`${key}<`)) {
          const id = this.id();
          sent.set(`${key}<`, id);
          const at = start + m.at;
          this.put({ kind: "irc", id, at, message: { direction: "in", peer: sub.name, text: m.text, messageId: at.toString(16), broadcast: m.broadcast ?? false, wakeRelay: m.relay ?? false, fromParent: false, receipts: [] } }, live);
          if (live) this.termLine(`\r\n\x1b[35mIRC ← ${sub.name}${m.broadcast ? " (all)" : ""}\x1b[0m ${firstSentence(m.text)}\r\n`);
        }
        const r = m.reply;
        if (!r || elapsed < m.at + r.after) return;
        const delivered = elapsed >= m.at + r.after + 700;
        const at = start + m.at + r.after;
        const id = sent.get(`${key}>`);
        if (!id) {
          const nid = this.id();
          sent.set(`${key}>`, nid);
          this.put(ircSend(nid, at, sub.name, r.text, delivered), live);
          if (live) this.termLine(`\r\n\x1b[36m⏺ write\x1b[0m agent://${sub.name}\r\n`);
        } else if (delivered && !sent.has(`${key}✓`)) {
          this.put(ircSend(id, at, sub.name, r.text, true), live);
        }
        if (delivered) sent.set(`${key}✓`, "");
      }),
    );
  }

  /** The next version of this agent's board test report (`presented/board-test-report-v<n>.md`): one past the newest its transcript shows. */
  private nextReportVersion(): number {
    let newest = 0;
    for (const item of this.byId.values()) if (item.kind === "tool" && item.artifact?.slug === "board-test-report") newest = Math.max(newest, item.artifact.version);
    return newest + 1;
  }

  private finishedTool(id: string, start: number, spec: ToolSpec, output: string, status: ToolStatus, end: number): TranscriptItem {
    let view = spec.view;
    if (view?.type === "bash") view = { ...view, output, exitCode: spec.exitCode ?? 0 };
    if (spec.files?.length && !view) view = { type: "diff", files: spec.files.map((f) => fileDiff(f)) };
    if (spec.subagents) view = { type: "task", agents: this.subagents.filter((s) => spec.subagents?.some((x) => x.name === s.name)) };
    return {
      kind: "tool",
      id,
      at: start,
      callId: `call_${id}`,
      tool: spec.tool,
      title: spec.title,
      intent: spec.intent,
      args: spec.args,
      status,
      durationMs: Math.max(1, (end - start) || spec.ms),
      output: view?.type === "bash" || !output ? undefined : output,
      truncated: false,
      view,
      error: spec.error,
      artifact: spec.artifact,
    };
  }

  /** Committed on the branch since the merge-base (git.commit moves uncommitted files here). */
  private committed: ChangedFile[] = [];

  /** Branch changes vs the merge-base: committed + uncommitted, merged per path. */
  branchFiles(): ChangedFile[] {
    if (!this.committed.length) return this.files;
    const out = this.committed.map((f) => ({ ...f }));
    for (const f of this.files) {
      const prev = out.find((x) => x.path === f.path);
      if (prev) {
        prev.added += f.added;
        prev.removed += f.removed;
      } else out.push({ ...f });
    }
    return out;
  }

  /** `git commit -a`: uncommitted files become part of the branch history. */
  commit(): void {
    const merged = this.branchFiles();
    this.committed = merged === this.files ? this.files.map((f) => ({ ...f })) : merged;
    this.files = [];
    this.refreshDerived();
  }

  addFile(f: ChangedFile): void {
    const i = this.files.findIndex((x) => x.path === f.path);
    if (i < 0) this.files.push({ ...f });
    else {
      const prev = this.files[i] as ChangedFile;
      this.files[i] = { ...prev, added: prev.added + f.added, removed: prev.removed + f.removed };
    }
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
  }

  setTodo(task: string, status: TodoPhase["tasks"][number]["status"]): void {
    for (const p of this.todos) {
      for (const t of p.tasks) {
        if (t.content === task) {
          t.status = status;
          if (status !== "blocked") t.blocker = undefined;
        }
      }
    }
    this.refreshDerived();
  }

  /** Adds a mode/notice row immediately (control methods). */
  note(kind: "mode" | "notice", text: string, level: "info" | "warn" | "error" = "info"): void {
    const now = this.host.now();
    if (kind === "mode") this.put({ kind: "mode", id: this.id(), at: now, text });
    else this.put({ kind: "notice", id: this.id(), at: now, level, text, source: "teleflock" });
  }

  compact(instructions?: string): void {
    const now = this.host.now();
    const before = this.ctxTokens;
    this.ctxTokens = Math.round(this.ctxTokens * 0.28);
    this.put({ kind: "compaction", id: this.id(), at: now, summary: instructions ? `Compacted with focus: ${instructions}` : "Compacted the conversation: decisions, open todos and changed files kept.", tokensBefore: before });
    this.refreshDerived();
    this.host.agentChanged(this.agent.id);
    this.host.metaChanged(this.agent.id);
    this.host.activity(this.agent.id, "compacted", `${this.agent.name} compacted`, `${Math.round(before / 1000)}k → ${Math.round(this.ctxTokens / 1000)}k tokens`);
  }

  /** Resets transcript for `agent.newSession`. */
  newSession(): void {
    this.items = [];
    this.byId.clear();
    this.ctxTokens = 3000;
    this.todos = [];
    this.subagents = [];
    this.mainUsd = 0;
    this.advisorUsd = 0;
    this.advisorUntil = 0;
    this.lastTurnTps = undefined;
    this.files = [];
    this.refreshDerived();
    this.host.session(this.agent.id, { k: "reset", snapshot: this.snapshot(200) });
    this.host.agentChanged(this.agent.id);
  }

  /** Text for attached omp terminals. */
  private termLine(text: string): void {
    this.host.termWrite(this.agent.id, text);
  }

  /** Recent transcript rendered as terminal text (initial frame of an agent terminal), under it omp's dialog of a prompt only the terminal answers. */
  renderTui(rows: number): string {
    const out: string[] = [];
    for (const it of this.items.slice(-30)) {
      if (it.kind === "user") out.push(`\x1b[1;35m❯\x1b[0m ${it.text}`);
      else if (it.kind === "assistant") out.push(`\x1b[35m●\x1b[0m ${it.text}`);
      else if (it.kind === "thinking") out.push(`\x1b[2m✻ Thought for ${Math.round((it.durationMs ?? 0) / 1000)}s\x1b[0m`);
      else if (it.kind === "tool") {
        out.push(`\x1b[36m⏺ ${it.tool}\x1b[0m ${it.title} \x1b[2m${it.status}\x1b[0m`);
        // omp's task rows: `· 40%` (completion estimate, live only) then `· 2.4%/272K` (context).
        if (it.view?.type === "task") for (const s of it.view.agents) out.push(`  ${s.status === "running" ? "\x1b[36m◆" : "\x1b[32m✓"}\x1b[0m ${s.name}${s.completionPct != null ? ` · \x1b[36m${s.completionPct}%\x1b[0m` : ""}${s.context ? `\x1b[2m · ${s.context.pct.toFixed(1)}%/${Math.round(s.context.window / 1000)}K\x1b[0m` : ""}`);
      } else if (it.kind === "notice") out.push(`\x1b[33m! ${it.text}\x1b[0m`);
    }
    // omp's dialog sits at the bottom, where its composer goes
    const dialog = this.terminalDialog();
    if (dialog) out.push(...dialog.split("\r\n"));
    const lines = out.join("\n").split("\n").slice(-(rows - 3));
    return lines.join("\r\n");
  }
}

/** How an answer reads in the ask tool row and Activity: the picked labels, the typed text, or what ended the ask. */
function answerText(options: readonly NeedsOption[], a: Answer): string {
  if (a.cancel) return "(dismissed)";
  if (a.chat) return "(chat about this)";
  return a.text ?? a.choices.map((id) => options.find((o) => o.id === id)?.label ?? id).join(", ");
}

/** Mean of the running subagents' completion estimates, as tf-hostd summarises them for the board. */
function meanCompletion(subs: Subagent[]): number | undefined {
  const est = subs.flatMap((s) => (s.completionPct != null ? [s.completionPct] : []));
  return est.length ? est.reduce((a, b) => a + b, 0) / est.length : undefined;
}

function capsFor(live: boolean, readOnly: boolean): Capabilities {
  const on = live && !readOnly;
  return {
    prompt: on,
    steer: on,
    followUp: on,
    abort: live,
    answer: live,
    model: on,
    thinking: on,
    fast: on,
    plan: on,
    goal: on,
    compact: on,
    rename: live,
    fork: on,
    branch: on,
    tree: live,
    btw: on,
    export: live,
    handoff: on,
    subagents: on,
    bridge: on,
    retry: on,
    subagentRetry: on,
    refusalRetry: on,
  };
}

function usageFor(chars: number) {
  const output = Math.round(chars / 4);
  return { input: 1200 + output * 3, output, cacheRead: 18_000 + output * 10, cacheWrite: 900, costUsd: round2((output * 25) / 1e6 + 0.004) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function firstSentence(text: string): string {
  const plain = text.replace(/[*`|#]/g, "").replace(/\s+/g, " ").trim();
  const m = plain.match(/^(.{1,120}?[.!?])(\s|$)/);
  return (m?.[1] ?? plain.slice(0, 100)).trim();
}

function lastFragment(text: string): string {
  const plain = text.replace(/[*`#|]/g, "").replace(/\s+/g, " ").trim();
  const parts = plain.split(/(?<=[.!?:])\s/);
  const last = parts[parts.length - 1] ?? plain;
  return last.length > 80 ? `…${last.slice(-79)}` : last;
}

/** The parent's `write agent://<peer>` send, as hostd normalizes it (running → delivered). */
function ircSend(id: string, at: number, peer: string, text: string, delivered: boolean): TranscriptItem {
  return {
    kind: "tool",
    id,
    at,
    callId: `call_${id}`,
    tool: "write",
    title: `agent://${peer}`,
    args: { path: `agent://${peer}`, content: text },
    status: delivered ? "ok" : "running",
    durationMs: delivered ? 40 : undefined,
    output: delivered ? `Delivered to ${peer}.` : undefined,
    truncated: false,
    view: { type: "irc", direction: "out", peer, text, broadcast: false, wakeRelay: false, fromParent: false, receipts: delivered ? [{ to: peer, outcome: "injected" }] : [] },
  };
}
