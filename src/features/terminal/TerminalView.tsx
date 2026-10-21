import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  CloudOff,
  CornerDownLeft,
  Eye,
  Globe,
  Keyboard,
  MessageSquareText,
  Minus,
  PanelTop,
  Plus,
  RotateCcw,
  Search,
  Server,
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentKey, navigate, useAgent, useHosts, useSettings, useTunnels, useWorkspaces } from "@/core";
import type { ConnPhase, PaneInfo, Split, TermMode, TermOpened, TermTarget, Workspace } from "@/core/gen";
import {
  BottomSheet,
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
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Spinner,
  StatusOrb,
  type Status,
  Tooltip,
  cn,
  spring,
  useIsMobile,
} from "@/design";
import { usePaletteCommands, type PaletteCommand } from "@/features/palette/registry";
import { PreviewButton } from "@/features/preview/PreviewButton";
import { PreviewList } from "@/features/preview/PreviewList";
import { usePreviewStore } from "@/features/preview/store";
import { haptic } from "@/features/shell/haptics";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { COLUMN_STATUS, PHASE_LABEL, phaseBusy } from "@/features/shell/status";
import { encodeKey, type NamedKey } from "./keys";
import type { TermPhase } from "./session";
import { TabActions } from "./TabActions";
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

const SEND_KEYS: { id: string; label: ReactNode; aria: string; bytes: string }[] = [
  { id: "esc", label: "Esc", aria: "Escape", bytes: encodeKey("esc") },
  { id: "ctrl-c", label: "Ctrl+C", aria: "Control C (interrupt)", bytes: "\x03" },
  { id: "tab", label: "Tab", aria: "Tab", bytes: encodeKey("tab") },
  { id: "left", label: <ArrowLeft />, aria: "Left arrow", bytes: encodeKey("left") },
  { id: "up", label: <ArrowUp />, aria: "Up arrow", bytes: encodeKey("up") },
  { id: "down", label: <ArrowDown />, aria: "Down arrow", bytes: encodeKey("down") },
  { id: "right", label: <ArrowRight />, aria: "Right arrow", bytes: encodeKey("right") },
  { id: "enter", label: <CornerDownLeft />, aria: "Enter", bytes: encodeKey("enter" satisfies NamedKey) },
  { id: "ctrl-d", label: "Ctrl+D", aria: "Control D (end of input)", bytes: "\x04" },
  { id: "ctrl-l", label: "Ctrl+L", aria: "Control L (clear)", bytes: "\x0c" },
];

const SPLITS: { split: Split; label: string; icon: ReactNode; shortcut?: string }[] = [
  { split: "tab", label: "In a new tab", icon: <PanelTop />, shortcut: "Ctrl Shift T" },
  { split: "right", label: "Split right", icon: <SquareSplitHorizontal /> },
  { split: "down", label: "Split down", icon: <SquareSplitVertical /> },
];

/** Compact label for a detected URL: `:5173` plus its path, if any. */
function urlLabel(url: string, port: number): string {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  return `:${port}${path === "/" ? "" : path}`;
}

