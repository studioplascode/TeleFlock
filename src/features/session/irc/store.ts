import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { core, parseAgentKey, toApiError, useAgent, useCore, useIrcEntries, useSession } from "@/core";
import { useWindowVisible } from "@/design";
import { type BoardMessage, type ChatLog, fromTranscript, mergeChatPage, unreadCount } from "./chat";
import { readMark, seenScope, useIrcSeen } from "./seen";

/**
 * Each session's agent chat log as the app holds it (`session.agentChat`, hosts ≥ 0.9.0): fetched
 * whole once, then only what changed after the revision held, whenever `SessionMeta.agentChat`
 * names a newer one (or another epoch: the log was rebuilt). Shared by the inspector card, the
 * phone's Chat tab and the message board.
 */

interface Entry {
  log?: ChatLog;
  loading: boolean;
  /** Why the last fetch failed. */
  error?: string;
}

const useLogs = create<{ logs: Record<string, Entry> }>()(() => ({ logs: {} }));

function update(key: string, change: (e: Entry) => Entry): void {
  useLogs.setState((s) => ({ logs: { ...s.logs, [key]: change(s.logs[key] ?? { loading: false }) } }));
}

const inflight = new Map<string, Promise<void>>();
/** Asked again while a fetch ran: one more follows it. */
const again = new Set<string>();

/** Brings the session's copy up to date: one request at a time per session. */
export function syncAgentChat(key: string): Promise<void> {
  const running = inflight.get(key);
  if (running) {
    again.add(key);
    return running;
  }
  const { hostId, agentId } = parseAgentKey(key);
  const run = (async () => {
    do {
      again.delete(key);
      const have = useLogs.getState().logs[key]?.log;
      update(key, (e) => ({ ...e, loading: true }));
      try {
        const page = await core.host(hostId).call("session.agentChat", have ? { agentId, epoch: have.epoch, after: have.rev } : { agentId });
        update(key, (e) => ({ log: mergeChatPage(e.log, page), loading: false }));
      } catch (err) {
        const e = toApiError(err);
        update(key, (x) => ({ ...x, loading: false, error: e.hint ? `${e.message} (${e.hint})` : e.message }));
        break;
      }
    } while (again.has(key));
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** How often a log the host reads from files (an older bridge) is fetched again: while the message board shows, and while the inspector card does. */
export const BOARD_POLL_MS = 3000;
export const CARD_POLL_MS = 10_000;

export interface AgentChatView {
  /** `log`: the whole agent tree (the host's log); `transcript`: the session's own IRC rows (hosts before 0.9.0, or the log can't be read). */
  source: "log" | "transcript";
  /** Oldest first. */
  messages: readonly BoardMessage[];
  /** The first fetch is in flight. */
  loading: boolean;
  /** Why the log couldn't be read (the copy, or the transcript's rows, stay shown). */
  error?: string;
  /** The host dropped its oldest messages. */
  truncated: boolean;
  /** Fetch again now. */
  refresh(): void;
}

/**
 * A session's agent chat. With `pollMs`, a log the host can't follow by itself (an older bridge:
 * it re-reads the transcript files on each fetch) is fetched again that often while the window is
 * visible; a live one moves with the session's meta.
 */
export function useAgentChat(agentKey: string, pollMs?: number): AgentChatView {
  const { meta } = useSession(agentKey);
  const info = meta?.agentChat;
  const entry = useLogs((s) => s.logs[agentKey]);
  const rows = useIrcEntries(agentKey);
  const transcript = useMemo(() => fromTranscript(rows), [rows]);
  const visible = useWindowVisible();
  const epoch = info?.epoch;
  const rev = info?.rev ?? 0;
  const live = info?.live ?? false;
  const held = entry?.log;
  const behind = epoch !== undefined && (held?.epoch !== epoch || held.rev < rev);
  const failed = entry?.error !== undefined;

  // What the meta names is newer than the copy. A failed fetch is tried again at the next change (or Retry).
  useEffect(() => {
    if (behind) void syncAgentChat(agentKey);
  }, [agentKey, behind, epoch, rev]);

  // A log read from files: again while shown, and when the session's own IRC rows change.
  useEffect(() => {
    if (epoch === undefined || live || !pollMs || !visible) return;
    void syncAgentChat(agentKey);
    const timer = window.setInterval(() => void syncAgentChat(agentKey), pollMs);
    return () => clearInterval(timer);
  }, [agentKey, epoch, live, pollMs, visible, rows.length]);

  const useLog = epoch !== undefined && (held !== undefined || !failed);
  return {
    source: useLog ? "log" : "transcript",
    messages: useLog ? (held?.messages ?? []) : transcript,
    loading: useLog && held === undefined,
    error: entry?.error,
    truncated: useLog && (held?.truncated ?? false),
    refresh: () => {
      update(agentKey, (e) => ({ ...e, error: undefined }));
      void syncAgentChat(agentKey);
    },
  };
}

/** The session's read mark: where it is kept (`seenScope`) and the newest `at` read. */
export function useSeenMark(agentKey: string): { scope: string; at: number } {
  const scope = seenScope(agentKey, useAgent(agentKey)?.omp?.sessionId);
  const at = useIrcSeen((s) => readMark(s.board, scope, agentKey));
  return { scope, at };
}

/** Messages of the session's agent chat the user hasn't seen on the message board (on this device). */
export function useChatUnread(agentKey: string, messages: readonly BoardMessage[]): number {
  const { at } = useSeenMark(agentKey);
  return useMemo(() => unreadCount(messages, at), [messages, at]);
}

/** The session has subagents or agent chat: its menus offer the message board. */
export function useHasAgentChat(agentKey: string): boolean {
  return useCore((s) => {
    const meta = s.sessions[agentKey]?.meta;
    return meta !== undefined && (meta.subagents.length > 0 || (meta.agentChat?.count ?? 0) > 0);
  });
}
