import { Check, Copy } from "lucide-react";
import { memo, type ReactNode, useContext, useState } from "react";
import { linkProps } from "@/core";
import { Caret, cn } from "@/design";
import { PreviewButton } from "@/features/preview";
import { SessionCtx } from "../context";
import { highlight, languageFor, TOKEN_CLASS } from "../lib/highlight";
import { lruMemo } from "../lib/lru";
import { type Block, type Inline, localhostPort, parseBlocks, parseInline } from "./parse";

const parseBlocksCached = lruMemo(300, parseBlocks);

export interface MarkdownProps {
  text: string;
  /** Shows the glowing caret at the end of the last block. */
  streaming?: boolean;
  className?: string;
}

/** How long a streamed chunk keeps its own fade-in span before it settles into plain text. */
const FRESH_MS = 700;
const MAX_FRESH = 10;
const NO_FRESH: FreshChunk[] = [];

interface FreshChunk {
  key: number;
  len: number;
  at: number;
}

/**
 * Tracks the trailing chunks appended while streaming, so each one can fade in on its own
 * (`.tf-token`). Derived during render from the previous text, like `StreamText`.
 */
function useFreshChunks(text: string, streaming: boolean): FreshChunk[] {
  const [s, setS] = useState<{ source: string; chunks: FreshChunk[]; next: number }>({ source: text, chunks: NO_FRESH, next: 0 });
  if (text !== s.source) {
    if (streaming && text.startsWith(s.source)) {
      const now = performance.now();
      const chunks = [...s.chunks.filter((c) => now - c.at < FRESH_MS), { key: s.next, len: text.length - s.source.length, at: now }].slice(-MAX_FRESH);
      setS({ source: text, chunks, next: s.next + 1 });
    } else {
      setS({ source: text, chunks: NO_FRESH, next: s.next + 1 });
    }
  }
  return streaming ? s.chunks : NO_FRESH;
}

/**
 * Wraps the trailing characters of an inline tree in `fresh` nodes, newest chunk last. Counts
 * visible characters, so markdown syntax at the tail shifts the boundary by a glyph at most.
 */
function markFresh(nodes: Inline[], chunks: FreshChunk[]): Inline[] {
  if (chunks.length === 0) return nodes;
  const queue = chunks.map((c) => ({ key: c.key, len: c.len })).reverse();
  const walk = (list: Inline[]): Inline[] => {
    const out: Inline[] = [];
    let i = list.length - 1;
    for (; i >= 0 && queue.length > 0; i--) {
      const n = list[i]!;
      if (n.t === "text") {
        let rest = n.v;
        const parts: Inline[] = [];
        while (rest.length > 0 && queue.length > 0) {
          const c = queue[0]!;
          const take = Math.min(c.len, rest.length);
          parts.unshift({ t: "fresh", key: c.key, v: rest.slice(rest.length - take) });
          rest = rest.slice(0, rest.length - take);
          c.len -= take;
          if (c.len === 0) queue.shift();
        }
        if (rest) parts.unshift({ t: "text", v: rest });
        out.unshift(...parts);
      } else if (n.t === "strong" || n.t === "em" || n.t === "del" || n.t === "link") {
        out.unshift({ ...n, c: walk(n.c) });
      } else {
        // Inline code and breaks are atomic: consume their width without splitting them.
        let w = n.t === "code" ? n.v.length : 1;
        while (w > 0 && queue.length > 0) {
          const c = queue[0]!;
          const take = Math.min(c.len, w);
          c.len -= take;
          w -= take;
          if (c.len === 0) queue.shift();
        }
        out.unshift(n);
      }
    }
    return [...list.slice(0, i + 1), ...out];
  };
  return walk(nodes);
}

/**
 * Markdown for assistant text, plan reviews and tool markdown views. Blocks are memoised by
 * their source, so while streaming only the last (growing) block re-renders; its newest chunks
 * fade in from omp purple behind the caret.
 */
export function Markdown({ text, streaming = false, className }: MarkdownProps) {
  const blocks = parseBlocksCached(text);
  const fresh = useFreshChunks(text, streaming);
  return (
    <div className={cn("tf-md min-w-0 text-[13.5px] leading-[1.62] text-ink-2 max-md:leading-[1.55]", className)}>
      {blocks.map((b, i) => {
        const last = streaming && i === blocks.length - 1;
        return <BlockView key={i} block={b} src={b.src} tail={last ? <Caret /> : null} fresh={last ? fresh : NO_FRESH} />;
      })}
      {streaming && blocks.length === 0 && <Caret />}
    </div>
  );
}

const BlockView = memo(
  function BlockView({ block, tail, fresh }: { block: Block; src: string; tail: ReactNode; fresh: FreshChunk[] }) {
    return renderBlock(block, tail, fresh);
  },
  (a, b) =>
    a.src === b.src && a.tail === b.tail && a.fresh === b.fresh && a.block.t === b.block.t && (a.block.t !== "code" || b.block.t !== "code" || a.block.open === b.block.open),
);

