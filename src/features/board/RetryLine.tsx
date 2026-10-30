import { Hourglass } from "lucide-react";
import type { RetryWait } from "@/core/gen";
import { cn, Tooltip, useNow } from "@/design";
import { retryDetail, retryText } from "@/features/session/resume/words";

/**
 * What a running card or phone row says while omp waits to retry a provider error: "Rate limit ·
 * retrying in 4:54 (1/10)", with a live countdown, in the place of "Thinking…" and the quiet chip.
 * Nothing to answer and nothing stuck (`OmpInfo.retry`).
 */
export function RetryLine({ wait, className }: { wait: RetryWait; className?: string }) {
  const now = useNow(1000);
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          {retryDetail(wait, now).map((line, i) => (
            <span key={i} className={cn(i > 0 && "font-normal text-mute")}>
              {line}
            </span>
          ))}
        </span>
      }
    >
      <span data-testid="retry-line" className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full bg-warn/12 px-2 py-0.5 text-2xs font-bold whitespace-nowrap text-warn", className)}>
        <Hourglass className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate tabular">{retryText(wait, now)}</span>
      </span>
    </Tooltip>
  );
}
