import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { type Needle, offsetsIn } from "./match";
import type { FindActive } from "./store";
import "./find.css";

/** What a transcript list highlights (TranscriptLog's `find`). */
export interface TranscriptFind {
  needle: Needle | null;
  active: FindActive | null;
  /** Bumped to bring the current match into view. */
  nonce: number;
  /** Rows the matcher counts: only these are painted, so the highlights and the count agree. */
  rows: ReadonlySet<string>;
}

/** CSS Custom Highlight API (Chromium, WebView2, Android WebView, WebKit ≥ 17.2). */
const supported = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
/** Elements whose text runs on inside one line of text; any other element boundary separates texts. */
const INLINE: Record<string, true> = { A: true, ABBR: true, B: true, CODE: true, DEL: true, EM: true, I: true, INS: true, KBD: true, MARK: true, Q: true, S: true, SMALL: true, SPAN: true, STRONG: true, SUB: true, SUP: true, TIME: true, U: true };
/** A jump to a row that never renders gives up after this long. */
const JUMP_MAX_MS = 4000;

interface Seg {
  node: Text;
  /** Offset of the node's first character in the row text. */
  start: number;
}

/**
 * A row's visible text as one string, in document order: texts in different blocks are kept
 * apart by a line break (a query never holds one, so no match spans two blocks); subtrees marked
 * `data-find-skip` (card chrome: authors, times, status) and SVGs are left out.
 */
