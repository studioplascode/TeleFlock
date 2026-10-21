import { ChevronDown, CornerDownLeft, ExternalLink, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { draftKey, drafts, type IrcEntry, type IrcThread, ircThreads, ircUnread, parseAgentKey, useDraft, useIrcEntries, useSession } from "@/core";
import type { Subagent } from "@/core/gen";
import { AgentGlyph, cn, formatAge, IconButton, Input, Spinner, useNow } from "@/design";
import { hostCall, usePending } from "../api";
import { Markdown } from "../markdown/Markdown";
import { useSessionUi } from "../state";
import { SUB_LABEL, SUB_STATUS } from "../subagents/Subagents";
import { peerTint, usePeerSub } from "./IrcBubble";
import { useIrcSeen } from "./seen";

/** Unread inbound IRC messages in a session (for tab badges). */
export function useIrcUnreadCount(agentKey: string): number {
  const entries = useIrcEntries(agentKey);
  const seen = useIrcSeen((s) => s.seen[agentKey]);
  return useMemo(() => entries.filter((e) => e.message.direction === "in" && e.at > (seen?.[e.message.peer] ?? 0)).length, [entries, seen]);
}

/** Messages shown per thread before "Show all". */
const THREAD_TAIL = 6;

/**
 * The session's IRC conversations grouped by peer, most recent first. Each peer shows counts and
 * unread messages; expanding a thread marks it read, every message jumps to its transcript row,
 * and subagent peers open in the subagent viewer or take a direct message.
 */
export function ChatThreads({ agentKey }: { agentKey: string }) {
  const entries = useIrcEntries(agentKey);
  const threads = useMemo(() => ircThreads(entries), [entries]);
  const seen = useIrcSeen((s) => s.seen[agentKey]);
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      {threads.map((t) => (
        <ThreadCard
          key={t.peer}
          agentKey={agentKey}
          thread={t}
          unread={ircUnread(t, seen?.[t.peer])}
          open={openPeer === t.peer}
          onToggle={() => setOpenPeer((p) => (p === t.peer ? null : t.peer))}
          onView={(id) => useSessionUi.getState().openSubagent(agentKey, id)}
        />
      ))}
    </div>
  );
}

function ThreadCard({
  agentKey,
  thread,
  unread,
  open,
  onToggle,
  onView,
}: {
  agentKey: string;
  thread: IrcThread;
  unread: number;
  open: boolean;
  onToggle: () => void;
  onView: (subId: string) => void;
}) {
  const sub = usePeerSub(agentKey, thread.peer);
  const now = useNow(30_000);
  const name = thread.peer === "all" ? "Broadcasts" : (sub?.name ?? thread.peer);
  const last = thread.last;
  return (
    <div className={cn("overflow-hidden rounded-[14px] transition-colors", open ? "bg-[rgb(10_10_16/0.45)] shadow-hairline" : "hover:bg-white/[0.03]")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left">
        <AgentGlyph name={thread.peer} size={30} status={sub ? SUB_STATUS[sub.status] : undefined} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <b className={cn("truncate text-[12.5px] font-extrabold", unread ? "text-ink" : "text-ink-2")}>{name}</b>
            <span className="shrink-0 text-[10.5px] font-semibold text-mute-2 tabular">
              {thread.inbound} in · {thread.outbound} out
            </span>
          </span>
          <span className={cn("block truncate text-[11.5px]", unread ? "font-semibold text-ink-2" : "text-mute")}>
            {last.message.direction === "out" ? "Sent: " : ""}
            {last.message.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim() || "(empty)"}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10.5px] font-semibold text-mute-2 tabular">{formatAge(now - last.at)}</span>
          {unread > 0 ? (
            <span className="inline-grid h-[17px] min-w-[17px] place-items-center rounded-full bg-accent px-1.5 text-[10px] leading-none font-extrabold text-white tabular shadow-[0_0_12px_rgb(163_92_240/0.6)]" aria-label={`${unread} unread`}>
              {unread}
            </span>
          ) : (
            <ChevronDown className={cn("size-3.5 text-mute-2 transition-transform", !open && "-rotate-90")} />
          )}
        </span>
      </button>
      {open && <ThreadBody agentKey={agentKey} thread={thread} sub={sub} onView={onView} />}
    </div>
  );
}

