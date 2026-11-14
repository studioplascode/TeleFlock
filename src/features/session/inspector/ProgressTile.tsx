import { roundPct, TIME_LEFT_TICK_MS, timeLeft, timeLeftText } from "@/core/progress";
import { cn, Tooltip, useNow } from "@/design";
import { madeAgo, turnProgressHint, useTurnProgress } from "@/features/board/ProgressChip";
import { Meter } from "./LimitsTile";

/**
 * Session panel, first while the agent runs: its own estimate of the turn (`OmpInfo.progress`) as a bar,
 * "64% done", its current step in its words, time left and how old the estimate is. The session header
 * leaves it to this tile while the inspector rail is on screen.
 */
export function ProgressTile({ agentKey, className }: { agentKey: string; className?: string }) {
  const progress = useTurnProgress(agentKey);
  const now = useNow(progress ? TIME_LEFT_TICK_MS : null);
  if (!progress) return null;
  const pct = roundPct(progress.pct);
  const left = timeLeft(progress, now);
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          {turnProgressHint(progress, now).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
      className="max-w-80"
    >
      <div tabIndex={0} className={cn("focus-ring rounded-lg", className)}>
        <Meter
          term="turn"
          reading={`${pct}% done`}
          fill={pct}
          status="running"
          label={`About ${pct}% done (the agent's own estimate)`}
          detail={
            <>
              {progress.stage && <span className="line-clamp-2 text-ink-2">{progress.stage}</span>}
              <span className="block">
                {left ? timeLeftText(left) : "time left: too early to tell"} · estimated {madeAgo(progress.at, now)}
              </span>
            </>
          }
        />
      </div>
    </Tooltip>
  );
}

/**
 * The folded Session card's summary: "64% done · ~7m left" while the agent runs, then the card's `rest`
 * (`overviewSummary`), so a folded card still says how far along the turn is.
 */
export function ProgressSummary({ agentKey, rest }: { agentKey: string; rest: string }) {
  const progress = useTurnProgress(agentKey);
  const now = useNow(progress ? TIME_LEFT_TICK_MS : null);
  const left = progress && timeLeft(progress, now);
  const turn = progress && `${roundPct(progress.pct)}% done${left ? ` · ${timeLeftText(left)}` : ""}`;
  return [turn, rest].filter(Boolean).join(" · ");
}
