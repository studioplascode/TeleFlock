import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  calendar,
  type HostUsage,
  rangeSince,
  refreshUsage,
  type TodaySpend,
  USAGE_PAGE_EVERY_MS,
  type UsageRange,
  usageIsStale,
  useAgent,
  useCore,
  useHostIds,
  useHostUsage,
  useHosts,
  useTodaySpend,
} from "@/core";
import { AgentGlyph, cn, EmptyState, formatAge, formatCompact, formatUsd, IconButton, NumberTicker, PageHeader, SegmentedControl, Skeleton, Tile, Tooltip, useIsMobile, useNow, useWindowActive } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { LimitsSection } from "./LimitsSection";
import { activeDays, bars, daySeries, heatmap, hourProfile, mergeInsights, streaks } from "./usageData";
import { Highlights, HoursTile, ModelsTile, ProjectsTile, RecordsTile, SessionsTile, SpendersTile, StreakTile, ToolsTile, usd } from "./UsageTiles";

const RANGES: { value: Exclude<UsageRange, "today">; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All" },
];

/** The Today figure (shared with the board's tile: same answers, same merge). */
function TodayTile({ t }: { t: TodaySpend }) {
  const now = useNow(60_000);
  const midnight = calendar().startOfDay(now);
  const hours = Math.max(0.5, (now - midnight) / 3_600_000);
  const pace = t.cost / hours;
  const peak = Math.max(...t.byHour, 0.000001);
  const mobile = useIsMobile();
  return (
    <Tile variant="omp" className={cn("flex min-h-56 flex-col p-5 max-md:min-h-0 max-md:p-4", !mobile && "@container @3xl:[--fit-max:var(--text-mega)]")}>
      <div className="flex items-center gap-2">
        <span className="kicker text-white/80">Today</span>
        {t.live > 0 && (
          <Tooltip content={`${formatUsd(t.live)} seen live since the hosts' last sync (indexed at the next one)`}>
            <span tabIndex={0} className="rounded-full bg-white/18 px-2 py-0.5 text-[10px] font-extrabold tracking-[0.06em] text-white uppercase">live</span>
          </Tooltip>
        )}
      </div>
      <NumberTicker value={t.cost} format={(n) => usd(n, t.unpriced)} className={cn("mt-2 font-display font-bold", mobile ? "mt-1 text-hero" : "text-hero-fit")} />
      <span className="mt-1 text-sm font-semibold text-white/85">
        <NumberTicker value={t.tokens} format={formatCompact} className="font-bold text-white" /> tokens · {t.requests} requests
      </span>
      <div className="mt-3 flex h-8 items-end gap-[2px]" aria-hidden>
        {t.byHour.map((c, h) => (
          <div key={h} className={cn("flex-1 rounded-t-[2px]", h === new Date(now).getHours() ? "bg-white" : "bg-white/30")} style={{ height: `${Math.max(4, (c / peak) * 100)}%` }} />
        ))}
      </div>
      <div className="mt-auto grid grid-cols-3 gap-3 pt-3 text-xs font-semibold text-white/80 [&>span]:min-w-0 [&_b]:truncate">
        <span>
          <b className="block font-display text-lg text-white">{formatCompact(t.input)}</b>in
        </span>
        <span>
          <b className="block font-display text-lg text-white">{formatCompact(t.output)}</b>out
        </span>
        <span title="Average spend per hour since midnight on this device, projected over 24 h">
          <b className="block font-display text-lg text-white">{formatUsd(pace)}/h</b>
          <span className="block truncate">~{formatUsd(pace * 24)} / day</span>
        </span>
      </div>
      {(t.approx.length > 0 || t.unpriced > 0) && (
        <p className="mt-2 text-[10.5px] font-semibold text-white/70">
          {t.unpriced > 0 ? `${t.unpriced} request${t.unpriced === 1 ? "" : "s"} without a price · ` : ""}
          {t.approx.length > 0 ? "some hosts report live spend only until their index answers" : ""}
        </p>
      )}
    </Tile>
  );
}

