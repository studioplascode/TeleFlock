import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { getSessionItem, getTranscript, loadOlder, useAgent, useCore, useSession, useSessionItem } from "@/core";
import type { TranscriptItem } from "@/core/gen";
import { cn, Elapsed, IconButton, Shimmer, Skeleton, Spinner, spring, StatusOrb, Tooltip, useIdleReady } from "@/design";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { ACTIONS } from "@/features/shell/vocab";
import { inSessionScope } from "../context";
import { useTranscriptFind } from "../find/hooks";
import { type TranscriptFind, useFindPainter } from "../find/painter";
import { FindScopeCtx } from "../find/reveal";
import { useSessionUi } from "../state";
import { arrivedSince, type ListMark } from "./arrivals";
import { estimateRowHeight, initialScrollOffset } from "./estimate";
import { EmptyTranscript } from "./FreshStart";
import { lastMessage, type MessageKind, messageKind, nearestMessage, type ReadingRows, readingRows, sameMessage, type StepDir, stepMessage } from "./lastMessage";
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
/** Where a jump to a row's start lands its top: under the faded top edge (and a phone's pager dots). */
const JUMP_TOP_PX = 28;
/** A row whose top is this close to that spot is already there: no pill. */
const JUMP_NEAR_PX = 24;
/** How long a jump keeps placing its row while the rows around it measure in. */
const JUMP_SETTLE_MS = 1000;
/** Input on the list that hands a jump in progress back to the user. */
const JUMP_ENDERS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
/** A page of earlier rows that brought nothing in by then ends the step waiting for it (rows that came are in by the next frame). */
const PAGE_SETTLE_MS = 1000;

/** The message steppers, left to right: the agent's (its rows sit left), then the prompts (theirs sit right). */
const STEP_KINDS: readonly MessageKind[] = ["assistant", "user"];
/**
 * What each kind's stepper can do, as bits of one number (shifted by `NAV_SHIFT`): it has messages,
 * a step back, a step on. One number, so a scroll that changes none of them renders nothing.
 */
const NAV_HAS = 1;
const NAV_OLDER = 2;
const NAV_NEWER = 4;
const NAV_SHIFT: Record<MessageKind, number> = { assistant: 0, user: 3 };
const navHas = (nav: number, kind: MessageKind, flag: number) => ((nav >> NAV_SHIFT[kind]) & flag) !== 0;

/** Alt+↑ / Alt+↓ step through the agent's messages, with Shift through the prompts (the shortcuts `ACTIONS` names). */
const STEP_KEYS: Record<MessageKind, Record<StepDir, string>> = {
  assistant: { older: ACTIONS.olderAgentMessage.shortcut, newer: ACTIONS.newerAgentMessage.shortcut },
  user: { older: ACTIONS.olderOwnMessage.shortcut, newer: ACTIONS.newerOwnMessage.shortcut },
};

function stepKeyOf(e: globalThis.KeyboardEvent): { dir: StepDir; kind: MessageKind } | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  const dir = e.key === "ArrowUp" ? "older" : e.key === "ArrowDown" ? "newer" : null;
  return dir && { dir, kind: e.shiftKey ? "user" : "assistant" };
}

/** A text field with something in it keeps the step keys for its caret (macOS moves it by paragraph). */
function holdsText(t: Element | null): boolean {
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return t.value !== "";
  return t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable && t.textContent !== "");
}

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
  /** The route's session: the step keys also work while focus is on nothing (`inSessionScope`). */
  pageKeys?: boolean;
}

/** One kind's message stepper: its word between the arrows, the group's name and its two steps' names. */
export interface StepNames {
  label: string;
  group: string;
  older: string;
  newer: string;
}

/** What the message steppers of a transcript list step through (`TranscriptLogProps.steps`). */
export interface MessageSteps {
  /**
   * Which kind of message row `id` is (`messageKind`). Read when a step is worked out, so a reply that
   * starts streaming counts as soon as it has text.
   */
  kindOf: (id: string) => MessageKind | null;
  names: Record<MessageKind, StepNames>;
  /**
   * Whether a key press belongs to this list (`target`: where it happened, `list`: the list itself):
   * Alt+↑ / Alt+↓ then step through the agent's messages, Alt+Shift+↑ / ↓ through the prompts. A text
   * field with text in it keeps them. Without it the keys don't step this list.
   */
  keys?: (target: Element | null, list: HTMLElement) => boolean;
}

