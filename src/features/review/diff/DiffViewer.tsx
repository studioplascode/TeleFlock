import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronRight, FileWarning, FoldVertical, WrapText } from "lucide-react";
import { type CSSProperties, type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/design";
import { FILE_STATUS, FileStatusIcon } from "../fileStatus";
import { familyFor, TOKEN_CLASS, tokenize } from "./highlight";
import { type DiffFile, type DiffLine, type Hunk, type Range, wordDiff } from "./parse";

export type DiffLayout = "unified" | "split";

type Marks = Range[] | undefined;

type Row =
  | { t: "file"; file: DiffFile }
  /** `hidden`: unchanged lines between the previous hunk (or the file start) and this one. */
  | { t: "hunk"; file: DiffFile; hunk: Hunk; hidden: number }
  | { t: "line"; file: DiffFile; line: DiffLine; marks: Marks }
  | { t: "pair"; file: DiffFile; left?: DiffLine; right?: DiffLine; marksL: Marks; marksR: Marks }
  | { t: "empty"; file: DiffFile; msg: string }
  | { t: "gap"; file: DiffFile };

const H = { file: 44, hunk: 32, line: 20, empty: 52, gap: 12 } as const;

/** Group a hunk's lines into del/add runs so the i-th deletion pairs with the i-th addition. */
function* runs(lines: DiffLine[]): Generator<{ ctx?: DiffLine; note?: DiffLine; dels?: DiffLine[]; adds?: DiffLine[] }> {
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) break;
    if (l.kind === "ctx") {
      yield { ctx: l };
      i++;
    } else if (l.kind === "note") {
      yield { note: l };
      i++;
    } else {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (lines[i]?.kind === "del") dels.push(lines[i++] as DiffLine);
      while (lines[i]?.kind === "add") adds.push(lines[i++] as DiffLine);
      yield { dels, adds };
    }
  }
}

function buildRows(files: DiffFile[], layout: DiffLayout, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ t: "file", file });
    if (!collapsed.has(file.path)) {
      if (file.binary) rows.push({ t: "empty", file, msg: "Binary file — not shown" });
      else if (file.hunks.length === 0)
        rows.push({ t: "empty", file, msg: file.status === "renamed" ? "Renamed without changes" : file.status === "untracked" && file.added === 0 ? "Empty file" : "No textual changes in this diff" });
      let nextOld = 1;
      for (const hunk of file.hunks) {
        rows.push({ t: "hunk", file, hunk, hidden: hunk.oldLines === 0 && hunk.oldStart === 0 ? 0 : Math.max(0, hunk.oldStart - nextOld) });
        nextOld = hunk.oldStart + hunk.oldLines;
        for (const r of runs(hunk.lines)) {
          if (r.ctx) {
            rows.push(layout === "unified" ? { t: "line", file, line: r.ctx, marks: undefined } : { t: "pair", file, left: r.ctx, right: r.ctx, marksL: undefined, marksR: undefined });
          } else if (r.note) {
            rows.push({ t: "line", file, line: r.note, marks: undefined });
          } else {
            const dels = r.dels ?? [];
            const adds = r.adds ?? [];
            // i-th deletion ↔ i-th addition; wordDiff declines pairs that are really rewrites.
            const marks = dels.map((d, k) => {
              const a = adds[k];
              return a ? wordDiff(d.text, a.text) : null;
            });
            if (layout === "unified") {
              dels.forEach((d, k) => rows.push({ t: "line", file, line: d, marks: marks[k]?.a }));
              adds.forEach((a, k) => rows.push({ t: "line", file, line: a, marks: marks[k]?.b }));
            } else {
              const n = Math.max(dels.length, adds.length);
              for (let k = 0; k < n; k++) rows.push({ t: "pair", file, left: dels[k], right: adds[k], marksL: marks[k]?.a, marksR: marks[k]?.b });
            }
          }
        }
      }
    }
    rows.push({ t: "gap", file });
  }
  return rows;
}

