import { roundPct, TIME_LEFT_TICK_MS, timeLeft, timeLeftText } from "@/core/progress";
import { cn, Tooltip, useNow } from "@/design";
import { turnProgressHint, useTurnProgress } from "@/features/board/ProgressChip";

/**
 * The main agent's own estimate of its turn (`OmpInfo.progress`) under the session's name, desktop and
 * phone: a bar, "64% done", the agent's current step in its words (it gives way first), "~7m left". Only
 * while the agent runs; where the recap stands once it is idle.
 */
export function ProgressLine({ agentKey, className }: { agentKey: string; className?: string }) {
  const progress = useTurnProgress(agentKey);
  const now = useNow(progress ? TIME_LEFT_TICK_MS : null);
  if (!progress) return null;
  const pct = roundPct(progress.pct);
  const left = timeLeft(progress, now);
  return (
    <Tooltip
      content={
        <span className="flex max-w-80 flex-col gap-1">
          {turnProgressHint(progress, now).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <div tabIndex={0} data-status="running" className={cn("focus-ring flex min-w-0 items-center gap-1.5 rounded-xs text-[11px] font-semibold text-mute tabular", className)}>
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`About ${pct}% done (the agent's own estimate)`}
          className="relative mr-0.5 h-1 w-12 shrink-0 overflow-hidden rounded-full bg-ink/8"
        >
          <span className="absolute inset-y-0 left-0 rounded-full st-fill transition-[width] duration-700 ease-out" style={{ width: `${pct}%` }} />
        </span>
        <span className="shrink-0">
          <b className="font-bold text-ink-2">{pct}%</b> done
        </span>
        {progress.stage && <span className="min-w-0 truncate">· {progress.stage}</span>}
        {left && <span className="shrink-0">· {timeLeftText(left)}</span>}
      </div>
    </Tooltip>
  );
}
