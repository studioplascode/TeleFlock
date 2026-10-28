import { CircleAlert, KeyRound, Plus, RefreshCw, Server, ShieldAlert, Star } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { core, navigate, useHostIds, useHosts } from "@/core";
import type { AccountsSnapshot, AuthFlow } from "@/core/gen";
import { Button, cn, EmptyState, IconButton, PageHeader, Select, Skeleton, spring, Spinner, Tile, useIsMobile } from "@/design";
import { isFinalFlow } from "@/features/auth";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { OmpAreaNav } from "@/features/shell/OmpArea";
import { AccountGroups } from "./AccountGroups";
import { LinkAccountSheet } from "./LinkAccountSheet";
import { ProviderMark } from "./ProviderMark";
import { pickerSections, providerLook } from "./providers";
import { loadAccounts, useHostAccounts } from "./store";

/** The host the page showed last (device-local). */
const useLastHost = create<{ hostId?: string; set: (hostId: string) => void }>()(
  persist((set) => ({ set: (hostId) => set({ hostId }) }), { name: "tf.accounts", partialize: ({ hostId }) => ({ hostId }) }),
);

/** Route host, else the last one shown, else the first online host, else the first host. */
function useHostChoice(routeHost: string | undefined): { hostId?: string; options: { value: string; label: string; hint?: string }[] } {
  const ids = useHostIds();
  const { profiles, status } = useHosts();
  const last = useLastHost((s) => s.hostId);
  const online = ids.filter((id) => status[id]?.phase === "online");
  const hostId = routeHost ?? (last && ids.includes(last) ? last : (online[0] ?? ids[0]));
  const options = ids.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id, hint: status[id]?.phase === "online" ? undefined : "offline" }));
  return { hostId, options };
}

function Banner({ tone, icon, children, action }: { tone: "warn" | "info" | "accent"; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  const mobile = useIsMobile();
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-lg px-4 py-2.5 text-xs font-semibold [&>svg]:size-4 [&>svg]:shrink-0",
        tone === "warn" && "bg-warn/10 text-warn",
        tone === "info" && "bg-white/[0.03] text-mute shadow-[inset_0_0_0_1px_var(--color-line-2)]",
        tone === "accent" && "bg-accent/8 text-ink-2 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]",
        mobile && "flex-wrap",
      )}
    >
      {icon}
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action && <div className={cn("flex shrink-0 items-center gap-1.5", mobile && "w-full")}>{action}</div>}
    </div>
  );
}

/** No account yet: one line on why it matters, the popular subscriptions one tap away. */
function FirstAccount({ host, snapshot, onLink }: { host: string; snapshot: AccountsSnapshot; onLink(provider?: string): void }) {
  const picks = pickerSections(snapshot.providers).popular.slice(0, 4);
  return (
    <Tile className="relative overflow-hidden px-6 py-10 max-md:px-4 max-md:py-8">
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[36rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(163_92_240/0.22),transparent)]" />
      <div className="relative mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
        <div className="grid size-14 place-items-center rounded-lg bg-omp text-white shadow-glow-accent [&_svg]:size-6">
          <KeyRound />
        </div>
        <div>
          <h2 className="font-display text-2xl font-bold text-ink max-md:text-xl">Link your first account</h2>
          <p className="mt-1.5 text-sm text-mute">omp needs a subscription or an API key on {host} before any agent can run.</p>
        </div>
        {picks.length > 0 && (
          <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
            {picks.map((e, i) => {
              const look = providerLook(e.provider.id, e.provider.name);
              return (
                <motion.button
                  key={e.provider.id}
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...spring.smooth, delay: 0.08 + i * 0.04 }}
                  onClick={() => onLink(e.provider.id)}
                  className="flex flex-col items-center gap-2 rounded-lg bg-white/[0.035] px-2 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line)] transition-[background-color,box-shadow] hover:bg-white/[0.07] hover:shadow-[inset_0_0_0_1px_var(--color-line-3)] focus-ring pressable"
                  aria-label={`Link ${look.name}`}
                >
                  <ProviderMark id={e.provider.id} ompName={e.provider.name} size={40} />
                  <span className="text-xs font-extrabold text-ink">{look.name}</span>
                </motion.button>
              );
            })}
          </div>
        )}
        <Button variant={picks.length > 0 ? "secondary" : "primary"} icon={<Plus />} onClick={() => onLink()}>
          {picks.length > 0 ? `All ${snapshot.providers.length} providers` : "Link account"}
        </Button>
      </div>
    </Tile>
  );
}

