import { ArrowUpCircle, Check, ChevronDown, CircleAlert, Copy, Globe, KeyRound, RefreshCw, Search, TerminalSquare, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { McpServerDraft, McpStatus, McpTestResult, McpTool, McpTransport } from "@/core/gen";
import { Button, cn, Elapsed, EmptyState, IconButton, Input, Shimmer, Spinner } from "@/design";
import { copyText } from "@/features/hosts/CopyCommand";
import { filterTools, plural, quoteArg, STATUS_META, type StatusTone, statusLabel } from "./model";

const TONE: Record<StatusTone, string> = {
  ok: "bg-done/12 text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.3)]",
  warn: "bg-warn/12 text-warn shadow-[inset_0_0_0_1px_rgb(251_191_36/0.34)]",
  error: "bg-error/14 text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]",
  busy: "bg-accent/12 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]",
  muted: "bg-white/6 text-mute",
};

const DOT: Partial<Record<McpStatus, string>> = { connected: "bg-done", needsAuth: "bg-warn", failed: "bg-error" };

/** Transport glyph tile: a terminal for stdio, a globe for HTTP / SSE. */
export function TransportGlyph({ transport, className }: { transport: McpTransport; className?: string }) {
  return (
    <span
      className={cn("grid size-9 shrink-0 place-items-center rounded-md bg-white/[0.045] text-mute shadow-hairline [&_svg]:size-4", className)}
      title={transport === "stdio" ? "Runs on the host (stdio)" : transport === "sse" ? "Remote server (legacy SSE)" : "Remote server (HTTP)"}
    >
      {transport === "stdio" ? <TerminalSquare /> : <Globe />}
    </span>
  );
}

/** What a session gets from the server, as last checked ("Connected · 14 tools", "Sign in needed", …). */
export function StatusChip({ status, tools, hidden, className }: { status: McpStatus; tools: number; hidden?: boolean; className?: string }) {
  const tone = hidden ? "muted" : STATUS_META[status].tone;
  const busy = status === "checking" || status === "pending";
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold whitespace-nowrap", TONE[tone], className)}>
      {hidden ? (
        "Hidden"
      ) : status === "checking" ? (
        <Shimmer>Checking…</Shimmer>
      ) : (
        <>
          {DOT[status] && <span className={cn("size-1.5 rounded-full", DOT[status])} aria-hidden />}
          {busy && <span className="size-1.5 animate-pulse rounded-full bg-accent-hi" aria-hidden />}
          {statusLabel(status, tools)}
        </>
      )}
    </span>
  );
}

/** A tinted notice above the list (check failed, unreadable config file). */
export function Banner({ tone, title, children, action, className }: { tone: "warn" | "error"; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-lg px-3.5 py-3",
        tone === "warn" ? "bg-warn/[0.07] shadow-[inset_0_0_0_1px_rgb(251_191_36/0.24)]" : "bg-error/[0.07] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.28)]",
        className,
      )}
    >
      <CircleAlert className={cn("mt-0.5 size-4 shrink-0", tone === "warn" ? "text-warn" : "text-error")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-bold text-ink">{title}</p>
        {children && <div className="text-xs text-ink-2">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** The host's tf-hostd answers `unknown_method`: it predates MCP servers. */
export function OutdatedHost({ onRetry }: { onRetry(): void }) {
  return (
    <EmptyState
      icon={<ArrowUpCircle />}
      title="This host needs a newer tf-hostd"
      description="Its TeleFlock host daemon predates MCP servers. Reconnect the host to deploy the bundled tf-hostd, then come back."
      action={
        <Button variant="secondary" icon={<RefreshCw />} onClick={onRetry}>
          Try again
        </Button>
      }
      className="mt-8"
    />
  );
}

/** Monospace error text with a copy button. */
export function ErrorText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-md bg-error/[0.07] py-2 pr-1.5 pl-3 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.22)]", className)}>
      <code className="min-w-0 flex-1 py-0.5 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-[#ffb1c1] select-text">{text}</code>
      <IconButton size="sm" label="Copy the error" onClick={() => copyText(text, "Error")}>
        <Copy />
      </IconButton>
    </div>
  );
}

