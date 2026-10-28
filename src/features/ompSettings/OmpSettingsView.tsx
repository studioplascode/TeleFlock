import { CircleAlert, RefreshCw, Search, Server, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { navigate, useHostIds, useHosts, useHostState } from "@/core";
import type { OmpSetting } from "@/core/gen";
import { Button, cn, EmptyState, IconButton, Input, PageHeader, Select, Skeleton, Tile, useIsMobile } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { OmpAreaFrame } from "@/features/shell/OmpArea";
import { VIEWS } from "@/features/shell/vocab";
import { type RowContext, SettingRow } from "./controls";
import { buildTabs, MODEL_ROLES_KEY, matchesQuery, OMP_TABS, OTHER_TAB, type SettingTab } from "./model";
import { useOmpSettings } from "./useOmpSettings";

/** The host the page showed last (device-local). */
const useLastHost = create<{ hostId?: string; set: (hostId: string) => void }>()(
  persist((set) => ({ set: (hostId) => set({ hostId }) }), { name: "tf.ompSettings", partialize: ({ hostId }) => ({ hostId }) }),
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

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Tile className="px-5 py-3 max-md:px-3.5 max-md:py-2">
      {title && <h3 className="kicker pt-2 pb-1">{title}</h3>}
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </Tile>
  );
}

function TabButton({ tab, active, onClick, compact }: { tab: SettingTab; active: boolean; onClick: () => void; compact: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md text-sm font-semibold transition-colors focus-ring",
        compact ? "h-8 px-3" : "h-9 w-full px-3 text-left",
        active ? "bg-accent/16 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "text-mute hover:bg-white/6 hover:text-ink",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{tab.label}</span>
      {tab.modified > 0 && (
        <span className="rounded-full bg-accent/20 px-1.5 text-2xs font-bold text-accent-hi tabular" title={`${tab.modified} changed from omp's defaults`}>
          {tab.modified}
        </span>
      )}
      {!compact && <span className="text-2xs text-mute-2 tabular">{tab.count}</span>}
    </button>
  );
}

function tabLabel(id: string | undefined): string {
  if (!id) return "Other";
  return OMP_TABS.find((t) => t.id === id)?.label ?? id;
}

/**
 * Every omp setting of one host with omp's own labels, tabs and groups (schema read by tf-hostd
 * from the host's omp build), plus the model-roles editor and an Other tab for keys omp's panel
 * lacks. Writes go through `omp.settingsSet` (omp's global config).
 */
