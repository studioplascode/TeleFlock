import { Bot, Clock3, Coins, Database, Flame, Gauge, Hammer, Layers, Medal, Timer, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { Calendar } from "@/core";
import type { UsageStat } from "@/core/gen";
import { agentGlyphTheme, cn, formatCompact, formatInt, formatUsd, Tile, Tooltip } from "@/design";
import { derive, formatSpanMs, type HeatCell, type MergedUsage, projectName, type Streaks } from "./usageData";

/** `$1.23`, or `N/A` when the only requests had no price (a subscription without a public rate). */
export function usd(cost: number, unpriced = 0): string {
  return cost === 0 && unpriced > 0 ? "N/A" : formatUsd(cost);
}

export function pct(x: number | null): string {
  if (x == null) return "—";
  const v = x * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
}

function ms(v: number | null): string {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

function Kicker({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="kicker flex items-center gap-1.5 [&_svg]:size-3.5">{icon}{children}</span>;
}

/** A proportional bar (no animation: values jump, calm by default). */
function Meter({ value, max, color, className }: { value: number; max: number; color?: string; className?: string }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-white/6", className)}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

/** Four headline figures for the range. */
export function Highlights({ m, className }: { m: MergedUsage; className?: string }) {
  const d = derive(m.totals);
  const cards: { icon: ReactNode; label: string; value: string; sub: string; tip: string }[] = [
    { icon: <Coins />, label: "Spend", value: usd(m.totals.costUsd, m.totals.unpriced), sub: `${formatCompact(m.totals.tokens)} tokens`, tip: "API-equivalent estimate: subscription requests priced at the public rate card, not your bill" },
    { icon: <Zap />, label: "Requests", value: formatInt(m.totals.requests), sub: `${pct(d.errorRate)} errors`, tip: "Model requests, subagents and advisors included; errors ended with a provider or stream error" },
    { icon: <Database />, label: "Cache hits", value: pct(d.cacheRate), sub: d.savedUsd > 0 ? `saved ~${formatUsd(d.savedUsd)}` : "of prompt tokens", tip: "Share of prompt tokens read from the provider's cache, and what that saved (API-equivalent)" },
    { icon: <Bot />, label: "Agent time", value: formatSpanMs(m.workMs), sub: `${m.sessionCount} session${m.sessionCount === 1 ? "" : "s"} · ${m.subagentCount} subagent run${m.subagentCount === 1 ? "" : "s"}`, tip: "Time agents spent working: request spans joined across pauses under 10 min, never counting time waiting for you" },
  ];
  return (
    <div className={cn("grid grid-cols-2 gap-3 @3xl:grid-cols-4 max-md:gap-2.5", className)}>
      {cards.map((c) => (
        <Tooltip key={c.label} content={c.tip}>
          <Tile className="flex flex-col gap-1 p-4" tabIndex={0}>
            <Kicker icon={c.icon}>{c.label}</Kicker>
            <span className="font-display text-xl font-bold text-ink tabular">{c.value}</span>
            <span className="truncate text-2xs font-semibold text-mute">{c.sub}</span>
          </Tile>
        </Tooltip>
      ))}
    </div>
  );
}

/** Current and longest streak, plus a Monday-first activity calendar. */
export function StreakTile({ s, cells, className }: { s: Streaks; cells: HeatCell[][]; className?: string }) {
  const tone = ["bg-white/[0.05]", "bg-accent/25", "bg-accent/45", "bg-accent/70", "bg-accent"];
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <Kicker icon={<Flame />}>Streak</Kicker>
      <div className="flex items-end gap-5">
        <div>
          <span className="font-display text-hero font-bold text-ink tabular">{s.current}</span>
          <span className="ml-1.5 text-sm font-semibold text-mute">day{s.current === 1 ? "" : "s"}{s.todayActive || s.current === 0 ? "" : " · keep it going today"}</span>
        </div>
        <div className="ml-auto text-right text-2xs font-semibold text-mute">
          <div>
            best <b className="text-ink tabular">{s.longest}</b>
          </div>
          <div>
            <b className="text-ink tabular">{s.activeDays}</b> active days
          </div>
        </div>
      </div>
      <div className="flex gap-[3px] overflow-hidden" role="img" aria-label={`Activity over the last ${cells.length} weeks`}>
        {cells.map((col) => (
          <div key={col[0]?.key} className="flex flex-1 flex-col gap-[3px]">
            {col.map((c) => (
              <div key={c.key} title={c.future ? undefined : `${c.key} · ${formatInt(c.requests)} requests`} className={cn("aspect-square w-full rounded-[3px]", c.future ? "opacity-0" : tone[c.level])} />
            ))}
          </div>
        ))}
      </div>
    </Tile>
  );
}

/** Spend per model with speed: average output rate and time to first token. */
export function ModelsTile({ m, className }: { m: MergedUsage; className?: string }) {
  const max = Math.max(...m.models.map((x) => x.stat.costUsd), 0.000001);
  const fastest = [...m.models].filter((x) => x.stat.tpsN >= 5).sort((a, b) => b.stat.tps / b.stat.tpsN - a.stat.tps / a.stat.tpsN)[0];
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <div className="flex items-baseline gap-2">
        <Kicker icon={<Layers />}>Models</Kicker>
        {fastest && <span className="ml-auto truncate text-2xs font-semibold text-mute">fastest: <b className="text-ink">{fastest.model}</b></span>}
      </div>
      {m.models.length === 0 ? (
        <p className="text-sm text-mute">No model requests in this range.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {m.models.slice(0, 8).map((x) => {
            const d = derive(x.stat);
            const theme = agentGlyphTheme(`${x.provider}/${x.model}`);
            return (
              <li key={`${x.provider}/${x.model}`} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="size-2 shrink-0 self-center rounded-full" style={{ background: theme.from }} aria-hidden />
                  <span className="min-w-0 truncate font-mono font-bold text-ink" title={`${x.provider}/${x.model}`}>{x.model}</span>
                  <span className="shrink-0 text-mute-2">{x.provider}</span>
                  <span className="ml-auto w-16 shrink-0 text-right font-bold text-ink tabular">{usd(x.stat.costUsd, x.stat.unpriced)}</span>
                </div>
                <Meter value={x.stat.costUsd} max={max} color={`linear-gradient(90deg, ${theme.from}, ${theme.to})`} />
                <div className="flex flex-wrap gap-x-3 text-[10.5px] font-semibold text-mute tabular">
                  <span>{formatInt(x.stat.requests)} req</span>
                  <span>{formatCompact(x.stat.tokens)} tok</span>
                  {d.tps != null && <span>{Math.round(d.tps)} tok/s</span>}
                  {d.ttftMs != null && <span>first token {ms(d.ttftMs)}</span>}
                  {x.stat.unpriced > 0 && <span className="text-mute-2">{x.stat.unpriced} unpriced</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

function ShareList({ rows, label }: { rows: { key: string; label: string; stat: UsageStat }[]; label: string }) {
  const total = rows.reduce((n, r) => n + r.stat.costUsd, 0);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] font-extrabold tracking-[0.08em] text-mute uppercase">{label}</span>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs">
          <span className="truncate font-semibold text-ink">{r.label}</span>
          <span className="font-bold text-ink tabular">{usd(r.stat.costUsd, r.stat.unpriced)}</span>
          <Meter value={r.stat.costUsd} max={total} className="col-span-2 h-1" />
        </div>
      ))}
    </div>
  );
}

const AGENT_LABEL: Record<string, string> = { main: "Main agents", subagent: "Subagents", advisor: "Advisors" };

/** Who spent it: providers, agent types and the busiest subagents. */
export function SpendersTile({ m, className }: { m: MergedUsage; className?: string }) {
  return (
    <Tile className={cn("flex flex-col gap-4 p-5 max-md:p-4", className)}>
      <Kicker icon={<Bot />}>Who spent it</Kicker>
      <ShareList label="Agents" rows={m.agents.map((a) => ({ key: a.key, label: AGENT_LABEL[a.key] ?? a.key, stat: a.stat }))} />
      <ShareList label="Providers" rows={m.providers.map((p) => ({ key: p.key, label: p.key, stat: p.stat }))} />
      <ShareList label="Top subagents" rows={m.subagents.slice(0, 5).map((s) => ({ key: s.key || "other", label: s.key || "Others", stat: s.stat }))} />
      {m.tiers.some((t) => t.key !== "") && (
        <p className="text-2xs font-semibold text-mute">
          Priority tiers: {m.tiers.filter((t) => t.key !== "").map((t) => `${t.key} ${formatInt(t.stat.requests)} req`).join(" · ")}
          {m.totals.premium > 0 ? ` · ${formatInt(m.totals.premium)} premium` : ""}
        </p>
      )}
    </Tile>
  );
}

export function ProjectsTile({ m, hostNames, className }: { m: MergedUsage; hostNames: Record<string, string>; className?: string }) {
  const multi = new Set(m.projects.map((p) => p.hostId)).size > 1;
  const max = Math.max(...m.projects.map((p) => p.stat.costUsd), 0.000001);
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <Kicker icon={<Database />}>Projects</Kicker>
      {m.projects.length === 0 && <p className="text-sm text-mute">No project activity in this range.</p>}
      <ul className="flex flex-col gap-2.5">
        {m.projects.slice(0, 8).map((p) => (
          <li key={`${p.hostId}:${p.folder}`} className="flex flex-col gap-1" title={p.cwd ?? p.folder}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 truncate font-bold text-ink">{projectName(p)}</span>
              {multi && <span className="shrink-0 text-mute-2">{hostNames[p.hostId] ?? p.hostId}</span>}
              <span className="ml-auto shrink-0 text-mute tabular">{formatInt(p.stat.requests)} req</span>
              <span className="w-14 shrink-0 text-right font-bold text-ink tabular">{usd(p.stat.costUsd, p.stat.unpriced)}</span>
            </div>
            <Meter value={p.stat.costUsd} max={max} />
          </li>
        ))}
      </ul>
    </Tile>
  );
}

export function ToolsTile({ m, className }: { m: MergedUsage; className?: string }) {
  const max = Math.max(...m.tools.map((t) => t.calls), 1);
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <Kicker icon={<Hammer />}>Top tools</Kicker>
      {m.tools.length === 0 && <p className="text-sm text-mute">No tool calls in this range.</p>}
      <ul className="flex flex-col gap-2">
        {m.tools.slice(0, 8).map((t) => (
          <li key={t.name} className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="truncate font-mono font-bold text-ink">{t.name}</span>
            <Meter value={t.calls} max={max} />
            <span className="text-right font-semibold text-mute tabular">
              {formatCompact(t.calls)}
              {t.errors > 0 && <span className="text-mute-2"> · {pct(t.errors / t.calls)} err</span>}
            </span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Requests by local hour of day; the busiest hour named. */
export function HoursTile({ profile, className }: { profile: number[]; className?: string }) {
  const max = Math.max(...profile, 1);
  const peak = profile.indexOf(max);
  const night = profile.slice(0, 6).reduce((a, b) => a + b, 0);
  const total = profile.reduce((a, b) => a + b, 0);
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <div className="flex items-baseline gap-2">
        <Kicker icon={<Clock3 />}>Hour of day</Kicker>
        {total > 0 && <span className="ml-auto text-2xs font-semibold text-mute">peak {String(peak).padStart(2, "0")}:00{night / total > 0.15 ? " · night owl" : ""}</span>}
      </div>
      <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={`Requests by hour of day, busiest ${peak}:00`}>
        {profile.map((n, h) => (
          <div key={h} title={`${String(h).padStart(2, "0")}:00 · ${formatInt(n)} requests`} className={cn("flex-1 rounded-t-[3px]", h === peak && total > 0 ? "bg-accent" : "bg-white/12")} style={{ height: `${Math.max(3, (n / max) * 100)}%` }} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9.5px] text-mute-2">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </Tile>
  );
}

export function SessionsTile({ m, hostNames, now, className }: { m: MergedUsage; hostNames: Record<string, string>; now: number; className?: string }) {
  const multi = new Set(m.sessions.map((s) => s.hostId)).size > 1;
  return (
    <Tile className={cn("flex flex-col gap-2 p-5 max-md:p-4", className)}>
      <Kicker icon={<Medal />}>Top sessions</Kicker>
      {m.sessions.length === 0 && <p className="text-sm text-mute">No sessions in this range.</p>}
      <ul className="flex flex-col divide-y divide-line">
        {m.sessions.slice(0, 6).map((s, i) => (
          <li key={`${s.hostId}:${s.file}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2">
            <span className="font-display text-sm font-bold text-mute-2 tabular">{i + 1}</span>
            <div className="min-w-0">
              <div className="truncate text-xs font-bold text-ink" title={s.file}>{s.title ?? s.id ?? s.file}</div>
              <div className="truncate text-[10.5px] font-semibold text-mute">
                {s.cwd ? projectName({ folder: "x", cwd: s.cwd }) : ""}
                {multi ? ` · ${hostNames[s.hostId] ?? s.hostId}` : ""} · {formatInt(s.requests)} req{s.delegated > 0 ? ` (${formatInt(s.delegated)} delegated)` : ""} · {formatSpanMs(s.endedAt - s.startedAt)} · {formatSpanMs(now - s.endedAt)} ago
              </div>
            </div>
            <span className="text-sm font-bold text-ink tabular">{usd(s.costUsd, s.unpriced)}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** Fun records of the range. */
export function RecordsTile({ m, bestDay, cal, className }: { m: MergedUsage; bestDay?: { key: string; cost: number }; cal: Calendar; className?: string }) {
  const rows: { icon: ReactNode; label: string; value: string; sub: string }[] = [];
  if (bestDay && bestDay.cost > 0) rows.push({ icon: <Coins />, label: "Biggest day", value: formatUsd(bestDay.cost), sub: bestDay.key });
  if (m.priciest) rows.push({ icon: <Gauge />, label: "Priciest request", value: formatUsd(m.priciest.costUsd), sub: `${m.priciest.model} · ${cal.day(m.priciest.at)}` });
  if (m.biggest) rows.push({ icon: <Layers />, label: "Biggest request", value: `${formatCompact(m.biggest.tokens)} tok`, sub: m.biggest.model });
  if (m.longest) rows.push({ icon: <Timer />, label: "Longest session", value: formatSpanMs(m.longest.endedAt - m.longest.startedAt), sub: m.longest.title ?? m.longest.id ?? "" });
  return (
    <Tile className={cn("flex flex-col gap-3 p-5 max-md:p-4", className)}>
      <Kicker icon={<Medal />}>Records</Kicker>
      {rows.length === 0 && <p className="text-sm text-mute">Records appear once there is activity in this range.</p>}
      <ul className="grid grid-cols-2 gap-3">
        {rows.map((r) => (
          <li key={r.label} className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
            <span className="flex items-center gap-1.5 text-[10.5px] font-extrabold tracking-[0.06em] text-mute uppercase [&_svg]:size-3">{r.icon}{r.label}</span>
            <span className="font-display text-lg font-bold text-ink tabular">{r.value}</span>
            <span className="truncate text-[10.5px] font-semibold text-mute-2" title={r.sub}>{r.sub}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}
