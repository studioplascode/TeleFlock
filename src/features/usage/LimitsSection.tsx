import { AlertTriangle, Gauge, KeyRound, RefreshCw, TimerReset } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { describePace, formatPct, formatSpan, type HostLimits, projectWindow, refreshLimits, useAccountLimits, useHosts, type WindowPace } from "@/core";
import type { LimitAccount, LimitWindow } from "@/core/gen";
import { Badge, Chip, cn, EmptyState, formatAge, IconButton, Skeleton, spring, Tile, Tooltip, useIsMobile, useNow } from "@/design";
import { PROVIDER_NAMES, paceStatus } from "./limitsUi";

/** One account across the hosts that report it (the same login is often on several hosts). */
interface AccountRow {
  account: LimitAccount;
  hostIds: string[];
}

/** Accounts from every host, newest report per account key, hosts that see it listed. */
function mergeAccounts(byHost: Record<string, HostLimits>): AccountRow[] {
  const rows = new Map<string, AccountRow>();
  for (const [hostId, h] of Object.entries(byHost))
    for (const account of h.data?.accounts ?? []) {
      const prev = rows.get(account.key);
      if (!prev) rows.set(account.key, { account, hostIds: [hostId] });
      else {
        prev.hostIds.push(hostId);
        if ((account.fetchedAt ?? 0) > (prev.account.fetchedAt ?? 0)) prev.account = account;
      }
    }
  return [...rows.values()].sort(
    (a, b) => Number(a.account.windows.length === 0) - Number(b.account.windows.length === 0) || a.account.provider.localeCompare(b.account.provider) || a.account.label.localeCompare(b.account.label),
  );
}

