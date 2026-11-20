import type { IrcEntry } from "@/core";
import type { AgentChatLog, AgentChatMessage, IrcReceipt, Subagent } from "@/core/gen";
import { groupSubagents, type SubagentNode, treeOrder } from "../subagents/grouping";

/**
 * The message board's model (architecture §6.17, host side §3.34): a session's agent chat log as the host keeps it
 * (`session.agentChat`, hosts ≥ 0.9.0), or, from older hosts, the IRC rows of the session's own
 * transcript; who is who in the session's agent tree; filters and unread.
 */

/** omp's id of a session's main agent. */
export const MAIN = "Main";
/** The sender of what the user sent an agent from TeleFlock (`agent.subagent` chat). */
export const USER = "user";
/** Messages kept per session: as many as the host's log keeps. */
export const MAX_MESSAGES = 2000;

/** A message on the board: an entry of the host's log, or a row of the session's transcript (`itemId`). */
export type BoardMessage = AgentChatMessage & { itemId?: string };

/** The app's copy of a session's log. */
export interface ChatLog {
  epoch: string;
  /** The log revision the copy is complete up to (`session.agentChat {after}`). */
  rev: number;
  /** Oldest first: by time, then in the host's order. */
  messages: BoardMessage[];
  /** The host dropped its oldest messages. */
  truncated: boolean;
  /** The host learns each message as it is sent (else it reads the session's files on each fetch). */
  live: boolean;
}

/** Stable by time: equal times keep their order (the host's, then arrival). */
function byTime(list: BoardMessage[]): BoardMessage[] {
  for (let i = 1; i < list.length; i++) {
    if ((list[i] as BoardMessage).at < (list[i - 1] as BoardMessage).at) return [...list].sort((a, b) => a.at - b.at);
  }
  return list;
}

/**
 * Folds a page of `session.agentChat` into the copy: the whole log when the page says so (`reset`,
 * another epoch: tf-hostd rebuilt it), else the changed messages replace theirs by id and new ones
 * join, in time order. Unchanged messages keep their objects; the oldest beyond the cap go.
 */
export function mergeChatPage(prev: ChatLog | undefined, page: AgentChatLog): ChatLog {
  const whole = !prev || page.reset || prev.epoch !== page.epoch;
  const rev = whole ? page.rev : Math.max(prev.rev, page.rev);
  if (!whole && page.messages.length === 0 && rev === prev.rev && prev.truncated === page.truncated && prev.live === page.live) return prev;
  let messages: BoardMessage[];
  if (whole) messages = byTime([...page.messages]);
  else {
    const changed = new Map(page.messages.map((m) => [m.id, m]));
    messages = prev.messages.map((m) => changed.get(m.id) ?? m);
    for (const m of prev.messages) changed.delete(m.id);
    for (const m of changed.values()) messages.push(m);
    messages = byTime(messages);
  }
  if (messages.length > MAX_MESSAGES) messages = messages.slice(messages.length - MAX_MESSAGES);
  return { epoch: page.epoch, rev, messages, truncated: page.truncated, live: page.live };
}

/**
 * The session's own IRC rows as board messages (hosts before 0.9.0 keep no log): what the main
 * agent sent and what reached it. A send still running is pending; a refused one failed.
 */
export function fromTranscript(entries: readonly IrcEntry[]): BoardMessage[] {
  const rowOf = new Map<string, string>();
  for (const e of entries) if (e.message.messageId) rowOf.set(e.message.messageId, e.itemId);
  const out = entries.map((e): BoardMessage => {
    const m = e.message;
    const sent = m.direction === "out";
    const everyone = m.peer === "all";
    const to = sent ? (everyone ? m.receipts.map((r) => r.to) : [m.peer]) : [MAIN];
    let receipts: IrcReceipt[] = sent ? m.receipts : [];
    if (sent && (e.status === "pending" || e.status === "running")) receipts = to.map((t) => ({ to: t, outcome: "pending" }));
    else if (sent && (e.status === "error" || e.status === "aborted" || e.status === "denied") && !receipts.some((r) => r.outcome === "failed")) {
      receipts = (to.length ? to : [m.peer]).map((t) => ({ to: t, outcome: "failed", error: e.error }));
    }
    return {
      id: e.itemId,
      itemId: e.itemId,
      from: sent ? MAIN : m.peer,
      to,
      broadcast: m.broadcast || everyone,
      text: m.text,
      at: e.at,
      replyTo: m.replyTo ? rowOf.get(m.replyTo) : undefined,
      wakeRelay: m.wakeRelay,
      progress: false,
      receipts,
      rev: 0,
    };
  });
  return byTime(out);
}

