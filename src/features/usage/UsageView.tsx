import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { core, useAgent, useCore, useHostIds, useHosts } from "@/core";
import type { UsageDay, UsageModel, UsageReport } from "@/core/gen";
import { AgentGlyph, EmptyState, NumberTicker, PageHeader, Skeleton, Tile, Tooltip, agentGlyphTheme, cn, formatCompact, formatUsd, spring, useIsMobile, useNow } from "@/design";
import { reportError } from "@/features/board/agentActions";
import { useTodayUsage } from "@/features/board/BentoRow";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { LimitsSection } from "./LimitsSection";

const DAYS = 14;
const REFRESH_MS = 60_000;

function mergeReports(reports: UsageReport[]): { days: UsageDay[]; models: UsageModel[] } {
  const days = new Map<string, UsageDay>();
  const models = new Map<string, UsageModel>();
  for (const r of reports) {
    for (const d of r.days) {
      const cur = days.get(d.day) ?? { day: d.day, costUsd: 0, tokens: 0 };
      days.set(d.day, { day: d.day, costUsd: cur.costUsd + d.costUsd, tokens: cur.tokens + d.tokens });
    }
    for (const m of r.models) {
      const cur = models.get(m.model) ?? { model: m.model, costUsd: 0, tokens: 0 };
      models.set(m.model, { model: m.model, costUsd: cur.costUsd + m.costUsd, tokens: cur.tokens + m.tokens });
    }
  }
  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-DAYS),
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

/** `host.usage` for every host in view, refreshed every minute and when hosts come online. */
function useUsageReports(hostIds: string[]): { reports: UsageReport[]; loading: boolean } {
  const online = useHosts((s) => hostIds.filter((id) => s.status[id]?.phase === "online").join("|"));
  const [reports, setReports] = useState<Record<string, UsageReport>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ids = online ? online.split("|") : [];
    let alive = true;
    const load = async () => {
      const results = await Promise.allSettled(ids.map((id) => core.host(id).call("host.usage", { days: DAYS })));
      if (!alive) return;
      const next: Record<string, UsageReport> = {};
      results.forEach((r, i) => {
        const id = ids[i];
        if (!id) return;
        if (r.status === "fulfilled") next[id] = r.value;
        else reportError(`Couldn't load usage for ${id}`, r.reason);
      });
      setReports(next);
      setLoading(false);
    };
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [online]);
  return { reports: hostIds.map((id) => reports[id]).filter((r): r is UsageReport => !!r), loading };
}

function TodayTile({ hostFilter }: { hostFilter: string }) {
  const { cost, tokens } = useTodayUsage(hostFilter);
  const io = useCore(
    useShallow((s) => {
      let input = 0;
      let output = 0;
      for (const [id, h] of Object.entries(s.hosts))
        if (hostFilter === "all" || hostFilter === id) {
          input += h.state.usage.input;
          output += h.state.usage.output;
        }
      return [input, output] as const;
    }),
  );
  const now = useNow(60_000);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const hours = Math.max(0.5, (now - midnight.getTime()) / 3_600_000);
  const pace = cost / hours;
  const mobile = useIsMobile();
  return (
    // desktop: the figure fits the tile (mega once the page is wide) instead of clipping a four-figure day
    <Tile variant="omp" className={cn("flex min-h-56 flex-col p-5 max-md:min-h-0 max-md:p-4", !mobile && "@container @3xl:[--fit-max:var(--text-mega)]")}>
      <span className="kicker text-white/80">Today</span>
      <NumberTicker value={cost} format={formatUsd} className={cn("mt-2 font-display font-bold", mobile ? "mt-1 text-hero" : "text-hero-fit")} />
      <span className="mt-1 text-sm font-semibold text-white/85">
        <NumberTicker value={tokens} format={formatCompact} className="font-bold text-white" /> tokens
      </span>
      {/* a narrow desktop tile gives the pace column (the longest figure) whatever "in"/"out" leave over */}
      <div className="mt-auto grid grid-cols-3 gap-3 pt-4 text-xs font-semibold text-white/80 max-md:pt-3 @max-[22rem]:grid-cols-[auto_auto_minmax(0,1fr)] @max-[22rem]:gap-x-5 [&>span]:min-w-0 [&_b]:truncate">
        <span>
          <b className="block font-display text-lg text-white">{formatCompact(io[0])}</b>in
        </span>
        <span>
          <b className="block font-display text-lg text-white">{formatCompact(io[1])}</b>out
        </span>
        <span title="Average spend per hour today, projected over 24 h">
          <b className="block font-display text-lg text-white">{formatUsd(pace)}/h</b>
          <span className="block truncate">~{formatUsd(pace * 24)} / day</span>
        </span>
      </div>
    </Tile>
  );
}

