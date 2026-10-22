import { Gauge } from "lucide-react";
import type { ReactNode } from "react";
import { describePace, formatPct, formatSpan, parseAgentKey, type SessionLimits, sessionLimits, tightestWindow, useAccountLimits, useAgent, type WindowPace } from "@/core";
import type { LimitWindow } from "@/core/gen";
import { cn, formatAge, type Status, Tooltip, useNow } from "@/design";
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

/** Short time-left phrase for the meter / header chip. */
export function timeLeftText(pace: WindowPace): string {
  switch (pace.outcome) {
    case "runsOut":
      return `runs out in ~${formatSpan(pace.etaMs ?? 0)} at this pace`;
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

/**
 * One labelled bar of the inspector's "can it keep going" row. The reading always carries its
 * direction ("61% used", "41% left"); the fill is neutral until `status` turns it warm.
 */
export function Meter({ term, reading, fill, status, detail, label }: { term: ReactNode; reading: ReactNode; fill: number; status?: Status; detail?: ReactNode; label: string }) {
  return (
    <div data-status={status} className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-[10.5px] font-bold text-mute">
        <span className="truncate">{term}</span>
        <span className="shrink-0 font-display text-[15px] font-bold tracking-[-0.02em] whitespace-nowrap text-ink tabular">{reading}</span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-white/8" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill)} aria-label={label}>
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out", status ? "st-fill" : "bg-ink-2/60")}
          style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
        />
      </div>
      {detail && <div className="mt-1 text-[10.5px] leading-snug font-semibold text-mute-2 tabular">{detail}</div>}
    </div>
  );
}

/** "limit 41% left": the session account's tightest window, as a bar of what is left, plus time left at the current pace. */
export function LimitsMeter({ agentKey, tps }: { agentKey: string; tps?: number }) {
  const v = useSessionLimits(agentKey);
  const { limits, tight } = v;
  if (!limits || !tight) {
    if (v.unpinned < 2) return null;
    return (
      <div className="min-w-0 flex-1 text-[10.5px] font-semibold text-mute-2">
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
      <div data-limits-tile tabIndex={0} className="focus-ring min-w-0 flex-1 rounded-sm">
        <Meter
          term="limit"
          reading={`${formatPct(remaining)} left`}
          fill={remaining * 100}
          status={status === "needs-you" || status === "error" ? status : undefined}
          label={`${formatPct(remaining)} of ${window.label} left`}
          detail={
            <>
              <span className={cn("block", (pace.outcome === "runsOut" || pace.outcome === "exhausted") && "text-ink-2")}>
                {timeLeftText(pace)}
                {limits.stale && " · stale"}
              </span>
              <span className="block truncate">{window.label}</span>
            </>
          }
        />
        <span className="sr-only">{describePace(pace)}</span>
      </div>
    </Tooltip>
  );
}
