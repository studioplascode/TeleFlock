import { Check, ChevronDown, Download, ExternalLink, RefreshCw, Search, Store, X } from "lucide-react";
import { useEffect, useState } from "react";
import { core, linkProps, toApiError } from "@/core";
import type { ApiError, InstallScope, SkillList, SkillSearchHit } from "@/core/gen";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, formatAge, formatCompact, IconButton, Input, Select, Skeleton, Spinner, useNow } from "@/design";
import { hitInstalled, registryKey, urlHost } from "./model";
import { Tag } from "./parts";
import type { PluginsQuery } from "./usePlugins";

export type SkillSort = "relevance" | "downloads" | "recent";

const SORTS: { value: SkillSort; label: string }[] = [
  { value: "relevance", label: "Best match" },
  { value: "downloads", label: "Most downloaded" },
  { value: "recent", label: "Recently updated" },
];

const SUGGESTIONS = ["review", "changelog", "pdf", "docs", "testing", "security"];

interface SearchState {
  /** The query and sort the hits are for. */
  for: string;
  hits: SkillSearchHit[];
  total: number;
  page: number;
  registryUrl?: string;
  error?: ApiError;
  loading: boolean;
}

/** `skills.search` as the user types (debounced 450 ms; Enter searches at once), sorted, a page at a time ("Show more" appends). */
function useSkillSearch(hostId: string, cwd: string | undefined) {
  const [text, setText] = useState("");
  const [sort, setSort] = useState<SkillSort>("relevance");
  const [query, setQuery] = useState({ q: "", n: 0 });
  const [page, setPage] = useState(1);
  const [state, setState] = useState<SearchState>({ for: "", hits: [], total: 0, page: 0, loading: false });
  useEffect(() => {
    const q = text.trim();
    const timer = window.setTimeout(() => setQuery((cur) => (cur.q === q ? cur : { q, n: cur.n + 1 })), 450);
    return () => window.clearTimeout(timer);
  }, [text]);
  // A new query or sort starts at page 1.
  const forKey = `${query.q}\u0000${sort}\u0000${cwd ?? ""}`;
  const [pageFor, setPageFor] = useState(forKey);
  if (pageFor !== forKey) {
    setPageFor(forKey);
    setPage(1);
  }
  useEffect(() => {
    if (!query.q) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    core
      .host(hostId)
      .call("skills.search", { query: query.q, sort, page, ...(cwd ? { cwd } : {}) })
      .then(
        (r) =>
          live &&
          setState((s) => ({
            for: forKey,
            hits: page > 1 && s.for === forKey ? [...s.hits, ...r.hits.filter((h) => !s.hits.some((x) => x.id === h.id))] : r.hits,
            total: r.total,
            page: r.page,
            registryUrl: r.registryUrl,
            loading: false,
          })),
        (e: unknown) => live && setState((s) => ({ ...s, for: forKey, error: toApiError(e), loading: false })),
      );
    return () => {
      live = false;
    };
    // `query.n` asks again (Enter, Retry); `forKey` is query + sort + folder.
  }, [hostId, cwd, query, sort, page, forKey]);
  const typed = !!text.trim();
  const current = state.for === forKey;
  return {
    text,
    setText,
    sort,
    setSort,
    submit: () => setQuery((cur) => ({ q: text.trim(), n: cur.n + 1 })),
    retry: () => setQuery((cur) => ({ ...cur, n: cur.n + 1 })),
    more: () => setPage((p) => p + 1),
    query: query.q,
    hits: typed && current && !(state.error && state.hits.length === 0) ? state.hits : undefined,
    total: current ? state.total : 0,
    registryUrl: state.registryUrl,
    error: typed && current ? state.error : undefined,
    loading: state.loading && typed,
  };
}