export interface DiffViewerProps {
  files: DiffFile[];
  layout: DiffLayout;
  wrap: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  /** Files the reviewer ticked off; the header shows a "Viewed" checkbox when `onToggleViewed` is set. */
  viewed?: ReadonlySet<string>;
  onToggleViewed?: (path: string) => void;
  /** Turn line wrapping on (offered by the long-line hint while lines overflow). */
  onWrap?: () => void;
  /** Scroll so this file's header is at the top (`nonce` re-triggers for the same path). */
  scrollTo?: { path: string; nonce: number };
  /** The file whose header is pinned at the top changed. */
  onTopFile?: (path: string) => void;
  /** Narrow screens: one line-number column instead of old + new. */
  compact?: boolean;
  /** A refresh is in flight: a thin sweep runs along the top edge. */
  busy?: boolean;
  className?: string;
}

/** Sets `data-hscroll` on the frame: `none` (fits), `more` (content continues to the right), `end`. */
function syncHScroll(el: HTMLElement, frame: HTMLElement | null) {
  if (!frame) return;
  const over = el.scrollWidth - el.clientWidth;
  const v = over <= 2 ? "none" : el.scrollLeft >= over - 2 ? "end" : "more";
  if (frame.dataset.hscroll !== v) frame.dataset.hscroll = v;
}

/**
 * Virtualized diff: only on-screen rows render (and get highlighted), fixed row heights without wrap
 * (zero measurement), measured rows with wrap. File headers stay pinned while their hunks scroll.
 */