/** A session's steppers: the agent's messages and the user's own. */
export const SESSION_STEPS: Record<MessageKind, StepNames> = {
  assistant: { label: "Agent", group: "Agent's messages", older: ACTIONS.olderAgentMessage.label, newer: ACTIONS.newerAgentMessage.label },
  user: { label: "You", group: "Your messages", older: ACTIONS.olderOwnMessage.label, newer: ACTIONS.newerOwnMessage.label },
};

/**
 * Virtualised, append-only transcript of a session. Rows subscribe to their own item; this
 * component only re-renders when the id list (or which row is the last message) changes.
 */
export function Transcript({ agentKey, pageKeys = false, ...layout }: TranscriptProps) {
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
  // The newest message (the agent's text or the user's prompt, whichever is newer): the pill beside
  // "jump to latest" brings its start up. From the store, so a text row that starts streaming takes
  // over without a new id.
  const last = useCore((s) => {
    const e = s.sessions[agentKey];
    return e ? lastMessage(e.itemIds, (id) => e.items[id]) : null;
  }, sameMessage);
  // Message steps read the store when they are worked out: a reply streaming in counts once it has text.
  const steps = useMemo<MessageSteps>(
    () => ({ kindOf: (id) => messageKind(getSessionItem(agentKey, id)), names: SESSION_STEPS, keys: (t) => inSessionScope(t, agentKey, pageKeys) }),
    [agentKey, pageKeys],
  );
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
        jumpBack={last && (last.kind === "assistant" ? { id: last.id, label: "Agent's last message", short: "Agent's message" } : { id: last.id, label: "Your last message", short: "Your message" })}
        steps={steps}
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
  items?: readonly (TranscriptItem | undefined)[];
  /** Height of row `index` before it is measured, for lists of something else than transcript items (default: from `items`). */
  estimateSize?: (index: number) => number;
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
  /**
   * A row to offer a jump to beside the "jump to latest" pill (the last message: `lastMessage`),
   * named by `label` (`short` where the list is narrow: phones, split panes). The jump brings the
   * row's top to the top of the list; the pill hides while it is there.
   */
  jumpBack?: { id: string; label: string; short?: string } | null;
  /**
   * Message steppers beside the pills while scrolled up: per kind, ⌃ back to the start of the
   * previous message and ⌄ on to the next, from where the list is read (the row at its top), and the
   * keys `keys` lets through. Without it, none.
   */
  steps?: MessageSteps | null;
  ariaLabel?: string;
  /** Scroll this row into view and flash it (a new `nonce` re-triggers). */
  focus?: { itemId: string; nonce: number };
  /** A new non-zero value sticks to the bottom and scrolls there (e.g. after the user sent a message). */
  followSignal?: number;
  /** Which rows the list shows (e.g. a filter): rows that come with another view are not counted as new. */
  view?: string;
  /** Find in transcript: matches to highlight in the rendered rows, and the current one to bring into view. */
  find?: TranscriptFind;
}

/**
 * The transcript list itself, independent of where rows come from. Sticks to the bottom while
 * streaming, offers a "jump to latest" pill when scrolled up (and beside it one to `jumpBack`'s
 * row, and the `steps` steppers), and pages older rows in at the top without a jump.
 */
