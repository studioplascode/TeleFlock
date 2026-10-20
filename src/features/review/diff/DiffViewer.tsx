import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, FileWarning } from "lucide-react";
import { type CSSProperties, type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/design";
import { FILE_STATUS, FileStatusIcon } from "../fileStatus";
import { familyFor, TOKEN_CLASS, tokenize } from "./highlight";
import { changedSpan, type DiffFile, type DiffLine, type Hunk } from "./parse";

export type DiffLayout = "unified" | "split";

type Span = [number, number] | undefined;

type Row =
  | { t: "file"; file: DiffFile }
  | { t: "hunk"; file: DiffFile; hunk: Hunk }
  | { t: "line"; file: DiffFile; line: DiffLine; span: Span }
  | { t: "pair"; file: DiffFile; left?: DiffLine; right?: DiffLine; spanL: Span; spanR: Span }
  | { t: "empty"; file: DiffFile; msg: string }
  | { t: "gap"; file: DiffFile };

const H = { file: 44, hunk: 30, line: 20, empty: 52, gap: 14 } as const;

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
      for (const hunk of file.hunks) {
        rows.push({ t: "hunk", file, hunk });
        for (const r of runs(hunk.lines)) {
          if (r.ctx) {
            rows.push(layout === "unified" ? { t: "line", file, line: r.ctx, span: undefined } : { t: "pair", file, left: r.ctx, right: r.ctx, spanL: undefined, spanR: undefined });
          } else if (r.note) {
            rows.push({ t: "line", file, line: r.note, span: undefined });
          } else {
            const dels = r.dels ?? [];
            const adds = r.adds ?? [];
            const spans = dels.map((d, k) => {
              const a = adds[k];
              return a && dels.length === adds.length ? changedSpan(d.text, a.text) : null;
            });
            if (layout === "unified") {
              dels.forEach((d, k) => rows.push({ t: "line", file, line: d, span: spans[k]?.a }));
              adds.forEach((a, k) => rows.push({ t: "line", file, line: a, span: spans[k]?.b }));
            } else {
              const n = Math.max(dels.length, adds.length);
              for (let k = 0; k < n; k++) rows.push({ t: "pair", file, left: dels[k], right: adds[k], spanL: spans[k]?.a, spanR: spans[k]?.b });
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
  /** Scroll so this file's header is at the top (`nonce` re-triggers for the same path). */
  scrollTo?: { path: string; nonce: number };
  /** The file whose header is pinned at the top changed. */
  onTopFile?: (path: string) => void;
  className?: string;
}

/**
 * Virtualized diff: only on-screen rows render (and get highlighted), fixed row heights without wrap
 * (zero measurement), measured rows with wrap. File headers stay pinned while their hunks scroll.
 */
export function DiffViewer({ files, layout, wrap, collapsed, onToggle, scrollTo, onTopFile, className }: DiffViewerProps) {
  // TanStack Virtual mutates one virtualizer instance per scroll; compiler memoization would freeze it.
  "use no memo";
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
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

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
  let topFile: DiffFile | undefined;
  if (first) {
    const firstRow = rows[first.index];
    if (firstRow && !(firstRow.t === "file" && first.start >= scrollTop - 1)) topFile = firstRow.file;
  }
  const topPath = topFile?.path;
  useEffect(() => {
    if (topPath) onTopFile?.(topPath);
  }, [topPath, onTopFile]);

  const gutter = layout === "unified" ? 104 : 52;
  const contentMinWidth = wrap ? undefined : layout === "unified" ? `calc(${maxLen + 2}ch + ${gutter}px)` : `calc(${2 * (maxLen + 2)}ch + ${2 * gutter}px)`;

  return (
    <div className={cn("relative min-h-0 overflow-hidden rounded-lg bg-bg-deep shadow-[inset_0_0_0_1px_var(--color-line)]", className)} style={{ "--vw": `${viewW}px` } as CSSProperties}>
      {topFile && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky" style={{ width: viewW || undefined }}>
          <div className="pointer-events-auto">
            <FileHeader file={topFile} collapsed={collapsed.has(topFile.path)} onToggle={onToggle} pinned />
          </div>
        </div>
      )}
      <div ref={scrollRef} className="size-full overflow-auto overscroll-contain font-mono text-[12px] leading-[20px]" role="table" aria-label="Diff" tabIndex={0}>
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
                <RowView row={row} layout={layout} wrap={wrap} collapsed={row.t === "file" && collapsed.has(row.file.path)} onToggle={onToggle} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const RowView = memo(function RowView({ row, layout, wrap, collapsed, onToggle }: { row: Row; layout: DiffLayout; wrap: boolean; collapsed: boolean; onToggle: (p: string) => void }) {
  switch (row.t) {
    case "file":
      return <FileHeader file={row.file} collapsed={collapsed} onToggle={onToggle} />;
    case "gap":
      return <div className="h-[14px]" aria-hidden />;
    case "empty":
      return (
        <div className="sticky left-0 flex h-[52px] items-center gap-2 px-4 font-sans text-xs text-mute" style={{ width: "var(--vw)" }}>
          <FileWarning className="size-4 text-mute-2" />
          {row.msg}
        </div>
      );
    case "hunk":
      return (
        <div className="flex h-[30px] items-center bg-accent/[0.07] text-[11px] text-accent-ink/80 shadow-[inset_0_1px_0_rgb(163_92_240/0.12),inset_0_-1px_0_rgb(163_92_240/0.12)]">
          <span className="sticky left-0 truncate px-3" style={{ maxWidth: "var(--vw)" }}>
            {row.hunk.header.replace(/ @@.*$/, " @@")}
            {row.hunk.section && <span className="ml-2 text-mute">{row.hunk.section}</span>}
          </span>
        </div>
      );
    case "line":
      return <UnifiedLine line={row.line} span={row.span} path={row.file.path} wrap={wrap} />;
    case "pair":
      return layout === "split" ? <SplitLine row={row} wrap={wrap} /> : null;
  }
});

function FileHeader({ file, collapsed, onToggle, pinned }: { file: DiffFile; collapsed: boolean; onToggle: (p: string) => void; pinned?: boolean }) {
  const meta = FILE_STATUS[file.status];
  return (
    <div className={cn("sticky left-0 h-[44px] px-1.5 pt-1.5 font-sans", pinned && "bg-bg-deep/85 backdrop-blur-md")} style={{ width: "var(--vw)" }}>
      <button
        type="button"
        onClick={() => onToggle(file.path)}
        aria-expanded={!collapsed}
        className="flex h-9 w-full items-center gap-2 rounded-md bg-tile-2 px-2.5 text-left shadow-[var(--shadow-d1)] transition-colors focus-ring hover:bg-tile-3"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-mute transition-transform duration-300 ease-spring", !collapsed && "rotate-90")} />
        <FileStatusIcon status={file.status} />
        <span className="min-w-0 flex-1 truncate text-xs">
          {file.oldPath && file.oldPath !== file.path && (
            <>
              <span className="text-mute line-through decoration-mute-2">{file.oldPath}</span>
              <span className="mx-1.5 text-mute-2">→</span>
            </>
          )}
          <span className="font-bold text-ink">{file.path}</span>
        </span>
        <span className={cn("hidden text-2xs font-bold sm:inline", meta.text)}>{meta.label}</span>
        <DiffBar added={file.added} removed={file.removed} />
      </button>
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

const LINE_BG: Record<DiffLine["kind"], string> = { add: "bg-add/[0.09]", del: "bg-del/[0.09]", ctx: "", note: "" };
const GUTTER_BG: Record<DiffLine["kind"], string> = { add: "bg-add/[0.14] text-add/70", del: "bg-del/[0.14] text-del/70", ctx: "text-mute-2/70", note: "text-mute-2/70" };
const MARK: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " ", note: " " };

function Code({ text, path, span, kind, wrap }: { text: string; path: string; span: Span; kind: DiffLine["kind"]; wrap: boolean }) {
  const toks = tokenize(text, familyFor(path));
  const spanCls = kind === "add" ? "bg-add/25 rounded-[2px]" : "bg-del/25 rounded-[2px]";
  const out: ReactNode[] = [];
  let pos = 0;
  toks.forEach(([k, v], ti) => {
    const cls = TOKEN_CLASS[k];
    if (!span || pos + v.length <= span[0] || pos >= span[1]) {
      out.push(cls ? <span key={ti} className={cls}>{v}</span> : v);
    } else {
      const a = Math.max(0, span[0] - pos);
      const b = Math.min(v.length, span[1] - pos);
      if (a > 0) out.push(<span key={`${ti}a`} className={cls}>{v.slice(0, a)}</span>);
      out.push(
        <span key={`${ti}b`} className={cn(cls, spanCls)}>
          {v.slice(a, b)}
        </span>,
      );
      if (b < v.length) out.push(<span key={`${ti}c`} className={cls}>{v.slice(b)}</span>);
    }
    pos += v.length;
  });
  return <span className={cn("min-w-0 flex-1 pr-4 text-ink-2", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>{out.length ? out : "\u200b"}</span>;
}

function UnifiedLine({ line, span, path, wrap }: { line: DiffLine; span: Span; path: string; wrap: boolean }) {
  if (line.kind === "note") {
    return <div className="flex min-h-5 pl-[104px] text-[11px] text-mute-2 italic">{line.text}</div>;
  }
  return (
    <div className={cn("flex min-h-5", LINE_BG[line.kind])} role="row">
      <span className={cn("sticky left-0 flex shrink-0 select-none", GUTTER_BG[line.kind], line.kind === "ctx" && "bg-bg-deep")}>
        <span className="w-11 pr-1.5 text-right tabular">{line.oldNo ?? ""}</span>
        <span className="w-11 pr-1.5 text-right tabular">{line.newNo ?? ""}</span>
        <span className={cn("w-4 text-center", line.kind === "add" ? "text-add" : line.kind === "del" ? "text-del" : "")}>{MARK[line.kind]}</span>
      </span>
      <Code text={line.text} path={path} span={span} kind={line.kind} wrap={wrap} />
    </div>
  );
}

function SplitSide({ line, kind, path, span, wrap }: { line?: DiffLine; kind: "del" | "add"; path: string; span: Span; wrap: boolean }) {
  const k = line ? (line.kind === "ctx" ? "ctx" : kind) : "ctx";
  return (
    <div className={cn("flex min-h-5 w-1/2 min-w-0", line ? LINE_BG[k] : "bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(255_255_255/0.025)_6px_12px)]")}>
      <span className={cn("flex w-[52px] shrink-0 select-none", line ? GUTTER_BG[k] : "")}>
        <span className="w-9 pr-1.5 text-right tabular">{line ? (kind === "del" ? line.oldNo : line.newNo) : ""}</span>
        <span className={cn("w-4 text-center", k === "add" ? "text-add" : k === "del" ? "text-del" : "")}>{line ? MARK[k] : ""}</span>
      </span>
      {line ? <Code text={line.text} path={path} span={span} kind={k} wrap={wrap} /> : <span className="flex-1" />}
    </div>
  );
}

function SplitLine({ row, wrap }: { row: Extract<Row, { t: "pair" }>; wrap: boolean }) {
  return (
    <div className="flex min-h-5 divide-x divide-line" role="row">
      <SplitSide line={row.left} kind="del" path={row.file.path} span={row.spanL} wrap={wrap} />
      <SplitSide line={row.right} kind="add" path={row.file.path} span={row.spanR} wrap={wrap} />
    </div>
  );
}
