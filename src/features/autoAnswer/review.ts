import type { Agent, AutoDecision } from "@/core/gen";
import { askText } from "@/features/inbox/askText";
import { formatWait, starPicks } from "./format";

/*
 * Decide for me's review (architecture §3.23 "Review"): the questions it answered that nobody
 * looked at yet (`HostInfo.decisions`, hosts ≥ 0.9.0), as the Inbox's "Decided for you" lists
 * them, and the follow-up that changes an answer. Pure, tested (`review.test.ts`).
 */

/** A decision with the host it was made on. */
export type HostDecision = AutoDecision & { hostId: string };

/** What a person picks instead: option labels, and typed ("Other") text. */
export interface AnswerChoice {
  labels: readonly string[];
  text?: string;
}

/** `<hostId>/<id>`: a decision across hosts. */
export function decisionKey(d: Pick<HostDecision, "hostId" | "id">): string {
  return `${d.hostId}/${d.id}`;
}

/**
 * Every host's unreviewed decisions, oldest first (`at`; at the same time, host order, then the
 * host's own order). `hidden` (`decisionKey`s) are left out: marked reviewed here, before the
 * host's state drops them.
 */
export function collectDecisions(
  hosts: Readonly<Record<string, { state: { info: { decisions?: readonly AutoDecision[] } } } | undefined>>,
  order: readonly string[],
  hidden: Readonly<Record<string, true>> = {},
): HostDecision[] {
  const ids = [...order.filter((id) => hosts[id]), ...Object.keys(hosts).filter((id) => !order.includes(id))];
  const out: HostDecision[] = [];
  for (const hostId of ids) {
    for (const d of hosts[hostId]?.state.info.decisions ?? []) {
      if (!hidden[`${hostId}/${d.id}`]) out.push({ ...d, hostId });
    }
  }
  // Array.prototype.sort is stable: equal times keep the order above.
  return out.sort((a, b) => a.at - b.at);
}

/** Two lists show the same decisions in the same order (decisions never change once made). */
export function sameDecisions(a: readonly HostDecision[], b: readonly HostDecision[]): boolean {
  return a === b || (a.length === b.length && a.every((d, i) => d.id === b[i]?.id && d.hostId === b[i]?.hostId));
}

/** Unreviewed decisions made at or after `since` (host clock): a "While you were away" digest. */
export function decidedSince(decisions: readonly Pick<AutoDecision, "at">[] | undefined, since: number): number {
  return (decisions ?? []).filter((d) => d.at >= since).length;
}

/**
 * The agent a decision belongs to on its host's board: the one with its id, unless that pane went on to
 * another omp session (`/new`: the id stays, the conversation that was asked is gone), else the agent that
 * continues its omp session (a parked agent resumed later runs under a new id; decisions keep the old one).
 * Undefined: the agent ended and left the board, or its session did.
 */
export function decisionAgent<A extends Pick<Agent, "id" | "omp" | "parked">>(d: Pick<AutoDecision, "agentId" | "sessionId" | "sessionFile">, agents: readonly A[]): A | undefined {
  const byId = agents.find((a) => a.id === d.agentId);
  const now = byId?.omp?.sessionId;
  if (byId && !(d.sessionId && now && now !== d.sessionId)) return byId;
  if (d.sessionId) {
    const bySession = agents.find((a) => a.omp?.sessionId === d.sessionId);
    if (bySession) return bySession;
  }
  if (!d.sessionFile) return undefined;
  return agents.find((a) => a.omp?.sessionFile === d.sessionFile || a.parked?.sessionFile === d.sessionFile);
}

/** What was sent: the picked options' labels in their order, and the typed text. */
export function sentChoice(d: Pick<AutoDecision, "options" | "text">): { labels: string[]; text?: string } {
  const labels = d.options.filter((o) => o.picked).map((o) => o.label);
  const text = d.text?.trim();
  return text ? { labels, text } : { labels };
}

/** "★ Use SQLite", "★ A, ★ B", or "your earlier answer (Postgres, “keep SQLite for tests”)". */
export function pickedText(d: Pick<AutoDecision, "options" | "text" | "earlier">): string {
  const { labels, text } = sentChoice(d);
  const typed = text ? [`“${text}”`] : [];
  if (d.earlier) return `your earlier answer (${[...labels, ...typed].join(", ") || "as it was"})`;
  return [starPicks(labels), ...typed].join(", ");
}

