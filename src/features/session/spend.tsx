import type { ReactNode } from "react";
import type { CostInfo, ModelShare, Spender } from "@/core/gen";
import { agentGlyphTheme, cn, formatCompact, formatUsd, NumberTicker, Popover, PopoverContent, PopoverTrigger, Tooltip, useFinePointer } from "@/design";
import { GLOSSARY } from "@/features/shell/glossary";
import { Term } from "@/features/shell/Term";
import { CollapsibleTile } from "./inspector/InspectorCard";

export interface SpenderInfo {
  key: Spender;
  label: string;
  /** The label with its glossary meaning (rows without a split by model). */
  term: ReactNode;
  dot: string;
  /** The glossary meaning, shown under the split by model (whose row it replaces as the hover). */
  note?: string;
}

/**
 * The three spenders of an omp session, as omp's status line bills them (`$main (+subagents) +
 * advisor`); tf-hostd splits `CostInfo.usd` and `Liveness.tps` the same way.
 */
export const SPENDERS: readonly SpenderInfo[] = [
  { key: "main", label: "Main agent", term: "Main agent", dot: "bg-accent" },
  { key: "subagents", label: "Subagents", term: <Term id="subagent">Subagents</Term>, dot: "bg-omp-blue", note: GLOSSARY.subagent.text },
  { key: "advisor", label: "Advisor", term: <Term id="advisor" />, dot: "bg-omp-pink", note: GLOSSARY.advisor.text },
];

/** `spender`'s part of `CostSplit.models` / `TpsSplit.models` (hosts ≥ 0.9.5), the largest first. */
export function sharesOf(models: readonly ModelShare[] | undefined, spender: Spender): ModelShare[] {
  return models?.filter((m) => m.spender === spender) ?? [];
}

/** USD of a model's part: amounts under a cent read as such, not as "$0.00". */
export function formatUsdPart(usd: number): string {
  return usd > 0 && usd < 0.005 ? "<$0.01" : formatUsd(usd);
}

/** Output rate: "64 tok/s", "<1 tok/s". */
export function formatTps(tps: number): string {
  return `${tps > 0 && tps < 1 ? "<1" : Math.round(tps)} tok/s`;
}

