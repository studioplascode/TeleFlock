import { Check, ChevronDown, CircleAlert, Download, ExternalLink, Plus, RefreshCw, Search, Store, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { linkProps } from "@/core";
import type { ApiError, CatalogPlugin, InstallScope, Marketplace, PluginList } from "@/core/gen";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, formatAge, IconButton, Input, Select, Skeleton, useNow } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";
import { errorLine, filterCatalog, installedScopes, isoMs, pluginKey, SOURCE_LABEL, sourceKind } from "./model";
import { Glyph, GroupHeader, ProvidesChips, Tag } from "./parts";
import type { PluginsQuery } from "./usePlugins";

const ALL = "__all__";
/** Catalog cards shown before "Show all". */
const FOLDED = 24;

/** Well-known marketplaces to add with one tap. */
const EXAMPLES: readonly { source: string; what: string }[] = [
  { source: "anthropics/claude-plugins-official", what: "Anthropic's official Claude Code plugins" },
  { source: "obra/superpowers-marketplace", what: "Superpowers: brainstorming, planning, TDD and debugging skills" },
];

function InstallMenu({ plugin, cwd, projectName, busy, onInstall }: { plugin: CatalogPlugin; cwd?: string; projectName?: string; busy?: string; onInstall(scope: InstallScope): void }) {
  if (busy) {
    return (
      <Button size="sm" variant="secondary" loading disabled className="shrink-0">
        {busy}
      </Button>
    );
  }
  if (!cwd) {
    return (
      <Button size="sm" variant="secondary" icon={<Download />} onClick={() => onInstall("user")} className="shrink-0" aria-label={`Install ${plugin.id}`}>
        Install
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Download />} trailing={<ChevronDown className="size-3.5" />} className="shrink-0" aria-label={`Install ${plugin.id}`}>
          Install
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onInstall("user")}>For every project</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onInstall("project")}>For {projectName ?? "this project"} only</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CatalogCard({ plugin: p, installed, cwd, projectName, busy, onInstall }: { plugin: CatalogPlugin; installed: InstallScope[]; cwd?: string; projectName?: string; busy?: string; onInstall(p: CatalogPlugin, scope: InstallScope): void }) {
  const home = linkProps(p.homepage);
  // Installed for every project already: a project install would only shadow it.
  const done = installed.includes("user") || (installed.includes("project") && !!cwd);
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-bold text-ink">{p.name}</span>
            {p.version && <span className="shrink-0 font-mono text-2xs text-mute-2">{p.version}</span>}
          </span>
          <span className="truncate text-2xs text-mute-2">
            {[p.marketplace, p.author && `by ${p.author}`, p.category].filter(Boolean).join(" · ")}
          </span>
        </span>
        {done ? (
          <Tag tone="project" className="mt-0.5 inline-flex items-center gap-1 py-0.5 text-[11px]">
            <Check className="size-3" />
            {installed.includes("user") ? "Installed" : "In this project"}
          </Tag>
        ) : (
          <InstallMenu plugin={p} cwd={cwd} projectName={projectName} busy={busy} onInstall={(scope) => onInstall(p, scope)} />
        )}
      </div>
      {p.description && <p className="line-clamp-2 text-2xs text-mute">{p.description}</p>}
      {(p.provides.length > 0 || home) && (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <ProvidesChips provides={p.provides} />
          {home && (
            <a {...home} className="ml-auto inline-flex items-center gap-1 text-2xs font-semibold text-mute hover:text-ink">
              Homepage
              <ExternalLink className="size-3" />
            </a>
          )}
        </span>
      )}
    </li>
  );
}

