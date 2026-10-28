import { ArrowLeft, Check, ChevronRight, KeyRound, Search, Smartphone, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { core } from "@/core";
import type { AuthFlow, LoginProvider } from "@/core/gen";
import { BottomSheet, Button, Dialog, DialogContent, IconButton, Input, spring, useIsMobile } from "@/design";
import { RemoteAuthPanel, useRemoteAuth } from "@/features/auth";
import { ProviderMark } from "./ProviderMark";
import { matchesProvider, type PickerEntry, pickerSections, providerDetail, providerLook } from "./providers";
import { accountLinked } from "./store";

export interface LinkAccountSheetProps {
  hostId: string;
  /** Host display name. */
  host: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Everything `omp login` offers on the host, in omp's order. */
  providers: LoginProvider[];
  /** Active accounts per stored provider id (marks providers already linked). */
  linked: Record<string, number>;
  /** Start on this provider instead of the picker (Re-link, deep link). */
  provider?: string;
  /** Follow this running link instead of starting one (it was started earlier). */
  flowId?: string;
}

function PopularTile({ entry, linked, onPick, index }: { entry: PickerEntry; linked: number; onPick(id: string): void; index: number }) {
  const p = entry.provider;
  const look = providerLook(p.id, p.name);
  const detail = look.blurb ?? providerDetail(p);
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.smooth, delay: index * 0.025 }}
      onClick={() => onPick(p.id)}
      className="group relative flex min-w-0 items-center gap-3 rounded-lg bg-white/[0.03] p-3 text-left shadow-[inset_0_0_0_1px_var(--color-line)] transition-[background-color,box-shadow] hover:bg-white/[0.06] hover:shadow-[inset_0_0_0_1px_var(--color-line-3)] focus-ring pressable"
      aria-label={`Link ${look.name}`}
    >
      <ProviderMark id={p.id} ompName={p.name} size={38} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-extrabold text-ink">{look.name}</span>
        {detail && <span className="block truncate text-[11px] font-semibold text-mute">{detail}</span>}
      </span>
      {linked > 0 && (
        <span className="absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-done/20 text-done" title={`${linked} linked`}>
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      )}
    </motion.button>
  );
}

function ProviderRow({ entry, linked, onPick }: { entry: PickerEntry; linked: number; onPick(id: string): void }) {
  const p = entry.provider;
  const look = providerLook(p.id, p.name);
  const detail = providerDetail(p);
  return (
    <li>
      <button type="button" onClick={() => onPick(p.id)} className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.05] focus-ring max-md:py-2.5">
        <ProviderMark id={p.id} ompName={p.name} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-ink">{look.name}</span>
          {detail && <span className="block truncate text-[11px] font-medium text-mute-2">{detail}</span>}
        </span>
        {linked > 0 && <span className="shrink-0 text-[11px] font-bold text-done">{linked} linked</span>}
        <ChevronRight className="size-4 shrink-0 text-mute-2" />
      </button>
    </li>
  );
}

