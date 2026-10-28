import { KeyRound, MoreHorizontal, Plus, RefreshCw, Star, StarOff, TimerReset, Trash2, Users } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { formatPct, formatSpan, projectWindow } from "@/core";
import type { AccountsSnapshot, LimitWindow, LinkedAccount } from "@/core/gen";
import {
  Badge,
  BottomSheet,
  Button,
  Chip,
  cn,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatAge,
  IconButton,
  spring,
  Tile,
  toast,
  Tooltip,
  useIsMobile,
  useMinWidth,
  useNow,
} from "@/design";
import { paceStatus } from "@/features/usage/limitsUi";
import { describeError } from "@/features/workspace/shared/errors";
import { ProviderMark } from "./ProviderMark";
import { linkProviderFor, providerLook } from "./providers";
import { preferAccount, unlinkAccount } from "./store";

export interface AccountActions {
  /** Opens the link sheet on a provider (`Add another`, `Re-link`). */
  link(provider: string): void;
}

/** One compact quota bar: what's left and when it resets. */
function Quota({ w, fetchedAt, now }: { w: LimitWindow; fetchedAt?: number; now: number }) {
  const pace = projectWindow(w, fetchedAt, now);
  const status = paceStatus(w, pace);
  const used = Math.min(1, pace.used ?? 0);
  return (
    <li className="flex min-w-0 flex-col gap-1" data-limit={w.id}>
      <div className="flex items-baseline gap-2 text-[11px] font-bold">
        <span className="min-w-0 truncate text-ink-2">{w.window ?? w.label}</span>
        {w.tier && <span className="font-semibold text-mute-2">{w.tier}</span>}
        <span data-status={status} className={cn("ml-auto shrink-0 tabular", status === "error" || status === "needs-you" ? "st-text" : "text-ink")}>
          {pace.remaining != null ? `${formatPct(pace.remaining)} left` : "—"}
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-white/6"
        role="progressbar"
        aria-label={`${w.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used * 100)}
      >
        <motion.div data-status={status} className="absolute inset-y-0 left-0 rounded-full st-bg" initial={{ width: 0 }} animate={{ width: `${used * 100}%` }} transition={spring.gentle} />
      </div>
      {pace.resetsInMs != null && pace.resetsInMs > 0 && (
        <span className="flex items-center gap-1 text-[10.5px] font-semibold text-mute-2 tabular">
          <TimerReset className="size-3" /> resets in {formatSpan(pace.resetsInMs)}
        </span>
      )}
    </li>
  );
}

function UnlinkConfirm({ account, providerName, host, lastOne, onOpenChange, onConfirm }: { account: LinkedAccount; providerName: string; host: string; lastOne: boolean; onOpenChange(open: boolean): void; onConfirm(): Promise<void> }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const title = `Unlink ${account.label}?`;
  const run = () => {
    setBusy(true);
    void onConfirm().finally(() => setBusy(false));
  };
  const body = (
    <div className="flex flex-col gap-3 text-sm text-mute">
      <p>
        omp on <b className="text-ink-2">{host}</b> stops using this {providerName} {account.kind === "apiKey" ? "key" : "account"} and removes its sign-in there.
      </p>
      {account.sessions > 0 && (
        <p data-status="needs-you" className="rounded-lg st-soft px-3 py-2 text-xs font-semibold">
          {account.sessions} live session{account.sessions === 1 ? " uses" : "s use"} it now.{" "}
          {lastOne ? `They stop working until you link ${providerName} again.` : `Their next request moves to another ${providerName} account.`}
        </p>
      )}
    </div>
  );
  const footer = (
    <div className={cn("flex gap-2", mobile ? "flex-col-reverse" : "justify-end")}>
      <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy} className={cn(mobile && "w-full")}>
        Keep it
      </Button>
      <Button variant="danger" icon={<Trash2 />} loading={busy} onClick={run} className={cn(mobile && "w-full")}>
        Unlink
      </Button>
    </div>
  );
  if (mobile)
    return (
      <BottomSheet open onOpenChange={onOpenChange} title={title} footer={footer}>
        {body}
      </BottomSheet>
    );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={title} width={460} footer={footer} icon={<Trash2 />}>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account, providerName, host, hostId, lastOne, single, broker, actions, now }: {
  account: LinkedAccount;
  providerName: string;
  host: string;
  hostId: string;
  lastOne: boolean;
  /** The provider's only active sign-in: preferring it changes nothing (unless it already is). */
  single: boolean;
  broker: boolean;
  actions: AccountActions & { linkProvider?: string };
  now: number;
}) {
  const mobile = useIsMobile();
  const [confirm, setConfirm] = useState(false);
  const [preferring, setPreferring] = useState(false);
  const key = account.kind === "apiKey";
  const canUnlink = account.credentialId != null && !account.disabled && !broker;
  const canPrefer = !key && !account.disabled && (account.preferred || !single);
  const prefer = (preferred: boolean) => {
    setPreferring(true);
    preferAccount(hostId, account, preferred).then(
      () => toast({ title: preferred ? `omp tries ${account.label} first` : `${account.label} is no longer preferred`, description: preferred ? `For new ${providerName} sessions on ${host}.` : undefined, status: "done", duration: 2600 }),
      (e: unknown) => {
        const d = describeError(e);
        toast({ title: "Couldn't change the preferred account", description: d.hint ?? d.title, status: "error" });
      },
    ).finally(() => setPreferring(false));
  };
  const unlink = () =>
    unlinkAccount(hostId, account).then(
      () => {
        setConfirm(false);
        toast({ title: `Unlinked ${account.label}`, description: `omp on ${host} no longer uses it.`, status: "done" });
      },
      (e: unknown) => {
        const d = describeError(e);
        toast({ title: `Couldn't unlink ${account.label}`, description: d.hint ?? d.title, status: "error" });
      },
    );
  const meta: ReactNode[] = [];
  if (account.org) meta.push(<span className="min-w-0 truncate">{account.org}</span>);
  if (account.sessions > 0)
    meta.push(
      <span className="flex items-center gap-1 text-ink-2">
        <Users className="size-3" />
        {account.sessions} live session{account.sessions === 1 ? "" : "s"}
      </span>,
    );
  if (account.linkedAt) meta.push(<span>{key ? "added" : "linked"} {formatAge(now - account.linkedAt)}</span>);
  const windows = account.windows.slice(0, mobile ? 2 : 3);
  return (
    <li className={cn("flex flex-col gap-3 px-5 py-4 max-md:px-4", account.disabled && "bg-error/[0.035]")} data-account={account.key}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("min-w-0 truncate text-sm font-extrabold", account.disabled ? "text-ink-2" : "text-ink")} title={account.label}>
              {account.label}
            </span>
            {account.preferred && (
              <Chip tone="accent" icon={<Star className="fill-current" />}>
                Preferred
              </Chip>
            )}
            {account.plan && <Badge tone="accent">{account.plan}</Badge>}
            {key && <Badge>API key</Badge>}
            {account.disabled && <Badge tone="error">Expired</Badge>}
          </div>
          {meta.length > 0 && (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11.5px] font-semibold text-mute">
              {meta.map((m, i) => (
                <span key={i} className="flex min-w-0 items-center gap-2">
                  {i > 0 && <span aria-hidden className="text-mute-2">·</span>}
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
        {canPrefer && (
          <Tooltip content={account.preferred ? "Stop preferring it (omp picks by remaining quota)" : (account.preferBlocked ?? "Prefer for new sessions: omp tries it first")}>
            <span>
              <IconButton
                size="sm"
                label={account.preferred ? "Stop preferring" : "Prefer for new sessions"}
                onClick={() => prefer(!account.preferred)}
                disabled={preferring || (!account.preferred && !!account.preferBlocked)}
                className={cn(account.preferred && "text-accent-hi")}
              >
                <Star className={cn(account.preferred && "fill-current")} />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {(canUnlink || canPrefer) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={`More for ${account.label}`}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{account.label}</DropdownMenuLabel>
              {canPrefer &&
                (account.preferred ? (
                  <DropdownMenuItem icon={<StarOff />} onSelect={() => prefer(false)}>
                    Stop preferring
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem icon={<Star />} disabled={!!account.preferBlocked} onSelect={() => prefer(true)}>
                    Prefer for new sessions
                  </DropdownMenuItem>
                ))}
              {canUnlink && (
                <>
                  {canPrefer && <DropdownMenuSeparator />}
                  <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => setConfirm(true)}>
                    Unlink…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {account.disabled ? (
        <div data-status="error" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg st-soft px-3 py-2 text-xs font-semibold">
          <KeyRound className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            omp stopped using this login{account.disabledReason ? `: ${account.disabledReason}` : "."}
            <span className="block font-medium text-mute">Sign in to it again to bring it back.</span>
          </span>
          {actions.linkProvider && (
            <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => actions.link(actions.linkProvider as string)} className={cn(mobile && "w-full")}>
              Re-link
            </Button>
          )}
        </div>
      ) : windows.length > 0 ? (
        <ul className={cn("grid gap-y-3", mobile ? "grid-cols-2 gap-x-4" : windows.length === 1 ? "grid-cols-1 gap-x-5 sm:max-w-xs" : "grid-cols-2 gap-x-5 lg:grid-cols-3")}>
          {windows.map((w) => (
            <Quota key={w.id} w={w} fetchedAt={account.windowsAt} now={now} />
          ))}
        </ul>
      ) : !key && account.windowsError ? (
        <p className="text-[11px] font-semibold text-mute-2">{account.windowsError}</p>
      ) : null}
      {confirm && <UnlinkConfirm account={account} providerName={providerName} host={host} lastOne={lastOne} onOpenChange={setConfirm} onConfirm={unlink} />}
    </li>
  );
}

/** Linked accounts and keys grouped by provider, in omp's provider order. */
export function AccountGroups({ hostId, host, snapshot, actions }: { hostId: string; host: string; snapshot: AccountsSnapshot; actions: AccountActions }) {
  const now = useNow(30_000);
  const mobile = useIsMobile();
  const groups: { provider: string; accounts: LinkedAccount[] }[] = [];
  for (const a of snapshot.accounts) {
    const g = groups.find((x) => x.provider === a.provider);
    if (g) g.accounts.push(a);
    else groups.push({ provider: a.provider, accounts: [a] });
  }
  const ref = useRef<HTMLDivElement>(null);
  const wide = useMinWidth(ref, 900) && !mobile;
  const tiles = groups.map((g, gi) => {
    const omp = snapshot.providers.find((p) => p.id === g.provider);
    const name = providerLook(g.provider, omp?.name).name;
    const linkProvider = linkProviderFor(g.provider, snapshot.providers);
    const active = g.accounts.filter((a) => !a.disabled).length;
    const oauthActive = g.accounts.filter((a) => !a.disabled && a.kind === "oauth").length;
    return (
      <motion.div key={g.provider} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: gi * 0.04 }} className="min-w-0">
        <Tile className="overflow-hidden p-0" data-provider={g.provider}>
          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5 max-md:px-4">
            <ProviderMark id={g.provider} ompName={omp?.name} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-md font-bold text-ink">{name}</div>
              {omp && omp.name !== name && <div className="truncate text-[11px] font-semibold text-mute-2">{omp.name}</div>}
            </div>
            {linkProvider && (
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => actions.link(linkProvider)} aria-label={`Link another ${name} account`}>
                <span className={cn(mobile && "sr-only")}>Add another</span>
              </Button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {g.accounts.map((a) => (
              <AccountRow
                key={a.key}
                account={a}
                providerName={name}
                host={host}
                hostId={hostId}
                lastOne={active <= 1}
                single={oauthActive <= 1}
                broker={!!snapshot.broker}
                actions={{ ...actions, linkProvider }}
                now={now}
              />
            ))}
          </ul>
        </Tile>
      </motion.div>
    );
  });
  if (!wide)
    return (
      <div ref={ref} className="flex flex-col gap-3">
        {tiles}
      </div>
    );
  // Two columns, each tile into the shorter one (omp's provider order reads left to right, top down).
  const left = { h: 0, items: [] as ReactNode[] };
  const right = { h: 0, items: [] as ReactNode[] };
  groups.forEach((g, i) => {
    const col = left.h <= right.h ? left : right;
    col.h += 1.2 + g.accounts.reduce((n, a) => n + 1 + (a.windows.length > 0 || a.disabled ? 1 : 0), 0);
    col.items.push(tiles[i]);
  });
  return (
    <div ref={ref} className="grid grid-cols-2 items-start gap-3">
      <div className="flex min-w-0 flex-col gap-3">{left.items}</div>
      <div className="flex min-w-0 flex-col gap-3">{right.items}</div>
    </div>
  );
}
