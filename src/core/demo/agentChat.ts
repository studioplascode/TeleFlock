import type { AgentChatInfo, AgentChatLog, AgentChatMessage, IrcReceipt, Subagent, TranscriptItem } from "@/core/gen";
import { apiError } from "../errors";
import { ircOf } from "../irc";
import type { AgentSim } from "./agent";
import { poolTurn, type SubagentSpec } from "./scripts";

/**
 * Demo host: each omp session's agent chat log (`session.agentChat`, `SessionMeta.agentChat`;
 * tf-hostd's `agent_chat.rs`, architecture §3.34). pool's tree talks the way omp's IRC bus would
 * carry it while its task runs: the subagents' messages to Main and Main's answers (the
 * `IrcSpec`s of `poolTurn`, which Main's transcript shows too), PoolBench orchestrating its sweep
 * and summary, the nested sweep orchestrating one bench per size, scouts asking each other, a
 * broadcast, replies and a send refused because its recipient had ended. Other sessions' logs are
 * their transcript's IRC rows. What the user sends a subagent from the app joins as `user`.
 * Messages get ids in the order they appear and a log revision on every change, like tf-hostd's.
 */

export interface AgentChatDeps {
  /** forge plays a tf-hostd ≥ 0.9.0; studio-pc one before (no log: the app shows transcript rows). */
  supported(): boolean;
  now(): number;
}

const MAIN = "Main";
const USER = "user";
/** omp settles a delivery (its receipt) this long after the send starts, as Main's transcript shows it. */
const SETTLE_MS = 700;
/** A send to an agent that isn't running is refused at once. */
const REFUSE_MS = 120;
/** The user's broadcast arrives as one request per subagent: requests this close with the same text are one message. */
const BROADCAST_SLACK_MS = 30_000;

/** One message before it has an id: `key` names it across syncs (and in `replyTo`). */
interface Draft {
  key: string;
  from: string;
  to: string[];
  broadcast: boolean;
  text: string;
  at: number;
  replyTo?: string;
  wakeRelay: boolean;
  progress: boolean;
  receipts: IrcReceipt[];
}

/**
 * What pool's subagents say to each other (not to or from Main), ms after its task starts; agents
 * by omp id (a nested one under its parent's). `replyTo`: the key of the message it answers
 * (`irc:<subagent>:<n>`: the n-th `IrcSpec` of that subagent). `outcome`: omp's receipt (default
 * `injected`: the recipient was busy). A send to an agent that isn't running at that moment fails.
 */
interface TreeLine {
  key: string;
  at: number;
  from: string;
  to: string;
  text: string;
  replyTo?: string;
  progress?: boolean;
  outcome?: "injected" | "woken";
}

