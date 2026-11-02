/**
 * What a browser request card shows: an agent's `use_user_browser` request as this device can
 * answer it. Pure; the cards (session, panel) and their tests use it.
 */
import type { Agent, BrowserRequest, BrowserScope, BrowserStatus } from "@/core/gen";

export type RequestPhase =
  /** Allow for this session / Allow once / Deny. */
  | "ask"
  /** Allowed, but `cap` agents use the browser: it attaches when one is detached. Allow anyway / Deny. */
  | "waiting"
  /** This device has no browser (a phone, a core without it): Deny here, allow on a computer. */
  | "elsewhere";

export interface RequestView {
  requestId: string;
  hostId: string;
  agentId: string;
  agentName: string;
  reason: string;
  at: number;
  phase: RequestPhase;
  /** Agents attached now, and how many may be. */
  using: number;
  cap: number;
  /** The scope it was allowed with (waiting). */
  scope?: BrowserScope;
}

function fromStatus(r: BrowserRequest, status: BrowserStatus): RequestView {
  return {
    requestId: r.id,
    hostId: r.hostId,
    agentId: r.agentId,
    agentName: r.agentName,
    reason: r.reason,
    at: r.at,
    phase: r.waiting ? "waiting" : "ask",
    using: status.attachments.length,
    cap: status.cap,
    scope: r.scope,
  };
}

/** Every request this device's browser has, oldest first (the panel). */
export function requestViews(status: BrowserStatus | null): RequestView[] {
  if (!status) return [];
  return [...status.requests].sort((a, b) => a.at - b.at).map((r) => fromStatus(r, status));
}

/** What a request card reads of an agent (an `AgentView` fits). */
export type RequestAgent = Pick<Agent, "id" | "name" | "needs" | "browser"> & { hostId: string };

/**
 * The request of one agent (its session card): from the browser's list when this device can
 * answer it, else from the agent's own card (`Agent.browser.request`, or its needs on hosts that
 * only report those), answerable with Deny only.
 */
export function agentRequestView(agent: RequestAgent, status: BrowserStatus | null, canHost: boolean): RequestView | null {
  const listed = status?.requests.find((r) => r.hostId === agent.hostId && r.agentId === agent.id);
  if (listed && status && canHost) return fromStatus(listed, status);
  const ask = agent.browser?.request;
  const needs = agent.needs?.browser ? agent.needs : undefined;
  const requestId = ask?.id ?? needs?.requestId;
  if (!requestId) return null;
  return {
    requestId,
    hostId: agent.hostId,
    agentId: agent.id,
    agentName: agent.name,
    reason: ask?.reason ?? needs?.question ?? "",
    at: ask?.at ?? needs?.since ?? 0,
    phase: canHost ? "ask" : "elsewhere",
    using: status?.attachments.length ?? 0,
    cap: status?.cap ?? 0,
  };
}

/** "Waiting for the browser: 4 agents use it". */
export function waitingText(using: number, cap: number): string {
  const n = Math.max(using, cap);
  return `Waiting for the browser: ${n} ${n === 1 ? "agent uses" : "agents use"} it`;
}

/** The one line a notification or a compact row says about a request. */
export function requestLine(v: Pick<RequestView, "agentName" | "reason">): string {
  const reason = v.reason.trim();
  return reason ? `${v.agentName} wants to use your browser: ${reason}` : `${v.agentName} wants to use your browser`;
}
