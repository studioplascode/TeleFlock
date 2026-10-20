import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  Eye,
  Keyboard,
  MessageSquareText,
  Minus,
  Plus,
  RotateCcw,
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquareTerminal,
  PanelTop,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { agentKey, navigate, useAgent, useHosts, useSettings, useWorkspaces } from "@/core";
import type { ConnPhase, PaneInfo, Split, TermMode, TermOpened, TermTarget, Workspace } from "@/core/gen";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  GlowBorder,
  IconButton,
  SegmentedControl,
  Spinner,
  StatusOrb,
  Tooltip,
  cn,
  spring,
  useIsMobile,
} from "@/design";
import { usePaletteCommands, type PaletteCommand } from "@/features/palette/registry";
import { PreviewButton } from "@/features/preview/PreviewButton";
import { haptic } from "@/features/shell/haptics";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { COLUMN_STATUS, PHASE_LABEL } from "@/features/shell/status";
import { encodeKey, type NamedKey } from "./keys";
import type { TermPhase } from "./session";
import { type TerminalHandle, TerminalPane } from "./TerminalPane";
import { clampFontSize, DEFAULT_FONT_SIZE } from "./theme";
import { useLocalhostUrls } from "./useLocalhostUrls";

export interface TerminalViewProps {
  hostId: string;
  paneId?: string;
  agentId?: string;
}

/** What the view is attached to. `shell` carries a nonce so "new shell" twice opens two shells. */
type Selection =
  | { kind: "pane"; paneId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "shell"; workspaceId: string | null; cwd: string | null; split: Split; nonce: number };

