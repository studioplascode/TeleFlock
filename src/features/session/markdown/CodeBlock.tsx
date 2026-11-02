import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/design";
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

/** `note`: a line under the header (why a diagram or formula is shown as source). */
export function CodeBlock({
  code,
  lang,
  open = false,
  tail,
  className,
  maxHeight,
  note,
}: {
  code: string;
  lang?: string;
  open?: boolean;
  tail?: ReactNode;
  className?: string;
  maxHeight?: number;
  note?: ReactNode;
}) {
  const key = languageFor(lang);
  const { copied, copy } = useCopy(code);
  return (
    <div className={cn("group/code relative my-2.5 overflow-hidden rounded-md bg-bg-deep/80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]", className)}>
      <div data-find-skip className="flex h-7 items-center gap-2 border-b border-line px-3 text-2xs text-mute-2 max-md:h-6 max-md:px-2.5">
        <span className="font-mono font-semibold tracking-wide">{lang || "text"}</span>
        {open && <span className="tf-shimmer-text tf-loop font-semibold">writing…</span>}
        <button type="button" onClick={copy} className={cn(HEADER_BUTTON, "ml-auto")} aria-label="Copy code">
          {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {note && (
        <div data-find-skip className="border-b border-line bg-warn/[0.06] px-3 py-1 text-2xs text-warn max-md:px-2.5">
          {note}
        </div>
      )}
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