export function TranscriptLog({
  ids,
  items,
  estimateSize,
  renderRow,
  loading = false,
  empty,
  footer,
  hasMore = false,
  onLoadOlder,
  jumpLabel,
  jumpBack,
  steps,
  ariaLabel = "Transcript",
  focus,
  followSignal = 0,
  view,
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
  // The same for handlers: a second page must not start before the first one's rows are in.
  const loadingRef = useRef(false);
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  // Count 0, not ids.length: a transcript mounting with rows already loaded lands at the bottom instantly.
  const lastShown = useRef<ListMark>({ count: 0, lastId: undefined, view });
  const glideRaf = useRef(0);
  const settled = useIdleReady(400);
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const listRef = useRef<HTMLDivElement>(null);
  // The jump-back pill's aim: its row and which way that is from the view (null: no pill). Kept with
  // the row it was worked out for, so a new target never shows the previous one's arrow.
  const [aim, setAim] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const backIdRef = useRef(jumpBack?.id);
  backIdRef.current = jumpBack?.id;
  const jumpRaf = useRef(0);
  // The row the jump in progress places (while `jumpRaf` runs): a step meanwhile walks on from it.
  const placing = useRef<string | null>(null);
  // Message steppers: what there is to step to from where the list is read (`NAV_*` bits per kind),
  // and the kind whose step back waits for earlier rows to page in (its ⌃ spins meanwhile).
  const [nav, setNav] = useState(0);
  const [paging, setPaging] = useState<MessageKind | null>(null);
  // That step: its kind, and the first row before the page it waits for came in.
  const pendingStep = useRef<{ kind: MessageKind; first: string | undefined } | null>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;

  // Stable while the rows are: a new getItemKey makes the virtualizer re-measure every row (O(n))
  // on each render, which scrolling a long transcript does dozens of times a second.
  const estimate = useCallback((i: number) => (estimateSize ? estimateSize(i) : estimateRowHeight(items?.[i], dense)), [items, dense, estimateSize]);
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
    if (!v) return;
    setUnseen(0);
    // Following the bottom again: a step still waiting for earlier rows is off.
    if (pendingStep.current) dropStep();
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
      else locate();
    });
    ro.observe(content);
    ro.observe(viewport);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(glideRaf.current);
      glideRaf.current = 0;
    };
  }, []);

  // Rows appended / prepended, or another view (a filter) of the rows.
  useLayoutEffect(() => {
    const prev = lastShown.current;
    lastShown.current = { count: ids.length, lastId: ids[ids.length - 1], view };
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
      if (prev.count === 0) toBottom();
      else glide();
    } else if (view !== prev.view) {
      setUnseen(0);
    } else {
      const added = arrivedSince(prev, ids, view);
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
      el?.animate([{ backgroundColor: "color-mix(in srgb, var(--color-accent) 16%, transparent)", borderRadius: "18px" }, { backgroundColor: "transparent", borderRadius: "18px" }], { duration: 1400, easing: "ease-out" });
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

  // How far the list scrolls to bring row `index`'s top to its spot, and whether it scrolls that far
  // (else a jump there ends at the bottom, where "jump to latest" goes). Its place in the list,
  // measured or (not rendered) estimated. Not from the rendered range: a scroll event reaches React
  // before the virtualiser has moved that range along.
  const spotShift = (index: number): { shift: number; reaches: boolean } | null => {
    const el = scrollRef.current;
    const list = listRef.current;
    const row = index < 0 ? undefined : virtualizer.measurementsCache[index];
    if (!el || !list || !row) return null;
    const shift = list.getBoundingClientRect().top - el.getBoundingClientRect().top + row.start - JUMP_TOP_PX;
    return { shift, reaches: el.scrollTop + shift < el.scrollHeight - el.clientHeight - STICK_PX };
  };

  // Where the jump-back row is from the view: "up" / "down", or null (no pill) while its top is at
  // the top already, or when the list can't scroll it up there. Reads refs only: the resize
  // observer calls it too.
  const aimBack = () => {
    const id = backIdRef.current;
    const to = id == null || stick.current ? null : spotShift(idsRef.current.lastIndexOf(id));
    if (id == null || !to) {
      setAim(null);
      return;
    }
    const dir = Math.abs(to.shift) <= JUMP_NEAR_PX || (to.shift > 0 && !to.reaches) ? null : to.shift < 0 ? "up" : "down";
    setAim((prev) => (dir == null ? null : prev?.id === id && prev.dir === dir ? prev : { id, dir }));
  };

  // Where the list is read (`readingRows`): the rows above and below the spot a jump brings a row's
  // top to, from the virtualiser's row places (measured, or estimated where not rendered) like the
  // pill's aim. Reads refs only.
  const readAt = (): ReadingRows | null => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return null;
    return readingRows(virtualizer.measurementsCache, el.getBoundingClientRect().top - list.getBoundingClientRect().top + JUMP_TOP_PX, JUMP_NEAR_PX);
  };

  // What the steppers can do from where the list is read (`NAV_*` bits per kind; 0 while following
  // the bottom, where they don't show). A step back is there while earlier rows can page in.
  const navAt = (): number => {
    const s = stepsRef.current;
    const at = s && !stick.current ? readAt() : null;
    if (!s || !at) return 0;
    const ids = idsRef.current;
    const more = hasMoreRef.current && loadOlderRef.current != null;
    let bits = 0;
    for (const kind of STEP_KINDS) {
      const older = more || stepMessage(ids, s.kindOf, at, "older", kind) != null;
      const newer = stepMessage(ids, s.kindOf, at, "newer", kind) != null;
      // A message at the spot is no step either way, but its stepper stays.
      let has = older || newer;
      for (let i = at.above + 1; !has && i < at.below && i < ids.length; i++) has = s.kindOf(ids[i] as string) === kind;
      bits |= ((has ? NAV_HAS : 0) | (older ? NAV_OLDER : 0) | (newer ? NAV_NEWER : 0)) << NAV_SHIFT[kind];
    }
    return bits;
  };

  // The pill's aim and the steppers' steps, wherever the view or the rows moved.
  const locate = () => {
    aimBack();
    setNav(navAt());
  };
  // A new target (rows streaming in), rows paged in, or the list let go of the bottom / caught it.
  useLayoutEffect(() => locate(), [ids, jumpBack?.id, stuck, hasMore]);

  // Brings a row's top to JUMP_TOP_PX and stops following the bottom, like scrolling up. A row not
  // rendered yet comes into view by the virtualiser's estimates first; then the row itself is placed,
  // frame by frame while the rows around it measure in, until it holds still, the user takes over or
  // the list follows the bottom again.
  const jumpToStart = (id: string) => {
    const el = scrollRef.current;
    const index = idsRef.current.lastIndexOf(id);
    if (!el || index < 0) return;
    setStick(false);
    cancelAnimationFrame(jumpRaf.current);
    placing.current = id;
    const rowEl = () => el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    // Scrolls the row to its spot (as near as the list scrolls); false once it is there.
    const place = (row: HTMLElement) => {
      const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_TOP_PX));
      if (Math.abs(to - el.scrollTop) <= 1) return false;
      el.scrollTop = to;
      return true;
    };
    const row = rowEl();
    if (row) place(row);
    else virtualizer.scrollToIndex(index, { align: "start" });
    const since = performance.now();
    let still = 0;
    const step = () => {
      const now = rowEl();
      still = now && !place(now) ? still + 1 : 0;
      jumpRaf.current = !stick.current && still < 3 && performance.now() - since < JUMP_SETTLE_MS ? requestAnimationFrame(step) : 0;
    };
    jumpRaf.current = requestAnimationFrame(step);
  };

  // Any input on the list ends a jump in progress (the user scrolls on from there), and a step that
  // waits for earlier rows. Not the step keys, which step on from the row being placed, nor the
  // modifiers pressed before them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = (ev?: Event) => {
      if (ev instanceof globalThis.KeyboardEvent && (stepKeyOf(ev) || ev.key === "Alt" || ev.key === "Shift")) return;
      cancelAnimationFrame(jumpRaf.current);
      jumpRaf.current = 0;
      if (pendingStep.current) dropStep();
    };
    for (const ev of JUMP_ENDERS) el.addEventListener(ev, stop, { passive: true });
    return () => {
      for (const ev of JUMP_ENDERS) el.removeEventListener(ev, stop);
      stop();
    };
  }, []);

  // Pages earlier rows in above without moving the view: the first row on screen keeps its place
  // (the `[ids]` layout effect puts it back). One page at a time.
  const pageOlder = () => {
    const el = scrollRef.current;
    const load = loadOlderRef.current;
    const top = idsRef.current[0];
    if (!el || !load || loadingRef.current || top == null) return;
    const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop);
    const id = first ? idsRef.current[first.index] : undefined;
    if (first && id) anchor.current = { id, delta: el.scrollTop - first.start };
    loadingRef.current = true;
    setLoadingOlder(true);
    void load()
      .then(
        () =>
          // A page that brought nothing (rows that came are in by the next frame) ends a step waiting for it.
          window.setTimeout(() => {
            if (pendingStep.current?.first === top && idsRef.current[0] === top) dropStep();
          }, PAGE_SETTLE_MS),
        () => dropStep(),
      )
      .finally(() => {
        loadingRef.current = false;
        setLoadingOlder(false);
      });
  };

  const dropStep = () => {
    pendingStep.current = null;
    setPaging(null);
  };

  // One step through `kind`'s messages from where the list is read, or from the row a jump still
  // places (so key repeat walks one message a press). A step on to a message the list can't scroll to
  // the top (in its last screenful) goes to the bottom, as Jump to latest does. A step back past the
  // loaded rows pages earlier ones in until it finds its message there or the host has none left.
  const stepTo = (dir: StepDir, kind: MessageKind) => {
    const s = stepsRef.current;
    const ids = idsRef.current;
    const placed = jumpRaf.current !== 0 && placing.current != null ? ids.lastIndexOf(placing.current) : -1;
    const at = placed >= 0 ? { above: placed - 1, below: placed + 1 } : readAt();
    if (!s || !at) return;
    const to = stepMessage(ids, s.kindOf, at, dir, kind);
    if (to) {
      dropStep();
      if (dir === "newer" && !spotShift(ids.lastIndexOf(to.id))?.reaches) {
        setStick(true);
        toBottom(true);
      } else jumpToStart(to.id);
    } else if (dir === "older" && hasMoreRef.current && loadOlderRef.current) {
      pendingStep.current = { kind, first: ids[0] };
      setPaging(kind);
      pageOlder();
    }
  };

  // A step back waiting for earlier rows goes on once some came in: to its message among them, or
  // another page while the host has more. A page that brought none ends it once the host has no more.
  const resumeStep = () => {
    const p = pendingStep.current;
    const s = stepsRef.current;
    if (!p || !s) return;
    const ids = idsRef.current;
    const at = p.first == null ? -1 : ids.indexOf(p.first);
    if (at === 0) {
      if (!hasMoreRef.current) dropStep();
      return;
    }
    const to = at > 0 ? nearestMessage(ids, s.kindOf, at, "older", p.kind) : null;
    if (to) {
      dropStep();
      jumpToStart(to.id);
    } else if (at > 0 && hasMoreRef.current) {
      p.first = ids[0];
      pageOlder();
    } else dropStep();
  };
  // After the prepend above has put the view back.
  useLayoutEffect(() => resumeStep(), [ids, hasMore]);

  // Alt+↑ / Alt+↓ (Shift: the prompts) wherever `steps.keys` says a key press is this list's.
  const stepKeys = steps?.keys != null;
  useEffect(() => {
    if (!stepKeys) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const step = stepKeyOf(e);
      const keys = stepsRef.current?.keys;
      const list = scrollRef.current;
      const t = e.target instanceof Element ? e.target : null;
      if (!step || e.defaultPrevented || e.isComposing || !keys || !list || holdsText(t) || !keys(t, list)) return;
      e.preventDefault();
      stepTo(step.dir, step.kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, [stepKeys]);

  // Unsticking is driven by user input (wheel, touch, keys, scrollbar) only: the virtualizer moves
  // scrollTop on its own while rows measure, which would read as the user scrolling up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom <= STICK_PX && !stick.current) setStick(true);
    if (el.scrollTop < LOAD_OLDER_PX && hasMore) pageOlder();
    locate();
  };

  // Wheel/touch/keys up while stuck: release immediately so the user wins against streaming.
  const release = (e: WheelEvent) => {
    if (e.deltaY < 0 && stick.current) setStick(false);
  };
  const releaseKey = (e: KeyboardEvent) => {
    if (stick.current && (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home")) setStick(false);
  };

  const visible = virtualizer.getVirtualItems();
  // The pill once it has been aimed at the current target.
  const back = aim != null && aim.id === jumpBack?.id ? aim.dir : null;
  // A stepper for each kind the list has messages of, while scrolled up.
  const stepKinds = steps && !stuck ? STEP_KINDS.filter((k) => navHas(nav, k, NAV_HAS)) : [];
  // What shows over the bottom edge: a change slides the rest over (else no layout work while
  // scrolling re-renders the list).
  const arrangement = `${!stuck && back != null}/${stepKinds.join()}`;

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
            <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
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
      {/*
        Over the bottom edge, centred: the message steppers, the pill to the last message and Jump to
        latest, one coming or going sliding the others over. Below 34rem (phones, narrow panes) the
        steppers take a row of their own above the pills.
      */}
      <div className="pointer-events-none absolute inset-x-3 bottom-4 z-raised flex flex-wrap items-end justify-center gap-2 @container">
        <AnimatePresence mode="popLayout">
          {steps && stepKinds.length > 0 && (
            <motion.div
              key="steps"
              layout="position"
              layoutDependency={arrangement}
              initial={{ opacity: 0, y: 16, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: spring.bouncy }}
              exit={{ opacity: 0, y: 10, scale: 0.92 }}
              className={cn("flex basis-full justify-center @min-[34rem]:basis-auto", dense ? "gap-4" : "gap-2")}
            >
              {stepKinds.map((kind) => (
                <MessageStepper
                  key={kind}
                  names={steps.names[kind]}
                  shortcuts={steps.keys && !dense ? STEP_KEYS[kind] : undefined}
                  older={navHas(nav, kind, NAV_OLDER)}
                  newer={navHas(nav, kind, NAV_NEWER)}
                  paging={paging === kind}
                  dense={dense}
                  onStep={(dir) => stepTo(dir, kind)}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        {/* The pills share a row of their own: the one to the last message shrinks rather than wraps. */}
        <div className="flex max-w-full min-w-0 justify-center gap-2">
          <AnimatePresence mode="popLayout">
            {!stuck && back && jumpBack && (
              <motion.button
                key="back"
                type="button"
                layout="position"
                layoutDependency={arrangement}
                initial={{ opacity: 0, y: 16, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: spring.bouncy }}
                exit={{ opacity: 0, y: 10, scale: 0.92 }}
                onClick={() => jumpToStart(jumpBack.id)}
                className="focus-ring pointer-events-auto flex min-w-0 items-center gap-2 rounded-full glass-blur px-3.5 py-2 text-xs font-bold text-ink-2 transition-colors hover:text-ink"
              >
                {back === "up" ? <ArrowUp className="size-3.5 shrink-0" /> : <ArrowDown className="size-3.5 shrink-0" />}
                <span className={cn("min-w-0 truncate", jumpBack.short && "hidden @min-[26rem]:block")}>{jumpBack.label}</span>
                {jumpBack.short && <span className="min-w-0 truncate @min-[26rem]:hidden">{jumpBack.short}</span>}
              </motion.button>
            )}
            {!stuck && ids.length > 0 && (
              <motion.button
                key="latest"
                type="button"
                layout="position"
                layoutDependency={arrangement}
                initial={{ opacity: 0, y: 16, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: spring.bouncy }}
                exit={{ opacity: 0, y: 10, scale: 0.92 }}
                onClick={() => {
                  setStick(true);
                  toBottom(true);
                }}
                className="focus-ring pointer-events-auto flex shrink-0 items-center gap-2 rounded-full glass-blur px-3.5 py-2 text-xs font-bold text-ink shadow-glow-accent"
              >
                {jumpLabel(unseen)}
                <ArrowDown className="size-3.5" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

interface MessageStepperProps {
  names: StepNames;
  /** The step keys, for the buttons' tooltips (desktop). */
  shortcuts?: Record<StepDir, string>;
  older: boolean;
  newer: boolean;
  /** Its step back waits for earlier rows to page in. */
  paging: boolean;
  /** Phone: larger buttons (they grow to 48 px targets on touch screens). */
  dense: boolean;
  onStep: (dir: StepDir) => void;
}

/** One kind's stepper over the list's bottom edge, a glass pill like the others: ⌃ label ⌄. */
function MessageStepper({ names, shortcuts, older, newer, paging, dense, onStep }: MessageStepperProps) {
  const size = dense ? "md" : "sm";
  const back = paging ? "Loading earlier messages…" : names.older;
  return (
    <div role="group" aria-label={names.group} className="pointer-events-auto flex items-center rounded-full glass-blur p-0.5 text-xs font-bold text-ink-2">
      <Tooltip content={back} shortcut={shortcuts?.older}>
        <IconButton label={back} size={size} className="rounded-full" disabled={!older} aria-busy={paging || undefined} onClick={() => onStep("older")}>
          {paging ? <Spinner size={14} label={back} /> : <ChevronUp />}
        </IconButton>
      </Tooltip>
      <span className="px-1 select-none">{names.label}</span>
      <Tooltip content={names.newer} shortcut={shortcuts?.newer}>
        <IconButton label={names.newer} size={size} className="rounded-full" disabled={!newer} onClick={() => onStep("newer")}>
          <ChevronDown />
        </IconButton>
      </Tooltip>
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
