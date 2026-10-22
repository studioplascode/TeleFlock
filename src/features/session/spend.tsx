import type { ReactNode } from "react";
import type { CostInfo } from "@/core/gen";
import { cn, formatCompact, formatUsd, NumberTicker } from "@/design";
import { Term } from "@/features/shell/Term";

/**
 * The three spenders of an omp session, as omp's status line bills them (`$main (+subagents) +
 * advisor`); tf-hostd splits `CostInfo.usd` and `Liveness.tps` the same way.
 */
export const SPENDERS: readonly { key: "main" | "subagents" | "advisor"; label: string; term: ReactNode; dot: string }[] = [
  { key: "main", label: "Main agent", term: "Main agent", dot: "bg-accent" },
  { key: "subagents", label: "Subagents", term: <Term id="subagent">Subagents</Term>, dot: "bg-omp-blue" },
  { key: "advisor", label: "Advisor", term: <Term id="advisor" />, dot: "bg-omp-pink" },
];

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
      <span className="font-medium text-mute tabular">
        {formatCompact(cost.input)} in / {formatCompact(cost.output)} out
      </span>
    </span>
  );
}

/** Inspector Spend tile: the session total, what each spender cost (share bars) and the token totals. */
export function SpendTile({ cost }: { cost?: CostInfo }) {
  const split = cost?.split;
  const total = cost?.usd ?? 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline" aria-label="Spend">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-bold text-mute">Spend</span>
        <span className="font-display text-xl font-bold tracking-[-0.03em] text-ink tabular">{cost ? <NumberTicker value={cost.usd} format={formatUsd} /> : "—"}</span>
      </div>
      {split &&
        SPENDERS.map((s) => {
          const usd = split[s.key];
          return (
            <div key={s.key} data-spender={s.key} className="grid grid-cols-[auto_6.5rem_1fr_auto] items-center gap-x-2 text-[11.5px]">
              <span className={cn("size-2 rounded-full", s.dot)} />
              <span className="truncate font-semibold text-ink-2">{s.term}</span>
              <span className="relative h-1 overflow-hidden rounded-full bg-white/6">
                <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out", s.dot)} style={{ width: `${total > 0 ? (100 * usd) / total : 0}%` }} />
              </span>
              <span className="text-right font-bold text-ink tabular">{formatUsd(usd)}</span>
            </div>
          );
        })}
      {cost && (
        <div className="text-[10.5px] font-semibold text-mute-2 tabular">
          {formatCompact(cost.input)} in / {formatCompact(cost.output)} out
        </div>
      )}
    </div>
  );
}