export function OmpSettingsView({ hostId: routeHost }: { hostId?: string }) {
  const mobile = useIsMobile();
  const { hostId, options } = useHostChoice(routeHost);
  const setLast = useLastHost((s) => s.set);
  const phase = useHosts((s) => (hostId ? s.status[hostId]?.phase : undefined));
  const online = phase === "online";
  const info = useHostState(hostId ?? "")?.info;
  const { data, error, loading, reload, save } = useOmpSettings(online ? hostId : undefined);
  const [query, setQuery] = useState("");
  const [tabId, setTabId] = useState("model");
  const topRef = useRef<HTMLDivElement>(null);

  const tabs = useMemo(() => (data ? buildTabs(data.settings) : []), [data]);
  const ctx = useMemo<RowContext | undefined>(() => {
    if (!hostId || !data) return undefined;
    const values = new Map(data.settings.map((s) => [s.id, s.value]));
    return { hostId, get: (id) => values.get(id), os: info?.os, save: (changes) => void save(changes) };
  }, [hostId, data, info?.os, save]);
  const roles = data?.settings.find((s) => s.id === MODEL_ROLES_KEY);
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
  const q = query.trim();
  const results = useMemo(() => {
    if (!q || !data) return [];
    const order = OMP_TABS.map((t) => t.id);
    // omp's tab order; unknown (newer) tabs after them; keys without a tab last.
    const rank = (s: OmpSetting) => {
      const t = s.id === MODEL_ROLES_KEY ? "model" : s.tab;
      if (!t) return order.length + 1;
      const i = order.indexOf(t);
      return i < 0 ? order.length : i;
    };
    return data.settings
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => matchesQuery(s, q))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map(({ s }) => s);
  }, [q, data]);

  const pickHost = (id: string) => {
    setLast(id);
    navigate({ name: "omp", hostId: id }, { replace: true });
  };

  const hostPicker = options.length > 1 && hostId && (
    <Select aria-label="Host" className={cn("h-10", mobile ? "w-full" : "w-52")} value={hostId} onValueChange={pickHost} options={options} />
  );
  const search = (
    <Input
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder={data ? `Search ${data.settings.length} settings` : "Search settings"}
      aria-label="Search omp settings"
      leading={<Search />}
      trailing={
        query ? (
          <IconButton size="sm" label="Clear search" onClick={() => setQuery("")}>
            <X />
          </IconButton>
        ) : undefined
      }
      boxClassName={mobile ? "w-full" : "w-72"}
    />
  );
  const refresh = data && (
    <IconButton label="Read omp's settings again" onClick={() => reload(true)} disabled={loading}>
      <RefreshCw className={cn(loading && "animate-spin tf-keep")} />
    </IconButton>
  );

  let body: ReactNode;
  if (!hostId) {
    body = <EmptyState icon={<Server />} title="No hosts yet" description="Add a host to edit the omp settings there." className="mt-8" />;
  } else if (!online) {
    body = (
      <EmptyState
        icon={<Server />}
        title="Host offline"
        description="omp settings are read from the host. Connect it first."
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Open Hosts
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (error && !data) {
    const old = error.code === "unknown_method";
    body = (
      <EmptyState
        icon={<CircleAlert />}
        title={old ? "This host needs a newer tf-hostd" : "Couldn't read omp's settings"}
        description={old ? "Its TeleFlock host daemon predates omp settings. Reconnect the host to deploy the bundled tf-hostd, then come back." : [error.message, error.hint].filter(Boolean).join(" — ")}
        action={
          <Button variant="secondary" icon={<RefreshCw />} onClick={() => reload(false)}>
            Try again
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (!data || !ctx || !tab) {
    body = (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-64 rounded-tile" />
        <Skeleton className="h-48 rounded-tile" />
      </div>
    );
  } else {
    const content = q ? (
      results.length === 0 ? (
        <EmptyState compact title={`Nothing matches “${q}”`} description="Search looks at labels, descriptions and keys." />
      ) : (
        <Section>
          {results.map((s) => (
            <SettingRow key={s.id} s={s} ctx={ctx} showPlace={s.id === MODEL_ROLES_KEY ? "Model" : [tabLabel(s.tab), s.group].filter(Boolean).join(" › ")} />
          ))}
        </Section>
      )
    ) : (
      <div ref={topRef} className="flex scroll-mt-4 flex-col gap-3">
        {tab.lead && <p className="text-sm text-mute">{tab.lead}</p>}
        {tab.id === "model" && roles && (
          <Section title="Model roles">
            <SettingRow s={{ ...roles, label: "Model roles", description: "Which model omp uses for each job. Agents, commands and `--model @role` refer to these roles." }} ctx={ctx} />
          </Section>
        )}
        {tab.sections.map((sec) => (
          <Section key={sec.title ?? ""} title={sec.title}>
            {sec.settings.map((s) => (
              <SettingRow key={s.id} s={s} ctx={ctx} />
            ))}
          </Section>
        ))}
      </div>
    );
    const rail = (
      <nav aria-label="omp settings tabs" className={cn(mobile ? "-mx-3 flex gap-1 overflow-x-auto px-3 pb-1" : "sticky top-4 flex flex-col gap-0.5 self-start")}>
        {tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            compact={mobile}
            active={!q && t.id === tab.id}
            onClick={() => {
              setQuery("");
              setTabId(t.id);
              // A new tab starts at its top, not at the old tab's scroll position.
              if ((topRef.current?.getBoundingClientRect().top ?? 0) < 0) topRef.current?.scrollIntoView({ block: "start" });
            }}
          />
        ))}
      </nav>
    );
    body = (
      <div className="flex flex-col gap-3">
        {data.source === "cli" && (
          <p className="flex items-start gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            <span>
              Labels, tabs and choices are missing: TeleFlock reads them through the TeleFlock bridge (its omp extension), which couldn't get them from omp {data.version} on
              this host. Every key is still listed under Other and can be edited.
            </span>
          </p>
        )}
        {mobile ? (
          <>
            {rail}
            {content}
          </>
        ) : (
          <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-6">
            {rail}
            {content}
          </div>
        )}
        {tab.id === OTHER_TAB && !q && <p className="text-2xs text-mute-2">Model roles are edited on the Model tab.</p>}
      </div>
    );
  }

  const meta = data && (
    <span className="font-mono text-2xs font-semibold text-mute-2" title={data.configPath ? `Writes go to ${data.configPath}` : undefined}>
      omp {data.version}
      {data.configPath && <span className="max-md:hidden"> · {data.configPath}</span>}
    </span>
  );

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title={VIEWS.omp.label} subtitle={options.find((o) => o.value === hostId)?.label} back actions={refresh} />
        <OmpAreaFrame current="omp" hostId={hostId} mobile>
          {hostPicker}
          {online && data && search}
          {body}
        </OmpAreaFrame>
      </div>
    );
  return (
    <OmpAreaFrame current="omp" hostId={hostId} mobile={false}>
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <VIEWS.omp.icon className="size-3" /> {options.find((o) => o.value === hostId)?.label ?? "Host"}
          </span>
        }
        title={VIEWS.omp.label}
        meta={meta}
        description="Everything omp lets you configure on this host, with omp's own tabs and labels. Changes save at once into omp's global config; omp sessions pick them up as they load their settings."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hostPicker}
            {online && data && search}
            {refresh}
          </div>
        }
      />
      {body}
    </OmpAreaFrame>
  );
}