const POOL_TREE: TreeLine[] = [
  {
    key: "plan",
    at: 1_600,
    from: "PoolBench",
    to: "PoolBench.Sweep",
    text: "Sweep pool sizes **16, 32 and 64** against the staging replica: one bench per size, 10 s each at 1.2k RPS. Report p99 per size.",
  },
  { key: "ack", at: 2_300, from: "PoolBench.Sweep", to: "PoolBench", replyTo: "plan", progress: true, text: "On it: Size16, Size32 and Size64 are starting. p99 per size in about 20 s." },
  {
    key: "cap",
    at: 3_800,
    from: "PoolBench.Sweep",
    to: "PoolBench.Sweep.Size64",
    text: "Heads-up: staging allows **50 connections in total** and Size16 + Size32 already hold 48. Back off if you're refused.",
  },
  { key: "ask", at: 7_400, from: "QueryScout", to: "LockAudit", text: "Does `/v1/search` keep any session state? It's my top handler and I'd rank it first for the pool." },
  {
    key: "stateless",
    at: 9_100,
    from: "LockAudit",
    to: "QueryScout",
    replyTo: "ask",
    text: "No, search is stateless. Only `/v1/billing` (advisory locks) and `/v1/tenants` (`SET search_path`) hold session state.",
  },
  {
    key: "refused",
    at: 10_200,
    from: "PoolBench.Sweep.Size64",
    to: "PoolBench.Sweep",
    replyTo: "cap",
    text: "Staging refused the 64-connection pool: `FATAL: sorry, too many clients already` (max_connections 50). Stopping.",
  },
  // Size64 ended at 10.5 s: omp refuses this one.
  { key: "retry", at: 12_200, from: "PoolBench.Sweep", to: "PoolBench.Sweep.Size64", text: "Retry with 48 connections?" },
  { key: "skip64", at: 12_900, from: "PoolBench.Sweep", to: "PoolBench", text: "Size64 failed: staging caps `max_connections` at 50. Carrying on with 16 and 32." },
  { key: "size16", at: 16_200, from: "PoolBench.Sweep.Size16", to: "PoolBench.Sweep", text: "size=16: p99 **18 ms** at 1.2k RPS, no waits for a connection." },
  { key: "ack-all", at: 16_400, from: "LockAudit", to: "PoolBench", replyTo: "irc:PoolBench:1", text: "Ack: my audit runs read-only queries on one connection." },
  { key: "size32", at: 18_800, from: "PoolBench.Sweep.Size32", to: "PoolBench.Sweep", text: "size=32: p99 **17 ms** at 1.2k RPS; 9 connections idle on average." },
  { key: "share", at: 22_000, from: "QueryScout", to: "PoolBench", text: "For your chart: `/v1/search` makes 61% of connection opens (3 per request), `/v1/tenants` 22%." },
  {
    key: "swept",
    at: 26_800,
    from: "PoolBench.Sweep",
    to: "PoolBench",
    replyTo: "plan",
    outcome: "woken",
    text: "Sweep done: size=16 → p99 18 ms, size=32 → 17 ms, size=64 refused by staging. **16 is the knee.**",
  },
  { key: "chart", at: 28_700, from: "PoolBench", to: "PoolBench.Summary", text: "Chart p99 per pool size into `bench/pool.svg`: 8 → 41 ms, 16 → 18 ms, 32 → 17 ms; mark 64 as refused by staging." },
  { key: "charted", at: 32_200, from: "PoolBench.Summary", to: "PoolBench", replyTo: "chart", outcome: "woken", text: "Chart written to `bench/pool.svg`, the knee at 16 marked." },
];

/** pool's task: the subagents whose `IrcSpec`s Main's transcript shows. */
const POOL_SUBS: SubagentSpec[] = poolTurn().flatMap((s) => (s.t === "tool" && s.spec.subagents ? s.spec.subagents : []));

/** Receipts of a send at `at` to `to`, as of `now`: pending until omp settles it. */
function settled(to: readonly string[], at: number, now: number, running: (id: string, at: number) => boolean, outcome = "injected"): IrcReceipt[] {
  return to.map((t) => {
    if (!running(t, at)) return now >= at + REFUSE_MS ? { to: t, outcome: "failed", error: `Failed: ${t} is not running.` } : { to: t, outcome: "pending" };
    return { to: t, outcome: now >= at + SETTLE_MS ? outcome : "pending" };
  });
}