function WindowRow({ w, pace, index }: { w: LimitWindow; pace: WindowPace; index: number }) {
  const status = paceStatus(w, pace);
  const used = Math.min(1, pace.used ?? 0);
  const projected = pace.outcome === "runsOut" ? 1 : pace.outcome === "resetsFirst" ? (pace.atReset ?? used) : used;
  const ratePct = pace.ratePerHour != null ? pace.ratePerHour * 100 : undefined;
  const absolute = w.amount != null && w.limit != null ? `${Math.round(w.amount).toLocaleString()} / ${Math.round(w.limit).toLocaleString()} ${w.unit}` : undefined;
  return (
    <li className="flex flex-col gap-1.5" data-limit={w.id}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate font-bold text-ink">{w.label}</span>
        {w.tier && <Badge>{w.tier} only</Badge>}
        <span className="ml-auto shrink-0 font-display text-base font-bold text-ink tabular">{pace.remaining != null ? `${formatPct(pace.remaining)} left` : "—"}</span>
      </div>
      <Tooltip content={pace.used != null ? `${formatPct(pace.used)} used${projected > used ? ` · striped: projected ${formatPct(projected)} by the reset` : ""}` : "No amount reported"}>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-white/6"
          role="progressbar"
          aria-label={`${w.label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used * 100)}
        >
          {projected > used && (
            <div
              data-status={status}
              className="absolute inset-y-0 rounded-full st-bg opacity-30 [background-image:repeating-linear-gradient(135deg,transparent_0_4px,rgb(0_0_0/0.35)_4px_8px)]"
              style={{ left: 0, width: `${projected * 100}%` }}
            />
          )}
          <motion.div
            data-status={status}
            className="absolute inset-y-0 left-0 rounded-full st-bg"
            initial={{ width: 0 }}
            animate={{ width: `${used * 100}%` }}
            transition={{ ...spring.gentle, delay: index * 0.04 }}
          />
        </div>
      </Tooltip>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] font-semibold text-mute">
        {pace.resetsInMs != null && pace.resetsInMs > 0 && (
          <span className="flex items-center gap-1 tabular">
            <TimerReset className="size-3" /> resets in {formatSpan(pace.resetsInMs)}
          </span>
        )}
        {ratePct != null && ratePct > 0 && (
          <Tooltip content={`Utilization change over the last ${formatSpan(pace.basisMs)} (all agents on this account)`}>
            <span className="tabular">{ratePct < 1 ? ratePct.toFixed(2) : ratePct.toFixed(1)}%/h</span>
          </Tooltip>
        )}
        {absolute && <span className="tabular">{absolute}</span>}
      </div>
      <div data-status={status} className={cn("text-[11.5px] font-bold", pace.outcome === "runsOut" || pace.outcome === "exhausted" ? "st-text" : "text-mute-2")}>
        {describePace(pace)}
      </div>
    </li>
  );
}

function AccountTile({ row, hostNames, now }: { row: AccountRow; hostNames: Record<string, string>; now: number }) {
  const { account } = row;
  const fetchedAt = account.fetchedAt ?? undefined;
  const stale = fetchedAt == null || now - fetchedAt > 15 * 60_000;
  const paces = account.windows.map((w) => projectWindow(w, fetchedAt, now));
  return (
    <Tile className="flex flex-col gap-3 p-5 max-md:p-4" data-account={account.key}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-extrabold tracking-[0.08em] text-mute uppercase">{PROVIDER_NAMES[account.provider] ?? account.provider}</div>
          <div className="truncate text-sm font-extrabold text-ink" title={account.label}>
            {account.label}
          </div>
          {account.org && <div className="truncate text-[11px] font-semibold text-mute-2">{account.org}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {account.plan && <Chip tone="accent">{account.plan}</Chip>}
          {!!account.resetsAvailable && (
            <Tooltip content="Banked limit resets this account can redeem (omp usage reset)">
              <Chip icon={<TimerReset />}>{account.resetsAvailable} reset{account.resetsAvailable === 1 ? "" : "s"}</Chip>
            </Tooltip>
          )}
        </div>
      </div>
      {account.windows.length > 0 ? (
        <ul className="flex flex-col gap-3.5">
          {account.windows.map((w, i) => (
            <WindowRow key={w.id} w={w} pace={paces[i] as WindowPace} index={i} />
          ))}
        </ul>
      ) : (
        <div data-status={account.disabled ? "error" : "needs-you"} className="flex items-start gap-2 rounded-lg st-soft px-3 py-2 text-xs font-semibold">
          {account.disabled ? <KeyRound className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
          <span className="min-w-0 break-words">
            {account.error ?? "No limits reported."}
            {account.disabled && <span className="block text-mute">Log in again in omp (/login) to restore it.</span>}
          </span>
        </div>
      )}
      {account.notes.length > 0 && <p className="text-[11px] text-mute-2">{account.notes.join(" · ")}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[10.5px] font-semibold text-mute-2">
        {fetchedAt != null && (
          <span data-status={stale ? "needs-you" : undefined} className={cn("tabular", stale && "st-text")}>
            {stale ? "stale · " : ""}omp read {formatAge(now - fetchedAt)}
          </span>
        )}
        {row.hostIds.length > 1 || Object.keys(hostNames).length > 1 ? (
          <span>
            {fetchedAt != null && "· "}
            {row.hostIds.map((id) => hostNames[id] ?? id).join(", ")}
          </span>
        ) : null}
      </div>
    </Tile>
  );
}

/**
 * "Subscriptions & limits": every connected account's quota windows, as omp reports them, with a pace
 * projection. Sits beside Today on Usage, so its tiles use one column there and two on wide pages.
 */
export function LimitsSection({ hostIds, className }: { hostIds: string[]; className?: string }) {
  const byHost = useAccountLimits(hostIds);
  const profiles = useHosts((s) => s.profiles);
  const hostNames = Object.fromEntries(profiles.filter((p) => hostIds.includes(p.id)).map((p) => [p.id, p.name]));
  const now = useNow(30_000);
  const mobile = useIsMobile();
  const [spinning, setSpinning] = useState(false);
  const rows = mergeAccounts(byHost);
  const hosts = Object.entries(byHost);
  const loading = hosts.some(([, h]) => h.loading) && rows.length === 0;
  const errors = hosts.filter(([, h]) => h.error || h.data?.error).map(([id, h]) => ({ id, message: h.data?.error ?? h.error ?? "" }));
  const received = Math.max(0, ...hosts.map(([, h]) => h.data?.fetchedAt ?? 0));
  const refresh = () => {
    setSpinning(true);
    void Promise.allSettled(hostIds.map((id) => refreshLimits(id))).finally(() => setSpinning(false));
  };

  const grid = cn("grid gap-3", mobile ? "grid-cols-1 gap-2.5" : "grid-cols-1 @3xl:grid-cols-2");

  return (
    <section aria-label="Subscriptions and limits" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex items-end gap-3">
        <div className="min-w-0">
          <div className="kicker flex items-center gap-1.5">
            <Gauge className="size-3.5" /> Subscriptions & limits
          </div>
          <p className="mt-0.5 text-xs font-semibold text-mute">
            Quota windows of every account omp is logged in to{received > 0 ? ` · checked ${formatAge(now - received)}` : ""}. Pace = how fast each window filled recently, across all agents.
          </p>
        </div>
        <IconButton className="ml-auto" size="sm" label="Refresh limits (ask omp again now)" onClick={refresh}>
          <RefreshCw className={cn(spinning && "animate-spin")} />
        </IconButton>
      </div>
      {errors.map((e) => (
        <div key={e.id} data-status="error" className="flex items-start gap-2 rounded-lg st-soft px-3 py-2 text-xs font-semibold">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            <b>{hostNames[e.id] ?? e.id}:</b> {e.message}
            {byHost[e.id]?.data?.accounts.length ? <span className="text-mute"> (showing the last good snapshot)</span> : null}
          </span>
        </div>
      ))}
      {loading ? (
        <div className={grid}>
          <Skeleton className="min-h-56 rounded-tile" />
          <Skeleton className="min-h-56 rounded-tile" />
        </div>
      ) : rows.length === 0 ? (
        errors.length === 0 && (
          <EmptyState
            title="No subscription limits"
            description="omp reports limits for OAuth subscriptions (Claude, ChatGPT/Codex, Copilot, Gemini, …). Log in with /login in omp; API-key providers have no quota windows."
          />
        )
      ) : (
        <div className={grid}>
          {rows.map((r) => (
            <AccountTile key={r.account.key} row={r} hostNames={hostNames} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