/** A model's share of its spender's figure: "71%", "<1%". */
function pctText(part: number, whole: number): string {
  const pct = whole > 0 ? (100 * part) / whole : 0;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** `provider/model`, as the Usage page keys (and colours) a model. */
function modelId(m: ModelShare): string {
  return m.provider ? `${m.provider}/${m.model}` : m.model;
}

/** One spender's figure by model: each model's value, share and share bar, the largest first. */
function ModelBreakdown({ spender, shares, figure, format }: { spender: SpenderInfo; shares: ModelShare[]; figure: number; format: (v: number) => string }) {
  return (
    <span className="flex w-64 max-w-full flex-col gap-1.5 py-0.5 text-xs" data-breakdown={spender.key}>
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", spender.dot)} />
        <span className="font-bold text-ink">{spender.label}</span>
        <span className="font-medium text-mute">by model</span>
        <span className="ml-auto font-bold text-ink tabular">{format(figure)}</span>
      </span>
      {shares.map((m) => {
        const id = modelId(m);
        const theme = agentGlyphTheme(id);
        return (
          <span key={id} className="flex flex-col gap-0.5" title={id}>
            <span className="flex items-baseline gap-1.5 text-[11px]">
              <span className="size-1.5 shrink-0 self-center rounded-full" style={{ background: theme.from }} aria-hidden />
              <span className="min-w-0 truncate font-mono font-semibold text-ink-2">{m.model}</span>
              {m.provider && <span className="min-w-0 shrink-[2] truncate text-[10.5px] font-medium text-mute-2">{m.provider}</span>}
              <span className="ml-auto shrink-0 font-semibold text-ink-2 tabular">{format(m.value)}</span>
              <span className="w-8 shrink-0 text-right font-medium text-mute tabular">{pctText(m.value, figure)}</span>
            </span>
            <span className="relative h-1 overflow-hidden rounded-full bg-ink/8">
              <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(100 * m.value) / figure}%`, background: `linear-gradient(90deg, ${theme.from}, ${theme.to})` }} />
            </span>
          </span>
        );
      })}
      {spender.note && <span className="text-[10.5px] leading-snug font-medium text-mute">{spender.note}</span>}
    </span>
  );
}

/**
 * A spender's row (Spend and Throughput tiles) that shows its figure by model: a tooltip on hover
 * or focus (desktop), a popover on tap (touch, where tooltips never open). A row with no split
 * (a host before 0.9.5, nothing billed or streaming) stays plain. `children`: the row, whose label
 * must not be a `<Term>` while it is the trigger (one hover per row). `side`: where the tooltip
 * goes, off the tile's other rows.
 */
export function SpenderRow({
  spender,
  shares,
  figure,
  format,
  side = "left",
  className,
  children,
}: {
  spender: SpenderInfo;
  shares: ModelShare[];
  figure: number;
  format: (v: number) => string;
  side?: "left" | "bottom";
  className?: string;
  children: ReactNode;
}) {
  const fine = useFinePointer();
  if (shares.length === 0) {
    return (
      <div data-spender={spender.key} className={className}>
        {children}
      </div>
    );
  }
  const breakdown = <ModelBreakdown spender={spender} shares={shares} figure={figure} format={format} />;
  const trigger = cn("focus-ring cursor-default rounded-sm text-left transition-colors hover:bg-ink/5 data-[state=open]:bg-ink/5", className);
  if (fine) {
    return (
      <Tooltip content={breakdown} side={side} className="max-w-80">
        <div tabIndex={0} data-spender={spender.key} className={trigger}>
          {children}
        </div>
      </Tooltip>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-spender={spender.key} className={trigger} onClick={(e) => e.stopPropagation()}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto min-w-0 max-w-[calc(100vw-1.5rem)] p-2.5">
        {breakdown}
      </PopoverContent>
    </Popover>
  );
}

/** Header cost tooltip: the session total, what it is made of and, per spender, by model. */
export function CostTooltip({ cost }: { cost: CostInfo }) {
  const split = cost.split;
  return (
    <span className="flex flex-col gap-1 py-0.5">
      <span>Session cost · {formatUsd(cost.usd)}</span>
      {split &&
        SPENDERS.map((s) => (
          <span key={s.key} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium text-mute">
              <span className={cn("size-1.5 rounded-full", s.dot)} />
              <span className="flex-1">{s.label}</span>
              <span className="tabular text-ink-2">{formatUsd(split[s.key])}</span>
            </span>
            {sharesOf(split.models, s.key).map((m) => (
              <span key={modelId(m)} className="flex items-center gap-1.5 pl-3 text-[10.5px] font-medium text-mute-2">
                <span className="min-w-0 flex-1 truncate font-mono">{m.model}</span>
                <span className="tabular text-mute">{formatUsdPart(m.value)}</span>
                <span className="w-7 text-right tabular">{pctText(m.value, split[s.key])}</span>
              </span>
            ))}
          </span>
        ))}
      <span className="font-medium text-mute tabular">
        {formatCompact(cost.input)} in / {formatCompact(cost.output)} out
      </span>
    </span>
  );
}

/** Inspector Spend tile: the session total, what each spender cost (share bars; hover a row for its models) and the token totals. */
export function SpendTile({ cost }: { cost?: CostInfo }) {
  const split = cost?.split;
  const total = cost?.usd ?? 0;
  return (
    <CollapsibleTile
      id="spend"
      title="Spend"
      className="rounded-lg bg-bg-deep/45 px-3 py-2.5 shadow-hairline"
      aside={<span className="font-display text-xl leading-none font-bold tracking-[-0.03em] text-ink tabular">{cost ? <NumberTicker value={cost.usd} format={formatUsd} /> : "—"}</span>}
    >
      {split &&
        SPENDERS.map((s) => {
          const usd = split[s.key];
          const shares = sharesOf(split.models, s.key);
          return (
            <SpenderRow key={s.key} spender={s} shares={shares} figure={usd} format={formatUsdPart} className="grid w-full grid-cols-[auto_6.5rem_1fr_auto] items-center gap-x-2 text-[11.5px]">
              <span className={cn("size-2 rounded-full", s.dot)} />
              <span className="truncate font-semibold text-ink-2">{shares.length ? s.label : s.term}</span>
              <span className="relative h-1 overflow-hidden rounded-full bg-ink/6">
                <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out", s.dot)} style={{ width: `${total > 0 ? (100 * usd) / total : 0}%` }} />
              </span>
              <span className="text-right font-bold text-ink tabular">{formatUsd(usd)}</span>
            </SpenderRow>
          );
        })}
      {cost && (
        <div className="text-[10.5px] font-semibold text-mute-2 tabular">
          {formatCompact(cost.input)} in / {formatCompact(cost.output)} out
        </div>
      )}
    </CollapsibleTile>
  );
}
