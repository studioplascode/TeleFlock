import { Hourglass } from "lucide-react";
import { useAgent } from "@/core";
import type { RetryWait } from "@/core/gen";
import { cn, Tooltip, useNow } from "@/design";
import { retryOf } from "@/features/board/retry";
import { retryDetail, retryText } from "./words";

/**
 * omp's wait to retry a provider error (`OmpInfo.retry`) under its session header, desktop and
 * phone: "Rate limit · retrying in 4:54 (1/10)" with a live countdown. Same look as the auto-resume
 * strip, which takes over (and this goes away) once omp gave up. Nothing to answer, nothing to do.
 */
export function RetryStrip({ agentKey, mobile = false }: { agentKey: string; mobile?: boolean }) {
  const wait = retryOf(useAgent(agentKey));
  return wait ? <Strip wait={wait} mobile={mobile} /> : null;
}

function Strip({ wait, mobile }: { wait: RetryWait; mobile: boolean }) {
  const now = useNow(1000);
  return (
    <div
      role="status"
      data-testid="retry-strip"
      className={cn("flex min-w-0 items-center gap-x-2 rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]", mobile && "mx-2 mb-1.5 shrink-0")}
    >
      <Tooltip
        content={
          <span className="flex flex-col gap-0.5">
            {retryDetail(wait, now).map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </span>
        }
      >
        <span tabIndex={0} className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-xs font-bold">
          <Hourglass className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate tabular">{retryText(wait, now)}</span>
        </span>
      </Tooltip>
    </div>
  );
}
