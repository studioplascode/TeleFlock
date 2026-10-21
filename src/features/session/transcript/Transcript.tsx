import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, MessageSquareDashed } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { getTranscript, loadOlder, useAgent, useSession, useSessionItem } from "@/core";
import type { TranscriptItem } from "@/core/gen";
import { cn, Elapsed, EmptyState, Shimmer, Skeleton, spring, StatusOrb, useIdleReady } from "@/design";
import { Row } from "./rows";

const STICK_PX = 56;
const LOAD_OLDER_PX = 480;
const ROW_GAP = 12;
/** Typical row heights before measurement (tool cards with output dominate). */
const ROW_ESTIMATE: Partial<Record<TranscriptItem["kind"], number>> = { tool: 320, assistant: 140, user: 88, thinking: 56 };
const ROW_ESTIMATE_DEFAULT = 48;
/** Growth larger than this while following is a jump (session switch, big paste), not a glide. */
const GLIDE_MAX_PX = 900;

export interface TranscriptProps {
  agentKey: string;
  className?: string;
  /** Padding around the rows (px). */
  padX?: number;
  /** Extra space under the last row (px), e.g. for an overlaid composer. */
  padBottom?: number;
  /** Avatar gutter for indented rows (px). */
  gutter?: number;
  /**
   * Rows rendered beyond each edge of the viewport once the transcript has settled (default 8).
   * The first paint renders at most 2, so opening a session lays out little more than a screenful.
   */
  overscan?: number;
}

/**
 * Virtualised, append-only transcript. Rows subscribe to their own item; this component only
 * re-renders when the id list changes. Sticks to the bottom while streaming, offers a
 * "jump to latest" pill when scrolled up, and pages older rows in at the top without a jump.
 */