/** The options that were not sent, in their order (★ tells the recommendation apart). */
export function otherOptions(d: Pick<AutoDecision, "options">): { label: string; recommended: boolean }[] {
  return d.options.filter((o) => !o.picked).map((o) => ({ label: o.label, recommended: o.recommended }));
}

/** The question as a row shows it: omp's title above it when the title adds something. */
export function decisionQuestion(d: Pick<AutoDecision, "title" | "question">): { title?: string; question: string } {
  const { headline, body } = askText({ title: d.title, message: d.question });
  return body === null ? { question: headline } : { title: headline, question: body };
}

/** How long it waited for a person, and whose setting answered: "waited 20 min · host default", "waited 30 min · its own setting" (the agent's). */
export function decisionMeta(d: Pick<AutoDecision, "waitedMs" | "source">): string {
  return `waited ${formatWait(d.waitedMs / 1000)} · ${d.source === "host" ? "host default" : "its own setting"}`;
}

/**
 * Why "Change answer" can't tell the agent now: its host is offline, it ended (left the board, or
 * parked: resume it first), or it waits for an answer to another question (omp takes no prompt
 * then). Null: it can.
 */
export type ChangeBlock = "offline" | "ended" | "waiting";

export function changeBlock(agent: Pick<Agent, "parked" | "state" | "needs"> | undefined, online: boolean): ChangeBlock | null {
  if (!agent || agent.parked) return "ended";
  if (!online) return "offline";
  if (agent.state === "blocked" && agent.needs?.answerable) return "waiting";
  return null;
}

/** The visible reason next to the disabled button. */
export function changeBlockText(block: ChangeBlock, agentName: string, hostName: string): string {
  switch (block) {
    case "ended":
      return `${agentName} has ended: resume it to tell it`;
    case "offline":
      return `${hostName} is offline: connect it to tell ${agentName}`;
    case "waiting":
      return `${agentName} is waiting for your answer to another question: answer that first`;
  }
}

/** Something is picked, and it is not what was sent: only then does "Send" send. */
export function choiceChanged(d: Pick<AutoDecision, "options" | "text">, choice: AnswerChoice): boolean {
  const text = choice.text?.trim() || undefined;
  if (choice.labels.length === 0 && !text) return false;
  const sent = sentChoice(d);
  const picked = new Set(choice.labels);
  const sameLabels = picked.size === sent.labels.length && sent.labels.every((l) => picked.has(l));
  return !(sameLabels && text === sent.text);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const quoted = (items: readonly string[]) => items.map((s) => `“${s}”`).join(", ");

/**
 * The message that changes an answer decide for me sent (`agent.prompt`: the question is gone, so
 * no `agent.answer`), from the user to the agent:
 * `Your question “Which database?” was answered automatically while I was away (decide for me
 * picked “Use SQLite”). Please go with “Use Postgres” instead.` Empty for an empty choice.
 */
export function changeAnswerMessage(d: Pick<AutoDecision, "title" | "question" | "options" | "text" | "earlier">, choice: AnswerChoice): string {
  const typed = choice.text?.trim();
  const wanted = [...choice.labels.map(oneLine), ...(typed ? [oneLine(typed)] : [])].filter(Boolean);
  if (wanted.length === 0) return "";
  const asked = oneLine(d.question) || oneLine(d.title);
  // the question names what to change; a long one is cut to a recognisable start
  const subject = asked ? `Your question ${quoted([asked.length > 160 ? `${asked.slice(0, 159).trimEnd()}…` : asked])}` : "Your question";
  const sent = sentChoice(d);
  const was = [...sent.labels.map(oneLine), ...(sent.text ? [oneLine(sent.text)] : [])];
  const how = was.length === 0 ? "" : d.earlier ? ` (decide for me sent my earlier answer ${quoted(was)})` : ` (decide for me picked ${quoted(was)})`;
  return `${subject} was answered automatically while I was away${how}. Please go with ${quoted(wanted)} instead.`;
}

/**
 * The Inbox's nav badge: what needs you plus the decisions to review; `calm` when only decisions
 * are there (nothing waits on you, so no sunset).
 */
export function inboxBadge(needs: number, decided: number): { count: number; calm: boolean } {
  return { count: needs + decided, calm: needs === 0 && decided > 0 };
}
