import type { IrcMessage, ToolStatus, TranscriptItem } from "@/core/gen";

/**
 * One omp IRC (agent ↔ agent) message in a transcript: an inbound `irc` row, or the `write
 * agent://<id>` / `wait` tool call that carried it (`tool.view.type === "irc"`).
 */
export interface IrcEntry {
  /** Transcript row id (jump target). */
  itemId: string;
  /** When the message was sent (omp's own time; a `wait` row's `at` is the call's start). */
  at: number;
  message: IrcMessage;
  /** Carried by a tool call: its status is the send's delivery state (pending → ok/error). */
  status?: ToolStatus;
  error?: string;
}

/** The IRC message a transcript row carries, if any. */
export function ircOf(item: TranscriptItem | undefined): IrcEntry | null {
  if (!item) return null;
  if (item.kind === "irc") return { itemId: item.id, at: item.message.sentAt ?? item.at, message: item.message };
  if (item.kind === "tool" && item.view?.type === "irc") {
    const { type: _type, ...message } = item.view;
    return { itemId: item.id, at: message.sentAt ?? item.at, message, status: item.status, error: item.error };
  }
  return null;
}