function ThreadBody({ agentKey, thread, sub, onView }: { agentKey: string; thread: IrcThread; sub?: Subagent; onView: (subId: string) => void }) {
  const markSeen = useIrcSeen((s) => s.markSeen);
  // Unread as of opening the thread: the "new" divider stays put while it is read.
  const [since] = useState(() => useIrcSeen.getState().seen[agentKey]?.[thread.peer] ?? 0);
  const [all, setAll] = useState(false);
  useEffect(() => markSeen(agentKey, thread.peer, thread.last.at), [agentKey, thread.peer, thread.last.at, markSeen]);
  const shown = all ? thread.entries : thread.entries.slice(-THREAD_TAIL);
  const firstNew = shown.find((e) => e.message.direction === "in" && e.at > since);
  const jump = (itemId: string) => {
    const ui = useSessionUi.getState();
    ui.setSheet(agentKey, false);
    ui.focusItem(agentKey, itemId);
  };
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5 pb-2">
      {thread.entries.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="focus-ring self-center rounded-full px-2 py-0.5 text-[11px] font-bold text-mute hover:bg-white/[0.05] hover:text-ink-2">
          Show all {thread.entries.length}
        </button>
      )}
      {shown.map((e) => (
        <div key={e.itemId}>
          {e === firstNew && (
            <div className="my-1 flex items-center gap-2 text-[10px] font-extrabold tracking-[0.1em] text-accent-hi uppercase" role="separator">
              <span className="h-px flex-1 bg-accent/40" />
              new
              <span className="h-px flex-1 bg-accent/40" />
            </div>
          )}
          <MiniMessage entry={e} onJump={() => jump(e.itemId)} />
        </div>
      ))}
      {sub && (
        <div className="mt-1 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onView(sub.id)}
            className="focus-ring pressable flex items-center justify-center gap-1.5 rounded-md bg-white/[0.05] py-1.5 text-[11.5px] font-bold text-ink-2 shadow-hairline hover:bg-white/[0.09]"
          >
            <ExternalLink className="size-3.5" /> Open {sub.name} · {SUB_LABEL[sub.status]}
          </button>
          <DirectMessage agentKey={agentKey} sub={sub} />
        </div>
      )}
    </div>
  );
}

/** One message in a thread: inbound left, outbound right; click jumps to its transcript row. */
function MiniMessage({ entry, onJump }: { entry: IrcEntry; onJump: () => void }) {
  const out = entry.message.direction === "out";
  const now = useNow(30_000);
  const sending = entry.status === "pending" || entry.status === "running";
  const failed = entry.status === "error" || (entry.message.receipts.length > 0 && entry.message.receipts.every((r) => r.outcome === "failed"));
  return (
    // A div, not a <button>: the Markdown body may hold links.
    <div
      role="button"
      tabIndex={0}
      onClick={onJump}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onJump();
        }
      }}
      title="Show in transcript"
      className={cn("group/msg focus-ring flex w-full cursor-pointer flex-col gap-0.5 rounded-[12px] text-left", out ? "items-end" : "items-start")}
    >
      <div
        className={cn("max-w-[92%] rounded-[14px] px-2.5 py-1.5 transition-[filter] group-hover/msg:brightness-125", out ? "rounded-tr-[5px]" : "rounded-tl-[5px]")}
        style={peerTint(entry.message.peer, out ? 0.55 : 1)}
      >
        <div className="max-h-[78px] overflow-hidden [mask-image:linear-gradient(#000_60px,transparent)]">
          <Markdown text={entry.message.text || "(empty)"} className="text-[12px] leading-[1.5] text-ink" />
        </div>
      </div>
      <span className="flex items-center gap-1.5 px-1 text-[10px] font-semibold text-mute-2 tabular">
        {out && (sending ? <Spinner size={9} label="sending" /> : failed ? <span className="text-error">not delivered</span> : <span className="text-done/80">✓</span>)}
        {entry.message.wakeRelay && <span>auto-reply</span>}
        {formatAge(now - entry.at)}
        <CornerDownLeft className="size-2.5 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-visible/msg:opacity-100" aria-hidden />
      </span>
    </div>
  );
}

/**
 * Message a subagent directly. omp has no way for an outside client to post on the IRC bus, so
 * this uses the subagent chat path (collab `agent-cmd chat`): the text lands in the subagent's
 * session as a user message (steering it when busy), not as IRC from this agent.
 */
function DirectMessage({ agentKey, sub }: { agentKey: string; sub: Subagent }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const key = draftKey("irc.dm", agentKey, sub.id);
  const [text, setText] = useDraft(key);
  const [busy, run] = usePending();
  const disabled = !meta?.caps.subagents;
  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    const res = await run(hostCall(hostId, "agent.subagent", { agentId, subagentId: sub.id, action: "chat", message }, { success: `Sent to ${sub.name}`, failure: `Couldn't message ${sub.name}` }));
    if (!res.ok) return;
    // Only what was sent: anything typed while sending stays in the draft.
    const cur = drafts.get(key);
    drafts.set(key, cur.startsWith(text) ? cur.slice(text.length).trimStart() : cur);
  };
  return (
    <div>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={disabled}
        placeholder={disabled ? "Messaging subagents needs a live session" : `Message ${sub.name}…`}
        aria-label={`Message ${sub.name}`}
        trailing={
          <IconButton label="Send" size="sm" onClick={() => void send()} disabled={disabled || !text.trim() || busy}>
            {busy ? <Spinner size={13} /> : <Send />}
          </IconButton>
        }
      />
      <div className="mt-1 px-1 text-[10.5px] text-mute-2">Goes into {sub.name}'s session as your message, not as IRC.</div>
    </div>
  );
}