export function collectText(root: Element): { text: string; segs: Seg[] } {
  const segs: Seg[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (el.hasAttribute("data-find-skip") || el.namespaceURI === "http://www.w3.org/2000/svg" || el.tagName === "STYLE" || el.tagName === "SCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const v = node.data;
    if (!v) continue;
    let block: Element | null = node.parentElement;
    while (block && block !== root && INLINE[block.tagName]) block = block.parentElement;
    if (lastBlock && block !== lastBlock) text += "\n";
    lastBlock = block;
    segs.push({ node, start: text.length });
    text += v;
  }
  return { text, segs };
}

/** The node and offset of row-text offset `at` (`end`: a boundary belongs to the node before it). */
function locate(segs: Seg[], at: number, end: boolean): [Text, number] | null {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = segs[mid] as Seg;
    if (s.start < at || (!end && s.start === at)) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  if (!s) return null;
  const off = at - s.start;
  return off >= 0 && off <= s.node.data.length ? [s.node, off] : null;
}

/** Ranges of every occurrence of `needle` in a row element's visible text, in document order. */
export function rangesIn(root: Element, needle: Needle): Range[] {
  const { text, segs } = collectText(root);
  const out: Range[] = [];
  for (const at of offsetsIn(text, needle)) {
    const a = locate(segs, at, false);
    const b = locate(segs, at + needle.text.length, true);
    if (!a || !b) continue;
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    out.push(r);
  }
  return out;
}

// Every transcript on screen paints into the same two highlights.
const painted = new Map<symbol, { all: Range[]; current: Range | null }>();

function publish(): void {
  if (!supported) return;
  const all = new Highlight();
  const current = new Highlight();
  current.priority = 1;
  for (const p of painted.values()) {
    for (const r of p.all) all.add(r);
    if (p.current) current.add(p.current);
  }
  CSS.highlights.set("tf-find", all);
  CSS.highlights.set("tf-find-current", current);
}

/**
 * One-line texts cut off with an ellipsis (`truncate`: a long bash command in its card's header)
 * that a jump scrolled sideways to show the current match. The browser paints the ellipsis where
 * the line was cut whatever the scroll position, so these clip instead while the match is in
 * them; the next jump elsewhere, or closing Find, puts them back.
 */
const unclipped = new Set<HTMLElement>();

/** Puts the ellipsis back on the texts `unclipped` holds, except the one holding `keep`. */
function reclip(keep?: Range): void {
  for (const el of unclipped) {
    if (keep && el.contains(keep.startContainer)) continue;
    el.style.textOverflow = "";
    el.scrollLeft = 0;
    unclipped.delete(el);
  }
}

/**
 * Scrolls the scrollers between the range and `scroller` (output wells, code blocks, truncated
 * one-line texts), then `scroller`, to centre the range.
 */
function reveal(range: Range, scroller: HTMLElement, unstick: () => void): void {
  reclip(range);
  for (let el = range.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
    const s = getComputedStyle(el);
    const overflowsX = el.scrollWidth > el.clientWidth + 1;
    const scrollsY = el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(s.overflowY);
    let scrollsX = overflowsX && /auto|scroll/.test(s.overflowX);
    if (overflowsX && s.overflowX === "hidden" && (s.textOverflow === "ellipsis" || unclipped.has(el))) {
      el.style.textOverflow = "clip";
      unclipped.add(el);
      scrollsX = true;
    }
    if (!scrollsX && !scrollsY) continue;
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (scrollsY && (r.top < box.top || r.bottom > box.bottom)) el.scrollTop += r.top - box.top - (box.height - r.height) / 2;
    if (scrollsX && (r.left < box.left || r.right > box.right)) el.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
  }
  const r = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  // Keep clear of the faded top edge and floating chips.
  if (r.top < box.top + 56 || r.bottom > box.bottom - 56) {
    unstick();
    scroller.scrollTop += r.top - box.top - (box.height - r.height) / 2;
  }
}

export interface PainterOptions {
  find: TranscriptFind | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  ids: readonly string[];
  /** Scroll so row `index` renders (virtualized list). */
  scrollToIndex: (index: number) => void;
  /** Stop following the bottom (a jump up must not be undone by streaming). */
  unstick: () => void;
}

/** Repaints at most this often while rows stream or scroll by. */
const PAINT_MS = 90;
/** How long a jump waits for a revealed card to render its text before it settles for the row. */
const REVEAL_WAIT_MS = 350;
/**
 * How long a jump keeps its match in view after revealing it: rows measuring in, a page of older
 * rows landing (the list keeps its own scroll anchor then) or the list finishing its own scroll
 * can still move it. Any user input on the list ends the jump at once.
 */
const SETTLE_MS = 1500;
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Paints Find's matches into the rendered rows of a transcript list and brings the current one
 * into view when `find.nonce` changes: scrolls the virtual list to its row, waits for the row
 * (and a card opening for it) to render, then centres the exact occurrence, inner scrollers
 * included. Only rows the matcher counts are painted, so highlights and the count agree.
 */
export function useFindPainter(o: PainterOptions): void {
  const live = useRef(o);
  useLayoutEffect(() => {
    live.current = o;
  });
  const me = useRef(Symbol("transcript"));
  const pending = useRef<{ id: string; since: number; asks: number; shown?: number; revealed?: number } | null>(null);
  const handled = useRef(o.find?.nonce ?? 0);
  const schedule = useRef<() => void>(() => {});

  const needle = o.find?.needle ?? null;
  const key = needle ? `${needle.caseSensitive ? 1 : 0}${needle.text}` : "";

  useEffect(() => {
    const id = me.current;
    if (!key) {
      painted.delete(id);
      publish();
      schedule.current = () => {};
      return;
    }
    let frame = 0;
    let timer = 0;
    let last = 0;
    const paint = () => {
      frame = 0;
      last = performance.now();
      const { find, contentRef, scrollRef, ids } = live.current;
      const content = contentRef.current;
      const n = find?.needle;
      if (!content || !find || !n) return;
      const active = find.active;
      const all: Range[] = [];
      let current: Range | null = null;
      let activeRow: HTMLElement | null = null;
      let activeCount = 0;
      for (const el of content.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = el.dataset.rowId;
        if (!rowId || !find.rows.has(rowId)) continue;
        const ranges = rangesIn(el, n);
        if (active && rowId === active.id) {
          activeRow = el;
          activeCount = ranges.length;
          current = ranges[Math.min(active.n, ranges.length - 1)] ?? null;
        }
        for (const r of ranges) if (r !== current) all.push(r);
      }
      painted.set(id, { all, current });
      publish();
      // Bring the current match into view once its row (and what opens for it) has rendered.
      const p = pending.current;
      const scroller = scrollRef.current;
      if (!p || !scroller || !active || p.id !== active.id) return;
      if (!activeRow) {
        // Not loaded yet: the find bar pages it in, and the new rows repaint.
        const index = ids.indexOf(p.id);
        if (index < 0) return;
        const age = performance.now() - p.since;
        if (age > JUMP_MAX_MS) {
          pending.current = null;
          return;
        }
        // Rows above measure in as the list moves: ask again until the row is there.
        if (p.asks === 0 || age > p.asks * 600) {
          p.asks += 1;
          live.current.unstick();
          live.current.scrollToIndex(index);
        }
        timer = window.setTimeout(run, 150);
        return;
      }
      p.shown ??= performance.now();
      if (current) {
        reveal(current, scroller, live.current.unstick);
        p.revealed ??= performance.now();
        if (performance.now() - p.revealed < SETTLE_MS) timer = window.setTimeout(run, 200);
        else pending.current = null;
      } else if (activeCount === 0 && performance.now() - p.shown < REVEAL_WAIT_MS) {
        // A card opening for the match (tool output, thinking) renders its text next.
        timer = window.setTimeout(run, 120);
      } else {
        // The text renders differently from what was matched (markdown syntax, a link's URL): the row.
        reclip();
        live.current.unstick();
        activeRow.scrollIntoView({ block: activeRow.offsetHeight > scroller.clientHeight ? "start" : "center" });
        pending.current = null;
      }
    };
    const run = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (frame) return;
      const wait = PAINT_MS - (performance.now() - last);
      if (wait > 0) timer = window.setTimeout(() => (frame = requestAnimationFrame(paint)), wait);
      else frame = requestAnimationFrame(paint);
    };
    schedule.current = run;
    const content = o.contentRef.current;
    const scroller = o.scrollRef.current;
    const mo = new MutationObserver(run);
    if (content) mo.observe(content, { subtree: true, childList: true, characterData: true });
    scroller?.addEventListener("scroll", run, { passive: true });
    const takeOver = () => {
      pending.current = null;
    };
    for (const ev of USER_INPUT) scroller?.addEventListener(ev, takeOver, { passive: true });
    run();
    return () => {
      mo.disconnect();
      scroller?.removeEventListener("scroll", run);
      for (const ev of USER_INPUT) scroller?.removeEventListener(ev, takeOver);
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      painted.delete(id);
      publish();
      reclip();
      schedule.current = () => {};
    };
    // The observers read everything else through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A new jump request, or a new current match / rows: repaint (and jump when asked).
  const nonce = o.find?.nonce ?? 0;
  const activeId = o.find?.active?.id;
  const activeN = o.find?.active?.n;
  const rows = o.find?.rows;
  useEffect(() => {
    if (nonce !== handled.current) {
      handled.current = nonce;
      if (activeId) pending.current = { id: activeId, since: performance.now(), asks: 0 };
    }
    schedule.current();
  }, [nonce, activeId, activeN, rows, o.ids]);
}