// ── who is who ──

/** A sender or recipient as the board names it. */
export interface ChatAgent {
  id: string;
  kind: "main" | "subagent" | "user";
  /** Short name: a nested subagent's without the names of those it runs under ("Sweep"), "You", the session's name. */
  label: string;
  /** The subagents it runs under, outermost first (their short names); empty for the main agent's own. */
  under: string[];
  /** Its row in the session's roster, when listed. */
  sub?: Subagent;
}

/**
 * Names the agents of a session's tree: by the roster (`Subagent.parentId`, else omp's dotted ids,
 * `A.B` under `A`; ids, else names), `Main` as the session, `user` as You; an agent the roster
 * doesn't list by its dotted id.
 */
export function agentNamer(subs: readonly Subagent[], mainName: string): (id: string) => ChatAgent {
  const { nodes } = groupSubagents(subs);
  const byName = new Map<string, SubagentNode>();
  for (const n of nodes.values()) if (!byName.has(n.sub.name)) byName.set(n.sub.name, n);
  const known = new Map<string, ChatAgent>();
  const resolve = (id: string): ChatAgent => {
    if (id === USER) return { id, kind: "user", label: "You", under: [] };
    const node = nodes.get(id) ?? byName.get(id);
    if (node?.parent) {
      const under: string[] = [];
      for (let p: SubagentNode | undefined = node.parent; p; p = p.parent) under.unshift(p.label);
      return { id, kind: "subagent", label: node.label, under, sub: node.sub };
    }
    if (id === MAIN && !node) return { id, kind: "main", label: mainName, under: [] };
    // Top level, or under a parent the roster lacks: its dotted name says where.
    const parts = (node?.sub.name ?? id).split(".");
    return { id, kind: "subagent", label: parts[parts.length - 1] || id, under: parts.slice(0, -1), sub: node?.sub };
  };
  return (id) => {
    let a = known.get(id);
    if (!a) known.set(id, (a = resolve(id)));
    return a;
  };
}

/** "under PoolBench › Sweep" (nothing for the main agent's own subagents). */
export function positionText(a: ChatAgent): string {
  return a.under.length ? `under ${a.under.join(" › ")}` : "";
}

/** Where an agent sits, or what it is: "under PoolBench › Sweep", "main agent", "from TeleFlock", "subagent". */
export function roleText(a: ChatAgent): string {
  return positionText(a) || (a.kind === "main" ? "main agent" : a.kind === "user" ? "from TeleFlock" : "subagent");
}

/** Everyone who sent or got a message, with their message count. */
export interface Participant {
  agent: ChatAgent;
  count: number;
}

/**
 * The board's agents: the main agent first, then the subagents in the Subagents panel's tree order
 * (each one's own right after it), agents the roster doesn't list by first appearance, You last.
 */
export function participants(messages: readonly BoardMessage[], subs: readonly Subagent[], agentOf: (id: string) => ChatAgent): Participant[] {
  const count = new Map<string, number>();
  for (const m of messages) for (const id of new Set([m.from, ...m.to])) count.set(id, (count.get(id) ?? 0) + 1);
  const order = new Map(treeOrder(groupSubagents(subs)).map((s, i) => [s.id, i]));
  const ranked = [...count].map(([id, n], seen) => {
    const agent = agentOf(id);
    const listed = agent.sub && order.get(agent.sub.id);
    const rank = agent.kind === "main" ? -1 : agent.kind === "user" ? Number.MAX_SAFE_INTEGER : (listed ?? MAX_MESSAGES * 4 + seen);
    return { agent, count: n, rank };
  });
  return ranked.sort((a, b) => a.rank - b.rank).map(({ agent, count: n }) => ({ agent, count: n }));
}

// ── filters and unread ──

export interface BoardFilter {
  /** One agent: messages it sent or got; two: messages between them. */
  agents: readonly string[];
  /** Literal, case-folded, over the text and the names. */
  query: string;
}

export const NO_FILTER: BoardFilter = { agents: [], query: "" };

/** Whether `m` shows under `f`. */
export function matches(m: BoardMessage, f: BoardFilter, agentOf: (id: string) => ChatAgent): boolean {
  const [a, b] = f.agents;
  if (a !== undefined && b === undefined && m.from !== a && !m.to.includes(a)) return false;
  if (a !== undefined && b !== undefined && !((m.from === a && m.to.includes(b)) || (m.from === b && m.to.includes(a)))) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  if (m.text.toLowerCase().includes(q)) return true;
  return [m.from, ...m.to].some((id) => {
    const who = agentOf(id);
    return id.toLowerCase().includes(q) || who.label.toLowerCase().includes(q);
  });
}

