import { ArrowDownLeft, ChevronDown, CircleX, Megaphone, MessagesSquare, Reply, Sparkles } from "lucide-react";
import { type CSSProperties, createContext, type ReactNode, useContext, useState } from "react";
import { type IrcEntry, useAgent, useSession } from "@/core";
import type { IrcMessage, IrcReceipt, Subagent } from "@/core/gen";
import { AgentGlyph, agentGlyphTheme, cn, formatAge, Spinner, Tooltip, useNow } from "@/design";
import { SessionCtx } from "../context";
import { Markdown } from "../markdown/Markdown";
import { useSessionUi } from "../state";
import { SUB_STATUS } from "../subagents/Subagents";

/**
 * Name of the agent whose transcript is rendering. Defaults to the session's agent; a subagent
 * transcript (e.g. inside the subagent viewer) provides the subagent's name.
 */
export const IrcSelfCtx = createContext<string | null>(null);

function useIrcSelf(): string {
  const own = useContext(IrcSelfCtx);
  const session = useContext(SessionCtx);
  const agent = useAgent(session?.key ?? "");
  return own ?? agent?.name ?? "this agent";
}

/** The session's subagent an IRC peer id names (omp ids are the subagent ids; names as fallback). */
export function usePeerSub(agentKey: string, peer: string): Subagent | undefined {
  const { meta } = useSession(agentKey);
  return meta?.subagents.find((s) => s.id === peer) ?? meta?.subagents.find((s) => s.name === peer);
}

