import type { ContextUsage, Subagent } from "@/core/gen";
import { cn, formatCompact, ProgressRing, Tooltip } from "@/design";

/** Context share at which a subagent's context bar turns warning-coloured (matches the board's context meter). */
const CONTEXT_HOT_PCT = 80;

/** omp prints context as one decimal (`2.4%/272K`); keep that below 10 % so tiny values are not all "0%". */
function formatPct(pct: number): string {
  return pct < 10 ? `${(Math.round(pct * 10) / 10).toString()}%` : `${Math.round(pct)}%`;
}

/** Tooltip text for omp's completion estimate (`Subagent.completionPct`). */
export function completionHint(pct: number): string {
  return `About ${Math.round(pct)}% done: the subagent's own estimate of how far along its task is. omp asks each running subagent every few minutes (first after 2 min); this is the percentage omp's terminal shows next to it.`;
}

/** Tooltip text for a subagent's context-window usage (`Subagent.context`). */
export function contextHint(ctx: ContextUsage): string {
  return ctx.window > 0
    ? `Context ${formatPct(ctx.pct)} full: ${formatCompact(ctx.tokens)} of ${formatCompact(ctx.window)} tokens in this subagent's own context window (omp's terminal shows ${formatPct(ctx.pct)}/${formatCompact(ctx.window)}).`
    : `${formatCompact(ctx.tokens)} tokens in this subagent's context (omp does not know its window size).`;
}

/** The subagent's completion estimate: a small ring and "40% done". */
export function CompletionMeter({ pct, size = "sm", className }: { pct: number; size?: "sm" | "md"; className?: string }) {
  const ring = size === "md" ? 18 : 13;
  return (
    <Tooltip content={<span className="block max-w-64">{completionHint(pct)}</span>}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap", className)}>
        <ProgressRing done={pct} total={100} size={ring} stroke={size === "md" ? 2.5 : 2} label={null} ariaLabel={`About ${Math.round(pct)}% done (subagent's own estimate)`} />
        <span className={cn("font-bold tabular text-accent-hi", size === "md" ? "text-xs" : "text-2xs")}>{Math.round(pct)}%</span>
        <span className={cn("text-mute-2", size === "md" ? "text-xs" : "text-2xs")}>done</span>
      </span>
    </Tooltip>
  );
}

/** The subagent's context-window usage: a short bar and "2.4% ctx". */
export function ContextMeter({ ctx, size = "sm", className }: { ctx: ContextUsage; size?: "sm" | "md"; className?: string }) {
  const known = ctx.window > 0;
  const hot = known && ctx.pct >= CONTEXT_HOT_PCT;
  return (
    <Tooltip content={<span className="block max-w-64">{contextHint(ctx)}</span>}>
      <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap", className)} aria-label={contextHint(ctx)}>
        {known && (
          <span className={cn("overflow-hidden rounded-full bg-white/8", size === "md" ? "h-1 w-8" : "h-[3px] w-5")} aria-hidden>
            <span className={cn("block h-full rounded-full transition-[width] duration-700", hot ? "bg-warn" : "bg-run")} style={{ width: `${Math.max(2, Math.min(100, ctx.pct))}%` }} />
          </span>
        )}
        <span className={cn("font-mono tabular", hot ? "text-warn" : "text-mute", size === "md" ? "text-xs" : "text-2xs")}>
          {known ? formatPct(ctx.pct) : formatCompact(ctx.tokens)}
        </span>
        <span className={cn("text-mute-2", size === "md" ? "text-xs" : "text-2xs")}>ctx</span>
      </span>
    </Tooltip>
  );
}

/**
 * The two percentages omp's terminal shows on a subagent row: its completion estimate (`40%`, only while
 * it runs and once omp's probe has answered) and its context usage (`2.4%/272K`). Renders nothing when
 * neither is known.
 */
export function SubagentMeters({ sub, size = "sm", className }: { sub: Subagent; size?: "sm" | "md"; className?: string }) {
  const completion = sub.status === "running" ? sub.completionPct : undefined;
  if (completion == null && !sub.context) return null;
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1", className)}>
      {completion != null && <CompletionMeter pct={completion} size={size} />}
      {sub.context && <ContextMeter ctx={sub.context} size={size} />}
    </span>
  );
}