/** pool's conversation so far, once its task runs (from `t0`, its first subagent's start). */
function poolDrafts(subs: readonly Subagent[], now: number): { t0: number; drafts: Draft[] } | undefined {
  const first = POOL_SUBS[0];
  const t0 = subs.find((s) => s.name === first?.name && s.parentId === undefined)?.startedAt;
  if (t0 === undefined) return undefined;
  const rows = new Map(subs.map((s) => [s.name, s]));
  const running = (id: string, at: number): boolean => {
    if (id === MAIN) return true;
    const r = rows.get(id);
    return r?.startedAt !== undefined && r.startedAt <= at && (r.endedAt === undefined ? r.status === "running" : r.endedAt > at);
  };
  const out: Draft[] = [];
  for (const sub of POOL_SUBS) {
    sub.irc?.forEach((m, j) => {
      const key = `irc:${sub.name}:${j}`;
      const at = t0 + m.at;
      if (at > now) return;
      const to = m.broadcast ? [MAIN, ...subs.filter((s) => s.name !== sub.name && running(s.name, at)).map((s) => s.name)] : [MAIN];
      // A wake relay answers what Main last told it.
      const asked = m.relay ? out.filter((d) => d.from === MAIN && d.to[0] === sub.name && d.at < at).at(-1)?.key : undefined;
      out.push({ key, from: sub.name, to, broadcast: m.broadcast ?? false, text: m.text, at, replyTo: asked, wakeRelay: m.relay ?? false, progress: false, receipts: settled(to, at, now, running) });
      const r = m.reply;
      if (r && at + r.after <= now) {
        out.push({ key: `${key}:reply`, from: MAIN, to: [sub.name], broadcast: false, text: r.text, at: at + r.after, replyTo: key, wakeRelay: false, progress: false, receipts: settled([sub.name], at + r.after, now, running) });
      }
    });
  }
  for (const l of POOL_TREE) {
    const at = t0 + l.at;
    if (at > now || !running(l.from, at)) continue;
    out.push({ key: l.key, from: l.from, to: [l.to], broadcast: false, text: l.text, at, replyTo: l.replyTo, wakeRelay: false, progress: l.progress ?? false, receipts: settled([l.to], at, now, running, l.outcome) });
  }
  return { t0, drafts: out };
}

/** A session's log from its transcript's IRC rows before `before` (what Main sent and what reached it). */
function transcriptDrafts(items: readonly TranscriptItem[], before = Number.POSITIVE_INFINITY): Draft[] {
  const keyOf = new Map<string, string>();
  const out: Draft[] = [];
  for (const row of items) {
    const e = ircOf(row);
    if (!e || e.at >= before) continue;
    const m = e.message;
    const key = `row:${row.id}`;
    if (m.messageId) keyOf.set(m.messageId, key);
    const replyTo = m.replyTo ? keyOf.get(m.replyTo) : undefined;
    if (m.direction === "in") {
      out.push({ key, from: m.peer, to: [MAIN], broadcast: m.broadcast, text: m.text, at: e.at, replyTo, wakeRelay: m.wakeRelay, progress: false, receipts: [{ to: MAIN, outcome: "injected" }] });
      continue;
    }
    const to = m.peer === "all" ? m.receipts.map((r) => r.to) : [m.peer];
    const pending = e.status === "pending" || e.status === "running";
    const failed = e.status === "error" || e.status === "aborted" || e.status === "denied";
    const receipts = pending ? to.map((t) => ({ to: t, outcome: "pending" })) : failed ? to.map((t) => ({ to: t, outcome: "failed", error: e.error })) : m.receipts;
    out.push({ key, from: MAIN, to, broadcast: m.broadcast || m.peer === "all", text: m.text, at: e.at, replyTo, wakeRelay: m.wakeRelay, progress: false, receipts });
  }
  return out;
}

/** What the user sent from the app (`agent.subagent` chat): one message per text, a broadcast's requests together. */
interface UserLine {
  n: number;
  at: number;
  to: string[];
  text: string;
  broadcast: boolean;
}

interface Log {
  epoch: string;
  rev: number;
  /** Next message number (`m<n>`). */
  next: number;
  ids: Map<string, string>;
  messages: Map<string, AgentChatMessage>;
  /** Each message as last exported, without its revision: a change bumps it. */
  shapes: Map<string, string>;
  user: UserLine[];
  /** The revision the session's meta last went out with. */
  announced: number;
}

export class DemoAgentChat {
  private readonly logs = new WeakMap<AgentSim, Log>();

  constructor(private readonly deps: AgentChatDeps) {}