/** Peer tint: the peer's glyph gradient at low alpha, so a conversation reads by colour. */
export function peerTint(peer: string, strength = 1): CSSProperties {
  const t = agentGlyphTheme(peer);
  return {
    backgroundImage: `linear-gradient(135deg, color-mix(in oklab, ${t.from} ${Math.round(15 * strength)}%, rgb(18 18 26 / 0.72)), color-mix(in oklab, ${t.to} ${Math.round(9 * strength)}%, rgb(18 18 26 / 0.72)))`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${t.from} ${Math.round(34 * strength)}%, transparent), var(--shadow-d1)`,
  };
}

const OUTCOME: Record<string, string> = { injected: "delivered", woken: "woke it", revived: "revived it" };

/** Delivery line for an outbound send: sending… / delivered / woke it / failed. */
function Delivery({ entry }: { entry: IrcEntry }) {
  const { status, message } = entry;
  if (status === "pending" || status === "running") {
    return (
      <span className="flex items-center gap-1 text-accent-hi">
        <Spinner size={10} label="sending" />
        sending
      </span>
    );
  }
  const failed: IrcReceipt[] = message.receipts.filter((r) => r.outcome === "failed");
  if (status === "error" || status === "aborted" || status === "denied" || (message.receipts.length > 0 && failed.length === message.receipts.length)) {
    const why = failed[0]?.error ?? entry.error;
    return (
      <Tooltip content={why ?? "Not delivered"}>
        <span className="flex items-center gap-1 text-error">
          <CircleX className="size-3" />
          {status === "denied" ? "denied" : status === "aborted" ? "cancelled" : "not delivered"}
        </span>
      </Tooltip>
    );
  }
  if (message.broadcast && message.receipts.length > 0) {
    return (
      <Tooltip content={message.receipts.map((r) => `${r.to}: ${r.outcome === "failed" ? `failed${r.error ? ` (${r.error})` : ""}` : (OUTCOME[r.outcome] ?? r.outcome)}`).join("\n")}>
        <span className="text-done">
          ✓ {message.receipts.length - failed.length}/{message.receipts.length} delivered
        </span>
      </Tooltip>
    );
  }
  const outcome = message.receipts[0]?.outcome;
  return <span className="text-done">✓ {outcome ? (OUTCOME[outcome] ?? outcome) : "sent"}</span>;
}

/** Small tags: broadcast / parent / auto-relay / reply / via wait. */
function Tags({ message, viaWait }: { message: IrcMessage; viaWait: boolean }) {
  const tags: { icon: typeof Reply; label: string; tip: string }[] = [];
  if (message.broadcast) tags.push({ icon: Megaphone, label: "broadcast", tip: "Sent to every live peer (agent://all)" });
  if (message.fromParent) tags.push({ icon: ArrowDownLeft, label: "parent", tip: "From this agent's parent" });
  if (message.wakeRelay) tags.push({ icon: Sparkles, label: "auto-reply", tip: "omp relayed the peer's final answer when its turn ended" });
  if (message.replyTo) tags.push({ icon: Reply, label: "reply", tip: `Answers message ${message.replyTo}` });
  if (viaWait) tags.push({ icon: MessagesSquare, label: "via wait", tip: "Picked up by a wait call" });
  return (
    <>
      {tags.map(({ icon: Icon, label, tip }) => (
        <Tooltip key={label} content={tip}>
          <span className="flex items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[10px] font-bold tracking-wide text-ink-2 uppercase">
            <Icon className="size-2.5" />
            {label}
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/** Peer name; opens the subagent viewer when the peer is one of this session's subagents. */
export function PeerName({ peer, sub, onOpen, className }: { peer: string; sub?: Subagent; onOpen?: () => void; className?: string }) {
  const label = peer === "all" ? "everyone" : (sub?.name ?? peer);
  if (!sub || !onOpen) return <b className={cn("font-extrabold text-ink", className)}>{label}</b>;
  return (
    <button type="button" onClick={onOpen} className={cn("focus-ring rounded-[4px] font-extrabold text-ink underline-offset-2 hover:underline", className)} title={`Open ${label}`}>
      {label}
    </button>
  );
}

/** Long bodies (wake relays carry a peer's whole answer) start clamped. */
const CLAMP_CHARS = 700;

/**
 * One IRC message in the transcript, as a chat bubble: inbound on the left with the sender's
 * glyph, outbound on the right with its delivery state. `withPrev` / `withNext`: neighbouring
 * rows continue the same conversation (same peer and direction), so the header and avatar fold.
 */
export function IrcBubble({ entry, withPrev = false, withNext = false }: { entry: IrcEntry; withPrev?: boolean; withNext?: boolean }) {
  const session = useContext(SessionCtx);
  const key = session?.key ?? "";
  const self = useIrcSelf();
  const m = entry.message;
  const out = m.direction === "out";
  const sub = usePeerSub(key, m.peer);
  const [expanded, setExpanded] = useState(false);
  const now = useNow(30_000);
  const long = m.text.length > CLAMP_CHARS || m.text.split("\n").length > 14;
  const clamped = long && !expanded;
  // The session's single viewer (switches it when this bubble sits inside the viewer itself).
  const open = sub ? () => useSessionUi.getState().openSubagent(key, sub.id) : undefined;
  const viaWait = !out && entry.status != null;

  const header: ReactNode = (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-semibold text-mute", out ? "justify-end pr-1" : "pl-1")}>
      <span className="flex items-center gap-1 text-[10px] font-extrabold tracking-[0.08em] text-mute-2 uppercase">
        <MessagesSquare className="size-3" />
        IRC
      </span>
      {out ? (
        <>
          <span className="text-ink-2">{self}</span>
          <span className="text-mute-2" aria-label="to">→</span>
          <AgentGlyph name={m.peer} size={16} />
          <PeerName peer={m.peer} sub={sub} onOpen={open} />
        </>
      ) : (
        <>
          <PeerName peer={m.peer} sub={sub} onOpen={open} />
          <span className="text-mute-2" aria-label="to">→</span>
          <span className="text-ink-2">{self}</span>
        </>
      )}
      <Tags message={m} viaWait={viaWait} />
      <span className="text-mute-2 tabular" title={new Date(entry.at).toLocaleString()}>
        · {formatAge(now - entry.at)}
      </span>
      {out && (
        <span className="text-[11px] font-bold">
          <Delivery entry={entry} />
        </span>
      )}
    </div>
  );

  const bubble = (
    <div
      className={cn(
        "relative max-w-[min(680px,86%)] overflow-hidden rounded-[18px] px-3.5 py-2 text-[13px] max-md:max-w-[92%] max-md:px-3",
        out ? (withPrev ? "rounded-tr-[8px]" : "rounded-tr-[5px]") : withPrev ? "rounded-tl-[8px]" : "rounded-tl-[5px]",
        withNext && (out ? "rounded-br-[8px]" : "rounded-bl-[8px]"),
        out && (entry.status === "pending" || entry.status === "running") && "opacity-80",
      )}
      style={peerTint(m.peer, out ? 0.7 : 1)}
    >
      <div className={cn(clamped && "max-h-[220px] [mask-image:linear-gradient(#000_70%,transparent)]")}>
        {m.text.trim() ? <Markdown text={m.text} className="text-[13px] text-ink" /> : <span className="text-xs text-mute-2 italic">(empty)</span>}
      </div>
      {long && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="focus-ring mt-1 flex items-center gap-1 rounded-[6px] text-[11px] font-bold text-accent-hi hover:underline">
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );

  return (
    // phones keep the glyph's 28 px column and close the gap instead (same look; the glyph no longer spills into the gap)
    <div className={cn("flex gap-2.5 max-md:gap-1.5", out ? "flex-row-reverse" : "flex-row", withPrev && "-mt-2 max-md:-mt-1")} data-irc={m.direction}>
      {!out && (
        <div className="w-7 shrink-0">
          {!withPrev &&
            (open ? (
              <button type="button" onClick={open} className="focus-ring pressable mt-[18px] rounded-[9px]" aria-label={`Open ${sub?.name ?? m.peer}`}>
                <AgentGlyph name={m.peer} size={28} status={sub ? SUB_STATUS[sub.status] : undefined} />
              </button>
            ) : (
              <AgentGlyph name={m.peer} size={28} className="mt-[18px]" />
            ))}
        </div>
      )}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", out ? "items-end" : "items-start")}>
        {!withPrev && header}
        {bubble}
      </div>
    </div>
  );
}