interface PaneEntry {
  pane: PaneInfo;
  tabId: string;
  tabLabel: string;
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function workspacePanes(ws: Workspace | undefined): PaneEntry[] {
  return ws ? ws.tabs.flatMap((t) => t.panes.map((pane) => ({ pane, tabId: t.id, tabLabel: t.label }))) : [];
}

const SEND_KEYS: { id: string; label: ReactNode; aria: string; bytes: string; hint?: string }[] = [
  { id: "esc", label: "Esc", aria: "Escape", bytes: encodeKey("esc") },
  { id: "ctrl-c", label: "Ctrl+C", aria: "Control C (interrupt)", bytes: "\x03", hint: "Interrupt" },
  { id: "tab", label: "Tab", aria: "Tab", bytes: encodeKey("tab") },
  { id: "left", label: <ArrowLeft />, aria: "Left arrow", bytes: encodeKey("left") },
  { id: "up", label: <ArrowUp />, aria: "Up arrow", bytes: encodeKey("up") },
  { id: "down", label: <ArrowDown />, aria: "Down arrow", bytes: encodeKey("down") },
  { id: "right", label: <ArrowRight />, aria: "Right arrow", bytes: encodeKey("right") },
  { id: "enter", label: <CornerDownLeft />, aria: "Enter", bytes: encodeKey("enter" satisfies NamedKey) },
  { id: "ctrl-d", label: "Ctrl+D", aria: "Control D (end of input)", bytes: "\x04", hint: "EOF" },
  { id: "ctrl-l", label: "Ctrl+L", aria: "Control L (clear)", bytes: "\x0c", hint: "Clear" },
];

const SPLITS: { split: Split; label: string; icon: ReactNode }[] = [
  { split: "tab", label: "In a new tab", icon: <PanelTop /> },
  { split: "right", label: "Split right", icon: <SquareSplitHorizontal /> },
  { split: "down", label: "Split down", icon: <SquareSplitVertical /> },
];

/** Full terminal screen: pane tabs, send-keys, takeover, desktop + mobile layouts. */
export function TerminalView({ hostId, paneId, agentId }: TerminalViewProps) {
  const isMobile = useIsMobile();
  const workspaces = useWorkspaces(hostId);
  const agent = useAgent(agentKey(hostId, agentId ?? ""));
  const conn = useHosts((h) => h.status[hostId]);
  const fontSize = useSettings((s) => s.terminalFontSize);

  // Selection follows the route props; local switches (tabs, new shell) override until they change.
  const propsKey = `${hostId}|${paneId ?? ""}|${agentId ?? ""}`;
  const [sel, setSel] = useState<{ key: string; sel: Selection | null }>({ key: "", sel: null });
  const [wsPick, setWsPick] = useState<{ key: string; id: string } | null>(null);
  const initial: Selection | null = paneId
    ? { kind: "pane", paneId }
    : agentId
      ? agent?.paneId
        ? { kind: "pane", paneId: agent.paneId }
        : { kind: "agent", agentId }
      : null;
  const selection = sel.key === propsKey ? sel.sel : initial;
  const select = useCallback((s: Selection) => setSel({ key: propsKey, sel: s }), [propsKey]);

  const [mode, setMode] = useState<TermMode>("control");
  const [phase, setPhase] = useState<TermPhase>({ k: "idle" });
  const [opened, setOpened] = useState<TermOpened | null>(null);
  const handle = useRef<TerminalHandle>(null);

  // Workspace: the one holding the attached pane, else the picked one, else the focused/first.
  const activePaneId =
    selection?.kind === "pane" ? selection.paneId : (opened?.paneId ?? (selection?.kind === "agent" ? agent?.paneId : undefined));
  const workspace = useMemo(() => {
    const byPane = activePaneId ? workspaces.find((w) => w.tabs.some((t) => t.panes.some((p) => p.id === activePaneId))) : undefined;
    if (byPane) return byPane;
    if (selection?.kind === "shell" && selection.workspaceId) return workspaces.find((w) => w.id === selection.workspaceId);
    if (wsPick?.key === propsKey) return workspaces.find((w) => w.id === wsPick.id);
    if (agent) return workspaces.find((w) => w.id === agent.workspaceId);
    return workspaces.find((w) => w.tabs.some((t) => t.panes.some((p) => p.focused))) ?? workspaces[0];
  }, [workspaces, activePaneId, selection, wsPick, propsKey, agent]);
  const panes = useMemo(() => workspacePanes(workspace), [workspace]);

  // With nothing selected, attach to the workspace's focused pane.
  const effective: Selection | null =
    selection ?? (() => {
      const p = panes.find((e) => e.pane.focused) ?? panes[0];
      return p ? { kind: "pane", paneId: p.pane.id } : null;
    })();

  const selKey = effective ? JSON.stringify(effective) : "";
  const target = useMemo<TermTarget | null>(() => {
    if (!selKey) return null;
    const e: Selection = JSON.parse(selKey);
    if (e.kind === "pane") return { kind: "pane", paneId: e.paneId };
    if (e.kind === "agent") return { kind: "agent", agentId: e.agentId };
    return { kind: "shell", workspaceId: e.workspaceId, cwd: e.cwd, split: e.split };
  }, [selKey]);
  const highlighted = effective?.kind === "pane" ? effective.paneId : opened?.paneId;
  const currentEntry = panes.find((e) => e.pane.id === highlighted);
  const urls = useLocalhostUrls(hostId, opened?.termId);

  const newShell = useCallback(
    (split: Split) => {
      haptic("select");
      select({ kind: "shell", workspaceId: workspace?.id ?? null, cwd: workspace?.cwd ?? null, split, nonce: Date.now() });
    },
    [select, workspace],
  );
  const send = useCallback((bytes: string) => {
    handle.current?.send(bytes);
    handle.current?.focus();
  }, []);
  const setFont = useCallback((px: number) => void useSettings.getState().update({ terminalFontSize: clampFontSize(px) }), []);
  const font = clampFontSize(fontSize || DEFAULT_FONT_SIZE);
  const takeOver = useCallback(() => {
    haptic("heavy");
    setMode("control");
    handle.current?.reopen(true);
  }, []);

  const paletteCmds = useMemo<PaletteCommand[]>(
    () => [
      { id: "terminal.takeover", title: "Terminal: Take over input", group: "Terminal", icon: <Zap />, run: takeOver },
      { id: "terminal.reattach", title: "Terminal: Reattach", group: "Terminal", icon: <RotateCcw />, run: () => handle.current?.reopen(false) },
      { id: "terminal.newShell", title: "Terminal: New shell", group: "Terminal", icon: <SquareTerminal />, run: () => newShell("tab") },
      {
        id: "terminal.mode",
        title: mode === "control" ? "Terminal: Observe only (read-only)" : "Terminal: Control (send input)",
        group: "Terminal",
        icon: mode === "control" ? <Eye /> : <Keyboard />,
        run: () => setMode((m) => (m === "control" ? "observe" : "control")),
      },
      { id: "terminal.fontUp", title: "Terminal: Larger text", group: "Terminal", icon: <Plus />, shortcut: "Ctrl +", run: () => setFont(font + 1) },
      { id: "terminal.fontDown", title: "Terminal: Smaller text", group: "Terminal", icon: <Minus />, shortcut: "Ctrl -", run: () => setFont(font - 1) },
    ],
    [takeOver, newShell, mode, setFont, font],
  );
  usePaletteCommands(paletteCmds);

  const online = !conn || conn.phase === "online";
  const live = phase.k === "live" && online;
  const sessionAgentId = currentEntry?.pane.agentId ?? agentId;
  const paneAgent = useAgent(agentKey(hostId, currentEntry?.pane.agentId ?? ""));
  const paneLabel =
    paneAgent?.name ?? (currentEntry ? entryLabel(currentEntry) : effective?.kind === "shell" ? "New shell" : (agent?.name ?? highlighted ?? "Terminal"));

  const tabs = (
    <PaneTabs
      hostId={hostId}
      panes={panes}
      active={highlighted}
      shellPending={effective?.kind === "shell" && !opened}
      onPick={(id) => {
        haptic("tick");
        select({ kind: "pane", paneId: id });
      }}
      onNewShell={newShell}
      compact={isMobile}
    />
  );

  const pane = target ? (
    <TerminalPane
      key={`${mode}|${effective?.kind === "shell" ? effective.nonce : ""}`}
      hostId={hostId}
      target={target}
      mode={mode}
      handleRef={handle}
      onOpened={setOpened}
      onPhase={setPhase}
    />
  ) : (
    <div className="grid h-full place-items-center p-6">
      {workspaces.length === 0 && !online ? (
        <div className="flex items-center gap-2 text-sm text-mute">
          <Spinner size={16} />
          {conn ? PHASE_LABEL[conn.phase] : "Connecting"}…
        </div>
      ) : (
        <EmptyState
          icon={<SquareTerminal />}
          title="No panes here yet"
          description="Open a shell in this workspace to get a real terminal."
          action={
            <Button variant="primary" icon={<Plus />} onClick={() => newShell("tab")}>
              New shell
            </Button>
          }
        />
      )}
    </div>
  );

  const modeToggle = (
    <SegmentedControl<TermMode>
      size="sm"
      aria-label="Terminal mode"
      value={mode}
      onValueChange={(m) => {
        haptic("select");
        setMode(m);
      }}
      options={[
        { value: "control", label: isMobile ? null : "Control", icon: <Keyboard /> },
        { value: "observe", label: isMobile ? null : "Observe", icon: <Eye /> },
      ]}
    />
  );

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MobileHeader
          back
          title={
            <span className="flex items-center gap-2">
              <StatusOrb status={live ? "running" : phase.k === "error" ? "error" : "idle"} activity={live ? "steady" : "silent"} size={8} label={null} />
              <span className="truncate">{paneLabel}</span>
            </span>
          }
          subtitle={online ? (workspace?.label ?? hostId) : <ReconnectingLabel phase={conn?.phase} />}
          actions={
            <>
              {modeToggle}
              <IconButton label="Take over" onClick={takeOver} disabled={mode === "observe"}>
                <Zap />
              </IconButton>
            </>
          }
        />
        <div className="shrink-0 px-2 pb-1.5">{tabs}</div>
        {urls.length > 0 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto px-3 pb-1.5 [scrollbar-width:none]">
            {urls.map((u) => (
              <PreviewButton key={u.port} hostId={hostId} port={u.port} label={u.url} />
            ))}
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden border-t border-line">{pane}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="relative grid size-10 place-items-center rounded-md bg-tile-3 shadow-d1 [&_svg]:size-5">
          <SquareTerminal className={cn(live ? "text-accent-hi" : "text-mute")} />
          <span className="absolute -right-0.5 -bottom-0.5">
            <StatusOrb status={live ? "running" : phase.k === "error" ? "error" : "idle"} activity={live ? "steady" : "silent"} size={9} label={null} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-bold text-ink">{paneLabel}</h1>
          <div className="flex min-w-0 items-center gap-2 text-xs text-mute">
            <span className="truncate">{workspace?.label ?? hostId}</span>
            {workspace?.repo && (
              <span className="truncate text-mute-2">
                {[workspace.repo.name !== workspace.label ? workspace.repo.name : null, workspace.worktree?.branch ?? workspace.repo.branch]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {!online && <ReconnectingLabel phase={conn?.phase} />}
          </div>
        </div>
        <AnimatePresence>
          {urls.map((u) => (
            <motion.div key={u.port} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={spring.bouncy}>
              <PreviewButton hostId={hostId} port={u.port} label={u.url} />
            </motion.div>
          ))}
        </AnimatePresence>
        {workspaces.length > 1 && (
          <WorkspacePicker
            workspaces={workspaces}
            current={workspace}
            onPick={(id) => {
              setWsPick({ key: propsKey, id });
              const first = workspacePanes(workspaces.find((w) => w.id === id))[0];
              if (first) select({ kind: "pane", paneId: first.pane.id });
            }}
          />
        )}
        {modeToggle}
        <div className="flex items-center rounded-md well p-0.5">
          <IconButton size="sm" label="Smaller text" onClick={() => setFont(font - 1)}>
            <Minus />
          </IconButton>
          <span className="w-9 text-center font-mono text-2xs font-bold text-mute tabular-nums">{font}px</span>
          <IconButton size="sm" label="Larger text" onClick={() => setFont(font + 1)}>
            <Plus />
          </IconButton>
        </div>
        <Tooltip content="Evict the other client and take input + sizing">
          <Button size="sm" variant={phase.k === "closed" || (phase.k === "error" && phase.error.code === "busy") ? "sunset" : "secondary"} icon={<Zap />} onClick={takeOver} disabled={mode === "observe"}>
            Take over
          </Button>
        </Tooltip>
        {sessionAgentId && (
          <Button size="sm" variant="ghost" icon={<MessageSquareText />} onClick={() => navigate({ name: "agent", hostId, agentId: sessionAgentId })}>
            Session
          </Button>
        )}
      </header>

      {tabs}

      <GlowBorder status="running" active={live} radius={22} width={1.25} className="min-h-0 flex-1">
        <div className="h-full overflow-hidden rounded-[22px] bg-bg-deep shadow-[var(--shadow-d2),inset_0_0_0_1px_rgb(255_255_255/0.06)]">{pane}</div>
      </GlowBorder>

      <SendKeysBar onSend={send} disabled={mode === "observe" || !live} />
    </div>
  );
}

function entryLabel(e: PaneEntry): string {
  return e.pane.title || basename(e.pane.cwd) || e.pane.id;
}

function ReconnectingLabel({ phase }: { phase: ConnPhase | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-bold text-warn">
      <Spinner size={11} label="Reconnecting" />
      {phase ? PHASE_LABEL[phase] : "Reconnecting"}
    </span>
  );
}

function PaneTabs({
  hostId,
  panes,
  active,
  shellPending,
  onPick,
  onNewShell,
  compact,
}: {
  hostId: string;
  panes: PaneEntry[];
  active: string | undefined;
  shellPending: boolean;
  onPick(paneId: string): void;
  onNewShell(split: Split): void;
  compact: boolean;
}) {
  return (
    <div role="tablist" aria-label="Panes" className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
      {panes.map((e, i) => (
        <PaneTab key={e.pane.id} hostId={hostId} entry={e} active={e.pane.id === active} divider={i > 0 && panes[i - 1]?.tabId !== e.tabId} onPick={onPick} />
      ))}
      {shellPending && (
        <span className="inline-flex h-8 shrink-0 items-center gap-2 rounded-sm bg-tile-4 px-3 text-xs font-bold text-ink shadow-d1">
          <Spinner size={12} /> New shell
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={<Plus />} trailing={compact ? undefined : <ChevronDown className="opacity-60" />} className="shrink-0">
            {compact ? "Shell" : "New shell"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Open a shell in this workspace</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SPLITS.map((s) => (
            <DropdownMenuItem key={s.split} icon={s.icon} onSelect={() => onNewShell(s.split)}>
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PaneTab({ hostId, entry, active, divider, onPick }: { hostId: string; entry: PaneEntry; active: boolean; divider: boolean; onPick(id: string): void }) {
  const agent = useAgent(agentKey(hostId, entry.pane.agentId ?? ""));
  const status = agent ? COLUMN_STATUS[agent.column] : "idle";
  const label = agent?.name ?? entryLabel(entry);
  return (
    <>
      {divider && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-2" />}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={`${entry.tabLabel} · ${entry.pane.id}`}
        onClick={() => onPick(entry.pane.id)}
        className={cn(
          "relative inline-flex h-8 max-w-56 shrink-0 items-center gap-2 rounded-sm px-3 text-xs font-bold whitespace-nowrap transition-colors focus-ring",
          active ? "text-ink" : "text-mute hover:bg-white/5 hover:text-ink",
        )}
      >
        {active && <motion.span layoutId={`term-tab-${hostId}`} transition={spring.snappy} aria-hidden className="absolute inset-0 rounded-sm bg-tile-4 shadow-d1" />}
        <span className="relative">
          {agent ? <StatusOrb status={status} activity={agent.column === "running" ? "busy" : "calm"} size={7} label={null} /> : <SquareTerminal className="size-3.5 text-mute-2" />}
        </span>
        <span className="relative truncate">{label}</span>
        <span className="relative font-mono text-2xs font-semibold text-mute-2">{entry.pane.id}</span>
      </button>
    </>
  );
}

function WorkspacePicker({ workspaces, current, onPick }: { workspaces: Workspace[]; current: Workspace | undefined; onPick(id: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" trailing={<ChevronDown className="opacity-60" />} className="max-w-56">
          <span className="truncate">{current?.label ?? "Workspace"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {[...workspaces]
          .sort((a, b) => a.order - b.order)
          .map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => onPick(w.id)} shortcut={w.id}>
              {w.label}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SendKeysBar({ onSend, disabled }: { onSend(bytes: string): void; disabled: boolean }) {
  return (
    <div role="toolbar" aria-label="Send keys" className="flex shrink-0 flex-wrap items-center gap-1.5">
      <span className="mr-1 kicker">Send</span>
      {SEND_KEYS.map((k) => (
        <motion.button
          key={k.id}
          type="button"
          aria-label={k.aria}
          title={k.hint ? `${k.aria}` : k.aria}
          disabled={disabled}
          whileTap={{ scale: 0.9, y: 1 }}
          transition={spring.press}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSend(k.bytes)}
          className={cn(
            "inline-flex h-8 min-w-9 items-center justify-center gap-1 rounded-sm bg-tile-3 px-2.5 font-mono text-xs font-bold text-ink-2 shadow-key transition-colors focus-ring hover:bg-tile-4 hover:text-ink disabled:opacity-40 [&_svg]:size-3.5",
            k.id === "ctrl-c" && "text-[#ff8aa5]",
          )}
        >
          {k.label}
        </motion.button>
      ))}
    </div>
  );
}
