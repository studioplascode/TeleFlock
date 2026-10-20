import { useLayoutEffect, useRef } from "react";
import { cn } from "@/design";
import { ansiCss, parseAnsi } from "../lib/ansi";

/** ANSI output in a deep well. `follow` pins the scroll to the bottom while output grows. */
export function AnsiText({ text, follow = false, maxHeight = 280, className }: { text: string; follow?: boolean; maxHeight?: number; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const segments = parseAnsi(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [text, follow]);
  return (
    <pre
      ref={ref}
      className={cn("overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-[#c4c4d0] [overflow-wrap:anywhere]", className)}
      style={{ maxHeight }}
    >
      {segments.map((s, i) => {
        const style = ansiCss(s.style);
        return style ? (
          <span key={i} style={style}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </pre>
  );
}
