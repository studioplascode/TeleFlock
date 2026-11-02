import { ArrowUp, ChevronDown, CircleX, CornerDownLeft, ExternalLink, Hourglass, ListFilter, Lock, Megaphone, MessagesSquare, RefreshCw, Reply, Search, Send, Sparkles, Users, X } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, draftKey, drafts, openSession, parseAgentKey, useAgent, useDraft, useSession } from "@/core";
import type { Subagent } from "@/core/gen";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  Select,
  Shimmer,
  Spinner,
  Textarea,
  toast,
  toastAnchorsChanged,
  Tooltip,
  useNow,
  useWindowVisible,
} from "@/design";
import { errorText, usePending } from "../api";
import { Markdown } from "../markdown/Markdown";
import { formatClock } from "../resume/words";
import { useSessionUi } from "../state";
import { groupSubagents, treeOrder } from "../subagents/grouping";
import { SUB_LABEL } from "../subagents/Subagents";
import { TranscriptLog } from "../transcript/Transcript";
import { AgentAvatar } from "./AgentAvatar";
import { closeBoardFull, takeReveal, useBoardUi } from "./boardUi";
import {
  agentNamer,
  type BoardMessage,
  type ChatAgent,
  deliveryOf,
  filterMessages,
  firstUnread,
  MAIN,
  MAX_MESSAGES,
  type Participant,
  participants,
  positionText,
  previewText,
  receiptText,
} from "./chat";
import { useIrcSeen } from "./seen";
import { BOARD_POLL_MS, syncAgentChat, useAgentChat, useSeenMark } from "./store";

/** Long bodies (wake relays carry a subagent's whole answer) start clamped. */
const CLAMP_CHARS = 700;
/** A message from the same sender to the same recipients this soon after the last one continues it. */
const FOLD_MS = 5 * 60_000;
/** The composer's "All running subagents". */
const ALL = "*all";
const SENT_MS = 2600;
const NO_SUBS: Subagent[] = [];

/** Same sender, recipients and kind as `prev`, soon after it: the row folds into the one above. */
function continues(prev: BoardMessage | undefined, m: BoardMessage): boolean {
  return (
    prev !== undefined &&
    prev.from === m.from &&
    prev.broadcast === m.broadcast &&
    prev.to.join("\n") === m.to.join("\n") &&
    m.at - prev.at < FOLD_MS &&
    !m.replyTo &&
    !m.wakeRelay &&
    !prev.wakeRelay
  );
}

/** What a row needs from the board. */
interface RowCtx {
  agentKey: string;
  agentOf: (id: string) => ChatAgent;
  byId: ReadonlyMap<string, BoardMessage>;
  now: number;
  mobile: boolean;
  expanded: ReadonlySet<string>;
  toggleExpanded(id: string): void;
  /** Bring a message into view (clearing filters that hide it). */
  reveal(id: string): void;
  /** Show only the messages one agent sent or got. */
  filterBy(id: string): void;
  /** Address the composer to a subagent. */
  messageTo(sub: Subagent): void;
}

/**
 * A session's message board (architecture §6.17, host side §3.34): every omp IRC message of its whole agent tree
 * in one chronological channel, who wrote to whom, replies, delivery and progress notes; a "New"
 * divider at what arrived since the board was last open on this device; filters by agent (one:
 * involving it; two: between them) and text; a composer that messages one subagent or all
 * running ones. Virtualised (logs run to 2,000 messages). The split panel and the full-screen
 * sheet (`BoardFrames`) both render it.
 */
