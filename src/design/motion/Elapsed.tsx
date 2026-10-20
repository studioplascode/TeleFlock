import { useNow } from "../lib/clock";
import { cn } from "../lib/cn";
import { formatElapsed } from "../lib/format";

export interface ElapsedProps {
  /** Start time (ms epoch). */
  since: number;
  /** Freeze at this time (ms epoch), e.g. when the run finished. */
  until?: number;
  className?: string;
}

/** Ticking run timer ("12s", "4:07", "1:02:09"). All timers share one 1s clock. */
export function Elapsed({ since, until, className }: ElapsedProps) {
  const now = useNow(1000);
  const end = until ?? now;
  return (
    <time className={cn("tabular", className)} dateTime={`PT${Math.max(0, Math.floor((end - since) / 1000))}S`}>
      {formatElapsed(end - since)}
    </time>
  );
}