/** Full terminal screen: pane tabs, send-keys, mode, takeover, previews; desktop + mobile layouts. */
export function TerminalView({ hostId, paneId, agentId }: TerminalViewProps) {
  const isMobile = useIsMobile();
  const workspaces = useWorkspaces(hostId);
  const agent = useAgent(agentKey(hostId, agentId ?? ""));
  const conn = useHosts((h) => h.status[hostId]);
  const hostName = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
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
    selection ??
    (() => {
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
  const pickPane = useCallback(
    (id: string) => {
      haptic("tick");
      select({ kind: "pane", paneId: id });
    },
    [select],
  );
  const send = useCallback((bytes: string) => {
    handle.current?.send(bytes);
    handle.current?.focus();
  }, []);
  const setFont = useCallback((px: number) => void useSettings.getState().update({ terminalFontSize: clampFontSize(px) }), []);
  const font = clampFontSize(fontSize || DEFAULT_FONT_SIZE);
  const changeMode = useCallback((m: TermMode) => {
    haptic("select");
    setMode(m);
  }, []);
  const toggleMode = useCallback(() => changeMode(mode === "control" ? "observe" : "control"), [changeMode, mode]);
  const takeOver = useCallback(() => {
    haptic("heavy");
    setMode("control");
    handle.current?.reopen(true);
  }, []);

  // Keyboard-first: Ctrl+Shift chords bubble out of xterm (TerminalPane lets them through).
  const nav = useRef({ panes, highlighted });
  nav.current = { panes, highlighted };
  useEffect(() => {
    if (isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.repeat) return;
      if (e.code === "KeyM") {
        e.preventDefault();
        toggleMode();
      } else if (e.code === "KeyT") {
        e.preventDefault();
        newShell("tab");
      } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
        const { panes: list, highlighted: cur } = nav.current;
        if (list.length < 2) return;
        e.preventDefault();
        const i = list.findIndex((p) => p.pane.id === cur);
        const next = list[(i + (e.code === "BracketLeft" ? -1 : 1) + list.length) % list.length];
        if (next) pickPane(next.pane.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, toggleMode, newShell, pickPane]);

  const paletteCmds = useMemo<PaletteCommand[]>(
    () => [
      { id: "terminal.takeover", title: "Terminal: Take over input", group: "Terminal", icon: <Zap />, run: takeOver },
      { id: "terminal.find", title: "Terminal: Find on screen", group: "Terminal", icon: <Search />, shortcut: "Ctrl F", run: () => handle.current?.openSearch() },
      { id: "terminal.reattach", title: "Terminal: Reattach", group: "Terminal", icon: <RotateCcw />, run: () => handle.current?.reopen(false) },
      { id: "terminal.newShell", title: "Terminal: New shell", group: "Terminal", icon: <SquareTerminal />, shortcut: "Ctrl Shift T", run: () => newShell("tab") },
      {
        id: "terminal.mode",
        title: mode === "control" ? "Terminal: Observe only (read-only)" : "Terminal: Control (send input)",
        group: "Terminal",
        icon: mode === "control" ? <Eye /> : <Keyboard />,
        shortcut: "Ctrl Shift M",
        run: toggleMode,
      },
      { id: "terminal.fontUp", title: "Terminal: Larger text", group: "Terminal", icon: <Plus />, shortcut: "Ctrl +", run: () => setFont(font + 1) },
      { id: "terminal.fontDown", title: "Terminal: Smaller text", group: "Terminal", icon: <Minus />, shortcut: "Ctrl -", run: () => setFont(font - 1) },
    ],
    [takeOver, newShell, mode, toggleMode, setFont, font],
  );
  usePaletteCommands(paletteCmds);

  const online = !conn || conn.phase === "online";
  const live = phase.k === "live" && online;
  const busy = phase.k === "error" && phase.error.code === "busy";
  // Take over only means something when another client holds (or just took) the input lease.
  const needsTakeover = online && mode === "control" && (busy || (phase.k === "closed" && phase.takenOver));
  const failed = online && phase.k === "error" && !busy;
  const orb: Status = live ? (mode === "observe" ? "review" : "running") : needsTakeover ? "needs-you" : failed ? "error" : "idle";
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
      onPick={pickPane}
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
      onModeChange={changeMode}
    />
  ) : (
    <div className="grid h-full place-items-center p-6">
      {workspaces.length === 0 && !online ? (
        <EmptyState
          icon={phaseBusy(conn?.phase) ? <Spinner size={22} label={PHASE_LABEL[conn?.phase ?? "connecting"]} /> : <CloudOff />}
          title={phaseBusy(conn?.phase) ? `${PHASE_LABEL[conn?.phase ?? "connecting"]} to ${hostName}…` : `${hostName} is ${conn ? PHASE_LABEL[conn.phase].toLowerCase() : "offline"}`}
          description="Its panes show up here, and terminals attach, as soon as the host is online."
          action={
            <Button icon={<Server />} onClick={() => navigate({ name: "hosts" })}>
              Hosts
            </Button>
          }
        />
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
      onValueChange={changeMode}
      options={[
        { value: "control", label: <span className={isMobile ? "sr-only" : "@max-[860px]:sr-only"}>Control</span>, icon: <Keyboard /> },
        { value: "observe", label: <span className={isMobile ? "sr-only" : "@max-[860px]:sr-only"}>Observe</span>, icon: <Eye /> },
      ]}
      className={cn(mode === "observe" && "shadow-[inset_0_0_0_1px_rgb(34_211_238/0.35)]")}
    />
  );

  // Detected dev servers. Mobile shows the newest one in the tab row, so a URL never resizes the pane.
  const detected = (
    <AnimatePresence initial={false}>
      {(isMobile ? urls.slice(0, 1) : urls).map((u) => (
        <motion.div
          key={u.port}
          layout
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={spring.bouncy}
          className={cn("shrink-0", isMobile ? "max-w-32" : "max-w-52")}
        >
          <PreviewButton hostId={hostId} port={u.port} label={urlLabel(u.url, u.port)} />
        </motion.div>
      ))}
    </AnimatePresence>
  );

  // State line along the pane edge (mobile): purple driving, cyan watching, sunset needs a decision.
  const edge = live ? (mode === "observe" ? "bg-[linear-gradient(90deg,#22d3ee,#0ea5e9)]" : "bg-run") : needsTakeover ? "bg-sun" : failed ? "bg-error" : "bg-transparent";

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MobileHeader
          back
          title={
            <span className="flex min-w-0 items-center gap-2">
              <StatusOrb status={orb} activity={live ? "steady" : "silent"} size={8} label={null} />
              <span className="truncate">{paneLabel}</span>
            </span>
          }
          subtitle={online ? (workspace?.label ?? hostName) : <ReconnectingLabel phase={conn?.phase} />}
          actions={
            <>
              {modeToggle}
              <AnimatePresence initial={false}>
                {needsTakeover && (
                  <motion.span key="takeover" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={spring.bouncy}>
                    <IconButton label="Take over" variant="sunset" onClick={takeOver}>
                      <Zap />
                    </IconButton>
                  </motion.span>
                )}
              </AnimatePresence>
            </>
          }
        />
        <div className="flex shrink-0 items-center gap-1 pr-2 pb-1.5 pl-2">
          <div className="min-w-0 flex-1">{tabs}</div>
          {detected}
          <PreviewsMenu mobile />
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div aria-hidden className={cn("absolute inset-x-0 top-0 z-raised h-[2px] transition-colors duration-500", edge)} />
          {pane}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="@container flex shrink-0 items-center gap-3">
        <div className="relative grid size-10 shrink-0 place-items-center rounded-md bg-tile-3 shadow-d1 [&_svg]:size-5">
          {mode === "observe" ? (
            <Eye className={cn(live ? "text-review" : "text-mute")} />
          ) : (
            <SquareTerminal className={cn(live ? "text-accent-hi" : "text-mute")} />
          )}
          <span className="absolute -right-0.5 -bottom-0.5">
            <StatusOrb status={orb} activity={live ? "steady" : "silent"} size={9} label={null} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-bold text-ink">{paneLabel}</h1>
          <div className="flex min-w-0 items-center gap-2 text-xs text-mute">
            <span className="truncate">{workspace?.label ?? hostName}</span>
            {workspace?.repo && (
              <span className="truncate text-mute-2 @max-[640px]:hidden">
                {[workspace.repo.name !== workspace.label ? workspace.repo.name : null, workspace.worktree?.branch ?? workspace.repo.branch].filter(Boolean).join(" · ")}
              </span>
            )}
            {!online && <ReconnectingLabel phase={conn?.phase} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          <Tooltip content={<span className="flex items-center gap-2">Control types into the pane · Observe is read-only<Kbd>Ctrl Shift M</Kbd></span>}>
            <span>{modeToggle}</span>
          </Tooltip>
          <div role="group" aria-label="Text size" className="flex items-center rounded-md well p-0.5 @max-[820px]:hidden">
            <IconButton size="sm" label="Smaller text (Ctrl −)" onClick={() => setFont(font - 1)}>
              <Minus />
            </IconButton>
            <span className="w-9 text-center font-mono text-2xs font-bold text-mute tabular-nums" aria-live="polite">
              {font}px
            </span>
            <IconButton size="sm" label="Larger text (Ctrl +)" onClick={() => setFont(font + 1)}>
              <Plus />
            </IconButton>
          </div>
          <AnimatePresence initial={false}>
            {needsTakeover && (
              <motion.div key="takeover" initial={{ opacity: 0, scale: 0.85, x: 8 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.85, x: 8 }} transition={spring.bouncy}>
                <Tooltip content="Evict the other client and take input + sizing">
                  <Button size="sm" variant="sunset" icon={<Zap />} onClick={takeOver}>
                    Take over
                  </Button>
                </Tooltip>
              </motion.div>
            )}
          </AnimatePresence>
          {sessionAgentId && (
            <Button
              size="sm"
              variant="ghost"
              icon={<MessageSquareText />}
              aria-label="Open session"
              onClick={() => navigate({ name: "agent", hostId, agentId: sessionAgentId })}
            >
              <span className="@max-[860px]:sr-only">Session</span>
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">{tabs}</div>
        {detected}
        <PreviewsMenu />
      </div>

      <GlowBorder status={mode === "observe" ? "review" : "running"} active={live} radius={22} width={1.25} speed={mode === "observe" ? 7 : undefined} className="min-h-0 flex-1">
        <div className="relative h-full overflow-hidden rounded-[22px] bg-bg-deep shadow-[var(--shadow-d2)]">
          {pane}
          {/* hairline + state ring above the terminal (a parent's inset shadow would sit under it) */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 z-raised rounded-[22px] transition-shadow duration-500",
              needsTakeover
                ? "shadow-[inset_0_0_0_1.5px_rgb(255_61_119/0.6),inset_0_0_40px_-12px_rgb(255_61_119/0.45)]"
                : failed
                  ? "shadow-[inset_0_0_0_1.5px_rgb(255_77_94/0.55)]"
                  : "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]",
            )}
          />
        </div>
      </GlowBorder>

      <footer className="@container flex min-h-8 shrink-0 items-center gap-3">
        {mode === "control" && <SendKeysBar onSend={send} disabled={!live} />}
        <div className="ml-auto flex shrink-0 items-center gap-3 text-2xs text-mute-2 @max-[900px]:hidden" aria-label="Terminal shortcuts">
          <span className="flex items-center gap-1">
            <Kbd>Ctrl Shift M</Kbd> mode
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Ctrl Shift T</Kbd> shell
          </span>
          {panes.length > 1 && (
            <span className="flex items-center gap-1">
              <Kbd>Ctrl Shift [ ]</Kbd> panes
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

function entryLabel(e: PaneEntry): string {
  return e.pane.title || basename(e.pane.cwd) || e.pane.id;
}

function ReconnectingLabel({ phase }: { phase: ConnPhase | undefined }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-bold text-warn">
      {phaseBusy(phase) ? <Spinner size={11} label="Reconnecting" /> : <CloudOff className="size-3" aria-hidden />}
      {phase ? PHASE_LABEL[phase] : "Reconnecting"}
    </span>
  );
}

/** Open preview tunnels (all hosts) behind a globe button: a popover on desktop, a sheet on mobile. */
function PreviewsMenu({ mobile = false }: { mobile?: boolean }) {
  const live = useTunnels().length;
  const opening = usePreviewStore((s) => Object.values(s.pending).some((p) => p.state === "opening"));
  const failed = usePreviewStore((s) => Object.values(s.pending).some((p) => p.state === "error"));
  const [open, setOpen] = useState(false);
  const label = [live ? `Previews: ${live} open` : "Previews", opening && "opening", failed && "one failed"].filter(Boolean).join(", ");
  const trigger = (
    <IconButton label={label} size={mobile ? "md" : "sm"} variant={live ? "secondary" : "ghost"} onClick={mobile ? () => setOpen(true) : undefined}>
      <span className="relative grid place-items-center">
        {opening ? <Spinner size={14} /> : <Globe />}
        {live > 0 && (
          <span className="absolute -top-1.5 -right-2 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-done px-0.5 font-mono text-[9px] leading-none font-extrabold text-[#1a2e05]">
            {live}
          </span>
        )}
        {failed && <span aria-hidden className="absolute -bottom-1 -left-1 size-2 rounded-full bg-error shadow-[0_0_0_2px_var(--color-bg)]" />}
      </span>
    </IconButton>
  );
  if (mobile) {
    return (
      <>
        {trigger}
        <BottomSheet open={open} onOpenChange={setOpen} title="Previews" description="Dev servers on your hosts, tunnelled over SSH.">
          <PreviewList className="pb-2" />
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-2">
        <div className="flex items-baseline justify-between px-2 pt-1 pb-2">
          <span className="kicker">Previews</span>
          <span className="text-2xs text-mute-2">SSH tunnels to dev servers</span>
        </div>
        <PreviewList />
      </PopoverContent>
    </Popover>
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
  // Roving arrows between tabs (WAI-ARIA tabs pattern); selection follows focus.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || tabs.length === 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
    const el = tabs[next];
    el?.focus();
    if (el?.dataset.paneId) onPick(el.dataset.paneId);
  };
  return (
    <div role="tablist" aria-label="Panes" onKeyDown={onKeyDown} className="flex min-w-0 items-center gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]">
      {panes.map((e, i) => {
        const tabPaneIds = panes.filter((p) => p.tabId === e.tabId).map((p) => p.pane.id);
        return (
          <PaneTab
            key={e.pane.id}
            hostId={hostId}
            entry={e}
            active={e.pane.id === active}
            divider={i > 0 && panes[i - 1]?.tabId !== e.tabId}
            onPick={onPick}
            compact={compact}
            tabPaneIds={tabPaneIds}
            onClosed={(closed) => {
              // Closing the attached pane: move to the nearest survivor.
              if (!active || !closed.includes(active)) return;
              const rest = panes.filter((p) => !closed.includes(p.pane.id));
              const next = rest[Math.min(i, rest.length - 1)];
              if (next) onPick(next.pane.id);
            }}
          />
        );
      })}
      {shellPending && (
        <span className="inline-flex h-8 shrink-0 items-center gap-2 rounded-sm bg-tile-4 px-3 text-xs font-bold text-ink shadow-d1">
          <Spinner size={12} /> New shell
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={<Plus />} trailing={compact ? undefined : <ChevronDown className="opacity-60" />} className="shrink-0" aria-label="New shell">
            {compact ? "Shell" : "New shell"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Open a shell in this workspace</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SPLITS.map((s) => (
            <DropdownMenuItem key={s.split} icon={s.icon} shortcut={compact ? undefined : s.shortcut} onSelect={() => onNewShell(s.split)}>
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PaneTab({
  hostId,
  entry,
  active,
  divider,
  onPick,
  compact,
  tabPaneIds,
  onClosed,
}: {
  hostId: string;
  entry: PaneEntry;
  active: boolean;
  divider: boolean;
  onPick(id: string): void;
  compact: boolean;
  tabPaneIds: string[];
  onClosed(paneIds: string[]): void;
}) {
  const agent = useAgent(agentKey(hostId, entry.pane.agentId ?? ""));
  const status = agent ? COLUMN_STATUS[agent.column] : "idle";
  const label = agent?.name ?? entryLabel(entry);
  return (
    <>
      {divider && <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-2" />}
      <TabActions
        hostId={hostId}
        target={{
          paneId: entry.pane.id,
          tabId: entry.tabId,
          tabLabel: entry.tabLabel,
          label,
          hasAgent: Boolean(entry.pane.agentId),
          tabPaneCount: tabPaneIds.length,
        }}
        tabPaneIds={tabPaneIds}
        onClosed={onClosed}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          data-pane-id={entry.pane.id}
          title={`${entry.tabLabel} · ${entry.pane.id}`}
          onClick={() => onPick(entry.pane.id)}
          className={cn(
            "relative inline-flex shrink-0 items-center gap-2 rounded-sm px-3 text-xs font-bold whitespace-nowrap transition-colors focus-ring",
            compact ? "h-9 max-w-44" : "h-8 max-w-56",
            active ? "text-ink" : "text-mute hover:bg-white/5 hover:text-ink",
          )}
        >
          {active && <motion.span layoutId={`term-tab-${hostId}`} transition={spring.snappy} aria-hidden className="absolute inset-0 rounded-sm bg-tile-4 shadow-d1" />}
          <span className="relative">
            {agent ? <StatusOrb status={status} activity={agent.column === "running" ? "busy" : "calm"} size={7} label={null} /> : <SquareTerminal className="size-3.5 text-mute-2" />}
          </span>
          <span className="relative truncate">{label}</span>
          {!compact && <span className="relative font-mono text-2xs font-semibold text-mute-2">{entry.pane.id}</span>}
        </button>
      </TabActions>
    </>
  );
}

function WorkspacePicker({ workspaces, current, onPick }: { workspaces: Workspace[]; current: Workspace | undefined; onPick(id: string): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" trailing={<ChevronDown className="opacity-60" />} className="max-w-56 @max-[720px]:max-w-32" aria-label={`Workspace: ${current?.label ?? "none"}`}>
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
    <div role="toolbar" aria-label="Send keys" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-1 kicker">Send</span>
      {SEND_KEYS.map((k) => (
        <motion.button
          key={k.id}
          type="button"
          aria-label={k.aria}
          title={k.aria}
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
