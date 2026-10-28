import { ChevronDown, Eye, FlaskConical, KeyRound, LogOut, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { McpServer } from "@/core/gen";
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
  useCalmMotion,
  useIsMobile,
  useNow,
} from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { type RowTest, rowActions, rowState, serverKey, summarize } from "./model";
import { DefinitionSummary, ErrorText, StatusChip, TestOutcome, ToolList, TransportGlyph } from "./parts";

/** "Checked 2m ago", ticking on its own (the row doesn't re-render for it). */
function CheckedAgo({ at }: { at: number }) {
  const now = useNow(30_000);
  return <span title={new Date(at).toLocaleString()}>Checked {formatAge(now - at)}</span>;
}

export type RowAction = "edit" | "test" | "signIn" | "signOut" | "remove";

export interface ServerRowProps {
  server: McpServer;
  /** Switch state: the requested one while the change is on its way. */
  enabled: boolean;
  expanded: boolean;
  /** "Hidden by …" for a shadowed server. */
  shadowNote: string | null;
  test?: RowTest;
  /** Bumped to bring the row into view and light it up (just saved, or opened from the add sheet). */
  flash?: number;
  home?: string;
  onToggle(key: string): void;
  onAction(action: RowAction, server: McpServer): void;
  onEnabled(server: McpServer, enabled: boolean): void;
}

/** One MCP server: transport, name, summary, status, switch and actions; expands to tools and details. */
export const ServerRow = memo(function ServerRow({ server: s, enabled, expanded, shadowNote, test, flash, home, onToggle, onAction, onEnabled }: ServerRowProps) {
  const mobile = useIsMobile();
  const calm = useCalmMotion();
  const tile = useRef<HTMLDivElement>(null);
  const key = serverKey(s);
  const imported = s.origin === "imported";
  // What the row may do (hidden imports: no switch or test; sign-in only for omp's own mcp.json servers).
  const act = rowActions(s);
  // As last checked, or as its test found it when that is newer.
  const view = rowState(s, test);
  // On the row only when the server asks for it; the menu has it otherwise.
  const wantsSignIn = view.status === "needsAuth" && act.signIn && !s.shadowed;
  const summary = summarize(s.server);
  const testing = test?.startedAt;

  useEffect(() => {
    if (flash) tile.current?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }, [flash, calm]);

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
        {act.test && (
          <DropdownMenuItem icon={<FlaskConical />} disabled={testing !== undefined} onSelect={() => onAction("test", s)}>
            Test
          </DropdownMenuItem>
        )}
        {act.signIn &&
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

  const chip = <StatusChip status={view.status} tools={view.tools.length} hidden={s.shadowed} />;
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
    <Tile
      ref={tile}
      data-mcp-row={key}
      variant="flat"
      className={cn("bg-white/[0.022] px-3.5 py-3 transition-colors hover:bg-white/[0.035] md:px-4", (s.shadowed || !enabled) && "bg-white/[0.012]")}
    >
      {flash ? (
        <span
          key={flash}
          aria-hidden
          className="tf-keep pointer-events-none absolute inset-0 animate-[tf-flash_1.6s_ease-out_0.3s_both] rounded-tile bg-accent/[0.05] shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.7),0_0_28px_-6px_rgb(163_92_240/0.5)]"
        />
      ) : null}
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
        <Switch
          checked={enabled}
          disabled={!act.toggle}
          onCheckedChange={(v) => onEnabled(s, v)}
          label={!act.toggle ? `${s.name} is hidden by a server of the same name` : enabled ? `Switch ${s.name} off` : `Switch ${s.name} on`}
        />
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
          {view.error && (view.status === "failed" ? <ErrorText text={view.error} /> : <p className="text-xs break-words text-warn">{view.error}</p>)}
          {s.note && <p className="text-xs text-mute">{s.note}</p>}
          {view.tools.length > 0 && <ToolList tools={view.tools} />}
          <DefinitionSummary server={s.server} extra={s.extra} />
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-mute-2">
            {view.serverInfo && (
              <span>
                <span className="font-semibold text-mute">{view.serverInfo.name}</span>
                {view.serverInfo.version && ` ${view.serverInfo.version}`}
              </span>
            )}
            {s.path && (
              <span className="font-mono" title={s.path}>
                {tildify(s.path, home)}
              </span>
            )}
            {view.checkedAt !== undefined && <CheckedAgo at={view.checkedAt} />}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {act.test && (
              <Button size="sm" variant="secondary" icon={<FlaskConical />} loading={testing !== undefined} onClick={() => onAction("test", s)}>
                Test
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={imported ? <Eye /> : <Pencil />} onClick={() => onAction("edit", s)}>
              {imported ? "View" : "Edit"}
            </Button>
          </div>
          {test && (testing !== undefined || test.result || test.error) && (
            // When the outcome is the row's state above, only its verdict line is added here.
            <TestOutcome testing={testing} result={test.result} error={test.error} compact={view.tested} signIn={act.signIn && !s.signedIn ? () => onAction("signIn", s) : undefined} />
          )}
        </div>
      )}
    </Tile>
  );
});