function DaysChart({ days, todayLive, className }: { days: UsageDay[]; todayLive: number; className?: string }) {
  const todayKey = days[days.length - 1]?.day;
  const values = days.map((d) => (d.day === todayKey ? Math.max(d.costUsd, todayLive) : d.costUsd));
  const max = Math.max(...values, 0.01);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <Tile className={cn("flex min-h-56 flex-col p-5 max-md:min-h-0 max-md:p-4", className)}>
      <div className="flex items-baseline gap-2">
        <span className="kicker">{days.length > 0 ? `Last ${days.length} days` : "Daily cost"}</span>
        <span className="ml-auto font-display text-lg font-bold text-ink">{formatUsd(total)}</span>
      </div>
      {days.length === 0 ? (
        <p className="m-auto py-6 text-center text-sm text-mute">No history yet: daily totals appear once a host reports usage.</p>
      ) : (
        <div className="mt-4 flex min-h-36 flex-1 items-end gap-1.5 max-md:mt-3 max-md:min-h-28 max-md:gap-1" role="img" aria-label={`Daily cost for the last ${days.length} days`}>
          {days.map((d, i) => {
            const v = values[i] ?? 0;
            const today = d.day === todayKey;
            return (
              <Tooltip key={d.day} content={`${d.day} · ${formatUsd(v)} · ${formatCompact(d.tokens)} tokens`}>
                <div className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                  <motion.div
                    data-status={today ? "running" : "idle"}
                    className={cn(
                      "w-full min-h-[3px] rounded-t-[6px] rounded-b-[3px]",
                      today ? "st-bg live-gradient shadow-glow-run" : "bg-white/10 group-hover:bg-accent/50",
                    )}
                    initial={{ height: 0 }}
                    animate={{ height: `${(v / max) * 100}%` }}
                    transition={{ ...spring.gentle, delay: i * 0.03 }}
                  />
                  <span className={cn("font-mono text-[9.5px] tabular", today ? "font-bold text-ink" : "text-mute-2")}>{d.day.slice(8)}</span>
                </div>
              </Tooltip>
            );
          })}
        </div>
      )}
    </Tile>
  );
}

const DONUT_R = 52;
const DONUT_C = 2 * Math.PI * DONUT_R;

/** Share of spend per model as an animated ring; the centre shows the total. */
function ModelDonut({ models }: { models: UsageModel[] }) {
  const total = models.reduce((a, m) => a + m.costUsd, 0);
  let offset = 0;
  return (
    <div className="relative mx-auto mt-4 grid size-[150px] place-items-center">
      <svg viewBox="0 0 128 128" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="64" cy="64" r={DONUT_R} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="11" />
        {models.map((m, i) => {
          const theme = agentGlyphTheme(m.model);
          const len = total > 0 ? (m.costUsd / total) * DONUT_C : 0;
          const gap = models.length > 1 ? Math.min(3, len / 3) : 0;
          const start = offset;
          offset += len;
          return (
            <motion.circle
              key={m.model}
              cx="64"
              cy="64"
              r={DONUT_R}
              fill="none"
              stroke={theme.from}
              strokeWidth="11"
              strokeLinecap="round"
              strokeDashoffset={-start}
              initial={{ strokeDasharray: `0 ${DONUT_C}` }}
              animate={{ strokeDasharray: `${Math.max(0, len - gap)} ${DONUT_C}` }}
              transition={{ ...spring.gentle, delay: 0.1 + i * 0.07 }}
            />
          );
        })}
      </svg>
      <div className="text-center">
        <NumberTicker value={total} format={formatUsd} className="font-display text-xl font-bold text-ink" />
        <div className="text-2xs font-semibold text-mute">{models.length} model{models.length === 1 ? "" : "s"}</div>
      </div>
    </div>
  );
}

