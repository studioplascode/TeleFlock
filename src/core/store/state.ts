import type {
  ActivityEvent,
  ActivityPage,
  Agent,
  ApiError,
  AppEvent,
  ConnStatus,
  HistoryPage,
  HostProfile,
  HostState,
  HostsListResult,
  Notification,
  SessionMeta,
  Settings,
  TranscriptItem,
  TunnelInfo,
  UiRequest,
} from "@/core/gen";
import type { Backend } from "@/core/transport/types";

/** An agent with its host attached. `key` = `${hostId}::${id}`. */
export type AgentView = Agent & { hostId: string; key: string };

/**
 * `read`: seen or acted on (here, in the OS, or by opening the agent). `resolved`: the needs-you
 * request it asked about was handled (anywhere); its answers are no longer offered.
 */
export type HostNotification = Notification & { hostId: string; read: boolean; resolved?: boolean };

export type HostActivityEvent = ActivityEvent & { hostId: string };

export interface HostEntry {
  /** Last applied revision; `null` = unknown (accept and adopt the next patch's rev). */
  rev: number | null;
  state: HostState;
}

export type SessionStatus = "idle" | "loading" | "live" | "ended" | "error";

/** One turn of a side conversation as streamed (`question` arrives with its first event). */
export interface BtwTurnView {
  question?: string;
  text: string;
  done: boolean;
}

/** One `/btw` side conversation: the question, then its follow-ups. Turns never seen live are holes. */
export interface BtwEntry {
  turns: (BtwTurnView | undefined)[];
}

export interface SessionEntry {
  status: SessionStatus;
  meta?: SessionMeta;
  /** Transcript row ids, oldest first. Replaced only when order/membership changes. */
  itemIds: string[];
  items: Record<string, TranscriptItem>;
  /** `undefined` until loaded, then the pending dialog or `null`. */
  ui?: UiRequest | null;
  hasMore: boolean;
  cursor?: string;
  error?: ApiError;
  endedReason?: string;
  btw: Record<string, BtwEntry>;
}

export interface ActivityEntry {
  events: HostActivityEvent[];
  hasMore: boolean;
  loaded: boolean;
}

export interface CoreState {
  backend: Backend;
  profiles: HostProfile[];
  profilesLoaded: boolean;
  status: Record<string, ConnStatus>;
  hosts: Record<string, HostEntry>;
  agents: Record<string, AgentView>;
  sessions: Record<string, SessionEntry>;
  notifications: HostNotification[];
  activity: Record<string, ActivityEntry>;
  settings: Settings | null;
  tunnels: TunnelInfo[];
}

/** Synthetic events the client feeds through the same ordered pipeline as AppEvents. */
export type InternalEvent =
  | { type: "$hostsList"; result: HostsListResult }
  /** `state.get` result (resync / refresh). Keeps the tracked revision. */
  | { type: "$stateGet"; hostId: string; state: HostState }
  | { type: "$history"; hostId: string; agentId: string; page: HistoryPage }
  | { type: "$sessionLoading"; hostId: string; agentId: string }
  | { type: "$sessionError"; hostId: string; agentId: string; error: ApiError }
  | { type: "$sessionDrop"; hostId: string; agentId: string }
  | { type: "$activity"; hostId: string; page: ActivityPage; append: boolean };

export type CoreEvent = AppEvent | InternalEvent;

/** Side effects the reducer asks the client to perform after a flush. */
export type Effect =
  | { kind: "resync"; hostId: string }
  /** A host became online again: reopen its live sessions. */
  | { kind: "hostOnline"; hostId: string }
  /** Agents changed lanes on this host (activity refresh trigger). */
  | { kind: "lanes"; hostId: string }
  | { kind: "openAgent"; hostId: string; agentId: string }
  /** An agent's collab link became live while its open session is in error: reopen it. */
  | { kind: "relink"; hostId: string; agentId: string }
  | { kind: "answerNext" };

export function initialCoreState(backend: Backend): CoreState {
  return {
    backend,
    profiles: [],
    profilesLoaded: false,
    status: {},
    hosts: {},
    agents: {},
    sessions: {},
    notifications: [],
    activity: {},
    settings: null,
    tunnels: [],
  };
}

export function emptySession(status: SessionStatus): SessionEntry {
  return { status, itemIds: [], items: {}, hasMore: false, btw: {} };
}
