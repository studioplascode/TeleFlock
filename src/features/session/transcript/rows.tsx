import { AlertTriangle, Brain, ChevronDown, CircleAlert, CornerDownRight, Info, Layers, Repeat2, Sparkles } from "lucide-react";
import { memo, useState } from "react";
import { ircOf, useCore, useSessionItem, useSettings } from "@/core";
import type { AssistantItem, CompactionItem, ModeItem, NoticeItem, ThinkingItem, ToolItem, TranscriptItem, UserItem } from "@/core/gen";
import { cn, Elapsed, formatCompact, formatElapsed, formatUsd, LogoMark, Shimmer, Tooltip } from "@/design";
import { IrcBubble } from "../irc/IrcBubble";
import { Markdown } from "../markdown/Markdown";
import { imageSrc, ToolCard } from "../tools/ToolCard";

/** `in:<peer>` / `out:<peer>` for IRC rows (consecutive rows with the same key group), else null. */
export function ircThreadKey(item: TranscriptItem | undefined): string | null {
  const m = ircOf(item)?.message;
  return m ? `${m.direction}:${m.peer}` : null;
}

/** A tool call on the gutter timeline (IRC sends render as chat bubbles instead). */
export const isRailTool = (item: TranscriptItem | undefined) => item?.kind === "tool" && item.view?.type !== "irc";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const clock = (at: number) => timeFmt.format(at);

export interface RowProps {
  agentKey: string;
  itemId: string;
  /** Neighbours, so runs of tool calls draw one connected timeline in the gutter. */
  prevId?: string;
  nextId?: string;
  /** Draw the gutter timeline (off when there is no gutter, e.g. phones). */
  rail?: boolean;
}

/** Row bound to the store: re-renders only when this item (or a neighbour's kind) changes. */
export const Row = memo(function Row({ agentKey, itemId, prevId, nextId, rail = false }: RowProps) {
  const item = useSessionItem(agentKey, itemId);
  // Booleans / short keys only, so a neighbour streaming output never re-renders this row.
  const prevTool = useCore((s) => rail && prevId != null && isRailTool(s.sessions[agentKey]?.items[prevId]));
  const nextTool = useCore((s) => rail && nextId != null && isRailTool(s.sessions[agentKey]?.items[nextId]));
  const prevIrc = useCore((s) => (prevId != null ? ircThreadKey(s.sessions[agentKey]?.items[prevId]) : null));
  const nextIrc = useCore((s) => (nextId != null ? ircThreadKey(s.sessions[agentKey]?.items[nextId]) : null));
  if (!item) return null;
  const irc = ircThreadKey(item);
  return <ItemRow item={item} rail={rail} up={prevTool} down={nextTool} ircPrev={irc != null && prevIrc === irc} ircNext={irc != null && nextIrc === irc} />;
});

/**
 * Same row as `Row` for items held outside the store (subagent transcripts). `up`/`down`: the
 * neighbouring rows are tool calls (joins the gutter timeline when `rail`). `ircPrev`/`ircNext`:
 * the neighbouring rows continue this IRC conversation (same peer and direction).
 */
export const ItemRow = memo(function ItemRow({
  item,
  rail = false,
  up = false,
  down = false,
  ircPrev = false,
  ircNext = false,
}: {
  item: TranscriptItem;
  rail?: boolean;
  up?: boolean;
  down?: boolean;
  ircPrev?: boolean;
  ircNext?: boolean;
}) {
  const irc = ircOf(item);
  if (irc) return <IrcBubble entry={irc} withPrev={ircPrev} withNext={ircNext} />;
  if (rail && item.kind === "tool") return <ToolRow item={item} up={up} down={down} />;
  return <ItemView item={item} />;
});

const RAIL_DOT: Record<ToolItem["status"], string> = {
  pending: "bg-accent shadow-[0_0_8px_rgb(163_92_240/0.9)] tf-loop animate-breathe [--tf-breath:1.4s]",
  running: "bg-accent shadow-[0_0_8px_rgb(163_92_240/0.9)] tf-loop animate-breathe [--tf-breath:1.4s]",
  ok: "bg-mute-2/70",
  error: "bg-error shadow-[0_0_8px_rgb(255_77_94/0.7)]",
  denied: "bg-sun-2",
  aborted: "bg-mute-2/40",
};

/** Tool call with its node on the turn's timeline: consecutive calls read as one connected run. */
function ToolRow({ item, up, down }: { item: ToolItem; up: boolean; down: boolean }) {
  return (
    <div className="relative pl-[var(--tf-gutter,38px)]">
      {up && <span aria-hidden className="absolute -top-3 left-[13.5px] h-[calc(0.75rem+15px)] w-px bg-line-2" />}
      {down && <span aria-hidden className="absolute top-[23px] -bottom-3 left-[13.5px] w-px bg-line-2" />}
      <span aria-hidden className={cn("absolute top-[15.5px] left-[10.5px] size-[7px] rounded-full transition-colors duration-500", RAIL_DOT[item.status])} />
      <ToolCard item={item} />
    </div>
  );
}