function ModelsTile({ models, className }: { models: UsageModel[]; className?: string }) {
  const max = Math.max(...models.map((m) => m.costUsd), 0.01);
  return (
    <Tile className={cn("flex flex-col p-5 max-md:p-4", className)}>
      <span className="kicker">By model</span>
      {models.length === 0 ? (
        <p className="mt-4 text-sm text-mute">No model usage recorded yet.</p>
      ) : (
        <>
          <ModelDonut models={models} />
          <ul className="mt-5 flex flex-col gap-3 max-md:mt-4 max-md:gap-2.5">
            {models.map((m, i) => {
              const theme = agentGlyphTheme(m.model);
              return (
                <li key={m.model} className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="size-2 shrink-0 self-center rounded-full" style={{ background: theme.from }} aria-hidden />
                    <span className="min-w-0 truncate font-mono font-bold text-ink">{m.model}</span>
                    <span className="ml-auto shrink-0 text-mute tabular">{formatCompact(m.tokens)} tok</span>
                    <span className="w-16 shrink-0 text-right font-bold text-ink tabular">{formatUsd(m.costUsd)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: `linear-gradient(90deg, ${theme.from}, ${theme.to})` }}
                      initial={{ width: 0 }}
                      animate={{ width: `${(m.costUsd / max) * 100}%` }}
                      transition={{ ...spring.gentle, delay: i * 0.05 }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Tile>
  );
}

function AgentCostRow({ agentKey, max }: { agentKey: string; max: number }) {
  const agent = useAgent(agentKey);
  if (!agent) return null;
  const cost = agent.omp?.cost;
  const usd = cost?.usd ?? 0;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2">
      <AgentGlyph name={agent.name} size={26} status={agent.column === "running" ? "running" : undefined} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-extrabold text-ink">{agent.name}</span>
          <span className="truncate font-mono text-2xs text-mute-2">{agent.omp?.model?.label ?? agent.omp?.model?.id ?? agent.kind}</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/6">
          <motion.div
            data-status={agent.column === "running" ? "running" : "idle"}
            className={cn("h-full rounded-full st-bg", agent.column === "running" && "live-gradient")}
            animate={{ width: `${max > 0 ? (usd / max) * 100 : 0}%` }}
            transition={spring.gentle}
          />
        </div>
      </div>
      <div className="text-right">
        <NumberTicker value={usd} format={formatUsd} className="text-sm font-bold text-ink" />
        {cost && (
          <div className="font-mono text-[10px] text-mute-2 tabular">
            {formatCompact(cost.input)} in · {formatCompact(cost.output)} out
          </div>
        )}
      </div>
    </li>
  );
}

function AgentsTile({ hostFilter, className }: { hostFilter: string; className?: string }) {
  const ranked = useCore(
    useShallow((s) =>
      Object.values(s.agents)
        .filter((a) => (hostFilter === "all" || a.hostId === hostFilter) && a.omp?.cost)
        .sort((a, b) => (b.omp?.cost?.usd ?? 0) - (a.omp?.cost?.usd ?? 0))
        .map((a) => a.key),
    ),
  );
  const max = useCore((s) => (ranked[0] ? (s.agents[ranked[0]]?.omp?.cost?.usd ?? 0) : 0));
  return (
    <Tile className={cn("flex flex-col p-5 max-md:p-4", className)}>
      <span className="kicker">Per agent · this session</span>
      {ranked.length === 0 ? (
        <p className="mt-4 text-sm text-mute">Cost appears once an omp agent has finished a turn.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {ranked.map((k) => (
            <AgentCostRow key={k} agentKey={k} max={max} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

/** Spend and limits: today next to subscription limits, then 14-day bars, models, per-agent (spec §5 Usage). */
export function UsageView() {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  const hostIds = filter === "all" ? ids : [filter];
  const { reports, loading } = useUsageReports(hostIds);
  const { cost } = useTodayUsage(filter);
  const { days, models } = mergeReports(reports);
  const mobile = useIsMobile();

  const body =
    hostIds.length === 0 ? (
      <EmptyState title="No hosts connected" description="Usage is read from each host's omp sessions." className="mt-10" />
    ) : (
      <div className={cn("grid items-start", mobile ? "grid-cols-1 gap-5" : "grid-cols-2 gap-x-3 gap-y-7 @3xl:grid-cols-3")}>
        <TodayTile hostFilter={filter} />
        <LimitsSection hostIds={hostIds} className={cn(!mobile && "@3xl:col-span-2")} />
        <div className={cn("grid", mobile ? "grid-cols-1 gap-2.5" : "col-span-2 grid-cols-2 gap-3 @3xl:col-span-3 @3xl:grid-cols-3")}>
          {loading && days.length === 0 ? (
            <Skeleton className={cn("min-h-56 rounded-tile", !mobile && "col-span-2")} />
          ) : (
            <DaysChart days={days} todayLive={cost} className={cn(!mobile && "col-span-2")} />
          )}
          <ModelsTile models={models} />
          <AgentsTile hostFilter={filter} className={cn(!mobile && "@3xl:col-span-3")} />
        </div>
      </div>
    );

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Usage" subtitle="Cost, tokens and limits" back />
        <div className="px-3 pt-1 pb-5">{body}</div>
      </div>
    );
  return (
    <div className="@container mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pt-7 pb-12">
      <PageHeader kicker="Spend" title="Usage" description="Cost and tokens from every omp session on the hosts in view, and how much of each subscription is left." />
      {body}
    </div>
  );
}
