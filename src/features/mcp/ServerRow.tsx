import { ChevronDown, Eye, FlaskConical, KeyRound, LogOut, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
import type { McpServer, McpTestResult } from "@/core/gen";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatAge,
  IconButton,
  Switch,
  Tile,
  useIsMobile,
  useNow,
} from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { canSignIn, serverKey, summarize } from "./model";
import { DefinitionSummary, ErrorText, StatusChip, TestOutcome, ToolList, TransportGlyph } from "./parts";

/** "Checked 2m ago", ticking on its own (the row doesn't re-render for it). */
function CheckedAgo({ at }: { at: number }) {
  const now = useNow(30_000);
  return <span title={new Date(at).toLocaleString()}>Checked {formatAge(now - at)}</span>;
}

export type RowAction = "edit" | "test" | "signIn" | "signOut" | "remove";

/** A test of the saved definition: running since `startedAt`, or its outcome. */
export interface RowTest {
  startedAt?: number;
  result?: McpTestResult;
  error?: string;
}

export interface ServerRowProps {
  server: McpServer;
  /** Switch state: the requested one while the change is on its way. */
  enabled: boolean;
  expanded: boolean;
  /** "Hidden by …" for a shadowed server. */
  shadowNote: string | null;
  test?: RowTest;
  home?: string;
  onToggle(key: string): void;
  onAction(action: RowAction, server: McpServer): void;
  onEnabled(server: McpServer, enabled: boolean): void;
}

/** One MCP server: transport, name, summary, status, switch and actions; expands to tools and details. */
export const ServerRow = memo(function ServerRow({ server: s, enabled, expanded, shadowNote, test, home, onToggle, onAction, onEnabled }: ServerRowProps) {
  const mobile = useIsMobile();
  const key = serverKey(s);
  const imported = s.origin === "imported";
  // hostd signs in (and out) servers of omp's own files that connect over HTTP and are on.
  const oauth = canSignIn(s.server) && !imported && s.enabled;
  const wantsSignIn = s.status === "needsAuth" && oauth && !s.shadowed;
  const summary = summarize(s.server);
  const testing = test?.startedAt;

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`More for ${s.name}`} size={mobile ? "md" : "sm"}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={imported ? <Eye /> : <Pencil />} onSelect={() => onAction("edit", s)}>
          {imported ? "View" : "Edit"}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<FlaskConical />} disabled={testing !== undefined} onSelect={() => onAction("test", s)}>
          Test
        </DropdownMenuItem>
        {oauth &&
          (s.signedIn ? (
            <DropdownMenuItem icon={<LogOut />} onSelect={() => onAction("signOut", s)}>
              Sign out
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem icon={<KeyRound />} onSelect={() => onAction("signIn", s)}>
              Sign in
            </DropdownMenuItem>
          ))}
        {!imported && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => onAction("remove", s)}>
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const chip = <StatusChip status={s.status} tools={s.tools.length} hidden={s.shadowed} />;
  const signIn = wantsSignIn && (
    <Button size="sm" variant="secondary" icon={<KeyRound />} onClick={() => onAction("signIn", s)} className="shrink-0">
      Sign in
    </Button>
  );
  const tags = (
    <>
      {s.origin === "project" && <span className="shrink-0 rounded-full bg-review/12 px-2 py-px text-[10px] font-bold text-review">Project</span>}
      {imported && s.sourceLabel && <span className="min-w-0 shrink truncate text-2xs font-semibold text-mute-2">{s.sourceLabel}</span>}
    </>
  );

  return (
    <Tile variant="flat" className={cn("bg-white/[0.022] px-3.5 py-3 transition-colors hover:bg-white/[0.035] md:px-4", (s.shadowed || !enabled) && "bg-white/[0.012]")}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggle(key)}
          className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-ring", s.shadowed && "opacity-55")}
        >
          <TransportGlyph transport={s.server.transport} className={cn(!enabled && "opacity-60")} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn("min-w-0 truncate text-md font-bold", enabled ? "text-ink" : "text-ink-2")}>{s.name}</span>
              {tags}
            </span>
            <span className="truncate font-mono text-2xs text-mute-2" title={summary}>
              {summary || "—"}
            </span>
            {mobile && <span className="mt-1 flex items-center gap-2">{chip}</span>}
          </span>
          {!mobile && chip}
        </button>
        {!mobile && signIn}
        <Switch checked={enabled} onCheckedChange={(v) => onEnabled(s, v)} label={enabled ? `Switch ${s.name} off` : `Switch ${s.name} on`} />
        {menu}
        {!mobile && (
          <ChevronDown className={cn("size-4 shrink-0 text-mute-2 transition-transform", expanded && "rotate-180")} aria-hidden onClick={() => onToggle(key)} />
        )}
      </div>
      {mobile && signIn && <div className="mt-2.5 flex pl-12">{signIn}</div>}
      {shadowNote && <p className="mt-1.5 pl-12 text-2xs font-semibold text-mute">{shadowNote}: sessions don't load this one.</p>}
      {s.status === "skipped" && s.note && !expanded && <p className="mt-1.5 pl-12 text-2xs text-mute">{s.note}</p>}
      {expanded && (
        <div className="mt-3.5 flex flex-col gap-4 border-t border-line pt-3.5 md:pl-12">
          {s.error && (s.status === "failed" ? <ErrorText text={s.error} /> : <p className="text-xs break-words text-warn">{s.error}</p>)}
          {s.note && <p className="text-xs text-mute">{s.note}</p>}
          {s.tools.length > 0 && <ToolList tools={s.tools} />}
          <DefinitionSummary server={s.server} extra={s.extra} />
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-mute-2">
            {s.serverInfo && (
              <span>
                <span className="font-semibold text-mute">{s.serverInfo.name}</span>
                {s.serverInfo.version && ` ${s.serverInfo.version}`}
              </span>
            )}
            {s.path && (
              <span className="font-mono" title={s.path}>
                {tildify(s.path, home)}
              </span>
            )}
            {s.checkedAt !== undefined && <CheckedAgo at={s.checkedAt} />}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<FlaskConical />} loading={testing !== undefined} onClick={() => onAction("test", s)}>
              Test
            </Button>
            {oauth && !s.signedIn && (
              <Button size="sm" variant="secondary" icon={<KeyRound />} onClick={() => onAction("signIn", s)}>
                Sign in
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={imported ? <Eye /> : <Pencil />} onClick={() => onAction("edit", s)}>
              {imported ? "View" : "Edit"}
            </Button>
          </div>
          {test && (testing !== undefined || test.result || test.error) && (
            <TestOutcome testing={testing} result={test.result} error={test.error} signIn={oauth && !s.signedIn ? () => onAction("signIn", s) : undefined} />
          )}
        </div>
      )}
    </Tile>
  );
});
