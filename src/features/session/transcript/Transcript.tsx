import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { getTranscript, loadOlder, useAgent, useCore, useSession, useSessionItem } from "@/core";
import type { TranscriptItem } from "@/core/gen";
import { cn, Elapsed, Shimmer, Skeleton, spring, StatusOrb, useIdleReady } from "@/design";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { useTranscriptFind } from "../find/hooks";
import { type TranscriptFind, useFindPainter } from "../find/painter";
import { FindScopeCtx } from "../find/reveal";
import { useSessionUi } from "../state";
import { estimateRowHeight, initialScrollOffset } from "./estimate";
import { EmptyTranscript } from "./FreshStart";
import { LimitRunRow } from "./LimitRunRow";
import { foldLimitRuns, limitSignature } from "./limitRuns";
import { Row } from "./rows";

const STICK_PX = 56;
const LOAD_OLDER_PX = 480;
const ROW_GAP = 12;
/** Phone spacing: rows sit closer so more of the conversation fits. */
const ROW_GAP_DENSE = 8;
/** Reading measure on very wide windows (the ask card and composer line up with it). */
export const TRANSCRIPT_MAX_WIDTH = 1120;
/** Growth larger than this while following is a jump (session switch, big paste), not a glide. */
const GLIDE_MAX_PX = 900;

/** Layout knobs shared by the session transcript and other transcript lists (subagents). */
export interface TranscriptLayout {
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
  /** Phone spacing: tighter row gaps and edge padding. */
  dense?: boolean;
}

export interface TranscriptProps extends TranscriptLayout {
  agentKey: string;
}

/**
 * Virtualised, append-only transcript of a session. Rows subscribe to their own item; this
 * component only re-renders when the id list changes.
 */