/** Spend per local day (or per group of days on long ranges); today's bar is the Today figure. */
function SpendChart({ days, today, className }: { days: ReturnType<typeof daySeries>; today: number; className?: string }) {
  const mobile = useIsMobile();
  const shown = bars(
    days.map((d, i) => (i === days.length - 1 ? { ...d, cost: today } : d)),
    mobile ? 21 : 45,
  );
  const max = Math.max(...shown.map((b) => b.cost), 0.01);
  const total = shown.reduce((n, b) => n + b.cost, 0);
  const avg = days.length > 0 ? total / days.length : 0;
  return (
    <Tile className={cn("flex min-h-56 flex-col p-5 max-md:p-4", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="kicker">Spend over time</span>
        <span className="text-2xs font-semibold text-mute">avg {formatUsd(avg)}/day{shown[0] && shown[0].span > 1 ? ` · ${shown[0].span}-day bars` : ""}</span>
        <span className="ml-auto font-display text-lg font-bold text-ink tabular">{formatUsd(total)}</span>
      </div>
      {shown.length === 0 ? (
        <p className="m-auto py-6 text-center text-sm text-mute">No history in this range yet.</p>
      ) : (
        <div className="mt-4 flex min-h-36 flex-1 items-end gap-1 max-md:min-h-28" role="img" aria-label={`Spend per day, ${formatUsd(total)} in total`}>
          {shown.map((b, i) => {
            const last = i === shown.length - 1;
            return (
              <Tooltip key={b.key} content={`${b.key}${b.span > 1 ? ` (+${b.span - 1} days)` : ""} · ${usd(b.cost, b.unpriced)} · ${formatCompact(b.tokens)} tokens · ${b.requests} requests`}>
                <div tabIndex={0} className="group flex h-full min-w-0 flex-1 flex-col justify-end focus-ring rounded-t-[4px]">
                  <div
                    data-status={last ? "running" : "idle"}
                    className={cn("w-full min-h-[3px] rounded-t-[4px] rounded-b-[2px]", last ? "st-bg" : "bg-white/12 group-hover:bg-accent/50")}
                    style={{ height: `${(b.cost / max) * 100}%` }}
                  />
                </div>
              </Tooltip>
            );
          })}
        </div>
      )}
      {shown.length > 0 && (
        <div className="mt-1.5 flex justify-between font-mono text-[9.5px] text-mute-2 tabular">
          <span>{shown[0]?.key.slice(5)}</span>
          <span>today</span>
        </div>
      )}
    </Tile>
  );
}

/** One line per host: how fresh its figures are (synced, syncing, offline with the last report, errors). */
function Freshness({ hostIds, byHost, names, now }: { hostIds: string[]; byHost: Record<string, HostUsage>; names: Record<string, string>; now: number }) {
  const phases = useHosts(useShallow((s) => hostIds.map((id) => s.status[id]?.phase ?? "idle")));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs font-semibold text-mute">
      {hostIds.map((id, i) => {
        const u = byHost[id];
        const online = phases[i] === "online";
        const stale = usageIsStale(u, online, USAGE_PAGE_EVERY_MS, now);
        const idx = u?.index;
        const text = !u?.receivedAt
          ? online
            ? "loading…"
            : "offline · no report yet"
          : idx && !idx.ready
            ? idx.syncing
              ? "indexing omp's sessions for the first time…"
              : "omp has not indexed any session yet"
            : idx?.syncing
              ? "syncing omp's index…"
              : idx?.syncedAt
                ? `synced ${formatAge(now - idx.syncedAt)}`
                : "index not synced since the host started";
        return (
          <span key={id} data-status={stale || idx?.error ? "needs-you" : idx?.syncing ? "running" : undefined} className={cn("flex items-center gap-1.5", (stale || idx?.error) && "st-text")}>
            {(stale || idx?.error) && <AlertTriangle className="size-3" />}
            {hostIds.length > 1 && <b className="text-ink-2">{names[id] ?? id}</b>}
            {stale ? `${online ? "last good report" : "offline · last report"} from ${formatAge(now - (u?.receivedAt ?? now))}` : text}
            {idx?.error && <span title={idx.error}> · last sync failed</span>}
          </span>
        );
      })}
    </div>
  );
}

function AgentCostRow({ agentKey, max }: { agentKey: string; max: number }) {
  const agent = useAgent(agentKey);
  if (!agent) return null;
  const cost = agent.omp?.cost;
  const spent = cost?.usd ?? 0;
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2">
      <AgentGlyph name={agent.name} size={26} status={agent.column === "running" ? "running" : undefined} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-extrabold text-ink">{agent.name}</span>
          <span className="truncate font-mono text-2xs text-mute-2">{agent.omp?.model?.label ?? agent.omp?.model?.id ?? agent.kind}</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/6">
          <div data-status={agent.column === "running" ? "running" : "idle"} className="h-full rounded-full st-bg" style={{ width: `${max > 0 ? (spent / max) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="text-right">
        <NumberTicker value={spent} format={formatUsd} className="text-sm font-bold text-ink" />
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
      <span className="kicker">Agents on the board · this session</span>
      {ranked.length === 0 ? (
        <p className="mt-4 text-sm text-mute">Cost appears once an omp agent has finished a turn.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {ranked.slice(0, 12).map((k) => (
            <AgentCostRow key={k} agentKey={k} max={max} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

/**
 * Usage: today next to subscription limits, then the selected range's history and insights
 * from omp's stats index on every host in view (spec §5 Usage, architecture §3.16).
 */
export function UsageView() {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  const hostIds = filter === "all" ? ids : [filter];
  const profiles = useHosts((s) => s.profiles);
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]));
  const [range, setRange] = useState<Exclude<UsageRange, "today">>("30d");
  const every = useWindowActive() ? USAGE_PAGE_EVERY_MS : null;
  const now = useNow(30_000);
  const byHost = useHostUsage(hostIds, range, every);
  const today = useTodaySpend(hostIds, every, now);
  const mobile = useIsMobile();
  const [spinning, setSpinning] = useState(false);
  const cal = calendar();

  const merged = useMemo(() => mergeInsights(hostIds.flatMap((id) => (byHost[id]?.insights ? [{ hostId: id, insights: byHost[id].insights }] : []))), [byHost, hostIds.join("|")]);
  const since = rangeSince(range, now, cal) ?? merged.hours[0]?.start ?? now;
  const days = useMemo(() => daySeries(merged.hours, cal, since, now), [merged, since, Math.floor(now / 3_600_000)]);
  const dayMap = useMemo(() => activeDays(merged.activity, cal), [merged]);
  const loading = hostIds.some((id) => byHost[id]?.loading) && !hostIds.some((id) => byHost[id]?.insights);
  const notReady = hostIds.length > 0 && hostIds.every((id) => byHost[id]?.index && !byHost[id]?.index?.ready);
  const best = days.reduce<{ key: string; cost: number } | undefined>((b, d) => (!b || d.cost > b.cost ? { key: d.key, cost: d.cost } : b), undefined);
  const refresh = () => {
    setSpinning(true);
    void Promise.allSettled([refreshUsage(hostIds, range), refreshUsage(hostIds, "today")]).finally(() => setSpinning(false));
  };

  const controls = (
    <div className="flex items-center gap-2">
      <SegmentedControl size="sm" aria-label="Range" value={range} onValueChange={setRange} options={RANGES} />
      <IconButton size="sm" label="Sync omp's index now and refresh" onClick={refresh}>
        <RefreshCw className={cn(spinning && "animate-spin tf-keep")} />
      </IconButton>
    </div>
  );

  const body =
    hostIds.length === 0 ? (
      <EmptyState title="No hosts connected" description="Usage is read from each host's omp sessions." className="mt-10" />
    ) : (
      <div className={cn("grid items-start", mobile ? "grid-cols-1 gap-5" : "grid-cols-2 gap-x-3 gap-y-7 @3xl:grid-cols-3")}>
        <TodayTile t={today} />
        <LimitsSection hostIds={hostIds} className={cn(!mobile && "@3xl:col-span-2")} />
        <section aria-label="History" className={cn("flex min-w-0 flex-col gap-3", !mobile && "col-span-2 @3xl:col-span-3")}>
          <div className="flex flex-col gap-1.5">
            {mobile && controls}
            <Freshness hostIds={hostIds} byHost={byHost} names={names} now={now} />
          </div>
          {loading ? (
            <Skeleton className="min-h-56 rounded-tile" />
          ) : notReady ? (
            <EmptyState title="Indexing omp's sessions" description="omp has not built its stats index on this host yet. TeleFlock started omp's own sync; history appears here when it finishes." />
          ) : (
            <div className={cn("grid", mobile ? "grid-cols-1 gap-2.5" : "grid-cols-2 gap-3 @3xl:grid-cols-3")}>
              <Highlights m={merged} className={cn(!mobile && "col-span-2 @3xl:col-span-3")} />
              <SpendChart days={days} today={today.cost} className={cn(!mobile && "col-span-2")} />
              <StreakTile s={streaks(dayMap, cal, now)} cells={heatmap(dayMap, cal, now, mobile ? 14 : 18)} />
              <ModelsTile m={merged} />
              <SpendersTile m={merged} />
              <ProjectsTile m={merged} hostNames={names} />
              <ToolsTile m={merged} />
              <HoursTile profile={hourProfile(merged.hours, cal)} />
              <RecordsTile m={merged} bestDay={best} cal={cal} />
              <SessionsTile m={merged} hostNames={names} now={now} className={cn(!mobile && "col-span-2 @3xl:col-span-3")} />
              <AgentsTile hostFilter={filter} className={cn(!mobile && "col-span-2 @3xl:col-span-3")} />
            </div>
          )}
          <p className="text-[11px] font-semibold text-mute-2">
            Costs are API-equivalent estimates from omp's rate cards: requests on a subscription are priced as if billed per request, so they are not your bill.
            {merged.totals.unpriced > 0 ? ` ${merged.totals.unpriced} request${merged.totals.unpriced === 1 ? " has" : "s have"} no public price (N/A, not free).` : ""}
          </p>
        </section>
      </div>
    );

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Usage" subtitle="Spend, tokens and limits" back />
        <div className="px-3 pt-1 pb-5">{body}</div>
      </div>
    );
  return (
    <div className="@container mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pt-7 pb-12">
      <PageHeader kicker="Spend" title="Usage" description="Cost, tokens and insights from omp's own stats on the hosts in view, and how much of each subscription is left." actions={controls} />
      {body}
    </div>
  );
}
