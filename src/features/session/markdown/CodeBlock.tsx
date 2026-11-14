import { Check, ChevronDown, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/design";
import { useOpenOnFind } from "../find/reveal";
import { highlight, languageFor, TOKEN_CLASS } from "../lib/highlight";

/** `copy()` puts `text` on the clipboard; `copied` shows for a moment afterwards. */
export function useCopy(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return { copied, copy };
}

/** The header button of a code block or figure: icon + label, shown on hover (always on touch). */
export const HEADER_BUTTON =
  "pressable focus-ring flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-mute opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100";

const PRE = "overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink-2 max-md:px-2.5 max-md:py-2 max-md:text-[11.5px] max-md:leading-[1.55]";

/**
 * `note`: a line under the header (why a diagram or formula is shown as source). `title`: what the
 * code is, after its language (an eval cell's title, where a command ran). `fold` (a tool call's
 * code): long lines wrap rather than scroll, so a command shows whole, and longer code shows its
 * first `fold` lines and "Show N more lines"; Find's current match in row `findRow` unfolds it.
 */
export function CodeBlock({
  code,
  lang,
  open = false,
  tail,
  className,
  maxHeight,
  note,
  title,
  fold,
  findRow,
}: {
  code: string;
  lang?: string;
  open?: boolean;
  tail?: ReactNode;
  className?: string;
  maxHeight?: number;
  note?: ReactNode;
  title?: ReactNode;
  fold?: number;
  findRow?: string;
}) {
  const key = languageFor(lang);
  const { copied, copy } = useCopy(code);
  return (
    <div className={cn("group/code relative my-2.5 overflow-hidden rounded-md bg-bg-deep/80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]", className)}>
      <div className="flex h-7 items-center gap-2 border-b border-line px-3 text-2xs text-mute-2 max-md:h-6 max-md:px-2.5">
        <span data-find-skip className="shrink-0 font-mono font-semibold tracking-wide">
          {lang || "text"}
        </span>
        {title != null && <span className="min-w-0 truncate font-semibold text-mute">{title}</span>}
        {open && (
          <span data-find-skip className="tf-shimmer-text tf-loop font-semibold">
            writing…
          </span>
        )}
        <button type="button" data-find-skip onClick={copy} className={cn(HEADER_BUTTON, "ml-auto")} aria-label="Copy code">
          {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {note && (
        <div data-find-skip className="border-b border-line bg-warn/[0.06] px-3 py-1 text-2xs text-warn max-md:px-2.5">
          {note}
        </div>
      )}
      {fold ? (
        <FoldedCode code={code} lang={key} fold={fold} findRow={findRow} />
      ) : (
        <pre className={PRE} style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
          <code>
            <Highlighted code={code} lang={key} />
            {tail}
          </code>
        </pre>
      )}
    </div>
  );
}

/** Lines past `fold` that a block shows rather than fold (no "Show 2 more lines"). */
const FOLD_SLACK = 4;

function FoldedCode({ code, lang, fold, findRow }: { code: string; lang?: string; fold: number; findRow?: string }) {
  const [all, setAll] = useState(false);
  useOpenOnFind(findRow ?? "", () => setAll(true), code);
  let lines = 1;
  let cut = code.length;
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) {
    if (lines === fold) cut = i;
    lines++;
  }
  const folds = lines > fold + FOLD_SLACK;
  return (
    <>
      <pre className={cn(PRE, "whitespace-pre-wrap [overflow-wrap:anywhere]")}>
        <code>
          <Highlighted code={folds && !all ? code.slice(0, cut) : code} lang={lang} />
        </code>
      </pre>
      {folds && (
        <button
          type="button"
          data-find-skip
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className={cn(
            "focus-ring relative flex w-full items-center justify-center gap-1.5 py-1.5 font-sans text-2xs font-bold text-accent-hi hover:text-ink",
            !all && "-mt-7 bg-gradient-to-b from-transparent via-bg-deep/85 to-bg-deep/95 pt-6",
          )}
        >
          <ChevronDown className={cn("size-3 transition-transform", all && "rotate-180")} />
          {all ? "Show less" : `Show ${lines - fold} more lines`}
        </button>
      )}
    </>
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
