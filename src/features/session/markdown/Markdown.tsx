import { Check, Copy } from "lucide-react";
import { memo, type ReactNode, useContext, useState } from "react";
import { Caret, cn } from "@/design";
import { PreviewButton } from "@/features/preview";
import { SessionCtx } from "../context";
import { highlight, languageFor, TOKEN_CLASS } from "../lib/highlight";
import { type Block, type Inline, localhostPort, parseBlocks, parseInline } from "./parse";

export interface MarkdownProps {
  text: string;
  /** Shows the glowing caret at the end of the last block. */
  streaming?: boolean;
  className?: string;
}

/**
 * Markdown for assistant text, plan reviews and tool markdown views. Blocks are memoised by
 * their source, so while streaming only the last (growing) block re-renders.
 */
export function Markdown({ text, streaming = false, className }: MarkdownProps) {
  const blocks = parseBlocks(text);
  return (
    <div className={cn("tf-md min-w-0 text-[13.5px] leading-[1.62] text-ink-2", className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} src={b.src} tail={streaming && i === blocks.length - 1 ? <Caret /> : null} />
      ))}
      {streaming && blocks.length === 0 && <Caret />}
    </div>
  );
}

const BlockView = memo(
  function BlockView({ block, tail }: { block: Block; src: string; tail: ReactNode }) {
    return renderBlock(block, tail);
  },
  (a, b) => a.src === b.src && a.tail === b.tail && a.block.t === b.block.t && (a.block.t !== "code" || b.block.t !== "code" || a.block.open === b.block.open),
);

function renderBlock(b: Block, tail: ReactNode): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p className="my-2 first:mt-0 last:mb-0 [overflow-wrap:anywhere]">
          <Inlines nodes={parseInline(b.text)} />
          {tail}
        </p>
      );
    case "h": {
      const size = b.level <= 1 ? "text-xl" : b.level === 2 ? "text-lg" : b.level === 3 ? "text-md" : "text-base";
      return (
        <div role="heading" aria-level={b.level} className={cn("mt-4 mb-1.5 font-display font-bold tracking-tight text-ink first:mt-0", size)}>
          <Inlines nodes={parseInline(b.text)} />
          {tail}
        </div>
      );
    }
    case "hr":
      return <hr className="my-4 border-0 border-t border-line-2" />;
    case "code":
      return <CodeBlock code={b.code} lang={b.lang} open={b.open} tail={tail} />;
    case "quote":
      return (
        <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-mute">
          {b.blocks.map((c, i) => (
            <BlockView key={i} block={c} src={c.src} tail={i === b.blocks.length - 1 ? tail : null} />
          ))}
        </blockquote>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag start={b.ordered ? b.start : undefined} className={cn("my-2 space-y-1 pl-5", b.ordered ? "list-decimal marker:text-mute" : "list-disc marker:text-accent/80")}>
          {b.items.map((item, i) => (
            <li key={i} className={cn("pl-0.5", item.task && "-ml-5 flex list-none items-start gap-2")}>
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
                {item.blocks.map((c, j) => (
                  <BlockView key={j} block={c} src={c.src} tail={i === b.items.length - 1 && j === item.blocks.length - 1 ? tail : null} />
                ))}
              </div>
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="my-3 overflow-x-auto rounded-md well">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} style={{ textAlign: b.align[i] }} className="border-b border-line-2 px-3 py-1.5 text-left font-bold text-ink">
                    <Inlines nodes={parseInline(h)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="odd:bg-white/[0.015]">
                  {b.head.map((_, j) => (
                    <td key={j} style={{ textAlign: b.align[j] }} className="border-b border-line px-3 py-1.5 align-top">
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
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return n.v;
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
            const port = session ? localhostPort(n.href) : undefined;
            return (
              <span key={i}>
                <a href={n.href} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent-hi underline decoration-accent/40 underline-offset-2 hover:decoration-accent-hi">
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
      <div className="flex h-7 items-center gap-2 border-b border-line px-3 text-2xs text-mute-2">
        <span className="font-mono font-semibold tracking-wide">{lang || "text"}</span>
        {open && <span className="tf-shimmer-text tf-loop font-semibold">writing…</span>}
        <button
          type="button"
          onClick={copy}
          className="pressable focus-ring ml-auto flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-mute opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink-2" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
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