/** Pure renderer for one transcript item. */
function ItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <UserRow item={item} />;
    case "assistant":
      return <AssistantRow item={item} />;
    case "thinking":
      return <ThinkingRow item={item} />;
    case "tool":
      return (
        <div className="pl-[var(--tf-gutter,38px)]">
          <ToolCard item={item} />
        </div>
      );
    case "notice":
      return <NoticeRow item={item} />;
    case "compaction":
      return <CompactionRow item={item} />;
    case "mode":
      return <ModeRow item={item} />;
    case "irc": {
      const irc = ircOf(item);
      return irc && <IrcBubble entry={irc} />;
    }
  }
}

/** hostd's collab guest name: prompts it sent without a known device (e.g. before a daemon restart). */
const GUEST_NAME = "TeleFlock";

/** Author chip text: null for prompts from this device (or typed on the host), else the sending device. */
function useForeignAuthor(author: string | undefined): string | null {
  const me = useSettings((s) => s.deviceName);
  if (!author || author === me || author === GUEST_NAME) return null;
  return author;
}

function UserRow({ item }: { item: UserItem }) {
  const author = useForeignAuthor(item.author);
  if (item.synthetic) {
    return (
      <div className="flex justify-end">
        <SyntheticTurn item={item} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 pt-2 max-md:gap-0.5 max-md:pt-0.5">
      <div className="flex items-center gap-2 pr-1 text-[11px] font-bold text-mute-2">
        {item.steering && (
          <span className="flex items-center gap-1 rounded-full bg-accent/14 px-2 py-0.5 text-[10px] tracking-wider text-accent-hi uppercase" title="Sent while the agent was working">
            <CornerDownRight className="size-3" />
            steer
          </span>
        )}
        {author ? <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10.5px] text-ink-2 shadow-hairline">{author}</span> : <span>You</span>}
        <span className="font-semibold tabular">{clock(item.at)}</span>
      </div>
      <div
        className={cn(
          "max-w-[min(720px,88%)] rounded-[20px] rounded-tr-[8px] px-4 py-2.5 text-[13.5px] leading-[1.55] whitespace-pre-wrap text-ink [overflow-wrap:anywhere] max-md:max-w-[92%] max-md:rounded-[18px] max-md:rounded-tr-[6px] max-md:px-3.5 max-md:py-2",
          item.steering
            ? "bg-[linear-gradient(135deg,rgb(163_92_240/0.24),rgb(79_139_255/0.16))] shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]"
            : "bg-tile-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),var(--shadow-d1)]",
        )}
      >
        {item.text}
        {item.images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.images.map((img, i) => {
              const src = imageSrc(img);
              return src ? <img key={i} src={src} alt={`attachment ${i + 1}`} className="max-h-40 rounded-md object-cover shadow-hairline" /> : null;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SyntheticTurn({ item }: { item: UserItem }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      className="focus-ring max-w-[min(720px,88%)] rounded-lg bg-white/[0.025] px-3 py-1.5 text-left text-xs text-mute shadow-hairline hover:bg-white/[0.04]"
    >
      <span className="flex items-center gap-1.5 font-semibold">
        <Repeat2 className="size-3" />
        {item.author === "advisor" ? "Advisor note" : "System turn"}
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
      </span>
      <span className={cn("mt-0.5 block whitespace-pre-wrap", !open && "line-clamp-1")}>{item.text}</span>
    </button>
  );
}

function AssistantRow({ item }: { item: AssistantItem }) {
  const stopped = item.stopReason && !/^(stop|end_turn|endTurn|toolUse|tool_use|length)$/.test(item.stopReason);
  return (
    <div className="flex gap-2.5 pt-1 max-md:pt-0">
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[10px] bg-run shadow-[0_4px_14px_-4px_rgb(91_103_246/0.7)]",
          item.streaming && "tf-loop animate-breathe [--tf-breath:1.4s]",
          "max-md:hidden",
        )}
        aria-hidden
      >
        <LogoMark size={16} mono className="text-white" title="omp" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-[11.5px] font-extrabold text-ink">
          omp
          {item.model && <span className="font-mono text-[10.5px] font-semibold text-mute-2">{item.model}</span>}
          <span className="font-semibold text-mute-2 tabular">{clock(item.at)}</span>
          {item.usage && (
            <Tooltip
              content={`${formatCompact(item.usage.input)} in · ${formatCompact(item.usage.output)} out · ${formatCompact(item.usage.cacheRead)} cached`}
            >
              <span tabIndex={0} className="focus-ring rounded-xs font-semibold text-mute-2 tabular">
                {formatUsd(item.usage.costUsd)}
              </span>
            </Tooltip>
          )}
        </div>
        {item.text || item.streaming ? <Markdown text={item.text} streaming={item.streaming} /> : null}
        {item.error && (
          <div className="mt-1.5 flex items-start gap-2 rounded-md bg-error/10 px-3 py-2 text-xs text-[#ff9aab] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)]">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{item.error}</span>
          </div>
        )}
        {stopped && !item.error && <div className="mt-1 text-2xs font-semibold text-mute-2">stopped: {item.stopReason}</div>}
      </div>
    </div>
  );
}

function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  const live = item.streaming;
  const tail = live ? item.text.slice(-420) : "";
  return (
    <div className="pl-[var(--tf-gutter,38px)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={item.redacted && !live}
        className={cn(
          "focus-ring pressable inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold shadow-hairline",
          live ? "bg-accent/10 text-accent-ink" : "bg-white/[0.04] text-mute hover:text-ink",
        )}
      >
        {live ? <Brain className="tf-loop size-3 animate-breathe [--tf-breath:1.2s]" /> : <Sparkles className="size-3" />}
        {live ? (
          <Shimmer>
            Thinking… <Elapsed since={item.at} />
          </Shimmer>
        ) : item.redacted ? (
          `Thought${item.durationMs != null ? ` for ${formatElapsed(item.durationMs)}` : ""} · redacted`
        ) : (
          `Thought${item.durationMs != null ? ` for ${formatElapsed(item.durationMs)}` : ""}`
        )}
        {!item.redacted && <ChevronDown className={cn("size-3 transition-transform duration-300", !open && "-rotate-90")} />}
      </button>
      {live && !open && tail && (
        <div className="relative mt-1.5 max-h-[4.8em] overflow-hidden pl-3 text-xs leading-[1.6] text-mute italic [mask-image:linear-gradient(transparent,#000_60%)]">
          <span className="absolute top-0 bottom-0 left-0 w-px bg-accent/40" />
          <div className="flex min-h-[4.8em] flex-col justify-end whitespace-pre-wrap">{tail}</div>
        </div>
      )}
      {open && !item.redacted && (
        <div className="mt-1.5 border-l border-accent/30 pl-3 text-[12.5px] text-mute italic">
          <Markdown text={item.text} streaming={live} className="text-[12.5px] text-mute" />
        </div>
      )}
    </div>
  );
}

const NOTICE_TONE: Record<NoticeItem["level"], { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: "bg-white/[0.03] text-mute" },
  warn: { icon: AlertTriangle, cls: "bg-warn/[0.08] text-[#fde68a] shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]" },
  error: { icon: CircleAlert, cls: "bg-error/[0.08] text-[#ff9aab] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)]" },
};

function NoticeRow({ item }: { item: NoticeItem }) {
  const tone = NOTICE_TONE[item.level];
  const Icon = tone.icon;
  return (
    <div className="pl-[var(--tf-gutter,38px)]">
      <div role={item.level === "error" ? "alert" : undefined} className={cn("flex items-start gap-2 rounded-md px-3 py-1.5 text-xs shadow-hairline", tone.cls)}>
        <Icon className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
        {item.source && <span className="shrink-0 font-mono text-[10.5px] opacity-70">{item.source}</span>}
      </div>
    </div>
  );
}

function CompactionRow({ item }: { item: CompactionItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring group/cmp flex w-full items-center gap-3 rounded-md text-left">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-review/40" />
        <span className="flex items-center gap-1.5 rounded-full bg-review/10 px-3 py-1 text-[11px] font-bold text-review shadow-[inset_0_0_0_1px_rgb(34_211_238/0.3)]">
          <Layers className="size-3" />
          Compacted{item.tokensBefore != null && ` · ${formatCompact(item.tokensBefore)} tokens`}
          <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-review/40" />
      </button>
      {open && <Markdown text={item.summary} className="mx-auto mt-2 max-w-[760px] rounded-lg bg-white/[0.025] px-4 py-3 text-[12.5px] shadow-hairline" />}
    </div>
  );
}

function ModeRow({ item }: { item: ModeItem }) {
  return (
    <div className="flex items-center gap-3 py-0.5 text-[11px] font-semibold text-mute-2">
      <span className="h-px flex-1 bg-line" />
      <span className="max-w-[70%] truncate">{item.text}</span>
      <span className="font-normal tabular">{clock(item.at)}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