export function filterMessages(messages: readonly BoardMessage[], f: BoardFilter, agentOf: (id: string) => ChatAgent): readonly BoardMessage[] {
  if (f.agents.length === 0 && !f.query.trim()) return messages;
  return messages.filter((m) => matches(m, f, agentOf));
}

/** Messages after `seenAt` that the user didn't write. */
export function unreadCount(messages: readonly BoardMessage[], seenAt: number): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as BoardMessage;
    if (m.at <= seenAt) break;
    if (m.from !== USER) n++;
  }
  return n;
}

/** The first message after `seenAt` the user didn't write (the board's "New" divider goes above it). */
export function firstUnread(messages: readonly BoardMessage[], seenAt: number): BoardMessage | undefined {
  return messages.find((m) => m.at > seenAt && m.from !== USER);
}

// ── delivery ──

/**
 * From this tf-hostd on, the log says `received` once the recipient's transcript has a message
 * omp queued for it (`injected`); an older one keeps `injected`.
 */
export const RECEIVED_MIN_HOSTD = "0.9.5";

/**
 * A recipient's state in words. omp's outcome once the send settled: `injected`, queued (the
 * recipient was busy: it takes the message in when its current step ends, after a long tool call
 * maybe minutes later); `woken`, it was idle and started a turn with it; `revived`, it was parked
 * and omp revived it with it. The log's `received`: the recipient's transcript has it.
 */
const STATE: Record<string, string> = { received: "delivered", woken: "woke it", revived: "revived it", injected: "queued" };

/** What a message's receipts say, for its status line. */
export type Delivery =
  | { kind: "none" }
  | { kind: "sending" }
  | { kind: "failed"; error?: string }
  /**
   * `delivered`: a recipient has it; `queued`: none has it yet, omp queued it for some. `label`:
   * one recipient's state ("delivered", "woke it", "queued"), else "2/3 delivered" ("3 queued"
   * while none has it). `queued`: the recipients it waits for.
   */
  | { kind: "delivered" | "queued"; label: string; queued: string[]; pending: number; failed: IrcReceipt[] };

export function deliveryOf(m: { receipts: readonly IrcReceipt[] }): Delivery {
  const r = m.receipts;
  if (r.length === 0) return { kind: "none" };
  const failed = r.filter((x) => x.outcome === "failed");
  const pending = r.filter((x) => x.outcome === "pending").length;
  if (failed.length === r.length) return { kind: "failed", error: failed.find((x) => x.error)?.error };
  if (pending === r.length) return { kind: "sending" };
  const queued = r.filter((x) => x.outcome === "injected").map((x) => x.to);
  const ok = r.length - failed.length - pending - queued.length;
  const kind = ok === 0 && queued.length > 0 ? "queued" : "delivered";
  const one = r.length === 1 ? (r[0] as IrcReceipt) : undefined;
  const label = one ? (STATE[one.outcome] ?? one.outcome) : kind === "queued" ? `${queued.length} queued` : `${ok}/${r.length} delivered`;
  return { kind, label, queued, pending, failed };
}

/** A part of a delivery line after its label. */
export interface DeliveryNote {
  tone: "queued" | "sending" | "failed";
  text: string;
}

/** What follows a delivery line's label: "1 queued", "2 sending", "not to Sweep" / "2 not delivered". */
export function deliveryNotes(d: Extract<Delivery, { label: string }>, name: (id: string) => string = (id) => id): DeliveryNote[] {
  const notes: DeliveryNote[] = [];
  if (d.kind === "delivered" && d.queued.length > 0) notes.push({ tone: "queued", text: `${d.queued.length} queued` });
  if (d.pending > 0) notes.push({ tone: "sending", text: `${d.pending} sending` });
  const [first] = d.failed;
  if (first) notes.push({ tone: "failed", text: d.failed.length === 1 ? `not to ${name(first.to)}` : `${d.failed.length} not delivered` });
  return notes;
}

/** One recipient's state in words ("delivered", "queued", "not delivered: …"). */
export function receiptText(r: IrcReceipt): string {
  if (r.outcome === "failed") return r.error ? `not delivered: ${r.error}` : "not delivered";
  if (r.outcome === "pending") return "sending";
  return STATE[r.outcome] ?? r.outcome;
}

/**
 * What the app can say of a queued message. `follows`: the host's log says when it reaches its
 * recipient (the message is the log's, tf-hostd ≥ 0.9.5); `oldHost`: the host's tf-hostd never does.
 */
export interface QueueWatch {
  follows: boolean;
  oldHost: boolean;
}