export function Transcript({ agentKey, ...layout }: TranscriptProps) {
  const session = useSession(agentKey);
  const focus = useSessionUi((s) => s.focus[agentKey]);
  const find = useTranscriptFind(agentKey);
  const rawIds = session.itemIds;
  // Which rows are provider-limit errors (or system turns): a row can turn into one in place, keeping its id.
  const limits = useCore((s) => {
    const e = s.sessions[agentKey];
    return e ? limitSignature(e.itemIds, e.items) : "";
  });
  // Items in id order: row height estimates before rows are measured (keeps the scrollbar steady).
  const rawItems = useMemo(() => {
    const byId = new Map(getTranscript(agentKey).items.map((it) => [it.id, it]));
    return rawIds.map((id) => byId.get(id));
    // `limits` re-reads the items when a row turns into an error without a new id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, rawIds, limits]);
  // Consecutive provider-limit errors read as one row; while Find is open every row stays, so its matches can be reached.
  const finding = find?.needle != null;
  const folded = useMemo(() => (finding ? null : foldLimitRuns(rawIds, rawItems)), [finding, rawIds, rawItems]);
  const ids = folded?.ids ?? rawIds;
  const items = folded?.items ?? rawItems;
  return (
    <FindScopeCtx.Provider value={agentKey}>
      <TranscriptLog
        {...layout}
        ids={ids}
        items={items}
        loading={session.status === "loading"}
        hasMore={session.hasMore}
        onLoadOlder={() => loadOlder(agentKey)}
        renderRow={(id, prevId, nextId, rail) => {
          const run = folded?.runs.get(id);
          return run ? <LimitRunRow agentKey={agentKey} run={run} /> : <Row agentKey={agentKey} itemId={id} prevId={prevId} nextId={nextId} rail={rail} />;
        }}
        empty={<EmptyTranscript agentKey={agentKey} />}
        footer={<WorkingFooter agentKey={agentKey} lastId={ids[ids.length - 1]} />}
        jumpLabel={(unseen) => <JumpLabel agentKey={agentKey} unseen={unseen} />}
        focus={focus}
        find={find}
      />
    </FindScopeCtx.Provider>
  );
}

export interface TranscriptLogProps extends TranscriptLayout {
  /** Row ids, oldest first. Pass the same array while the id list is unchanged. */
  ids: string[];
  /** The item of each id (same order), for size estimates before rows are measured. */
  items: readonly (TranscriptItem | undefined)[];
  /** One row; `rail` = draw the gutter timeline. */
  renderRow: (id: string, prevId: string | undefined, nextId: string | undefined, rail: boolean) => ReactNode;
  /** First load in flight: a skeleton while there are no rows yet. */
  loading?: boolean;
  /** Shown once loaded without rows. */
  empty: ReactNode;
  /** Under the last row (e.g. a "working" heartbeat). */
  footer?: ReactNode;
  /** Older rows exist above the first one; `onLoadOlder` pages them in. */
  hasMore?: boolean;
  onLoadOlder?: () => Promise<unknown>;
  /** Content of the "jump to latest" pill shown while scrolled up. */
  jumpLabel: (unseen: number) => ReactNode;
  ariaLabel?: string;
  /** Scroll this row into view and flash it (a new `nonce` re-triggers). */
  focus?: { itemId: string; nonce: number };
  /** A new non-zero value sticks to the bottom and scrolls there (e.g. after the user sent a message). */
  followSignal?: number;
  /** Find in transcript: matches to highlight in the rendered rows, and the current one to bring into view. */
  find?: TranscriptFind;
}

/**
 * The transcript list itself, independent of where rows come from. Sticks to the bottom while
 * streaming, offers a "jump to latest" pill when scrolled up, and pages older rows in at the top
 * without a jump.
 */
export function TranscriptLog({
  ids,
  items,
  renderRow,
  loading = false,
  empty,
  footer,
  hasMore = false,
  onLoadOlder,
  jumpLabel,
  ariaLabel = "Transcript",
  focus,
  followSignal = 0,
  find,
  className,
  padX = 20,
  dense = false,
  padBottom = dense ? 12 : 24,
  gutter = 38,
  overscan = 8,
}: TranscriptLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  // 0, not ids.length: a transcript mounting with rows already loaded lands at the bottom instantly.
  const lastCount = useRef(0);
  const lastId = useRef<string | undefined>(undefined);
  const glideRaf = useRef(0);
  const settled = useIdleReady(400);
  const settledRef = useRef(settled);
  settledRef.current = settled;

  // Stable while the rows are: a new getItemKey makes the virtualizer re-measure every row (O(n))
  // on each render, which scrolling a long transcript does dozens of times a second.
  const estimate = useCallback((i: number) => estimateRowHeight(items[i], dense), [items, dense]);
  const initialHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const itemKey = useCallback((i: number) => ids[i] ?? i, [ids]);
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey: itemKey,
    overscan: settled ? overscan : Math.min(overscan, 2),
    gap: dense ? ROW_GAP_DENSE : ROW_GAP,
    // Phones float the pager dots over this strip.
    paddingStart: 16,
    // First render already sits at the bottom (where the layout effect scrolls to), so opening a
    // session builds only the last screenful of rows instead of the top ones and then the bottom.
    initialOffset: () => initialScrollOffset(ids.reduce((sum, _, i) => sum + estimate(i) + (dense ? ROW_GAP_DENSE : ROW_GAP), 0), initialHeight),
    initialRect: { width: 0, height: initialHeight },
    // Scrolling re-renders with React's normal batching instead of flushSync inside every scroll
    // event: rows entering view mount once per frame, not once per event (overscan covers the edge).
    useFlushSync: false,
  });

  const setStick = (v: boolean) => {
    stick.current = v;
    setStuck(v);
    if (v) setUnseen(0);
  };

  useFindPainter({
    find,
    scrollRef,
    contentRef,
    ids,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: "center" }),
    unstick: () => {
      if (stick.current) setStick(false);
    },
  });

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
    const prevLast = lastId.current;
    lastId.current = ids[ids.length - 1];
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
    } else if (ids.length > prev) {
      // Only rows after the previous last one are new: older ones paged in (Find) are not.
      const at = prevLast === undefined ? -1 : ids.lastIndexOf(prevLast);
      const added = at < 0 ? ids.length - prev : ids.length - 1 - at;
      if (added > 0) setUnseen((n) => n + added);
    }
  }, [ids]);

  // Jump to a row (Chat tab): unstick, centre it, then flash it once it has rendered. Only
  // requests made while mounted count: a remount (session switch) must not replay an old jump.
  const handledFocus = useRef(focus?.nonce);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    if (!focus || focus.nonce === handledFocus.current) return;
    handledFocus.current = focus.nonce;
    const idx = ids.indexOf(focus.itemId);
    if (idx < 0) return;
    setStick(false);
    virtualizer.scrollToIndex(idx, { align: "center" });
    const t = window.setTimeout(() => {
      // Rows above may have measured (or an older page loaded) since: re-resolve, settle, flash.
      const now = idsRef.current.indexOf(focus.itemId);
      if (now < 0) return;
      virtualizer.scrollToIndex(now, { align: "center" });
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(focus.itemId)}"]`);
      el?.animate([{ backgroundColor: "rgb(163 92 240 / 0.16)", borderRadius: "18px" }, { backgroundColor: "transparent", borderRadius: "18px" }], { duration: 1400, easing: "ease-out" });
    }, 220);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new focus request jumps
  }, [focus?.nonce]);

  // The user just sent something: follow the conversation again, even if they had scrolled up.
  useEffect(() => {
    if (!followSignal) return;
    setStick(true);
    toBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new signal jumps
  }, [followSignal]);

  // Unsticking is driven by user input (wheel, touch, keys, scrollbar) only: the virtualizer moves
  // scrollTop on its own while rows measure, which would read as the user scrolling up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom <= STICK_PX && !stick.current) setStick(true);

    if (el.scrollTop < LOAD_OLDER_PX && hasMore && onLoadOlder && !loadingOlder && ids.length > 0) {
      const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop);
      const id = first ? ids[first.index] : undefined;
      if (first && id) anchor.current = { id, delta: el.scrollTop - first.start };
      setLoadingOlder(true);
      void onLoadOlder().finally(() => setLoadingOlder(false));
    }
  };

  // Wheel/touch/keys up while stuck: release immediately so the user wins against streaming.
  const release = (e: WheelEvent) => {
    if (e.deltaY < 0 && stick.current) setStick(false);
  };
  const releaseKey = (e: KeyboardEvent) => {
    if (stick.current && (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home")) setStick(false);
  };

  const visible = virtualizer.getVirtualItems();

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
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]",
          dense ? "[-webkit-mask-image:linear-gradient(transparent,#000_20px)]" : "[-webkit-mask-image:linear-gradient(transparent,#000_28px)]",
        )}
        role="log"
        aria-label={ariaLabel}
        aria-busy={loading}
        style={{ ["--tf-gutter" as string]: `${gutter}px` }}
      >
        <div ref={contentRef} className="mx-auto w-full" style={{ maxWidth: TRANSCRIPT_MAX_WIDTH, paddingLeft: padX, paddingRight: padX, paddingBottom: padBottom }}>
          {hasMore && (
            // Dense (phone): clears the pager dots floated over the top edge.
            <div className={cn("flex justify-center text-2xs font-semibold text-mute-2", dense ? "pt-6" : "pt-3")}>
              {loadingOlder ? <Shimmer>Loading earlier messages…</Shimmer> : "Scroll up for earlier messages"}
            </div>
          )}
          {loading && ids.length === 0 ? (
            <TranscriptSkeleton />
          ) : ids.length === 0 ? (
            empty
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {visible.map((v) => {
                const id = ids[v.index];
                if (!id) return null;
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    data-row-id={id}
                    data-find-active={find?.active?.id === id || undefined}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full [contain:layout_style]"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    {renderRow(id, ids[v.index - 1], ids[v.index + 1], gutter > 0)}
                  </div>
                );
              })}
            </div>
          )}
          {footer}
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
            className="focus-ring absolute bottom-4 left-1/2 z-raised flex -translate-x-1/2 items-center gap-2 rounded-full glass-blur px-3.5 py-2 text-xs font-bold text-ink shadow-glow-accent"
          >
            {jumpLabel(unseen)}
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
  // herdr is down: nothing runs, whatever the cached column says
  const herdrDown = useHerdrDown(agent?.hostId ?? "") !== undefined;
  const running = agent?.column === "running" && !herdrDown;
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
