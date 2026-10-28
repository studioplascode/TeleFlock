import { cn } from "@/design";

/** A run of text: plain, or the inside of a `backticked` span. */
export interface TickPart {
  text: string;
  code: boolean;
}

/**
 * Splits text at backtick pairs. tf-hostd quotes commands that way, and omp's setting descriptions name
 * flags and keys like that (`--model @role`). A backtick without a partner, or an empty pair, stays literal.
 */
export function splitTicks(text: string): TickPart[] {
  const parts: TickPart[] = [];
  let plain = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("`", at);
    const close = open < 0 ? -1 : text.indexOf("`", open + 1);
    if (close < 0) break;
    if (close === open + 1) {
      plain += text.slice(at, close + 1);
      at = close + 1;
      continue;
    }
    plain += text.slice(at, open);
    if (plain) parts.push({ text: plain, code: false });
    plain = "";
    parts.push({ text: text.slice(open + 1, close), code: true });
    at = close + 1;
  }
  plain += text.slice(at);
  if (plain) parts.push({ text: plain, code: false });
  return parts;
}

/** Text with its `backticked` spans set as inline code: commands, flags and setting keys read as typed. */
export function Ticks({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {splitTicks(text).map((part, i) =>
        part.code ? (
          <code key={i} className={cn("rounded-xs bg-white/6 px-1 font-mono text-2xs break-words text-ink-2", className)}>
            {part.text}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