/** Why a message is still queued for its recipients `names`, for tooltips. */
export function queuedText(names: readonly string[], w: QueueWatch): string {
  const one = names.length === 1;
  const who = one ? (names[0] as string) : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} agents`;
  const its = one ? "its" : "their";
  if (w.follows) return `Waiting for ${who} to finish ${its} current step: omp queued the message until then.`;
  const unknown = w.oldHost ? `This host can't tell when that happens (tf-hostd ${RECEIVED_MIN_HOSTD} can).` : "TeleFlock can't tell yet whether that happened.";
  return `omp queued the message: ${who} ${one ? "gets" : "get"} it at ${its} next step.\n${unknown}`;
}

/**
 * A delivery line's tooltip: one recipient's state and what it means (why a queued message
 * waits, why one failed), or each recipient's state and why the queued ones wait.
 */
export function deliveryTip(receipts: readonly IrcReceipt[], d: Delivery, w: QueueWatch, name: (id: string) => string = (id) => id): string | undefined {
  if (d.kind === "none" || d.kind === "sending") return undefined;
  if (receipts.length > 1) {
    const lines = receipts.map((r) => `${name(r.to)}: ${receiptText(r)}`);
    if (d.kind !== "failed" && d.queued.length > 0) lines.push("", queuedText(d.queued.map(name), w));
    return lines.join("\n");
  }
  if (d.kind === "failed") return d.error;
  const r = receipts[0] as IrcReceipt;
  const who = name(r.to);
  if (r.outcome === "injected") return queuedText([who], w);
  if (r.outcome === "received") return `${who} has it`;
  if (r.outcome === "woken") return `${who} was idle: the message started its turn`;
  if (r.outcome === "revived") return `${who} was parked: omp revived it with the message`;
  return undefined;
}

/** An outbound IRC row of an agent's transcript, as the log is searched for it (`logEntryOf`). */
export interface SentRow {
  /** omp id of the agent whose transcript it is: the sender. */
  from: string;
  /** omp id of the recipient; `all`: a broadcast. */
  to: string;
  text: string;
  /** The row's time: the assistant message that made the call started then, so omp sent it then or later. */
  at: number;
}

/** A row and the log tell time by omp's clock; a row the host stamped itself (its call's start) can be this much late. */
const ROW_SLACK_MS = 3_000;

/** The same body: tf-hostd compares bodies trimmed and cuts a long one (marked `\n\n…`). */
function sameText(logged: string, row: string): boolean {
  return logged.trim() === row.trim() || (logged.endsWith("\n\n…") && row.startsWith(logged.slice(0, -3)));
}

/**
 * The log's message for an outbound row of a transcript: the same sender, recipient (a
 * broadcast's: a broadcast) and text, the first sent at or after the row's time (identical sends
 * pair up in order), else the last sent shortly before it. `messages`: oldest first.
 */
export function logEntryOf(messages: readonly BoardMessage[], row: SentRow): BoardMessage | undefined {
  const all = row.to === "all";
  let before: BoardMessage | undefined;
  for (const m of messages) {
    if (m.at < row.at - ROW_SLACK_MS || m.from !== row.from || m.broadcast !== all) continue;
    if ((!all && (m.to.length !== 1 || m.to[0] !== row.to)) || !sameText(m.text, row.text)) continue;
    if (m.at >= row.at) return m;
    before = m;
  }
  return before;
}

/**
 * A transcript row's receipts (omp's outcomes when the send settled) with what the log's message
 * for it adds: a recipient whose transcript has it (`received`) no longer waits in its queue. A
 * row without receipts (an omp before them) takes the log's.
 */
export function rowReceipts(row: readonly IrcReceipt[], logged: Pick<BoardMessage, "receipts"> | undefined): readonly IrcReceipt[] {
  if (!logged) return row;
  if (row.length === 0) return logged.receipts;
  const got = new Set(logged.receipts.flatMap((r) => (r.outcome === "received" ? [r.to] : [])));
  return got.size === 0 ? row : row.map((r) => (r.outcome === "injected" && got.has(r.to) ? { ...r, outcome: "received" } : r));
}

/** One line of a message for previews: Markdown marks and line breaks gone. */
export function previewText(text: string): string {
  return text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

/** "Sweep", "Sweep, Size16 +2", "everyone": a message's recipients in a line. */
export function recipientsText(to: readonly string[], broadcast: boolean, agentOf: (id: string) => ChatAgent): string {
  if (broadcast) return "everyone";
  const names = to.slice(0, 2).map((id) => agentOf(id).label);
  return to.length > 2 ? `${names.join(", ")} +${to.length - 2}` : names.join(", ");
}