function renderBlock(b: Block, tail: ReactNode, fresh: FreshChunk[] = NO_FRESH): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p className="my-2 first:mt-0 last:mb-0 [overflow-wrap:anywhere] max-md:my-1.5">
          <Inlines nodes={markFresh(parseInline(b.text), fresh)} />
          {tail}
        </p>
      );
    case "h": {
      const size = b.level <= 1 ? "text-xl max-md:text-lg" : b.level === 2 ? "text-lg max-md:text-md" : b.level === 3 ? "text-md" : "text-base";
      return (
        <div role="heading" aria-level={b.level} className={cn("mt-4 mb-1.5 font-display font-bold tracking-tight text-ink first:mt-0 max-md:mt-3 max-md:mb-1", size)}>
          <Inlines nodes={markFresh(parseInline(b.text), fresh)} />
          {tail}
        </div>
      );
    }
    case "hr":
      return <hr className="my-4 border-0 border-t border-line-2 max-md:my-3" />;
    case "code":
      return <CodeBlock code={b.code} lang={b.lang} open={b.open} tail={tail} />;
    case "quote":
      return (
        <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-mute max-md:my-1.5 max-md:pl-2.5">
          {b.blocks.map((c, i) => (
            <BlockView key={i} block={c} src={c.src} tail={i === b.blocks.length - 1 ? tail : null} fresh={i === b.blocks.length - 1 ? fresh : NO_FRESH} />
          ))}
        </blockquote>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag start={b.ordered ? b.start : undefined} className={cn("my-2 space-y-1 pl-5 max-md:my-1.5 max-md:space-y-0.5 max-md:pl-4", b.ordered ? "list-decimal marker:text-mute" : "list-disc marker:text-accent/80")}>
          {b.items.map((item, i) => (
            <li key={i} className={cn("pl-0.5", item.task && "-ml-5 flex list-none items-start gap-2 max-md:-ml-4")}>
              {item.task && (
                <span
                  aria-label={item.checked ? "done" : "open"}
                  className={cn(
                    "mt-[3px] grid size-4 shrink-0 place-items-center rounded-[5px] text-[10px]",
                    item.checked ? "bg-done/20 text-done" : "shadow-[inset_0_0_0_1.5px_var(--color-mute-2)]",
                  )}
                >
                  {item.checked && "✓"}
                </span>
              )}
              <div className="min-w-0 [&>p]:my-0">
                {item.blocks.map((c, j) => {
                  const last = i === b.items.length - 1 && j === item.blocks.length - 1;
                  return <BlockView key={j} block={c} src={c.src} tail={last ? tail : null} fresh={last ? fresh : NO_FRESH} />;
                })}
              </div>
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="my-3 overflow-x-auto rounded-md well max-md:my-2">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} style={{ textAlign: b.align[i] }} className="border-b border-line-2 px-3 py-1.5 text-left font-bold text-ink max-md:px-2 max-md:py-1">
                    <Inlines nodes={parseInline(h)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="odd:bg-white/[0.015]">
                  {b.head.map((_, j) => (
                    <td key={j} style={{ textAlign: b.align[j] }} className="border-b border-line px-3 py-1.5 align-top max-md:px-2 max-md:py-1">
                      <Inlines nodes={parseInline(r[j] ?? "")} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {tail}
        </div>
      );
  }
}

export function Inlines({ nodes }: { nodes: Inline[] }) {
  const session = useContext(SessionCtx);
  // A chunk split around inline code yields two fresh pieces in one parent: suffix repeats.
  const seen = new Set<number>();
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "fresh": {
            const key = seen.has(n.key) ? `f${n.key}.${i}` : `f${n.key}`;
            seen.add(n.key);
            return (
              <span key={key} className="tf-token">
                {n.v}
              </span>
            );
          }
          case "code":
            return (
              <code key={i} className="rounded-[6px] bg-white/[0.07] px-[5px] py-[1px] font-mono text-[0.88em] text-[#e9dcff] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
                {n.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-extrabold text-ink">
                <Inlines nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "del":
            return (
              <del key={i} className="text-mute">
                <Inlines nodes={n.c} />
              </del>
            );
          case "link": {
            const link = linkProps(n.href);
            // Non-http(s) targets (javascript:, file:, custom handlers, relative paths) stay inert text.
            if (!link) return <Inlines key={i} nodes={n.c} />;
            const port = session ? localhostPort(link.href) : undefined;
            return (
              <span key={i}>
                <a {...link} className="font-semibold text-accent-hi underline decoration-accent/40 underline-offset-2 hover:decoration-accent-hi">
                  <Inlines nodes={n.c} />
                </a>
                {port != null && session && <PreviewButton hostId={session.hostId} port={port} className="mx-1 align-middle" />}
              </span>
            );
          }
          case "br":
            return <br key={i} />;
        }
      })}
    </>
  );
}

export function CodeBlock({ code, lang, open = false, tail, className, maxHeight }: { code: string; lang?: string; open?: boolean; tail?: ReactNode; className?: string; maxHeight?: number }) {
  const key = languageFor(lang);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className={cn("group/code relative my-2.5 overflow-hidden rounded-md bg-bg-deep/80 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]", className)}>
      <div className="flex h-7 items-center gap-2 border-b border-line px-3 text-2xs text-mute-2 max-md:h-6 max-md:px-2.5">
        <span className="font-mono font-semibold tracking-wide">{lang || "text"}</span>
        {open && <span className="tf-shimmer-text tf-loop font-semibold">writing…</span>}
        <button
          type="button"
          onClick={copy}
          className="pressable focus-ring ml-auto flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-mute opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink-2 max-md:px-2.5 max-md:py-2 max-md:text-[11.5px] max-md:leading-[1.55]" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        <code>
          <Highlighted code={code} lang={key} />
          {tail}
        </code>
      </pre>
    </div>
  );
}

export function Highlighted({ code, lang }: { code: string; lang?: string }) {
  const tokens = highlight(code, lang);
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === "plain" ? (
          t.text
        ) : (
          <span key={i} className={TOKEN_CLASS[t.kind]}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}