function InstallButton({ hit, cwd, projectName, busy, onInstall }: { hit: SkillSearchHit; cwd?: string; projectName?: string; busy?: string; onInstall(scope: InstallScope): void }) {
  if (busy) {
    return (
      <Button size="sm" variant="secondary" loading disabled className="shrink-0">
        {busy}
      </Button>
    );
  }
  if (!cwd) {
    return (
      <Button size="sm" variant="secondary" icon={<Download />} onClick={() => onInstall("user")} className="shrink-0">
        Install
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Download />} trailing={<ChevronDown className="size-3.5" />} className="shrink-0" aria-label={`Install ${hit.id}`}>
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

function HitCard({ hit, list, cwd, projectName, busy, onInstall }: { hit: SkillSearchHit; list?: SkillList; cwd?: string; projectName?: string; busy?: string; onInstall(hit: SkillSearchHit, scope: InstallScope): void }) {
  const now = useNow(60_000);
  const installed = hitInstalled(hit, list);
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 truncate font-mono text-sm font-bold text-ink">{hit.id}</code>
            <span className="shrink-0 font-mono text-2xs text-mute-2">{hit.version}</span>
          </span>
          <span className="line-clamp-2 text-2xs text-mute">{hit.description}</span>
        </span>
        {installed ? (
          <Tag tone="project" className="mt-0.5 inline-flex items-center gap-1 py-0.5 text-[11px]">
            <Check className="size-3" />
            {installed === "project" ? "In this project" : "Installed"}
          </Tag>
        ) : (
          <InstallButton hit={hit} cwd={cwd} projectName={projectName} busy={busy} onInstall={(scope) => onInstall(hit, scope)} />
        )}
      </div>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mute-2">
        <span>by {hit.publisher}</span>
        {hit.weeklyDownloads > 0 && <span className="tabular">{formatCompact(hit.weeklyDownloads)}/week</span>}
        <span title={new Date(hit.updatedAt).toLocaleString()}>updated {formatAge(now - hit.updatedAt)}</span>
        {hit.keywords.slice(0, 4).map((k) => (
          <span key={k} className="rounded-full bg-white/[0.05] px-1.5 py-px">
            {k}
          </span>
        ))}
      </span>
      {hit.deprecated && <p className="text-2xs font-semibold text-warn">Deprecated: {hit.deprecated}</p>}
    </li>
  );
}

/** Search the Skillshare registry (skills.omp.sh) and install a skill for every project or this one. */
export function SkillSearch({
  hostId,
  cwd,
  projectName,
  q,
  onInstalled,
  onBrowseMarketplaces,
}: {
  hostId: string;
  cwd?: string;
  projectName?: string;
  q: PluginsQuery;
  /** The row key of a skill just installed (the toast's "Show"). */
  onInstalled(key: string): void;
  onBrowseMarketplaces(): void;
}) {
  const s = useSkillSearch(hostId, cwd);
  const registryUrl = s.registryUrl ?? q.skills?.registryUrl ?? "https://skills.omp.sh";
  const host = urlHost(registryUrl);
  const link = linkProps(registryUrl);
  const install = (hit: SkillSearchHit, scope: InstallScope) => {
    void q.skillChange((h, allowScripts) => h.call("skills.install", { spec: hit.id, scope, ...(cwd ? { cwd } : {}), ...(allowScripts ? { allowScripts } : {}) }), {
      busy: [{ key: `install:${hit.id}`, label: "Installing…" }],
      title: `Installed “${hit.id}”`,
      failTitle: `Couldn't install “${hit.id}”`,
      change: "add",
      consent: "Install anyway",
      lines: true,
      action: () => ({ label: "Show", onClick: () => onInstalled(registryKey({ id: hit.id, scope })) }),
    });
  };
  const registryLink = link && (
    <a {...link} className="inline-flex items-center gap-1 font-bold text-accent-hi hover:underline">
      {host}
      <ExternalLink className="size-3" />
    </a>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="min-w-0 flex-[1_1_16rem]"
          onSubmit={(e) => {
            e.preventDefault();
            s.submit();
          }}
        >
          <Input
            value={s.text}
            onChange={(e) => s.setText(e.target.value)}
            placeholder={`Search ${host}: review, pdf, changelog…`}
            aria-label={`Search the skill registry (${host})`}
            data-esc-clears
            enterKeyHint="search"
            leading={<Search />}
            trailing={
              s.loading ? (
                <Spinner size={14} />
              ) : s.text ? (
                <IconButton size="sm" label="Clear search" onClick={() => s.setText("")}>
                  <X />
                </IconButton>
              ) : undefined
            }
          />
        </form>
        <Select aria-label="Sort" value={s.sort} onValueChange={(v) => s.setSort(v as SkillSort)} options={SORTS} className="h-10 w-44 max-md:flex-1" />
      </div>
      {!s.text.trim() ? (
        <div className="flex flex-col gap-2.5 px-0.5">
          <p className="text-xs text-mute">
            Skills published on {registryLink ?? host}, omp's skill registry. A skill is a folder with a SKILL.md that tells omp how to do one kind of task; installing one adds it to
            {cwd ? " every project, or only this one" : " every project on this host"}.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => s.setText(w)}
                className="h-7 rounded-full bg-white/6 px-3 text-xs font-bold text-ink-2 shadow-hairline pressable focus-ring hover:bg-white/10 hover:text-ink"
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      ) : s.error ? (
        <div className="flex flex-col items-start gap-2 rounded-md well px-3 py-3">
          <p className="text-xs font-bold text-ink">Couldn't search {host}</p>
          <p className="text-xs text-mute">{[s.error.message, s.error.hint].filter(Boolean).join(" — ")}</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={s.retry}>
            Retry
          </Button>
        </div>
      ) : !s.hits ? (
        <div className="flex flex-col gap-2" aria-busy aria-label="Searching the skill registry">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[84px] rounded-lg" />
          ))}
        </div>
      ) : s.hits.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-white/[0.018] px-4 py-6 text-center shadow-hairline">
          <p className="text-sm font-bold text-ink">Nothing on {host} matches “{s.query}”</p>
          <p className="max-w-md text-xs text-mute">
            The registry is young and still small. Skills also come with marketplace plugins, and any folder with a SKILL.md in ~/.omp/agent/skills (or a project's .omp/skills) is one.
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="secondary" icon={<Store />} onClick={onBrowseMarketplaces}>
              Browse marketplaces
            </Button>
            {link && (
              <Button size="sm" variant="ghost" asChild>
                <a {...link}>
                  <ExternalLink />
                  Open {host}
                </a>
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <ul className={cn("flex flex-col gap-2 transition-opacity", s.loading && "opacity-60")} aria-label="Registry skills">
            {s.hits.map((hit) => (
              <HitCard key={hit.id} hit={hit} list={q.skills} cwd={cwd} projectName={projectName} busy={q.busy[`install:${hit.id}`]} onInstall={install} />
            ))}
          </ul>
          <p className="flex items-center justify-between gap-2 px-0.5 text-2xs text-mute-2">
            <span className="tabular">
              {s.hits.length} of {s.total}
            </span>
            {s.hits.length < s.total && (
              <Button size="sm" variant="ghost" loading={s.loading} onClick={s.more}>
                Show more
              </Button>
            )}
          </p>
        </>
      )}
    </div>
  );
}
