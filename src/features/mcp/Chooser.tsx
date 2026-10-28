import { BadgeCheck, Check, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { core, toApiError } from "@/core";
import type { ApiError, McpRegistryEntry, McpServer } from "@/core/gen";
import { Button, cn, hashString, IconButton, Input, Skeleton, Spinner } from "@/design";
import { definedIn, findSame, plural } from "./model";
import { LetterMark } from "./parts";
import { MCP_TEMPLATES, type McpTemplate, type TemplateTag } from "./templates";

const TAG_TONE: Record<TemplateTag, string> = {
  OAuth: "bg-accent/14 text-accent-ink",
  Token: "bg-warn/12 text-warn",
  "No sign-in": "bg-done/12 text-done",
  Local: "bg-review/12 text-review",
};

const TAG_HINT: Record<TemplateTag, string> = {
  OAuth: "Sign in once in your browser; omp keeps the login on the host",
  Token: "Paste an access token",
  "No sign-in": "Works right away",
  Local: "Runs as a program on the host",
};

/**
 * "✓ Added · Open" in the corner of a card whose server is already set up on the host: opens that
 * one. The card itself still adds another copy (the form says it's one).
 */
function AddedOpen({ server, onOpen }: { server: McpServer; onOpen(s: McpServer): void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(server)}
      title={`Already set up as “${server.name}” in ${definedIn(server)}`}
      aria-label={`Added as “${server.name}”: open it`}
      className="absolute top-2.5 right-2.5 inline-flex h-6 items-center gap-1 rounded-full bg-done/12 pr-2.5 pl-2 text-[11px] font-bold whitespace-nowrap text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.25)] pressable touch-hit focus-ring hover:bg-done/20"
    >
      <Check className="size-3" />
      Added
      <span className="text-mute-2" aria-hidden>
        ·
      </span>
      <span className="text-ink">Open</span>
    </button>
  );
}

/** Popular servers as cards (curated in `templates.ts`); one the host already has offers to open it. */
export function TemplateGrid({ servers, onPick, onOpen }: { servers: readonly McpServer[]; onPick(t: McpTemplate): void; onOpen(s: McpServer): void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {MCP_TEMPLATES.map((t) => {
        const added = findSame(t.server, servers)[0];
        return (
          <div key={t.id} className="relative flex min-w-0">
            <button
              type="button"
              onClick={() => onPick(t)}
              className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg bg-white/[0.03] p-3 text-left shadow-hairline transition-colors pressable focus-ring hover:bg-white/[0.06]"
            >
              <LetterMark mark={t.mark} color={t.color} ink={t.ink} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("flex min-w-0 items-center gap-2", added && "pr-[6.75rem]")}>
                  <span className="truncate text-sm font-bold text-ink">{t.title}</span>
                  <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold", TAG_TONE[t.tag])} title={TAG_HINT[t.tag]}>
                    {t.tag}
                  </span>
                </span>
                <span className="line-clamp-2 text-2xs text-mute">{t.description}</span>
              </span>
            </button>
            {added && <AddedOpen server={added} onOpen={onOpen} />}
          </div>
        );
      })}
    </div>
  );
}

export interface RegistrySearchState {
  text: string;
  setText(text: string): void;
  /** Search now (Enter). */
  submit(): void;
  retry(): void;
  /** The query the results are for. */
  query: string;
  entries?: McpRegistryEntry[];
  error?: ApiError;
  loading: boolean;
}

/** `mcp.search` as the user types (debounced 450 ms; Enter searches at once). Lives in the sheet so results survive picking one. */
export function useRegistrySearch(hostId: string): RegistrySearchState {
  const [text, setText] = useState("");
  const [query, setQuery] = useState({ q: "", n: 0 });
  const [state, setState] = useState<{ query: string; entries?: McpRegistryEntry[]; error?: ApiError; loading: boolean }>({ query: "", loading: false });
  useEffect(() => {
    const q = text.trim();
    const timer = window.setTimeout(() => setQuery((cur) => (cur.q === q ? cur : { q, n: cur.n + 1 })), 450);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!query.q) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    core
      .host(hostId)
      .call("mcp.search", { query: query.q, limit: 12 })
      .then(
        (r) => live && setState({ query: query.q, entries: r.entries, loading: false }),
        (e: unknown) => live && setState({ query: query.q, error: toApiError(e), loading: false }),
      );
    return () => {
      live = false;
    };
  }, [hostId, query]);
  return {
    text,
    setText,
    submit: () => setQuery((cur) => ({ q: text.trim(), n: cur.n + 1 })),
    retry: () => setQuery((cur) => ({ ...cur, n: cur.n + 1 })),
    query: state.query,
    entries: text.trim() ? state.entries : undefined,
    error: text.trim() ? state.error : undefined,
    loading: state.loading && !!text.trim(),
  };
}