export function DiffViewer({ files, layout, wrap, collapsed, onToggle, viewed, onToggleViewed, onWrap, scrollTo, onTopFile, compact = false, busy = false, className }: DiffViewerProps) {
  // TanStack Virtual mutates one virtualizer instance per scroll; compiler memoization would freeze it.
  "use no memo";
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(files, layout, collapsed), [files, layout, collapsed]);
  const fileRowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => r.t === "file" && m.set(r.file.path, i));
    return m;
  }, [rows]);
  const maxLen = useMemo(() => files.reduce((m, f) => Math.max(m, f.maxLen), 0), [files]);
  const [viewW, setViewW] = useState(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => H[rows[i]?.t === "pair" ? "line" : (rows[i]?.t ?? "line")],
    overscan: 24,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return i;
      if (r.t === "file" || r.t === "gap" || r.t === "empty") return `${r.t}:${r.file.path}`;
      if (r.t === "hunk") return `h:${r.file.path}:${r.hunk.header}:${r.hunk.oldStart}`;
      return `${r.file.path}:${i}`;
    },
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      syncHScroll(el, frameRef.current);
    });
    ro.observe(el);
    setViewW(el.clientWidth);
    const onScroll = () => syncHScroll(el, frameRef.current);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Content width changes with wrap/layout/files: re-evaluate the long-line hint.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) syncHScroll(el, frameRef.current);
  });

  // Only a new scroll request (fresh object) scrolls; collapsing files must not re-trigger it.
  useEffect(() => {
    if (!scrollTo) return;
    const idx = fileRowIndex.get(scrollTo.path);
    if (idx !== undefined) virtualizer.scrollToIndex(idx, { align: "start" });
  }, [scrollTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = virtualizer.getVirtualItems();
  // pinned header: the file owning the first visible row, unless that row is the file's own header
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const first = items.length ? virtualizer.getVirtualItemForOffset(scrollTop) : undefined;
  // The file owning the first visible row is "on screen"; its header is pinned unless that row is the header itself.
  const firstRow = first ? rows[first.index] : rows[0];
  const topFile = first && firstRow && !(firstRow.t === "file" && first.start >= scrollTop - 1) ? firstRow.file : undefined;
  const topPath = firstRow?.file.path;
  useEffect(() => {
    if (topPath) onTopFile?.(topPath);
  }, [topPath, onTopFile]);

  const gutter = layout === "split" ? SPLIT_GUTTER : compact ? COMPACT_GUTTER : UNIFIED_GUTTER;
  const contentMinWidth = wrap ? undefined : layout === "unified" ? `calc(${maxLen + 2}ch + ${gutter}px)` : `calc(${2 * (maxLen + 2)}ch + ${2 * gutter}px)`;
  return (
    <div
      ref={frameRef}
      data-hscroll="none"
      className={cn("group/diff relative min-h-0 overflow-hidden rounded-lg bg-bg-deep shadow-[inset_0_0_0_1px_var(--color-line)]", className)}
      style={{ "--vw": `${viewW}px` } as CSSProperties}
    >
      {topFile && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky" style={{ width: viewW || undefined }}>
          <div className="pointer-events-auto">
            <FileHeader file={topFile} collapsed={collapsed.has(topFile.path)} onToggle={onToggle} viewed={viewed?.has(topFile.path)} onToggleViewed={onToggleViewed} compact={compact} pinned />
          </div>
        </div>
      )}
      {busy && (
        <span className="tf-loop pointer-events-none absolute inset-x-0 top-0 z-sticky h-0.5 animate-gradient-pan bg-omp bg-[length:200%_100%]" role="progressbar" aria-label="Refreshing diff" />
      )}
      <div
        ref={scrollRef}
        className="size-full overflow-auto overscroll-contain font-mono text-[12px] leading-[20px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-inset [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb:hover]:bg-white/30"
        role="region"
        aria-label="Diff"
        tabIndex={0}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize(), minWidth: contentMinWidth }}>
          {items.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={wrap ? virtualizer.measureElement : undefined}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${vi.start}px)`, height: wrap ? undefined : vi.size }}
              >
                {row.t === "file" ? (
                  <FileHeader file={row.file} collapsed={collapsed.has(row.file.path)} onToggle={onToggle} viewed={viewed?.has(row.file.path)} onToggleViewed={onToggleViewed} compact={compact} />
                ) : (
                  <RowView row={row} layout={layout} wrap={wrap} compact={compact} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* Long lines continue to the right: fade the edge and offer wrapping. */}
      <div className="pointer-events-none absolute top-[44px] right-0 bottom-0 z-[1] flex w-20 items-end justify-end bg-[linear-gradient(90deg,transparent,var(--color-bg-deep)_85%)] p-2.5 opacity-0 transition-opacity duration-300 group-data-[hscroll=more]/diff:opacity-100">
        {onWrap && (
          <button
            type="button"
            onClick={onWrap}
            tabIndex={-1}
            className="pointer-events-none flex h-7 items-center gap-1.5 rounded-full bg-tile-4/95 px-2.5 font-sans text-2xs font-bold whitespace-nowrap text-ink shadow-[var(--shadow-d1),inset_0_0_0_1px_var(--color-line-2)] transition-colors group-data-[hscroll=more]/diff:pointer-events-auto hover:bg-tile-5 [&_svg]:size-3.5"
          >
            <WrapText />
            Wrap
          </button>
        )}
      </div>
    </div>
  );
}

const UNIFIED_GUTTER = 108;
const COMPACT_GUTTER = 58;
const SPLIT_GUTTER = 50;

const RowView = memo(function RowView({ row, layout, wrap, compact }: { row: Exclude<Row, { t: "file" }>; layout: DiffLayout; wrap: boolean; compact: boolean }) {
  switch (row.t) {
    case "gap":
      return <div className="h-[12px]" aria-hidden />;
    case "empty":
      return (
        <div className="sticky left-0 flex h-[52px] items-center gap-2 px-4 font-sans text-xs text-mute" style={{ width: "var(--vw)" }}>
          <FileWarning className="size-4 text-mute-2" />
          {row.msg}
        </div>
      );
    case "hunk":
      return <HunkHeader hunk={row.hunk} hidden={row.hidden} path={row.file.path} compact={compact} />;
    case "line":
      return <UnifiedLine line={row.line} marks={row.marks} path={row.file.path} wrap={wrap} compact={compact} />;
    case "pair":
      return layout === "split" ? <SplitLine row={row} wrap={wrap} /> : null;
  }
});

function HunkHeader({ hunk, hidden, path, compact }: { hunk: Hunk; hidden: number; path: string; compact: boolean }) {
  return (
    <div className="flex h-[32px] items-center bg-[linear-gradient(90deg,rgb(163_92_240/0.11),rgb(163_92_240/0.04)_60%,transparent)] shadow-[inset_0_1px_0_rgb(163_92_240/0.14),inset_0_-1px_0_rgb(163_92_240/0.1)]">
      <span className="sticky left-0 flex min-w-0 items-center gap-2.5 px-2.5" style={{ width: "var(--vw)" }}>
        <span className="shrink-0 rounded-[5px] bg-accent/14 px-1.5 text-[11px] leading-[18px] font-semibold text-accent-ink/90 tabular" title={hunk.header.replace(/ @@.*$/, " @@")}>
          {hunk.oldStart === 0 && hunk.oldLines === 0 ? (
            <span className="text-add/90">new · {hunk.newLines} lines</span>
          ) : hunk.newStart === 0 && hunk.newLines === 0 ? (
            <span className="text-del/90">deleted · {hunk.oldLines} lines</span>
          ) : (
            <>
              <span className="text-del/90">
                −{hunk.oldStart}
                {hunk.oldLines === 1 ? "" : `,${hunk.oldLines}`}
              </span>{" "}
              <span className="text-add/90">
                +{hunk.newStart}
                {hunk.newLines === 1 ? "" : `,${hunk.newLines}`}
              </span>
            </>
          )}
        </span>
        {hunk.section && (
          <span className="min-w-0 flex-1 truncate text-[11.5px] opacity-80">
            <Highlighted text={hunk.section.trim()} path={path} />
          </span>
        )}
        {hidden > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-sans text-2xs font-semibold text-mute-2" title={`${hidden} unchanged line${hidden === 1 ? "" : "s"} above, not shown`}>
            <FoldVertical className="size-3" aria-hidden />
            {compact ? hidden : `${hidden} unchanged`}
          </span>
        )}
      </span>
    </div>
  );
}

function FileHeader({
  file,
  collapsed,
  onToggle,
  viewed,
  onToggleViewed,
  compact,
  pinned,
}: {
  file: DiffFile;
  collapsed: boolean;
  onToggle: (p: string) => void;
  viewed?: boolean;
  onToggleViewed?: (p: string) => void;
  compact: boolean;
  pinned?: boolean;
}) {
  const meta = FILE_STATUS[file.status];
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  return (
    <div className={cn("sticky left-0 h-[44px] px-1.5 pt-1.5 font-sans", pinned && "bg-bg-deep/85 backdrop-blur-md")} style={{ width: "var(--vw)" }}>
      <div className={cn("flex h-9 items-center rounded-md bg-tile-2 shadow-[var(--shadow-d1)] transition-colors", viewed && "bg-tile-1")}>
        <button
          type="button"
          onClick={() => onToggle(file.path)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-2 pl-2.5 text-left focus-ring hover:bg-white/[0.04]"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-mute transition-transform duration-300 ease-spring", !collapsed && "rotate-90")} />
          <FileStatusIcon status={file.status} />
          <span className={cn("flex min-w-0 flex-1 items-baseline text-xs", viewed && "opacity-60")} title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}>
            {file.oldPath && file.oldPath !== file.path && !compact && (
              <span className="mr-1.5 min-w-0 shrink truncate text-mute line-through decoration-mute-2">
                {file.oldPath}
                <span className="ml-1.5 text-mute-2 no-underline">→</span>
              </span>
            )}
            <span className="min-w-0 shrink truncate text-mute">{dir}</span>
            <span className="shrink-0 font-bold text-ink">{name}</span>
          </span>
          {!compact && <span className={cn("hidden text-2xs font-bold lg:inline", meta.text)}>{meta.label}</span>}
          <DiffBar added={file.added} removed={file.removed} compact={compact} />
        </button>
        {onToggleViewed && (
          <button
            type="button"
            role="checkbox"
            aria-checked={!!viewed}
            aria-label={`Mark ${file.path} as viewed`}
            onClick={() => onToggleViewed(file.path)}
            className={cn(
              "mr-1 flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-2xs font-bold transition-colors focus-ring",
              viewed ? "bg-done/12 text-done hover:bg-done/18" : "text-mute hover:bg-white/6 hover:text-ink",
            )}
          >
            <span
              className={cn(
                "grid size-3.5 place-items-center rounded-[4px] transition-colors [&_svg]:size-2.5",
                viewed ? "bg-done text-bg-deep" : "shadow-[inset_0_0_0_1.5px_var(--color-mute-2)]",
              )}
              aria-hidden
            >
              {viewed && <Check strokeWidth={4} />}
            </span>
            {!compact && "Viewed"}
          </button>
        )}
      </div>
    </div>
  );
}

/** +N −M with a 5-cell proportional bar (GitHub-style). */
export function DiffBar({ added, removed, compact }: { added: number; removed: number; compact?: boolean }) {
  const total = added + removed;
  const cells = 5;
  const addCells = total ? Math.round((added / total) * cells) : 0;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-2xs font-bold tabular">
      {added > 0 && <span className="text-add">+{added}</span>}
      {removed > 0 && <span className="text-del">−{removed}</span>}
      {!compact && total > 0 && (
        <span className="flex gap-px" aria-hidden>
          {Array.from({ length: cells }, (_, i) => (
            <span key={i} className={cn("size-[7px] rounded-[2px]", i < addCells ? "bg-add" : "bg-del")} />
          ))}
        </span>
      )}
    </span>
  );
}

// Rows carry a faint tint; the opaque sticky gutter carries the strong signal (edge bar + sign),
// and word-level marks show exactly what changed inside paired lines.
const LINE_BG: Record<DiffLine["kind"], string> = { add: "bg-add/[0.05]", del: "bg-del/[0.06]", ctx: "", note: "" };
const GUTTER: Record<DiffLine["kind"], string> = {
  add: "bg-[color-mix(in_oklab,var(--color-add)_11%,var(--color-bg-deep))] text-add/80 shadow-[inset_3px_0_0_var(--color-add)]",
  del: "bg-[color-mix(in_oklab,var(--color-del)_12%,var(--color-bg-deep))] text-del/85 shadow-[inset_3px_0_0_var(--color-del)]",
  ctx: "bg-bg-deep text-mute-2/70",
  note: "bg-bg-deep text-mute-2/70",
};
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "", note: "" };
const MARK_CLASS: Record<"add" | "del", string> = {
  add: "rounded-[3px] bg-add/[0.22] shadow-[inset_0_-1.5px_0_rgb(163_230_53/0.6)]",
  del: "rounded-[3px] bg-del/[0.24] shadow-[inset_0_-1.5px_0_rgb(255_107_139/0.65)]",
};

/** Syntax-highlighted text, split further at word-diff `marks`. */
function Highlighted({ text, path, marks, kind }: { text: string; path: string; marks?: Marks; kind?: DiffLine["kind"] }) {
  const toks = tokenize(text, familyFor(path));
  const markCls = kind === "add" || kind === "del" ? MARK_CLASS[kind] : "";
  const out: ReactNode[] = [];
  let pos = 0;
  let r = 0;
  for (const [k, v] of toks) {
    const cls = TOKEN_CLASS[k];
    let off = 0;
    while (off < v.length) {
      const abs = pos + off;
      while (marks && r < marks.length && (marks[r]?.[1] ?? 0) <= abs) r++;
      const m = marks?.[r];
      let end = v.length;
      let marked = false;
      if (m && m[0] < pos + v.length) {
        if (m[0] > abs) end = m[0] - pos;
        else {
          end = Math.min(v.length, m[1] - pos);
          marked = true;
        }
      }
      const piece = v.slice(off, end);
      if (marked) out.push(<span key={out.length} className={cn(cls, markCls)}>{piece}</span>);
      else out.push(cls ? <span key={out.length} className={cls}>{piece}</span> : piece);
      off = end;
    }
    pos += v.length;
  }
  return out;
}

function Code({ text, path, marks, kind, wrap }: { text: string; path: string; marks: Marks; kind: DiffLine["kind"]; wrap: boolean }) {
  return (
    <span className={cn("min-w-0 flex-1 pr-4 pl-1.5 text-ink-2", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
      {text ? <Highlighted text={text} path={path} marks={marks} kind={kind} /> : "\u200b"}
    </span>
  );
}

function UnifiedLine({ line, marks, path, wrap, compact }: { line: DiffLine; marks: Marks; path: string; wrap: boolean; compact: boolean }) {
  if (line.kind === "note") {
    return (
      <div className="flex min-h-5 font-sans text-[11px] text-mute-2 italic" style={{ paddingLeft: compact ? COMPACT_GUTTER : UNIFIED_GUTTER }}>
        {line.text}
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-5", LINE_BG[line.kind])}>
      <span className={cn("sticky left-0 z-[1] flex shrink-0 select-none", GUTTER[line.kind])} aria-hidden={line.kind === "ctx" || undefined}>
        {compact ? (
          <span className="w-10 pr-1 text-right tabular">{(line.kind === "del" ? line.oldNo : line.newNo) ?? ""}</span>
        ) : (
          <>
            <span className="w-11 pr-1.5 text-right tabular">{line.oldNo ?? ""}</span>
            <span className="w-11 pr-1.5 text-right tabular">{line.newNo ?? ""}</span>
          </>
        )}
        <span className={cn("w-[18px] text-center font-bold", line.kind === "add" ? "text-add" : "text-del")}>{SIGN[line.kind]}</span>
      </span>
      <Code text={line.text} path={path} marks={marks} kind={line.kind} wrap={wrap} />
    </div>
  );
}

function SplitSide({ line, kind, path, marks, wrap }: { line?: DiffLine; kind: "del" | "add"; path: string; marks: Marks; wrap: boolean }) {
  const k = line ? (line.kind === "ctx" ? "ctx" : kind) : "ctx";
  if (!line) {
    // Nothing on this side: a quiet hatch keeps both columns aligned without reading as content.
    return <div className="min-h-5 w-1/2 min-w-0 bg-[repeating-linear-gradient(135deg,transparent_0_5px,rgb(255_255_255/0.035)_5px_6px)]" aria-hidden />;
  }
  return (
    <div className={cn("flex min-h-5 w-1/2 min-w-0", LINE_BG[k])}>
      <span className={cn("flex w-[50px] shrink-0 select-none", GUTTER[k])}>
        <span className="w-8 pr-1 text-right tabular">{(kind === "del" ? line.oldNo : line.newNo) ?? ""}</span>
        <span className={cn("w-[18px] text-center font-bold", k === "add" ? "text-add" : "text-del")}>{SIGN[k]}</span>
      </span>
      <Code text={line.text} path={path} marks={marks} kind={k} wrap={wrap} />
    </div>
  );
}

function SplitLine({ row, wrap }: { row: Extract<Row, { t: "pair" }>; wrap: boolean }) {
  return (
    <div className="flex min-h-5 divide-x divide-line-2">
      <SplitSide line={row.left} kind="del" path={row.file.path} marks={row.marksL} wrap={wrap} />
      <SplitSide line={row.right} kind="add" path={row.file.path} marks={row.marksR} wrap={wrap} />
    </div>
  );
}
