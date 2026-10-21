import { Gauge } from "lucide-react";
import { describePace, formatPct, formatSpan, parseAgentKey, type SessionLimits, sessionLimits, tightestWindow, useAccountLimits, useAgent, type WindowPace } from "@/core";
import type { LimitWindow } from "@/core/gen";
import { cn, formatAge, ProgressRing, Tooltip, useNow } from "@/design";
import { PROVIDER_NAMES, paceStatus } from "@/features/usage/limitsUi";

export interface SessionLimitsView {
  limits?: SessionLimits;
  /** The window that binds first for this session's model. */
  tight?: { window: LimitWindow; pace: WindowPace };
  /** omp has limits for the provider but hasn't pinned this session to one of its accounts. */
  unpinned: number;
  now: number;
}

/** The subscription window an omp session's model draws from, as reported by `host.limits`. */
export function useSessionLimits(agentKey: string): SessionLimitsView {
  const { hostId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const data = useAccountLimits(agent?.omp ? [hostId] : [])[hostId]?.data;
  const now = useNow(30_000);
  const model = agent?.omp?.model;
  const limits = sessionLimits(data, agent?.omp?.sessionId, model, now);
  const tight = limits ? tightestWindow(limits.windows, limits.fetchedAt, now) : undefined;
  const unpinned = !limits && model ? (data?.accounts.filter((a) => a.provider === model.provider && a.windows.length > 0).length ?? 0) : 0;
  return { limits, tight, unpinned, now };
}

function estimateText(v: SessionLimitsView, tps: number | undefined): string {
  const { limits, tight } = v;
  if (!limits || !tight) return "";
  const { pace, window } = tight;
  const lines = [
    `${PROVIDER_NAMES[limits.account.provider] ?? limits.account.provider} · ${limits.account.label}${limits.pinned ? "" : " (the provider's only account)"}.`,
    `Tightest of ${limits.windows.length} window${limits.windows.length === 1 ? "" : "s"} for this model: ${window.label}.`,
  ];
  if (pace.ratePerHour != null)
    lines.push(
      `Pace: ${(pace.ratePerHour * 100).toFixed(1)}%/h, the window's utilization change over the last ${formatSpan(pace.basisMs)} across every agent on this account${tps != null ? ` (this session: ${Math.round(tps)} tok/s now)` : ""}. Assumes that pace holds.`,
    );
  else lines.push("Pace: not enough readings yet (needs ≥ 10 min of history).");
  if (limits.fetchedAt != null) lines.push(`omp read ${formatAge(v.now - limits.fetchedAt)}${limits.stale ? " — stale" : ""}.`);
  return lines.join(" ");
}

/** Short time-left phrase for the tile / header chip. */
export function timeLeftText(pace: WindowPace): string {
  switch (pace.outcome) {
    case "runsOut":
      return `~${formatSpan(pace.etaMs ?? 0)} at this pace`;
    case "exhausted":
      return pace.resetsInMs != null ? `resets in ${formatSpan(pace.resetsInMs)}` : "limit reached";
    case "resetsFirst":
    case "idle":
      return pace.resetsInMs != null ? `lasts until reset (${formatSpan(pace.resetsInMs)})` : "no run-out in sight";
    case "reset":
      return "window just reset";
    case "unknown":
      return "measuring pace…";
  }
}

/** Inspector Session pane: % left of the session account's tightest window + time left at the current pace. */
export function LimitsTile({ agentKey, tps }: { agentKey: string; tps?: number }) {
  const v = useSessionLimits(agentKey);
  const { limits, tight } = v;
  if (!limits || !tight) {
    if (v.unpinned < 2) return null;
    return (
      <div className="col-span-2 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2 text-[10.5px] font-semibold text-mute-2 shadow-hairline">
        <Gauge className="mr-1 inline size-3" />
        omp hasn't pinned this session to one of its {v.unpinned} accounts yet — see Usage for all limits.
      </div>
    );
  }
  const { window, pace } = tight;
  const status = paceStatus(window, pace);
  const remaining = pace.remaining ?? 0;
  return (
    <Tooltip content={estimateText(v, tps)} className="max-w-80">
      <div data-limits-tile className="col-span-2 flex items-center gap-3 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline">
        <ProgressRing done={Math.round(remaining * 100)} total={100} size={48} stroke={4.5} status={status} label={<span className="text-[11px] font-bold">{formatPct(remaining)}</span>} ariaLabel={`${formatPct(remaining)} of ${window.label} left`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[10.5px] font-bold text-mute">
            <Gauge className="size-3" />
            <span className="truncate">
              {window.label} · {limits.account.label}
            </span>
          </div>
          <div className="font-display text-xl font-bold tracking-[-0.03em] text-ink tabular">
            {formatPct(remaining)} <span className="text-sm text-mute">left</span>
          </div>
          <div data-status={status} className={cn("truncate text-[10.5px] font-semibold tabular", pace.outcome === "runsOut" || pace.outcome === "exhausted" ? "st-text" : "text-mute-2")}>
            {timeLeftText(pace)}
            {limits.stale && " · stale"}
          </div>
        </div>
        <span className="sr-only">{describePace(pace)}</span>
      </div>
    </Tooltip>
  );
}