export function MessageBoard({ agentKey, mobile }: { agentKey: string; mobile: boolean }) {
  // Keeps the session's meta coming (and so the log moving) while the board shows beside another view.
  useEffect(() => openSession(agentKey), [agentKey]);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const chat = useAgentChat(agentKey, BOARD_POLL_MS);
  const subs = meta?.subagents ?? NO_SUBS;
  const mainName = agent?.name ?? MAIN;
  const agentOf = useMemo(() => agentNamer(subs, mainName), [subs, mainName]);
  const people = useMemo(() => participants(chat.messages, subs, agentOf), [chat.messages, subs, agentOf]);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterMessages(chat.messages, { agents: picked, query }, agentOf), [chat.messages, picked, query, agentOf]);
  const ids = useMemo(() => shown.map((m) => m.id), [shown]);
  const byId = useMemo(() => new Map(chat.messages.map((m) => [m.id, m])), [chat.messages]);
  // Unread as of opening the board: the divider stays put while the board marks everything read.
  const mark = useSeenMark(agentKey);
  const [since] = useState(mark.at);
  const firstNew = useMemo(() => firstUnread(shown, since), [shown, since]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<{ itemId: string; nonce: number }>();
  const [follow, setFollow] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const now = useNow(60_000);
  const visible = useWindowVisible();
  const loaded = !chat.loading;

  // Everything shown counts as read while the board is on screen (a mark kept under the agent key moves to the session's).
  const latest = chat.messages[chat.messages.length - 1]?.at ?? 0;
  useEffect(() => {
    if (visible && latest > 0) useIrcSeen.getState().markSeen(mark.scope, latest, agentKey);
  }, [agentKey, mark.scope, latest, visible]);

  // A message to bring into view (a preview on the card, a reply's quote): filters that hide it go first.
  const reveal = useBoardUi((s) => s.reveal[agentKey]);
  useEffect(() => {
    if (!reveal || !loaded) return;
    if (!byId.has(reveal)) {
      takeReveal(agentKey);
      return;
    }
    if (!ids.includes(reveal)) {
      setPicked([]);
      setQuery("");
      return;
    }
    takeReveal(agentKey);
    setFocus((f) => ({ itemId: reveal, nonce: (f?.nonce ?? 0) + 1 }));
  }, [agentKey, reveal, loaded, byId, ids]);

  // Opening with more unread than the last few rows: start at the divider instead of the bottom.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !loaded || ids.length === 0) return;
    landed.current = true;
    if (reveal || !firstNew) return;
    if (ids.indexOf(firstNew.id) < ids.length - 4) setFocus((f) => ({ itemId: firstNew.id, nonce: (f?.nonce ?? 0) + 1 }));
  }, [loaded, ids, firstNew, reveal]);

  const estimate = useCallback(
    (i: number) => {
      const m = shown[i];
      if (!m) return 64;
      const lines = Math.min(12, m.text.split("\n").length + Math.floor(m.text.length / 90));
      return (continues(shown[i - 1], m) ? 24 : 46) + lines * 20 + (m.replyTo ? 30 : 0) + (m.receipts.length > 0 ? 18 : 0);
    },
    [shown],
  );

  const ctx: RowCtx = {
    agentKey,
    agentOf,
    byId,
    now,
    mobile,
    expanded,
    toggleExpanded: (id) =>
      setExpanded((cur) => {
        const next = new Set(cur);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    reveal: (id) => useBoardUi.setState((s) => ({ reveal: { ...s.reveal, [agentKey]: id } })),
    filterBy: (id) => setPicked([id]),
    messageTo: (sub) => {
      setTarget(sub.id);
      composerRef.current?.focus();
    },
  };

  const filtering = picked.length > 0 || query.trim() !== "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        mobile={mobile}
        query={query}
        onQuery={setQuery}
        people={people}
        picked={picked}
        onPick={setPicked}
        agentOf={agentOf}
        counts={filtering ? { shown: shown.length, total: chat.messages.length } : null}
      />
      <Notices agentKey={agentKey} source={chat.source} error={chat.error} truncated={chat.truncated} mainName={mainName} onRetry={chat.refresh} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TranscriptLog
          ids={ids}
          estimateSize={estimate}
          loading={chat.loading}
          ariaLabel="Agent chat"
          focus={focus}
          followSignal={follow}
          view={`${picked.join(" ")}\n${query}`}
          padX={mobile ? 8 : 14}
          padBottom={mobile ? 10 : 16}
          gutter={0}
          overscan={mobile ? 4 : 8}
          dense={mobile}
          renderRow={(id, prevId) => {
            const m = byId.get(id);
            if (!m) return null;
            const isNew = firstNew?.id === id;
            return <BoardRow m={m} compact={!isNew && continues(prevId === undefined ? undefined : byId.get(prevId), m)} divider={isNew} ctx={ctx} />;
          }}
          empty={
            filtering ? (
              <EmptyState
                className="mt-10"
                compact
                icon={<ListFilter />}
                title="No messages match"
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      setPicked([]);
                      setQuery("");
                    }}
                  >
                    Show all messages
                  </Button>
                }
              />
            ) : (
              <EmptyState
                className="mt-10"
                compact
                icon={<MessagesSquare />}
                title="No messages yet"
                description="What the agents of this session send each other over omp IRC shows up here, whichever subagent sends it."
              />
            )
          }
          jumpLabel={(unseen) => (unseen > 0 ? `${unseen} new` : "Jump to latest")}
        />
      </div>
      <BoardComposer
        agentKey={agentKey}
        mobile={mobile}
        subs={subs}
        agentOf={agentOf}
        target={target}
        onTarget={setTarget}
        fallbackTarget={defaultTarget(subs, picked, chat.messages, agentOf)}
        textareaRef={composerRef}
        onSent={() => {
          setFollow((n) => n + 1);
          if (chat.source === "log") void syncAgentChat(agentKey);
        }}
      />
    </div>
  );
}

