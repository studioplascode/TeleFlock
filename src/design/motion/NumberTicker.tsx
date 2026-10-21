import { type CSSProperties, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { formatInt } from "../lib/format";

export interface NumberTickerProps {
  value: number;
  /** Formatter, e.g. formatUsd or formatCompact. Digits roll; other characters swap. */
  format?: (n: number) => string;
  className?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Approximate advance of `chars` in em for the display face (tabular digits ≈ 0.51em, `.`/`,` ≈ 0.23em, `$`/units ≈ 0.64em). */
function emWidth(chars: string[]): number {
  let w = 0;
  for (const ch of chars) w += DIGITS.includes(ch) ? 0.52 : ch === "." || ch === "," ? 0.25 : 0.66;
  return w;
}

/**
 * Rolling odometer digits for cost / tokens. Columns are keyed from the right so units stay put.
 * Publishes `--fit-em` (the text's approximate width in em) for the `text-hero-fit` utility.
 */
export function NumberTicker({ value, format = formatInt, className }: NumberTickerProps) {
  const text = format(value);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const chars = [...text];
  return (
    <span className={cn("tf-ticker", className)} style={{ "--fit-em": emWidth(chars).toFixed(2) } as CSSProperties}>
      <span className="sr-only">{text}</span>
      {chars.map((ch, i) => {
        const key = chars.length - i;
        const d = DIGITS.indexOf(ch);
        if (d < 0) {
          return (
            <span key={`s${key}`} aria-hidden>
              {ch}
            </span>
          );
        }
        return (
          <span key={`d${key}`} className="tf-ticker__col" aria-hidden>
            <span className="tf-ticker__ghost">0</span>
            <span className="tf-ticker__strip" style={{ "--d": mounted ? d : 0 } as CSSProperties}>
              {DIGITS.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
