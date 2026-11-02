/**
 * Chat tasks (architecture §3.31): an omp agent with no repository or folder of the user's, like a
 * chat app with omp's tools. The host makes a folder for it (`<hostd home>/chats/<name>-<id>/`, empty,
 * never a repository), starts it with the usual launch recipe (`agent.start` with the `chat` target)
 * and opens it in its herdr workspace for chats. The board marks it (`Agent.chat`): no repo, branch,
 * worktree, review or ship affordances. Hosts that start chats say so with `HostInfo.chats`; older
 * daemons refuse the target (`invalid_params`) and the `chat.*` methods (`unknown_method`).
 */
import type { Agent, HostInfo, StartTarget } from "./gen";
import { isApiError } from "./errors";

/**
 * Dispatch's "No folder · chat" choice: stands where a repository root (single host) or a repository
 * id (Auto) goes in thread keys, draft keys and `lastRepo`. Never a path nor a repository id.
 */
export const CHAT_REPO = "chat:";

export function isChatRepo(repo: string | null | undefined): boolean {
  return repo === CHAT_REPO;
}

/** `agent.start`'s target for a new chat. */
export const CHAT_TARGET: StartTarget = { kind: "chat" };

/** The agent is a chat task. */
export function isChat(agent: Pick<Agent, "chat"> | null | undefined): boolean {
  return agent?.chat === true;
}

/** The host's daemon starts chat tasks. Unknown (no host info yet) counts as no. */
export function hostTakesChats(info: Pick<HostInfo, "chats"> | null | undefined): boolean {
  return !!info?.chats;
}

/** What to tell the user about a host whose daemon predates chat tasks. */
export const CHATS_NEED_UPDATE = {
  title: "This host can't start chats yet",
  hint: "Update TeleFlock's daemon on it (Hosts → Update), then try again",
} as const;

/**
 * A rejection that means the host's daemon predates chat tasks: `agent.start` with the `chat` target
 * fails to parse there (`invalid_params`, "unknown variant `chat`"), the `chat.*` methods are unknown.
 */
export function chatsUnsupported(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.code === "unknown_method") return /`chat\./.test(e.message);
  return e.code === "invalid_params" && /unknown variant `chat`/.test(e.message);
}
