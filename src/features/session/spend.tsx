import type { CostInfo, TpsSplit } from "@/core/gen";
import { cn, formatUsd } from "@/design";

/**
 * The three spenders of an omp session, as omp's status line bills them (`$main (+subagents) +
 * advisor`); tf-hostd splits `CostInfo.usd` and `Liveness.tps` the same way.
 */
const SPENDERS = [
  { key: "main", label: "Main agent", dot: "bg-accent" },
  { key: "subagents", label: "Subagents", dot: "bg-omp-blue" },
  { key: "advisor", label: "Advisor", dot: "bg-omp-pink" },
] as const;

/** Header cost tooltip: the session total and what it is made of. */
export function CostTooltip({ cost }: { cost: CostInfo }) {
  return (
    <span className="flex flex-col gap-1 py-0.5">
      <span>Session cost · {formatUsd(cost.usd)}</span>
      {cost.split &&
        SPENDERS.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 font-medium text-mute">
            <span className={cn("size-1.5 rounded-full", s.dot)} />
            <span className="flex-1">{s.label}</span>
            <span className="tabular text-ink-2">{formatUsd(cost.split?.[s.key] ?? 0)}</span>
          </span>
        ))}
    </span>
  );
}

/** Inspector: per-spender cost (share bar) and live output rate. */
export function SpendBreakdown({ cost, tps }: { cost?: CostInfo; tps?: TpsSplit }) {
  const split = cost?.split;
  if (!split && !tps) return null;
  const total = cost?.usd ?? 0;
  return (
    <div className="col-span-2 flex flex-col gap-1.5 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline" aria-label="Spend by source">
      <div className="flex items-center justify-between text-[10.5px] font-bold text-mute">
        <span>By source</span>
        <span className="text-mute-2">cost · tok/s</span>
      </div>
      {SPENDERS.map((s) => {
        const usd = split?.[s.key] ?? 0;
        const rate = tps?.[s.key] ?? 0;
        return (
          <div key={s.key} data-spender={s.key} className="grid grid-cols-[auto_1fr_auto_3.25rem] items-center gap-x-2 text-[11.5px]">
            <span className={cn("size-2 rounded-full", s.dot)} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-semibold text-ink-2">{s.label}</span>
              <span className="relative h-1 overflow-hidden rounded-full bg-white/6">
                <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out", s.dot)} style={{ width: `${total > 0 ? (100 * usd) / total : 0}%` }} />
              </span>
            </span>
            <span className="font-bold text-ink tabular">{split ? formatUsd(usd) : "—"}</span>
            <span className={cn("text-right font-semibold tabular", rate > 0 ? "text-accent-hi" : "text-mute-2")}>{rate > 0 ? Math.round(rate) : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}
