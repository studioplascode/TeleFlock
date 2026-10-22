import { type HostLimits, describePace, formatPct, formatSpan, tightestWindow, type WindowPace } from "@/core";
import type { LimitWindow } from "@/core/gen";
import { PROVIDER_NAMES } from "@/features/usage/limitsUi";

export interface LimitHeadline {
  /** "Claude 5h · 43% left · resets 2h 45m" (account named when several report limits). */
  text: string;
  /** describePace's verdict. */
  pace: string;
  tone: "error" | "warn" | "mute";
}

/** "5 Hour" → "5h", "7 days" → "7d", "30 min" → "30m"; anything else as reported. */
export function shortWindow(w: Pick<LimitWindow, "window" | "label">): string {
  const m = (w.window ?? "").match(/^(\d+)\s*(min|hour|day|week|month)/i);
  if (!m) return w.window ?? w.label;
  const unit = (m[2] ?? "").toLowerCase();
  return `${m[1]}${unit === "min" ? "m" : unit === "month" ? "mo" : unit[0]}`;
}

const OUTCOME_RANK: Record<WindowPace["outcome"], number> = { exhausted: 0, runsOut: 1, resetsFirst: 2, idle: 2, unknown: 2, reset: 3 };

interface AccountTightest {
  label: string;
  provider: string;
  best: { window: LimitWindow; pace: WindowPace };
}

/**
 * The subscription window that binds first across every account the hosts report (accounts shared by
 * several hosts count once; disabled credentials are skipped): exhausted, then soonest run-out, then
 * least remaining. Null when no account reports an amount.
 */
export function limitHeadline(byHost: Record<string, HostLimits>, now: number): LimitHeadline | null {
  const accounts = new Map<string, AccountTightest>();
  for (const h of Object.values(byHost))
    for (const a of h.data?.accounts ?? []) {
      if (accounts.has(a.key) || a.disabled) continue;
      const best = tightestWindow(a.windows, a.fetchedAt ?? h.data?.fetchedAt, now);
      if (best) accounts.set(a.key, { label: a.label, provider: a.provider, best });
    }
  let top: AccountTightest | undefined;
  for (const c of accounts.values()) {
    if (!top) {
      top = c;
      continue;
    }
    const a = OUTCOME_RANK[c.best.pace.outcome];
    const b = OUTCOME_RANK[top.best.pace.outcome];
    const tighter =
      a !== b ? a < b : c.best.pace.outcome === "runsOut" ? (c.best.pace.etaMs ?? Infinity) < (top.best.pace.etaMs ?? Infinity) : (c.best.pace.remaining ?? 1) < (top.best.pace.remaining ?? 1);
    if (tighter) top = c;
  }
  if (!top) return null;
  const { window: w, pace } = top.best;
  const provider = PROVIDER_NAMES[top.provider] ?? top.provider;
  const parts = [
    `${provider} ${shortWindow(w)}${w.tier ? ` ${w.tier}` : ""}${accounts.size > 1 ? ` (${top.label})` : ""}`,
    pace.remaining !== undefined ? `${formatPct(pace.remaining)} left` : undefined,
    pace.resetsInMs !== undefined && pace.resetsInMs > 0 ? `resets ${formatSpan(pace.resetsInMs)}` : undefined,
  ];
  return {
    text: parts.filter(Boolean).join(" · "),
    pace: describePace(pace),
    tone: pace.outcome === "exhausted" || w.status === "exhausted" ? "error" : pace.outcome === "runsOut" || w.status === "warning" ? "warn" : "mute",
  };
}