/**
 * Who the composer writes to until the user picks: the agent the board is filtered to, else the
 * running subagent that wrote last, else the first running one, else the first one.
 */
function defaultTarget(subs: readonly Subagent[], picked: readonly string[], messages: readonly BoardMessage[], agentOf: (id: string) => ChatAgent): string | null {
  const only = picked.length === 1 ? agentOf(picked[0] as string).sub : undefined;
  if (only) return only.id;
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 40); i--) {
    const sub = agentOf((messages[i] as BoardMessage).from).sub;
    if (sub?.status === "running") return sub.id;
  }
  return (subs.find((s) => s.status === "running") ?? subs[0])?.id ?? null;
}

// ------------------------------------------------------------------ toolbar

function Toolbar({
  mobile,
  query,
  onQuery,
  people,
  picked,
  onPick,
  agentOf,
  counts,
}: {
  mobile: boolean;
  query: string;
  onQuery: (q: string) => void;
  people: readonly Participant[];
  picked: readonly string[];
  onPick: (ids: string[]) => void;
  agentOf: (id: string) => ChatAgent;
  counts: { shown: number; total: number } | null;
}) {
  const names = picked.map((id) => agentOf(id).label);
  return (
    <div className={cn("flex shrink-0 flex-col gap-1.5 border-b border-line", mobile ? "px-2.5 py-2" : "px-3 py-2")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
          placeholder="Search messages"
          aria-label="Search messages"
          leading={<Search />}
          trailing={
            query ? (
              <IconButton label="Clear search" size="sm" className="-mr-2" onClick={() => onQuery("")}>
                <X />
              </IconButton>
            ) : undefined
          }
          boxClassName="h-8 min-w-0 flex-1 rounded-full"
          className="text-[13px]"
        />
        <AgentFilter people={people} picked={picked} onPick={onPick} names={names} />
      </div>
      {counts && (
        <div className="flex min-w-0 items-center gap-1.5 px-1 text-[11.5px] text-mute" role="status">
          <span className="min-w-0 truncate">
            {names.length === 1 && (
              <>
                Messages of <b className="font-bold text-ink-2">{names[0]}</b>
              </>
            )}
            {names.length === 2 && (
              <>
                Between <b className="font-bold text-ink-2">{names[0]}</b> and <b className="font-bold text-ink-2">{names[1]}</b>
              </>
            )}
            {query.trim() && (
              <>
                {names.length > 0 ? " · " : ""}“{query.trim()}”
              </>
            )}
          </span>
          <span className="shrink-0 text-mute-2 tabular">
            · {counts.shown} of {counts.total}
          </span>
          <button
            type="button"
            onClick={() => {
              onPick([]);
              onQuery("");
            }}
            className="focus-ring ml-auto shrink-0 rounded-[4px] font-bold text-accent-hi hover:underline"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** One agent: messages it sent or got; a second one: only the messages between the two. */
function AgentFilter({ people, picked, onPick, names }: { people: readonly Participant[]; picked: readonly string[]; onPick: (ids: string[]) => void; names: string[] }) {
  const toggle = (id: string) => {
    if (picked.includes(id)) onPick(picked.filter((p) => p !== id));
    else onPick(picked.length < 2 ? [...picked, id] : [picked[0] as string, id]);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={picked.length ? "secondary" : "ghost"}
          icon={<Users />}
          trailing={<ChevronDown className="opacity-70" />}
          className="h-8 max-w-[48%] shrink-0 rounded-full px-2.5"
          aria-label={picked.length ? `Filtered to ${names.join(" and ")}` : "Filter by agent"}
        >
          <span className="min-w-0 truncate">{picked.length === 0 ? "All agents" : names.join(" ↔ ")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-24px))]">
        <DropdownMenuLabel>One agent, or two for what they said to each other</DropdownMenuLabel>
        {people.map(({ agent: a, count }) => (
          <DropdownMenuCheckboxItem key={a.id} checked={picked.includes(a.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggle(a.id)} className="h-auto min-h-9 py-1.5">
            <AgentAvatar who={a} size={20} />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate">{a.label}</span>
              <span className="truncate text-2xs font-medium text-mute-2">{positionText(a) || (a.kind === "main" ? "main agent" : a.kind === "user" ? "from TeleFlock" : "subagent")}</span>
            </span>
            <span className="shrink-0 text-2xs font-bold text-mute-2 tabular">{count}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {picked.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<X />} onSelect={() => onPick([])}>
              Show every agent's messages
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Why the board shows less than the whole tree, or couldn't refresh. */
function Notices({ agentKey, source, error, truncated, mainName, onRetry }: { agentKey: string; source: "log" | "transcript"; error?: string; truncated: boolean; mainName: string; onRetry: () => void }) {
  const { meta } = useSession(agentKey);
  const lines: { key: string; text: ReactNode; retry?: boolean }[] = [];
  if (source === "transcript" && meta?.agentChat) lines.push({ key: "err", text: `Couldn't load the agent tree's messages (${error ?? "unknown error"}); showing ${mainName}'s own.`, retry: true });
  else if (source === "transcript") lines.push({ key: "old", text: `Only ${mainName}'s own messages: this host runs a TeleFlock before 0.9.0. Update it to see the whole agent tree.` });
  else if (error) lines.push({ key: "err", text: `Couldn't refresh: ${error}`, retry: true });
  if (truncated) lines.push({ key: "cut", text: `Older messages are gone: the host keeps the newest ${MAX_MESSAGES.toLocaleString("en-US")}.` });
  if (lines.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-ink/[0.025] px-3 py-1.5">
      {lines.map((l) => (
        <div key={l.key} className="flex min-w-0 items-center gap-2 text-[11.5px] text-mute" role="status">
          <span className="min-w-0 flex-1">{l.text}</span>
          {l.retry && (
            <Button size="sm" variant="ghost" icon={<RefreshCw />} className="h-6 shrink-0 px-2" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ rows

/** An agent's name; its menu filters the board to it, opens a subagent, or addresses the composer to it. */
function AgentName({ who, ctx, className }: { who: ChatAgent; ctx: RowCtx; className?: string }) {
  const sub = who.sub;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={who.id === who.label ? undefined : who.id} className={cn("focus-ring min-w-0 truncate rounded-[4px] font-extrabold text-ink underline-offset-2 hover:underline", className)}>
          {who.label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem icon={<ListFilter />} onSelect={() => ctx.filterBy(who.id)}>
          Only {who.kind === "user" ? "your" : `${who.label}'s`} messages
        </DropdownMenuItem>
        {sub && (
          <>
            <DropdownMenuItem icon={<ExternalLink />} onSelect={() => useSessionUi.getState().openSubagent(ctx.agentKey, sub.id)}>
              Open {who.label} · {SUB_LABEL[sub.status]}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Send />} onSelect={() => ctx.messageTo(sub)}>
              Message {who.label}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "→ Sweep", "→ Sweep, Size16 +2", "→ everyone" (a broadcast; the tooltip lists who got it). */
function Recipients({ m, ctx }: { m: BoardMessage; ctx: RowCtx }) {
  if (m.broadcast) {
    const names = m.to.map((id) => ctx.agentOf(id).label);
    return (
      <Tooltip content={names.length ? `To ${names.join(", ")}` : "Sent to every live agent (agent://all)"}>
        <span className="flex shrink-0 items-center gap-1 font-extrabold text-ink">
          <Megaphone className="size-3 text-mute" aria-hidden />
          everyone
          {names.length > 0 && <span className="font-semibold text-mute-2 tabular">({names.length})</span>}
        </span>
      </Tooltip>
    );
  }
  const shown = m.to.slice(0, 2);
  const rest = m.to.slice(2);
  return (
    <>
      {shown.map((id, i) => (
        <span key={id} className="flex min-w-0 items-center">
          <AgentName who={ctx.agentOf(id)} ctx={ctx} />
          {i < shown.length - 1 && <span className="text-mute-2">,</span>}
        </span>
      ))}
      {rest.length > 0 && (
        <Tooltip content={rest.map((id) => ctx.agentOf(id).label).join(", ")}>
          <span className="shrink-0 font-semibold text-mute-2">+{rest.length}</span>
        </Tooltip>
      )}
    </>
  );
}

/** The status line under a message: sending / delivered / not delivered (and why). */
function Receipts({ m }: { m: BoardMessage }) {
  const d = deliveryOf(m);
  if (d.kind === "none") return null;
  const detail = m.receipts.length > 1 ? m.receipts.map((r) => `${r.to}: ${receiptText(r)}`).join("\n") : undefined;
  let body: ReactNode;
  if (d.kind === "sending") {
    body = (
      <span className="flex items-center gap-1 text-accent-hi">
        <Spinner size={9} label="sending" />
        sending
      </span>
    );
  } else if (d.kind === "failed") {
    body = (
      <span className="flex min-w-0 items-center gap-1 text-error">
        <CircleX className="size-3 shrink-0" />
        <span className="min-w-0 truncate">not delivered{d.error ? `: ${d.error}` : ""}</span>
      </span>
    );
  } else {
    body = (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-done/85">✓ {d.label}</span>
        {d.pending > 0 && <span className="text-accent-hi">· {d.pending} sending</span>}
        {d.failed.length > 0 && <span className="min-w-0 truncate text-error">· {d.failed.length === 1 ? `not to ${d.failed[0]?.to}` : `${d.failed.length} not delivered`}</span>}
      </span>
    );
  }
  const tip = detail ?? (d.kind === "failed" ? d.error : undefined);
  return (
    <div className="mt-0.5 flex min-w-0 text-[10.5px] font-semibold text-mute-2">
      {tip ? (
        <Tooltip content={tip}>
          <span className="flex min-w-0">{body}</span>
        </Tooltip>
      ) : (
        body
      )}
    </div>
  );
}

/** The message this one answers, as a quote; a click brings it into view. */
function Quote({ m, ctx }: { m: BoardMessage; ctx: RowCtx }) {
  const q = m.replyTo === undefined ? undefined : ctx.byId.get(m.replyTo);
  if (!m.replyTo) return null;
  if (!q) {
    return (
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-mute-2">
        <Reply className="size-3" aria-hidden />
        Answers an earlier message
      </div>
    );
  }
  const who = ctx.agentOf(q.from);
  return (
    <button
      type="button"
      onClick={() => ctx.reveal(q.id)}
      title="Show the message it answers"
      className="focus-ring mb-1 flex w-full max-w-[min(100%,560px)] min-w-0 items-center gap-1.5 rounded-[8px] border-l-2 border-accent/50 bg-ink/[0.035] px-2 py-1 text-left text-[11.5px] text-mute hover:bg-ink/[0.06]"
    >
      <Reply className="size-3 shrink-0" aria-hidden />
      <b className="shrink-0 font-bold text-ink-2">{who.label}</b>
      <span className="min-w-0 truncate">{previewText(q.text) || "(empty)"}</span>
    </button>
  );
}

/**
 * One message: the sender's glyph and name, → recipients (or everyone), where the sender sits in
 * the tree, tags and time; the quote it answers; the Markdown body (long ones clamped); the
 * delivery line. `compact`: it continues the row above (same sender and recipients), so only the
 * body shows. `divider`: the first message that arrived since the board was last open.
 */
function BoardRow({ m, compact, divider, ctx }: { m: BoardMessage; compact: boolean; divider: boolean; ctx: RowCtx }) {
  const who = ctx.agentOf(m.from);
  const long = m.text.length > CLAMP_CHARS || m.text.split("\n").length > 14;
  const open = ctx.expanded.has(m.id);
  const where = positionText(who);
  const itemId = m.itemId;
  return (
    <div data-msg={m.id}>
      {divider && (
        <div className="mb-2 flex items-center gap-2 text-[10px] font-extrabold tracking-[0.1em] text-accent-hi uppercase" role="separator">
          <span className="h-px flex-1 bg-accent/40" />
          New
          <span className="h-px flex-1 bg-accent/40" />
        </div>
      )}
      <div className={cn("group/msg relative flex gap-2.5 rounded-[14px] px-1.5 py-1 hover:bg-ink/[0.025]", compact && (ctx.mobile ? "-mt-1.5" : "-mt-2.5"))}>
        <div className={cn("shrink-0", ctx.mobile ? "w-7" : "w-8")}>{!compact && <AgentAvatar who={who} size={ctx.mobile ? 28 : 32} />}</div>
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px]">
              <AgentName who={who} ctx={ctx} className="max-w-[45%]" />
              {where && <span className="max-w-[40%] truncate text-[11px] font-semibold text-mute-2">{where}</span>}
              <span className="text-mute-2" aria-label="to">
                →
              </span>
              <Recipients m={m} ctx={ctx} />
              {m.progress && (
                <Tooltip content="A progress note: the sender will report back">
                  <span className="flex items-center gap-1 rounded-full bg-ink/6 px-1.5 py-px text-[9.5px] font-bold tracking-wide text-mute uppercase">
                    <Hourglass className="size-2.5" />
                    progress
                  </span>
                </Tooltip>
              )}
              {m.wakeRelay && (
                <Tooltip content="omp relayed the sender's final answer when its turn ended">
                  <span className="flex items-center gap-1 rounded-full bg-ink/6 px-1.5 py-px text-[9.5px] font-bold tracking-wide text-mute uppercase">
                    <Sparkles className="size-2.5" />
                    auto-reply
                  </span>
                </Tooltip>
              )}
              <span className="ml-auto shrink-0 text-[11px] font-semibold text-mute-2 tabular" title={new Date(m.at).toLocaleString()}>
                {formatClock(m.at, ctx.now)}
              </span>
            </div>
          )}
          <Quote m={m} ctx={ctx} />
          <div className={cn(long && !open && "max-h-[220px] overflow-hidden [mask-image:linear-gradient(#000_70%,transparent)]")}>
            {m.text.trim() ? (
              <Markdown text={m.text} className={cn("text-[13px]", m.progress ? "text-mute italic" : "text-ink")} />
            ) : (
              <span className="text-xs text-mute-2 italic">(empty)</span>
            )}
          </div>
          {long && (
            <button type="button" onClick={() => ctx.toggleExpanded(m.id)} className="focus-ring mt-0.5 flex items-center gap-1 rounded-[6px] text-[11px] font-bold text-accent-hi hover:underline">
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
              {open ? "Show less" : "Show all"}
            </button>
          )}
          <Receipts m={m} />
        </div>
        {itemId && (
          <span className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
            <IconButton
              label="Show in transcript"
              size="sm"
              onClick={() => {
                const ui = useSessionUi.getState();
                ui.setSheet(ctx.agentKey, false);
                ui.focusItem(ctx.agentKey, itemId);
                closeBoardFull();
              }}
            >
              <CornerDownLeft />
            </IconButton>
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

/**
 * Message one subagent, or every running one at once (`agent.subagent` chat, `broadcast: true`: the
 * log shows it as one message from You). omp has no way for an outside client to post on its IRC
 * bus: the text lands in each subagent's session as the user's message (steering it when busy).
 * The main agent takes the session's own composer.
 */
function BoardComposer({
  agentKey,
  mobile,
  subs,
  agentOf,
  target,
  onTarget,
  fallbackTarget,
  textareaRef,
  onSent,
}: {
  agentKey: string;
  mobile: boolean;
  subs: readonly Subagent[];
  agentOf: (id: string) => ChatAgent;
  target: string | null;
  onTarget: (id: string) => void;
  fallbackTarget: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSent: () => void;
}) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const key = draftKey("irc.board", agentKey);
  const [text, setText] = useDraft(key);
  const [sending, run] = usePending();
  const [sent, setSent] = useState<string | null>(null);
  const ordered = useMemo(() => treeOrder(groupSubagents(subs)), [subs]);
  const running = ordered.filter((s) => s.status === "running");
  const chosen = target === ALL || subs.some((s) => s.id === target) ? target : fallbackTarget;
  const toSub = chosen === ALL ? undefined : subs.find((s) => s.id === chosen);
  const blocked =
    !agent || agent.omp?.link !== "live"
      ? "Not connected to the session"
      : !meta?.caps.subagents
        ? "This session can't take messages for its subagents"
        : subs.length === 0
          ? "No subagents to message yet"
          : null;
  const toName = chosen === ALL ? "all running subagents" : toSub ? agentOf(toSub.name).label : "";

  useEffect(() => {
    if (!sent) return;
    const t = window.setTimeout(() => setSent(null), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);

  // Toasts keep clear of the composer (it sits under their stack beside the session, and along a phone's bottom).
  useEffect(() => {
    toastAnchorsChanged();
    return toastAnchorsChanged;
  }, []);

  const send = async () => {
    const message = text.trim();
    if (!message || sending || blocked || !chosen) return;
    const all = chosen === ALL;
    const to = all ? running : toSub ? [toSub] : [];
    if (to.length === 0) return;
    const results = await run(Promise.allSettled(to.map((s) => core.host(hostId).call("agent.subagent", { agentId, subagentId: s.id, action: "chat", message, ...(all ? { broadcast: true } : {}) }))));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${agentOf((to[i] as Subagent).name).label}: ${errorText(r.reason).title}`] : []));
    if (failed.length === to.length) {
      toast({ title: all ? "Couldn't message the subagents" : `Couldn't message ${toName}`, description: failed.join("\n"), status: "error" });
      return;
    }
    if (failed.length > 0) toast({ title: `Couldn't message ${failed.length} of ${to.length} subagents`, description: failed.join("\n"), status: "error" });
    // Only what was sent: anything typed while sending stays in the draft.
    const cur = drafts.get(key);
    drafts.set(key, cur.startsWith(text) ? cur.slice(text.length).trimStart() : cur);
    setSent(all ? `Sent to ${to.length - failed.length} running subagent${to.length - failed.length === 1 ? "" : "s"}` : `Sent to ${toName}`);
    onSent();
  };

  const options = [
    {
      value: ALL,
      label: "All running subagents",
      hint: running.length ? `${running.length} running` : "none running",
      icon: <Megaphone />,
      disabled: running.length === 0,
    },
    ...ordered.map((s) => {
      const a = agentOf(s.name);
      return { value: s.id, label: a.label, hint: [SUB_LABEL[s.status], positionText(a)].filter(Boolean).join(" · "), icon: <AgentAvatar who={a} size={18} /> };
    }),
  ];

  const status = blocked ? (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold text-mute-2">
      <Lock className="size-3 shrink-0" />
      {blocked}
    </span>
  ) : sending ? (
    <Shimmer className="min-w-0 truncate text-[11px] font-semibold text-mute">Sending…</Shimmer>
  ) : sent ? (
    <span className="min-w-0 truncate text-[11px] font-semibold text-done" role="status">
      ✓ {sent}
    </span>
  ) : mobile ? null : (
    <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-mute-2">
      <Kbd>Enter</Kbd> send
    </span>
  );

  return (
    // Phones: the full-screen frame already keeps the safe area free; an overlaid keyboard (`--kb-inset`) lifts the composer.
    <div data-toast-anchor="" className={cn("shrink-0 border-t border-line", mobile ? "px-2.5 pt-2 pb-[max(10px,var(--kb-inset,0px))]" : "px-3 pt-2.5 pb-3")}>
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          // Desktop: Enter sends, Shift+Enter is a newline. Phone: Enter is a newline and the button sends (or Ctrl/Meta+Enter).
          if (mobile ? e.ctrlKey || e.metaKey : !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={blocked ? "Messaging is unavailable" : chosen === ALL ? "Message all running subagents…" : toSub ? `Message ${toName}…` : "Pick who to message"}
        aria-label={toName ? `Message ${toName}` : "Message a subagent"}
        disabled={!!blocked}
        enterKeyHint={mobile ? "enter" : undefined}
        maxHeight={mobile ? 120 : 180}
        boxClassName={cn("rounded-[18px] px-3 py-2", !!blocked && "opacity-80")}
        className={cn("text-[13.5px]", mobile && "min-h-[1lh] text-[15px]")}
        footer={
          <>
            <span className="shrink-0 text-[11px] font-bold text-mute-2">To</span>
            <Select
              value={chosen ?? ""}
              onValueChange={onTarget}
              options={options}
              disabled={!!blocked}
              placeholder="Pick a subagent"
              aria-label="Recipient"
              className="h-7 max-w-[60%] min-w-0 gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3.5"
            />
            <span className="ml-1 flex min-w-0 flex-1">{status}</span>
            <IconButton label={`Send${mobile ? "" : " (Enter)"}`} size={mobile ? "md" : "sm"} variant="primary" onClick={() => void send()} disabled={!text.trim() || sending || !!blocked || !chosen}>
              {sending ? <Spinner size={13} /> : <ArrowUp />}
            </IconButton>
          </>
        }
      />
    </div>
  );
}