function MarketplaceRow({ m, busy, onRefresh, onRemove }: { m: Marketplace; busy?: string; onRefresh(m: Marketplace): void; onRemove(m: Marketplace): void }) {
  const now = useNow(60_000);
  const at = isoMs(m.updatedAt);
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-lg bg-white/[0.022] px-3.5 py-2.5 shadow-hairline">
      <Glyph>
        <Store />
      </Glyph>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-bold text-ink">{m.name}</span>
          <span className="shrink-0 text-2xs text-mute-2 tabular">{m.plugins} plugins</span>
        </span>
        <span className="truncate font-mono text-2xs text-mute-2" title={`${m.source} (${m.sourceType})`}>
          {m.source}
        </span>
        {m.error ? (
          <span className="flex items-start gap-1 text-2xs text-warn">
            <CircleAlert className="mt-px size-3 shrink-0" />
            <span className="min-w-0 break-words">{m.error}</span>
          </span>
        ) : (
          <span className="truncate text-2xs text-mute-2">
            {[m.description ?? m.owner, at !== undefined && `catalog fetched ${formatAge(now - at)}`].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {busy ? (
        <Button size="sm" variant="ghost" loading disabled>
          {busy}
        </Button>
      ) : (
        <>
          <IconButton label={`Refresh the catalog of ${m.name}`} onClick={() => onRefresh(m)}>
            <RefreshCw />
          </IconButton>
          <IconButton label={`Remove ${m.name}`} onClick={() => onRemove(m)}>
            <Trash2 />
          </IconButton>
        </>
      )}
    </li>
  );
}

/** Add a marketplace: `owner/repo`, a git URL, a catalog URL or a folder on the host; errors under the input. */
function AddMarketplace({ q, marketplaces, cwd }: { q: PluginsQuery; marketplaces: readonly Marketplace[]; cwd?: string }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const busy = q.busy["market:add"];
  const kind = sourceKind(source);
  const add = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    setError(null);
    q.pluginChange((h) => h.call("plugins.marketplaceAdd", { source: s, ...(cwd ? { cwd } : {}) }), {
      busy: [{ key: "market:add", label: "Adding…" }],
      title: `Added the marketplace ${s}`,
      failTitle: `Couldn't add ${s}`,
      change: "change",
      lines: true,
      skillsUnchanged: true,
      inline: (e) => e.code === "invalid_params" || e.code === "omp_error",
    }).then(
      (changed) => changed && setSource(""),
      (e: ApiError) => setError(e),
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(source);
        }}
      >
        <Input
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setError(null);
          }}
          placeholder="owner/repo, a git or catalog URL, or a folder on the host"
          aria-label="Marketplace source"
          invalid={!!error}
          boxClassName="min-w-0 flex-[1_1_18rem]"
          trailing={kind ? <span className="pr-1 text-2xs font-semibold whitespace-nowrap text-mute-2">{SOURCE_LABEL[kind]}</span> : undefined}
        />
        <Button type="submit" variant="secondary" icon={<Plus />} loading={!!busy} disabled={!source.trim() || !!busy}>
          {busy ?? "Add"}
        </Button>
      </form>
      {error && <p className="px-0.5 text-xs break-words text-error">{errorLine(error)}</p>}
      <div className="flex flex-wrap items-center gap-1.5 px-0.5">
        <span className="text-2xs text-mute-2">Try</span>
        {EXAMPLES.map((x) => {
          const added = marketplaces.some((m) => m.source === x.source);
          return (
            <button
              key={x.source}
              type="button"
              title={x.what}
              disabled={added || !!busy}
              onClick={() => {
                setSource(x.source);
                add(x.source);
              }}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full px-3 font-mono text-2xs font-semibold shadow-hairline pressable focus-ring",
                added ? "bg-done/10 text-done" : "bg-white/6 text-ink-2 hover:bg-white/10 hover:text-ink",
              )}
            >
              {added && <Check className="size-3" />}
              {x.source}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Marketplace catalogs (`plugins.discover`, as last fetched: no network) with Install, then the marketplaces themselves. */
export function Catalog({
  hostId,
  cwd,
  projectName,
  list,
  q,
  onInstalled,
}: {
  hostId: string;
  cwd?: string;
  projectName?: string;
  list?: PluginList;
  q: PluginsQuery;
  /** The row key of a plugin just installed (the toast's "Show"). */
  onInstalled(key: string): void;
}) {
  const marketplaces = list?.marketplaces ?? [];
  const discover = useHostQuery(hostId, "plugins.discover", cwd ? { cwd } : {});
  // The catalogs change with the marketplaces (added, removed, refreshed).
  const fingerprint = marketplaces.map((m) => `${m.name}:${m.updatedAt ?? ""}:${m.plugins}`).join("|");
  const [seen, setSeen] = useState(fingerprint);
  const { reload } = discover;
  useEffect(() => {
    if (seen === fingerprint) return;
    setSeen(fingerprint);
    reload();
  }, [seen, fingerprint, reload]);
  const [text, setText] = useState("");
  const [only, setOnly] = useState(ALL);
  const [all, setAll] = useState(false);
  const plugins = discover.data?.plugins;
  const shown = useMemo(() => (plugins ? filterCatalog(plugins, text, only === ALL ? undefined : only) : undefined), [plugins, text, only]);
  const refreshAll = q.busy["market:*"];

  const install = (p: CatalogPlugin, scope: InstallScope) => {
    void q.pluginChange((h) => h.call("plugins.install", { spec: p.id, scope, ...(cwd ? { cwd } : {}) }), {
      busy: [{ key: `install:${p.id}`, label: "Installing…" }],
      title: `Installed “${p.name}”`,
      failTitle: `Couldn't install “${p.name}”`,
      change: "add",
      lines: true,
      action: (changed) => {
        const row = (changed.list as PluginList).marketplace.find((m) => m.id === p.id && m.scope === scope);
        return row ? { label: "Show", onClick: () => onInstalled(pluginKey(row)) } : undefined;
      },
    });
  };
  const refresh = (m?: Marketplace) =>
    void q.pluginChange((h) => h.call("plugins.marketplaceUpdate", { ...(m ? { name: m.name } : {}), ...(cwd ? { cwd } : {}) }), {
      busy: [{ key: m ? `market:${m.name}` : "market:*", label: "Refreshing…" }],
      title: m ? `Refreshed the catalog of ${m.name}` : "Refreshed every catalog",
      failTitle: m ? `Couldn't refresh ${m.name}` : "Couldn't refresh the catalogs",
      change: "change",
      lines: true,
      skillsUnchanged: true,
    });
  const remove = (m: Marketplace) =>
    void confirmAction({
      title: `Remove the marketplace ${m.name}?`,
      body: "Its catalog goes; plugins you installed from it stay installed until you remove them.",
      confirmLabel: "Remove",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void q.pluginChange((h) => h.call("plugins.marketplaceRemove", { name: m.name, ...(cwd ? { cwd } : {}) }), {
        busy: [{ key: `market:${m.name}`, label: "Removing…" }],
        title: `Removed the marketplace ${m.name}`,
        failTitle: `Couldn't remove ${m.name}`,
        change: "remove",
        lines: true,
        skillsUnchanged: true,
      });
    });

  const marketOptions = [{ value: ALL, label: "All marketplaces" }, ...marketplaces.map((m) => ({ value: m.name, label: m.name, hint: `${m.plugins}` }))];
  const visible = shown && (all || text ? shown : shown.slice(0, FOLDED));

  return (
    <div className="flex flex-col gap-5">
      {marketplaces.length === 0 ? (
        <EmptyState
          compact
          icon={<Store />}
          title="No marketplaces yet"
          description="A marketplace is a catalog of Claude Code–format plugins (commands, agents, hooks, skills, MCP servers) in a git repository or at a URL. Add one to browse it here."
          className="rounded-tile bg-white/[0.018] shadow-hairline"
        />
      ) : (
        <section aria-label="Marketplace plugins" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter plugins"
              aria-label="Filter marketplace plugins"
              data-esc-clears
              leading={<Search />}
              trailing={
                text ? (
                  <IconButton size="sm" label="Clear filter" onClick={() => setText("")}>
                    <X />
                  </IconButton>
                ) : undefined
              }
              boxClassName="min-w-0 flex-[1_1_14rem]"
            />
            {marketplaces.length > 1 && <Select aria-label="Marketplace" value={only} onValueChange={setOnly} options={marketOptions} className="h-10 w-56 max-md:flex-1" />}
          </div>
          {discover.error && !plugins ? (
            <div className="flex flex-col items-start gap-2 rounded-md well px-3 py-3">
              <p className="text-xs font-bold text-ink">Couldn't read the catalogs</p>
              <p className="text-xs text-mute">{errorLine(discover.error)}</p>
              <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={reload}>
                Retry
              </Button>
            </div>
          ) : !shown || !visible ? (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2" aria-busy aria-label="Reading the catalogs">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[96px] rounded-lg" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <p className="px-0.5 py-4 text-center text-xs text-mute">{text ? `No plugin matches “${text.trim()}”.` : "These catalogs list no plugins."}</p>
          ) : (
            <>
              <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2" aria-label="Catalog plugins">
                {visible.map((p) => (
                  <CatalogCard key={p.id} plugin={p} installed={installedScopes(p, list)} cwd={cwd} projectName={projectName} busy={q.busy[`install:${p.id}`]} onInstall={install} />
                ))}
              </ul>
              {visible.length < shown.length && (
                <Button variant="ghost" size="sm" onClick={() => setAll(true)} className="self-start">
                  Show all {shown.length}
                </Button>
              )}
            </>
          )}
        </section>
      )}
      <section aria-label="Marketplaces" className="flex flex-col gap-2">
        <GroupHeader
          title="Marketplaces"
          count={marketplaces.length}
          action={
            marketplaces.length > 0 && (
              <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={!!refreshAll} disabled={!!refreshAll} onClick={() => refresh()}>
                {refreshAll ? "Refreshing…" : "Refresh catalogs"}
              </Button>
            )
          }
        />
        {marketplaces.length > 0 && (
          <ul className="flex flex-col gap-2">
            {marketplaces.map((m) => (
              <MarketplaceRow key={m.name} m={m} busy={q.busy[`market:${m.name}`] ?? refreshAll} onRefresh={refresh} onRemove={remove} />
            ))}
          </ul>
        )}
        <AddMarketplace q={q} marketplaces={marketplaces} cwd={cwd} />
      </section>
    </div>
  );
}