export function Transcript({ agentKey, className, padX = 20, padBottom = 24, gutter = 38, overscan = 8 }: TranscriptProps) {
  const session = useSession(agentKey);
  const ids = session.itemIds;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  // 0, not ids.length: a transcript mounting with rows already loaded lands at the bottom instantly.
  const lastCount = useRef(0);
  const glideRaf = useRef(0);
  const settled = useIdleReady(400);
  const settledRef = useRef(settled);
  settledRef.current = settled;

  // Per-kind estimates keep the first (pre-measure) render close to one screenful of rows.
  const kinds = useMemo(() => {
    const byId = new Map(getTranscript(agentKey).items.map((it) => [it.id, it.kind]));
    return ids.map((id) => byId.get(id));
  }, [agentKey, ids]);
  const estimate = (i: number) => {
    const kind = kinds[i];
    return (kind && ROW_ESTIMATE[kind]) ?? ROW_ESTIMATE_DEFAULT;
  };
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey: (i) => ids[i] ?? i,
    overscan: settled ? overscan : Math.min(overscan, 2),
    gap: ROW_GAP,
    paddingStart: 16,
    // First render already sits at the bottom (where the layout effect scrolls to), so opening a
    // session builds only the last screenful of rows instead of the top ones and then the bottom.
    initialOffset: () => ids.reduce((sum, _, i) => sum + estimate(i) + ROW_GAP, 0),
    initialRect: { width: 0, height: typeof window === "undefined" ? 800 : window.innerHeight },
  });

  const setStick = (v: boolean) => {
    stick.current = v;
    setStuck(v);
    if (v) setUnseen(0);
  };

  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  // Follow the bottom with an eased glide instead of snapping on every streamed line, so text
  // rolls up smoothly. Reduced motion, big jumps and the first moments after opening (rows still
  // measuring in) snap, so opening never plays a scroll animation.
  const glide = () => {
    if (glideRaf.current) return;
    const step = () => {
      glideRaf.current = 0;
      const el = scrollRef.current;
      if (!el || !stick.current) return;
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (gap <= 0.5) return;
      if (gap > GLIDE_MAX_PX || !settledRef.current || document.documentElement.dataset.motion === "reduced") {
        el.scrollTop = el.scrollHeight;
        return;
      }
      el.scrollTop += Math.max(1, gap * 0.2);
      glideRaf.current = requestAnimationFrame(step);
    };
    glideRaf.current = requestAnimationFrame(step);
  };

  // Follow growth (new rows, streaming text, rows measuring) and viewport shrink (ask card,
  // queue chips, keyboard) while stuck to the bottom.
  useEffect(() => {
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) glide();
    });
    ro.observe(content);
    ro.observe(viewport);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(glideRaf.current);
      glideRaf.current = 0;
    };
  }, []);

  // Rows appended / prepended.
  useLayoutEffect(() => {
    const prev = lastCount.current;
    lastCount.current = ids.length;
    const a = anchor.current;
    if (a) {
      // Prepend: keep the previously first-visible row exactly where it was.
      const idx = ids.indexOf(a.id);
      anchor.current = null;
      if (idx > 0 && scrollRef.current) {
        const [offset] = virtualizer.getOffsetForIndex(idx, "start") ?? [0];
        scrollRef.current.scrollTop = offset + a.delta;
        return;
      }
    }
    if (stick.current) {
      // First paint of a session lands at the bottom instantly; later rows glide in.
      if (prev === 0) toBottom();
      else glide();
    } else if (ids.length > prev) setUnseen((n) => n + (ids.length - prev));
  }, [ids]);

  // Unsticking is driven by user input (wheel, touch, keys, scrollbar) only: the virtualizer moves
  // scrollTop on its own while rows measure, which would read as the user scrolling up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom <= STICK_PX && !stick.current) setStick(true);

    if (el.scrollTop < LOAD_OLDER_PX && session.hasMore && !loadingOlder && ids.length > 0) {
      const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop);
      const id = first ? ids[first.index] : undefined;
      if (first && id) anchor.current = { id, delta: el.scrollTop - first.start };
      setLoadingOlder(true);
      loadOlder(agentKey).finally(() => setLoadingOlder(false));
    }
  };

  // Wheel/touch/keys up while stuck: release immediately so the user wins against streaming.
  const release = (e: WheelEvent) => {
    if (e.deltaY < 0 && stick.current) setStick(false);
  };
  const releaseKey = (e: KeyboardEvent) => {
    if (stick.current && (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home")) setStick(false);
  };

  const items = virtualizer.getVirtualItems();
  const lastId = ids[ids.length - 1];

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={release}
        onKeyDown={releaseKey}
        onPointerDown={(e) => {
          // Grabbing the scrollbar (the scroller itself is the target).
          if (e.target === e.currentTarget && stick.current) setStick(false);
        }}
        onTouchMove={() => {
          const el = scrollRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > STICK_PX && stick.current) setStick(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [-webkit-mask-image:linear-gradient(transparent,#000_28px)]"
        role="log"
        aria-label="Transcript"
        aria-busy={session.status === "loading"}
        style={{ ["--tf-gutter" as string]: `${gutter}px` }}
      >
        <div ref={contentRef} style={{ paddingLeft: padX, paddingRight: padX, paddingBottom: padBottom }}>
          {session.hasMore && (
            <div className="flex justify-center pt-3 text-2xs font-semibold text-mute-2">
              {loadingOlder ? <Shimmer>Loading earlier messages…</Shimmer> : "Scroll up for earlier messages"}
            </div>
          )}
          {session.status === "loading" && ids.length === 0 ? (
            <TranscriptSkeleton />
          ) : ids.length === 0 ? (
            <EmptyState className="mt-16" icon={<MessageSquareDashed />} title="No messages yet" description="Send a prompt to get this agent going." />
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((v) => {
                const id = ids[v.index];
                if (!id) return null;
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full [contain:layout_style]"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <Row agentKey={agentKey} itemId={id} prevId={ids[v.index - 1]} nextId={ids[v.index + 1]} rail={gutter > 0} />
                  </div>
                );
              })}
            </div>
          )}
          <WorkingFooter agentKey={agentKey} lastId={lastId} />
        </div>
      </div>
      <AnimatePresence>
        {!stuck && ids.length > 0 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 16, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.bouncy }}
            exit={{ opacity: 0, y: 10, scale: 0.92 }}
            onClick={() => {
              setStick(true);
              toBottom(true);
            }}
            className="focus-ring absolute bottom-4 left-1/2 z-raised flex -translate-x-1/2 items-center gap-2 rounded-full glass px-3.5 py-2 text-xs font-bold text-ink shadow-glow-accent"
          >
            <JumpLabel agentKey={agentKey} unseen={unseen} />
            <ArrowDown className="size-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

function JumpLabel({ agentKey, unseen }: { agentKey: string; unseen: number }) {
  const agent = useAgent(agentKey);
  const live = agent?.live.streaming || agent?.live.tool != null;
  return (
    <>
      {live && <StatusOrb status="running" activity="busy" size={7} label={null} />}
      {unseen > 0 ? `${unseen} new` : live ? "Streaming" : "Jump to latest"}
    </>
  );
}

/** "Waiting on the model" heartbeat under the last row while a turn runs without visible output. */
function WorkingFooter({ agentKey, lastId }: { agentKey: string; lastId: string | undefined }) {
  const agent = useAgent(agentKey);
  const last = useSessionItem(agentKey, lastId ?? "");
  const running = agent?.column === "running";
  const lastLive =
    last != null &&
    ((last.kind === "assistant" && last.streaming) || (last.kind === "thinking" && last.streaming) || (last.kind === "tool" && (last.status === "running" || last.status === "pending")));
  const show = running && !lastLive;
  const since = agent?.omp?.turnStartedAt ?? agent?.stateSince ?? Date.now();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2.5 pt-3 pl-[var(--tf-gutter,38px)] text-xs font-semibold text-mute"
          aria-live="polite"
        >
          <span data-status="running" className="relative grid size-5 place-items-center">
            <span className="tf-loop absolute inset-0 animate-breathe rounded-full bg-accent/25 [--tf-breath:2.8s]" />
            <StatusOrb status="running" activity="calm" size={8} label={null} />
          </span>
          <Shimmer>{agent?.live.thinking ? "Thinking" : agent?.live.line ? agent.live.line : "Working"}…</Shimmer>
          <Elapsed since={since} className="text-mute-2 tabular" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Placeholder rows while the session loads (or while the phone defers mounting the transcript). */
export function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-4 pt-6">
      <Skeleton className="ml-auto h-12 w-2/5 rounded-[20px]" />
      <div className="flex gap-2.5">
        <Skeleton className="size-7 shrink-0 rounded-[10px]" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-4/5 rounded-sm" />
          <Skeleton className="h-4 w-3/5 rounded-sm" />
        </div>
      </div>
      <Skeleton className="ml-[38px] h-10 rounded-[16px]" />
      <Skeleton className="ml-[38px] h-28 rounded-[16px]" />
    </div>
  );
}