const SUGGESTIONS = ["github", "database", "slack", "memory", "search", "notion"];
const USES = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const MARK_COLORS = ["#7c6cf8", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#6366f1", "#14b8a6"];

function entryMark(e: McpRegistryEntry): { mark: string; color: string } {
  const words = e.title.split(/[\s-]+/).filter(Boolean);
  const mark = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : e.title.slice(0, 2);
  return { mark: mark.length > 1 ? mark[0]?.toUpperCase() + (mark[1] ?? "").toLowerCase() : mark.toUpperCase(), color: MARK_COLORS[hashString(e.id) % MARK_COLORS.length] as string };
}

/** Search box and result cards of the Smithery registry; a server the host already has offers to open it. */
export function RegistrySearch({
  search: s,
  servers,
  onPick,
  onOpen,
  autoFocus,
}: {
  search: RegistrySearchState;
  servers: readonly McpServer[];
  onPick(e: McpRegistryEntry): void;
  onOpen(s: McpServer): void;
  autoFocus?: boolean;
}) {
  const text = s.text.trim();
  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.submit();
        }}
      >
        <Input
          value={s.text}
          onChange={(e) => s.setText(e.target.value)}
          placeholder="Search Smithery: github, postgres, slack…"
          aria-label="Search the Smithery registry"
          autoFocus={autoFocus}
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
      {!text ? (
        <div className="flex flex-col gap-2.5 px-0.5">
          <p className="text-xs text-mute">Thousands of servers from smithery.ai. Hosted ones run on Smithery; local ones run on the host through the Smithery CLI.</p>
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
          <p className="text-xs font-bold text-ink">Couldn't search the registry</p>
          <p className="text-xs text-mute">{[s.error.message, s.error.hint].filter(Boolean).join(" — ")}</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={s.retry}>
            Retry
          </Button>
        </div>
      ) : !s.entries ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-lg" />
          ))}
        </div>
      ) : s.entries.length === 0 ? (
        <p className="px-0.5 py-4 text-center text-xs text-mute">Nothing on Smithery matches “{s.query}”.</p>
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 transition-opacity", s.loading && "opacity-60")}>
          {s.entries.map((e) => {
            const m = entryMark(e);
            const added = findSame(e.server, servers)[0];
            return (
              <div key={e.id} className="relative flex min-w-0">
                <button
                  type="button"
                  onClick={() => onPick(e)}
                  className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg bg-white/[0.03] p-3 text-left shadow-hairline transition-colors pressable focus-ring hover:bg-white/[0.06]"
                >
                  <span className={cn("flex min-w-0 items-center gap-3", added && "pr-[6.75rem]")}>
                    <LetterMark mark={m.mark} color={m.color} className="size-9 text-xs" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-bold text-ink">{e.title}</span>
                        {e.verified && <BadgeCheck className="size-3.5 shrink-0 text-review" aria-label="Verified" />}
                      </span>
                      <span className="truncate font-mono text-2xs text-mute-2">{e.id}</span>
                    </span>
                  </span>
                  {e.description && <span className="line-clamp-2 text-2xs text-mute">{e.description}</span>}
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mute-2">
                    <span className={cn("rounded-full px-1.5 py-px font-bold", e.remote ? "bg-accent/14 text-accent-ink" : "bg-review/12 text-review")}>{e.remote ? "Remote" : "Local"}</span>
                    <span className="tabular">{USES.format(e.useCount)} uses</span>
                    {e.inputs.length > 0 && <span>{plural(e.inputs.length, "setting")}</span>}
                    {e.tools.length > 0 && <span>{plural(e.tools.length, "tool")}</span>}
                  </span>
                  {e.warnings.map((w) => (
                    <span key={w} className="text-2xs font-semibold text-warn">
                      {w}
                    </span>
                  ))}
                </button>
                {added && <AddedOpen server={added} onOpen={onOpen} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