  private logOf(sim: AgentSim): Log {
    let log = this.logs.get(sim);
    if (!log) {
      log = { epoch: Math.round(this.deps.now() * 1000).toString(36), rev: 0, next: 1, ids: new Map(), messages: new Map(), shapes: new Map(), user: [], announced: 0 };
      this.logs.set(sim, log);
    }
    return log;
  }

  /** Folds what the sources say now into the log: new messages get the next ids, changed ones a new revision. */
  private sync(sim: AgentSim): Log {
    const log = this.logOf(sim);
    const now = this.deps.now();
    // pool's own rows from its task on are the script's; any before it (and other sessions') are as the transcript has them.
    const pool = poolDrafts(sim.subagents, now);
    const drafts = [...transcriptDrafts(sim.items, pool?.t0), ...(pool?.drafts ?? [])];
    for (const u of log.user) {
      drafts.push({ key: `user:${u.n}`, from: USER, to: u.to, broadcast: u.broadcast, text: u.text, at: u.at, wakeRelay: false, progress: false, receipts: u.to.map((t) => ({ to: t, outcome: "injected" })) });
    }
    drafts.sort((a, b) => a.at - b.at);
    for (const d of drafts) if (!log.ids.has(d.key)) log.ids.set(d.key, `m${log.next++}`);
    for (const d of drafts) {
      const id = log.ids.get(d.key) as string;
      const replyTo = d.replyTo === undefined ? undefined : log.ids.get(d.replyTo);
      const msg = { id, from: d.from, to: d.to, broadcast: d.broadcast, text: d.text, at: d.at, ...(replyTo ? { replyTo } : {}), wakeRelay: d.wakeRelay, progress: d.progress, receipts: d.receipts };
      const shape = JSON.stringify(msg);
      if (log.shapes.get(id) === shape) continue;
      log.shapes.set(id, shape);
      log.rev += 1;
      log.messages.set(id, { ...msg, rev: log.rev });
    }
    return log;
  }

  /** `SessionMeta.agentChat` (none from a host before 0.9.0). */
  info(sim: AgentSim): AgentChatInfo | undefined {
    if (!this.deps.supported() || !sim.omp) return undefined;
    const log = this.sync(sim);
    return { epoch: log.epoch, rev: log.rev, count: log.messages.size, live: true };
  }

  /** The log moved since the session's meta last went out (the host then sends the meta again). */
  moved(sim: AgentSim): boolean {
    const rev = this.info(sim)?.rev;
    const log = this.logs.get(sim);
    if (rev === undefined || !log || rev === log.announced) return false;
    log.announced = rev;
    return true;
  }

  /** `session.agentChat {agentId, epoch?, after?}`: what changed after `after` in `epoch`, else the whole log. */
  page(sim: AgentSim, p: Record<string, unknown>): AgentChatLog {
    if (!this.deps.supported()) throw apiError("unknown_method", "unknown method: session.agentChat");
    const log = this.sync(sim);
    const after = p.epoch === log.epoch && typeof p.after === "number" ? p.after : undefined;
    const seq = (id: string) => Number(id.slice(1));
    const messages = [...log.messages.values()].filter((m) => after === undefined || m.rev > after).sort((a, b) => a.at - b.at || seq(a.id) - seq(b.id));
    return { epoch: log.epoch, rev: log.rev, messages, reset: after === undefined, truncated: false, live: true };
  }

  /** The user sent subagent `to` a message from the app; `broadcast`: one of a message to every running subagent. */
  userSent(sim: AgentSim, to: string, text: string, broadcast: boolean): void {
    const log = this.logOf(sim);
    const now = this.deps.now();
    const last = log.user.at(-1);
    if (broadcast && last?.broadcast && last.text === text && now - last.at <= BROADCAST_SLACK_MS && !last.to.includes(to)) last.to = [...last.to, to];
    else log.user.push({ n: log.user.length + 1, at: now, to: [to], text, broadcast });
  }
}
