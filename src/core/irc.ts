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

/** All messages exchanged with one peer. */
export interface IrcThread {
  peer: string;
  /** Oldest first. */
  entries: IrcEntry[];
  last: IrcEntry;
  inbound: number;
  outbound: number;
}

/** Group entries by peer, most recently active peer first. */
export function ircThreads(entries: readonly IrcEntry[]): IrcThread[] {
  const byPeer = new Map<string, IrcEntry[]>();
  for (const e of entries) {
    const list = byPeer.get(e.message.peer);
    if (list) list.push(e);
    else byPeer.set(e.message.peer, [e]);
  }
  const threads: IrcThread[] = [];
  for (const [peer, list] of byPeer) {
    list.sort((a, b) => a.at - b.at);
    const inbound = list.filter((e) => e.message.direction === "in").length;
    threads.push({ peer, entries: list, last: list[list.length - 1] as IrcEntry, inbound, outbound: list.length - inbound });
  }
  return threads.sort((a, b) => b.last.at - a.last.at);
}

/** Inbound messages newer than `seenAt` (unread since the last view). */
export function ircUnread(thread: IrcThread, seenAt: number | undefined): number {
  return thread.entries.filter((e) => e.message.direction === "in" && e.at > (seenAt ?? 0)).length;
}
