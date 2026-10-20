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

/** Rolling odometer digits for cost / tokens. Columns are keyed from the right so units stay put. */
export function NumberTicker({ value, format = formatInt, className }: NumberTickerProps) {
  const text = format(value);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const chars = [...text];
  return (
    <span className={cn("tf-ticker", className)}>
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