function Picker({ providers, linked, onPick }: { providers: LoginProvider[]; linked: Record<string, number>; onPick(id: string): void }) {
  const mobile = useIsMobile();
  const [q, setQ] = useState("");
  const { popular, rest } = useMemo(() => pickerSections(providers), [providers]);
  const count = (id: string) => linked[id] ?? linked[id.replace(/-device$/, "")] ?? 0;
  const query = q.trim();
  const hits = query ? [...popular, ...rest].filter((e) => matchesProvider(e.provider, query) || (e.alternate ? matchesProvider(e.alternate, query) : false)) : [];
  return (
    <div className="flex flex-col gap-4">
      <Input
        autoFocus={!mobile}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${providers.length} providers`}
        aria-label="Search providers"
        leading={<Search />}
        trailing={
          q ? (
            <IconButton size="sm" label="Clear search" onClick={() => setQ("")}>
              <X />
            </IconButton>
          ) : undefined
        }
      />
      {query ? (
        hits.length > 0 ? (
          <ul className="-mx-2 flex flex-col">
            {hits.map((e) => (
              <ProviderRow key={e.provider.id} entry={e} linked={count(e.provider.id)} onPick={onPick} />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-mute">omp offers no sign-in matching “{query}”.</p>
        )
      ) : (
        <>
          {popular.length > 0 && (
            <section aria-label="Subscriptions" className="flex flex-col gap-2">
              <h3 className="kicker">Subscriptions</h3>
              <div className="grid grid-cols-2 gap-2">
                {popular.map((e, i) => (
                  <PopularTile key={e.provider.id} entry={e} linked={count(e.provider.id)} onPick={onPick} index={i} />
                ))}
              </div>
            </section>
          )}
          {rest.length > 0 && (
            <section aria-label="More providers" className="flex flex-col gap-1">
              <h3 className="kicker">More providers and API keys</h3>
              <ul className="-mx-2 flex flex-col">
                {rest.map((e) => (
                  <ProviderRow key={e.provider.id} entry={e} linked={count(e.provider.id)} onPick={onPick} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One link of one provider: mounting starts it, unmounting cancels it. */
function LinkFlow({
  hostId,
  provider,
  flowId,
  alternate,
  back,
  onSwitch,
  onClose,
  onAnother,
}: {
  hostId: string;
  provider: LoginProvider;
  flowId?: string;
  alternate?: LoginProvider;
  /** Leaves this sign-in (cancelling it) for the picker or the provider's browser sign-in. */
  back?: { label: string; go(): void };
  onSwitch(id: string): void;
  onClose(): void;
  onAnother(): void;
}) {
  const name = providerLook(provider.id, provider.name).name;
  const auth = useRemoteAuth({
    hostId,
    flowId,
    start: () => core.host(hostId).call("accounts.link", { provider: provider.id }) as Promise<AuthFlow>,
    autoOpen: true,
    onDone: () => accountLinked(hostId),
  });
  const offerCode = alternate && (auth.stage === "browser" || auth.stage === "paste");
  return (
    <div className="flex flex-col gap-4">
      {back && auth.stage !== "done" && (
        <button type="button" onClick={back.go} className="-mt-1 flex items-center gap-1.5 self-start rounded-sm text-xs font-bold text-mute hover:text-ink focus-ring">
          <ArrowLeft className="size-3.5" />
          {back.label}
        </button>
      )}
      <RemoteAuthPanel
        auth={auth}
        name={name}
        icon={<ProviderMark id={provider.id} ompName={provider.name} size={26} />}
        onClose={onClose}
        aside={
          offerCode && (
            <button
              type="button"
              onClick={() => onSwitch(alternate.id)}
              className="flex items-center gap-2 self-start rounded-sm text-xs font-bold text-accent-hi hover:underline focus-ring"
            >
              <Smartphone className="size-3.5" />
              Signing in on another device? Use a code instead
            </button>
          )
        }
      />
      {auth.stage === "done" && (
        <Button variant="ghost" size="sm" onClick={onAnother} className="-mt-2 self-center">
          Link another account
        </Button>
      )}
    </div>
  );
}

/**
 * Link account: pick a provider (popular subscriptions first, everything `omp login` offers
 * searchable), sign in with the shared remote-auth panel, success. A dialog on desktop, a bottom
 * sheet on phones. Closing it cancels a sign-in still running.
 */
export function LinkAccountSheet({ hostId, host, open, onOpenChange, providers, linked, provider, flowId }: LinkAccountSheetProps) {
  const mobile = useIsMobile();
  const [picked, setPicked] = useState<string | undefined>(provider);
  const [attach, setAttach] = useState<string | undefined>(flowId);
  const [attempt, setAttempt] = useState(0);
  const chosen = picked ? providers.find((p) => p.id === picked) : undefined;
  const alternate = chosen ? providers.find((p) => p.id === `${chosen.id}-device`) : undefined;
  const base = chosen?.id.endsWith("-device") ? providers.find((p) => `${p.id}-device` === chosen.id) : undefined;
  const look = chosen ? providerLook(chosen.id, chosen.name) : undefined;
  const pick = (id: string | undefined) => {
    setAttach(undefined);
    setAttempt((n) => n + 1);
    setPicked(id);
  };

  const title: ReactNode = chosen && look ? `Link ${look.name}` : "Link an account";
  const description = chosen
    ? chosen.id.endsWith("-device")
      ? `${chosen.name}: sign in with a code, from any device.`
      : chosen.name
    : `Sign in to a subscription or add an API key. omp on ${host} runs your agents' model calls on it.`;

  const body = chosen ? (
    <LinkFlow
      key={`${chosen.id}:${attempt}`}
      hostId={hostId}
      provider={chosen}
      flowId={attach}
      alternate={alternate}
      back={provider === chosen.id ? undefined : { label: base ? "Back to the browser sign-in" : "All providers", go: () => pick(base?.id) }}
      onSwitch={(id) => pick(id)}
      onClose={() => onOpenChange(false)}
      onAnother={() => pick(undefined)}
    />
  ) : providers.length > 0 ? (
    <Picker providers={providers} linked={linked} onPick={(id) => pick(id)} />
  ) : (
    <p className="py-8 text-center text-sm text-mute">omp on {host} offers no sign-ins (is omp installed?).</p>
  );

  if (mobile)
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title={title} description={description} maxHeight="92dvh" autoFocus={false}>
        {body}
      </BottomSheet>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} width={600} icon={<KeyRound />}>
        {body}
      </DialogContent>
    </Dialog>
  );
}