const TOOLS_FOLDED = 8;
const TOOLS_FILTER = 12;

/** A server's tools (name + description): folded after 8, filterable past 12. */
export function ToolList({ tools, className }: { tools: readonly McpTool[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = filterTools(tools, query);
  const folded = !open && !query && shown.length > TOOLS_FOLDED + 1;
  const list = folded ? shown.slice(0, TOOLS_FOLDED) : shown;
  return (
    <section className={cn("flex flex-col gap-2", className)} aria-label="Tools">
      <div className="flex items-center gap-2">
        <h4 className="kicker">{plural(tools.length, "tool")}</h4>
        {tools.length > TOOLS_FILTER && (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools"
            aria-label="Filter tools"
            data-esc-clears
            leading={<Search />}
            trailing={
              query ? (
                <IconButton size="sm" label="Clear filter" onClick={() => setQuery("")}>
                  <X />
                </IconButton>
              ) : undefined
            }
            boxClassName="ml-auto h-8 w-52 max-md:w-40"
            className="text-xs"
          />
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-mute-2">No tool matches “{query.trim()}”.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
          {list.map((t) => (
            <li key={t.name} className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-xs font-semibold text-ink-2" title={t.name}>
                {t.name}
              </span>
              {t.description && (
                <span className="line-clamp-2 text-2xs text-mute-2" title={t.description}>
                  {t.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(folded || (open && !query && shown.length > TOOLS_FOLDED + 1)) && (
        <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 self-start rounded-xs text-xs font-bold text-accent-hi focus-ring hover:text-ink">
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          {open ? "Show fewer" : `Show all ${tools.length}`}
        </button>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-2xs font-bold text-mute-2">{label}</dt>
      <dd className="min-w-0 text-xs break-words text-ink-2">{children}</dd>
    </>
  );
}

function KeyValues({ items, sep }: { items: McpServerDraft["env"]; sep: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      {items.map((kv) => (
        <code key={kv.key} className="font-mono text-2xs break-all">
          <span className="text-ink-2">{kv.key}</span>
          <span className="text-mute-2">{sep}</span>
          <span className={kv.secret ? "text-mute" : "text-ink-2"}>{kv.value}</span>
        </code>
      ))}
    </span>
  );
}

/** The definition as listed (secrets masked), as label/value rows. */
export function DefinitionSummary({ server: d, extra, className }: { server: McpServerDraft; extra?: readonly string[]; className?: string }) {
  const o = d.oauth;
  return (
    <dl className={cn("grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5", className)}>
      {d.transport === "stdio" ? (
        <>
          <Row label="Command">
            <code className="font-mono text-2xs">{[d.command ?? "", ...d.args.map(quoteArg)].join(" ")}</code>
          </Row>
          {d.cwd && (
            <Row label="Folder">
              <code className="font-mono text-2xs">{d.cwd}</code>
            </Row>
          )}
          {d.env.length > 0 && (
            <Row label="Environment">
              <KeyValues items={d.env} sep="=" />
            </Row>
          )}
        </>
      ) : (
        <>
          <Row label={d.transport === "sse" ? "URL (SSE)" : "URL"}>
            <code className="font-mono text-2xs break-all">{d.url}</code>
          </Row>
          {d.headers.length > 0 && (
            <Row label="Headers">
              <KeyValues items={d.headers} sep=": " />
            </Row>
          )}
        </>
      )}
      {d.timeoutMs !== undefined && <Row label="Timeout">{d.timeoutMs === 0 ? "None" : `${d.timeoutMs / 1000} s per request`}</Row>}
      {o && (
        <Row label="OAuth app">
          <code className="font-mono text-2xs">
            {[o.clientId && `client ${o.clientId}`, o.clientSecret && `secret ${o.clientSecret}`, o.scope && `scope ${o.scope}`, o.callbackPort && `port ${o.callbackPort}`, o.redirectUri].filter(Boolean).join(" · ")}
          </code>
        </Row>
      )}
      {extra && extra.length > 0 && <Row label="Kept as is">{extra.join(", ")}</Row>}
    </dl>
  );
}

/** A test in progress or its outcome. `signIn` offers the sign-in when the server wants one. */
export function TestOutcome({
  testing,
  result,
  error,
  needsAuthHint,
  signIn,
  className,
}: {
  testing?: number;
  result?: McpTestResult;
  error?: string;
  needsAuthHint?: string;
  signIn?: () => void;
  className?: string;
}) {
  if (testing !== undefined) {
    return (
      <div className={cn("flex items-center gap-2.5 rounded-md well px-3 py-2.5 text-xs text-ink-2", className)} aria-live="polite">
        <Spinner size={14} />
        <span className="min-w-0 flex-1">Connecting the way an omp session would… slow first starts can take up to 25 s.</span>
        <Elapsed since={testing} className="text-2xs text-mute-2" />
      </div>
    );
  }
  if (error) return <ErrorText text={error} className={className} />;
  if (!result) return null;
  const secs = `${(result.ms / 1000).toFixed(result.ms < 10_000 ? 1 : 0)} s`;
  if (result.status === "connected") {
    return (
      <div className={cn("flex flex-col gap-2 rounded-md bg-done/[0.06] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(163_230_53/0.2)]", className)} aria-live="polite">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold text-done">
          <Check className="size-3.5" />
          Connected in {secs} · {plural(result.tools.length, "tool")}
          {result.serverInfo && (
            <span className="font-semibold text-mute">
              {result.serverInfo.name}
              {result.serverInfo.version && ` ${result.serverInfo.version}`}
            </span>
          )}
        </p>
        {result.tools.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {result.tools.slice(0, 16).map((t) => (
              <code key={t.name} className="rounded-xs bg-white/6 px-1.5 py-px font-mono text-2xs text-ink-2" title={t.description}>
                {t.name}
              </code>
            ))}
            {result.tools.length > 16 && <span className="px-1 text-2xs text-mute-2">+{result.tools.length - 16} more</span>}
          </p>
        )}
      </div>
    );
  }
  if (result.status === "needsAuth") {
    return (
      <div className={cn("flex items-start gap-2.5 rounded-md bg-warn/[0.07] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.24)]", className)} aria-live="polite">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-xs font-bold text-warn">It wants a sign-in{needsAuthHint ? ` · ${needsAuthHint}` : ""}</p>
          {result.error && <p className="text-2xs break-words text-mute">{result.error}</p>}
        </div>
        {signIn && (
          <Button size="sm" variant="secondary" icon={<KeyRound />} onClick={signIn} className="shrink-0">
            Sign in
          </Button>
        )}
      </div>
    );
  }
  if (result.status === "pending") {
    return (
      <p className={cn("rounded-md well px-3 py-2.5 text-xs text-ink-2", className)} aria-live="polite">
        Still starting after {secs}. A first start can be downloading its package: test again in a moment.
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-live="polite">
      <p className="text-xs font-bold text-[#ff8aa5]">Couldn't connect ({secs})</p>
      {result.error && <ErrorText text={result.error} />}
    </div>
  );
}

/** Letter logo of a template or registry entry. */
export function LetterMark({ mark, color, ink, className }: { mark: string; color: string; ink?: string; className?: string }) {
  return (
    <span
      className={cn("grid size-10 shrink-0 place-items-center rounded-md font-display text-sm font-bold tracking-[-0.02em] shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_16px_-8px_rgb(0_0_0/0.8)]", className)}
      style={{ background: color, color: ink ?? "#fff" }}
      aria-hidden
    >
      {mark}
    </span>
  );
}