interface SheetState {
  /** Remounts the sheet per open (fresh picker, fresh sign-in). */
  n: number;
  open: boolean;
  provider?: string;
  flowId?: string;
}

/**
 * The accounts omp signs in with on one host (architecture §3.14): linked subscriptions per
 * provider with plan, quota windows, live sessions, the preferred one, expired logins to re-link,
 * API keys; Link account (the shared remote sign-in), unlink, prefer. `link` (route) opens the
 * link sheet once: on a provider, or on the picker when empty.
 */
export function AccountsView({ hostId: routeHost, link }: { hostId?: string; link?: string }) {
  const mobile = useIsMobile();
  const { hostId, options } = useHostChoice(routeHost);
  const setLast = useLastHost((s) => s.set);
  const online = useHosts((s) => (hostId ? s.status[hostId]?.phase === "online" : false));
  const host = options.find((o) => o.value === hostId)?.label ?? hostId ?? "this host";
  const { snapshot, error, loading, reload } = useHostAccounts(online ? hostId : undefined);
  const [sheet, setSheet] = useState<SheetState>({ n: 0, open: false });
  const [spinning, setSpinning] = useState(false);

  const openLink = (provider?: string, flowId?: string) => setSheet((s) => ({ n: s.n + 1, open: true, provider, flowId }));
  // A deep link (`#/accounts/<host>/link[/<provider>]`, Re-link buttons, nudges) opens the sheet once.
  useEffect(() => {
    if (link === undefined || !hostId) return;
    setSheet((s) => ({ n: s.n + 1, open: true, provider: link || undefined }));
    navigate({ name: "accounts", hostId }, { replace: true });
  }, [link, hostId]);
  useEffect(() => {
    if (hostId) setLast(hostId);
  }, [hostId, setLast]);

  const closeSheet = (open: boolean) => {
    if (open) return;
    setSheet((s) => ({ ...s, open: false }));
    // Its sign-in was cancelled or finished: the running-link banner must not offer it again.
    if (hostId) void loadAccounts(hostId);
  };
  const pickHost = (id: string) => {
    setLast(id);
    setSheet((s) => ({ ...s, open: false }));
    navigate({ name: "accounts", hostId: id }, { replace: true });
  };
  const refresh = () => {
    setSpinning(true);
    if (hostId) void loadAccounts(hostId, true).finally(() => setSpinning(false));
  };

  const running: AuthFlow[] = sheet.open ? [] : (snapshot?.flows ?? []).filter((f) => f.kind === "account" && !isFinalFlow(f));
  const linked: Record<string, number> = {};
  for (const a of snapshot?.accounts ?? []) if (!a.disabled) linked[a.provider] = (linked[a.provider] ?? 0) + 1;
  const active = (snapshot?.accounts ?? []).filter((a) => !a.disabled);
  const keys = active.filter((a) => a.kind === "apiKey").length;

  const hostPicker = options.length > 1 && hostId && (
    <Select aria-label="Host" className={cn("h-10", mobile ? "w-full" : "w-52")} value={hostId} onValueChange={pickHost} options={options} />
  );
  const refreshButton = snapshot && (
    <IconButton label="Read omp's accounts and limits again" onClick={refresh} disabled={spinning}>
      <RefreshCw className={cn((spinning || loading) && "animate-spin tf-keep")} />
    </IconButton>
  );
  const linkButton = snapshot && snapshot.accounts.length > 0 && (
    <Button variant="primary" icon={<Plus />} onClick={() => openLink()} className={cn(mobile && "w-full")}>
      Link account
    </Button>
  );

  let body: ReactNode;
  if (!hostId) {
    body = <EmptyState icon={<Server />} title="No hosts yet" description="Add a host to link the accounts omp runs your agents with there." className="mt-8" />;
  } else if (!online) {
    body = (
      <EmptyState
        icon={<Server />}
        title="Host offline"
        description="omp's accounts are read from the host. Connect it first."
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Open Hosts
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (error && !snapshot) {
    const old = error.code === "unknown_method";
    body = (
      <EmptyState
        icon={<CircleAlert />}
        title={old ? "This host needs a newer tf-hostd" : "Couldn't read omp's accounts"}
        description={old ? "Its TeleFlock host daemon predates accounts. Reconnect the host to deploy the bundled tf-hostd, then come back." : [error.message, error.hint].filter(Boolean).join(" — ")}
        action={
          <Button variant="secondary" icon={<RefreshCw />} onClick={() => reload()}>
            Try again
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (!snapshot) {
    body = (
      <div className={cn("grid gap-3", mobile ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-2")} aria-busy>
        <Skeleton className="h-44 rounded-tile" />
        <Skeleton className="h-44 rounded-tile" />
        <Skeleton className="h-32 rounded-tile" />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {running.map((f) => (
          <Banner
            key={f.flowId}
            tone="accent"
            icon={<Spinner size={16} label="Signing in" />}
            action={
              <>
                <Button size="sm" variant="primary" onClick={() => openLink(f.subject, f.flowId)} className={cn(mobile && "flex-1")}>
                  Continue
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void core.host(hostId).call("auth.cancel", { flowId: f.flowId }).finally(() => void loadAccounts(hostId))}
                  className={cn(mobile && "flex-1")}
                >
                  Cancel
                </Button>
              </>
            }
          >
            Linking <b className="text-ink">{providerLook(f.subject ?? "", f.title).name}</b> is still in progress on {host}.
          </Banner>
        ))}
        {snapshot.broker && (
          <Banner tone="info" icon={<ShieldAlert />}>
            omp on {host} keeps its credentials in an auth broker (<span className="font-mono">{snapshot.broker}</span>). Linking works from here; unlinking and preferences are managed on the broker host.
          </Banner>
        )}
        {snapshot.error && (
          <Banner tone="warn" icon={<CircleAlert />}>
            Some details may be missing: {snapshot.error}
          </Banner>
        )}
        {snapshot.accounts.length === 0 ? (
          <FirstAccount host={host} snapshot={snapshot} onLink={(p) => openLink(p)} />
        ) : (
          <>
            <AccountGroups hostId={hostId} host={host} snapshot={snapshot} actions={{ link: (p) => openLink(p) }} />
            <p className="flex items-start gap-2 px-1 text-[11.5px] text-mute-2">
              <Star className="mt-0.5 size-3 shrink-0" />
              omp spreads a provider's sessions over its accounts by the quota they have left; the preferred one is tried first for new sessions. API keys are used in the order
              they were added.
            </p>
          </>
        )}
      </div>
    );
  }

  const meta = active.length > 0 && (
    <span className="font-mono text-2xs font-semibold text-mute-2">
      {active.length - keys} account{active.length - keys === 1 ? "" : "s"}
      {keys > 0 ? ` · ${keys} key${keys === 1 ? "" : "s"}` : ""}
    </span>
  );
  const sheetEl = hostId && snapshot && (
    <LinkAccountSheet
      key={sheet.n}
      hostId={hostId}
      host={host}
      open={sheet.open}
      onOpenChange={closeSheet}
      providers={snapshot.providers}
      linked={linked}
      provider={sheet.provider}
      flowId={sheet.flowId}
    />
  );

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Accounts" subtitle={host} back actions={refreshButton} />
        <div className="flex flex-col gap-3 px-3 pt-1 pb-6">
          <OmpAreaNav current="accounts" hostId={hostId} />
          {hostPicker}
          {linkButton}
          {body}
        </div>
        {sheetEl}
      </div>
    );
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-8 pt-7 pb-12">
      <OmpAreaNav current="accounts" hostId={hostId} className="-mb-2" />
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="size-3" /> {host}
          </span>
        }
        title="Accounts"
        meta={meta}
        description="The subscriptions and API keys omp signs in with on this host. Every agent's model calls run on them."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hostPicker}
            {refreshButton}
            {linkButton}
          </div>
        }
      />
      {body}
      {sheetEl}
    </div>
  );
}
