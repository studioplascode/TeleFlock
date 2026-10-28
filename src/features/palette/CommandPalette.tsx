import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BarChart3,
  Bell,
  BellOff,
  Blocks,
  KeyRound,
  Bot,
  Clock3,
  CornerDownLeft,
  FolderGit2,
  FolderOpen,
  GitBranchPlus,
  GitFork,
  History,
  Inbox,
  Keyboard,
  LayoutDashboard,
  Columns2,
  MessageSquareReply,
  PanelLeft,
  Plug,
  PlugZap,
  Send,
  Server,
  Settings2,
  Sparkles,
  Square,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
  Spinner,
  spring,
  StatusOrb,
  toast,
  useMotionPreference,
} from "@/design";
import {
  agentKey,
  core,
  getAgentViews,
  getWorkspacesSnapshot,
  navigate,
  useHosts,
  useRoute,
  useSettings,
  useUi,
  type Route,
} from "@/core";
import type { MotionPref, ThinkingLevel } from "@/core/gen";
import { archiveWithUndo, openAnswerHud, openTerminal, setArchived, setMuted, stopAgent } from "@/features/board/agentActions";
import { connect } from "@/features/hosts/ConnStatusCard";
import { MOTION_COPY } from "@/features/settings/parts";
import { openNewAgent } from "@/features/workspace/NewAgentDialog";
import { toggleSplit } from "@/features/shell/keyboard";
import { toggleSidebar } from "@/features/shell/sidebarState";
import { COLUMN_STATUS, PHASE_STATUS } from "@/features/shell/status";
import { ACTIONS, type ActionDef, VIEWS } from "@/features/shell/vocab";
import { paneDetail, paneName } from "@/features/terminal/panes";
import { rankItem } from "./fuzzy";
import { type PaletteCommand, useContributed, useRecents } from "./registry";
import { hostCall, type PalettePage, sessionCommands } from "./sessionCommands";

/** One row in the palette. */
interface Entry {
  id: string;
  title: string;
  group: string;
  keywords: string[];
  icon: ReactNode;
  hint?: string;
  shortcut?: string;
  /** Runs and closes, or opens a sub-page. */
  run?: () => void | Promise<unknown>;
  page?: PalettePage;
}

const GROUP_ORDER = ["Recent", "This session", "Actions", "Views", "Agents", "Workspaces", "Shells", "Hosts", "Contributed"];
const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const MAX_RESULTS = 60;

/** Build the full entry list once per open (agents/workspaces are a snapshot taken on open). */
function useEntries(): Entry[] {
  const ui = useUi();
  const route = useRoute();
  const { profiles, status, setFilter } = useHosts();
  const settings = useSettings();
  const setMotion = useMotionPreference((s) => s.setPreference);
  const contributed = useContributed((s) => s.sources);
  const [agents] = useState(getAgentViews);
  const [workspaces] = useState(getWorkspacesSnapshot);

  const ctxKey = route.name === "agent" ? agentKey(route.hostId, route.agentId) : ui.selectedKey;
  const ctxAgent = ctxKey ? agents.find((a) => a.key === ctxKey) : undefined;
  const hostName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const firstOnline = profiles.find((p) => status[p.id]?.phase === "online")?.id;
  const defaultHost = ctxAgent?.hostId ?? firstOnline;

  const entries: Entry[] = [];

  if (ctxAgent) {
    const name = ctxAgent.name;
    for (const c of sessionCommands(ctxAgent.hostId, ctxAgent)) {
      entries.push({ id: `session:${c.id}`, title: c.title, group: "This session", keywords: [...c.keywords, name], icon: c.icon, hint: c.hint, run: c.run, page: c.page });
    }
    if (ctxAgent.column === "needs") {
      entries.push({ id: "session:answer", title: `${ACTIONS.answer.label} ${name}`, group: "This session", keywords: ["answer", "question", "reply", "approve"], icon: <MessageSquareReply />, hint: ACTIONS.answer.description, run: () => openAnswerHud(ctxAgent.key) });
    }
    if (ctxAgent.column === "running") {
      entries.push({ id: "session:stop", title: ACTIONS.stopTurn.label, group: "This session", keywords: ["stop", "interrupt", "cancel", "esc", name], icon: <Square />, hint: ACTIONS.stopTurn.description, run: () => stopAgent(ctxAgent.key) });
    }
    const muted = (settings.mutedAgents ?? []).includes(ctxAgent.key);
    const muteDef = muted ? ACTIONS.unmute : ACTIONS.mute;
    entries.push({ id: "session:mute", title: muteDef.label, group: "This session", keywords: ["mute", "unmute", "silence", "quiet", "notifications", name], icon: muted ? <Bell /> : <BellOff />, hint: muteDef.description, run: () => setMuted([ctxAgent.key], !muted) });
    entries.push(
      {
        id: "session:terminal",
        title: `${ACTIONS.terminal.label}: ${name}`,
        group: "This session",
        keywords: ["terminal", "pane", "tty"],
        icon: <SquareTerminal />,
        shortcut: ACTIONS.terminal.shortcut,
        hint: ACTIONS.terminal.description,
        // The full Terminal view (`openTerminal`'s phone form); a parked agent resumes first, then its new pane opens.
        run: () => openTerminal(ctxAgent.key, true),
      },
      ctxAgent.archived
        ? {
            id: "session:reopen",
            title: `${ACTIONS.reopen.label} ${name}`,
            group: "This session",
            keywords: ["unarchive", "reopen", "restore"],
            icon: <ArchiveRestore />,
            hint: ACTIONS.reopen.description,
            run: () => setArchived(ctxAgent.key, false),
          }
        : {
            id: "session:mark-done",
            title: `${ACTIONS.markDone.label}: ${name}`,
            group: "This session",
            keywords: ["archive", "done", "hide", "finish"],
            icon: <Archive />,
            hint: ACTIONS.markDone.description,
            run: () => archiveWithUndo([ctxAgent.key]),
          },
    );
  }

  const action = (id: string, def: ActionDef, icon: ReactNode, keywords: string[], run: () => void | Promise<unknown>): Entry => ({
    id,
    title: def.label,
    group: "Actions",
    keywords,
    icon,
    shortcut: def.shortcut,
    hint: def.description,
    run,
  });
  entries.push(
    action("act:new-task", ACTIONS.newTask, <Send />, ["task", "start", "branch", "dispatch", "send", "worktree", "quick"], () => navigate({ name: "dispatch" })),
    action("act:new-worktree", ACTIONS.newWorktree, <GitBranchPlus />, ["task", "start", "branch", "create", "git", "agent"], () => ui.openDialog({ kind: "newWorktree", hostId: defaultHost })),
    action("act:new-agent", ACTIONS.newAgent, <Bot />, ["start", "omp", "spawn"], () => ui.openDialog({ kind: "newAgent", hostId: defaultHost })),
    action("act:fan-out", ACTIONS.fanOut, <GitFork />, ["parallel", "compare", "many agents", "models", "worktrees"], () => ui.openDialog({ kind: "fanOut", hostId: defaultHost })),
    action("act:answer-next", ACTIONS.answerNext, <Zap />, ["answer", "question", "needs you", "reply", "unblock", "inbox"], () => ui.setAnswerNext(true)),
    action("act:past", ACTIONS.pastSessions, <History />, ["history", "resume"], () => ui.openDialog({ kind: "pastSessions", hostId: defaultHost })),
    action("act:open-folder", ACTIONS.openFolder, <FolderOpen />, ["folder", "workspace", "directory", "browse"], () => openNewAgent({ hostId: defaultHost, openFolder: true })),
    { id: "act:split", title: ui.split ? "Close split view" : "Split view", group: "Actions", keywords: ["side by side", "terminal", "pane"], icon: <Columns2 />, shortcut: ACTIONS.terminalBeside.shortcut, hint: ACTIONS.terminalBeside.description, run: () => toggleSplit(ui, route) },
    { id: "act:sidebar", title: "Toggle sidebar", group: "Actions", keywords: ["panel", "show", "hide"], icon: <PanelLeft />, shortcut: "Ctrl B", run: toggleSidebar },
    { id: "act:add-host", title: "Add a host…", group: "Actions", keywords: ["connect", "tailscale", "ssh", "wsl", "local"], icon: <Server />, hint: "Connect a machine over Tailscale SSH, locally or in WSL", run: () => ui.openDialog({ kind: "hostEditor" }) },
    { id: "act:shortcuts", title: "Keyboard shortcuts", group: "Actions", keywords: ["keys", "help", "?", "terms", "glossary"], icon: <Keyboard />, shortcut: "?", hint: "Every key, and what TeleFlock's words mean", run: () => ui.openDialog({ kind: "shortcuts" }) },
  );
  for (const m of ["system", "full", "reduced"] as const satisfies readonly MotionPref[]) {
    if (m === settings.motion) continue;
    entries.push({
      id: `act:motion-${m}`,
      title: `Motion: ${MOTION_COPY[m].label}`,
      group: "Actions",
      keywords: ["animation", "reduced motion", "accessibility", "settings", "calm", "lively"],
      icon: <Sparkles />,
      hint: MOTION_COPY[m].description,
      run: () => {
        setMotion(m);
        return settings.update({ motion: m });
      },
    });
  }

  const views: { id: Route["name"] & keyof typeof VIEWS; icon: ReactNode; keys: string[] }[] = [
    { id: "board", icon: <LayoutDashboard />, keys: ["home", "kanban", "flock", "lanes"] },
    { id: "dispatch", icon: <Send />, keys: ["send", "fire", "tasks", "many agents", "worktree", "quick"] },
    { id: "inbox", icon: <Inbox />, keys: ["needs you", "questions", "updates", "notifications"] },
    { id: "activity", icon: <Activity />, keys: ["timeline", "feed", "history"] },
    { id: "usage", icon: <BarChart3 />, keys: ["cost", "tokens", "spend", "limits", "subscription"] },
    { id: "hosts", icon: <Server />, keys: ["machines", "connections"] },
    { id: "settings", icon: <Settings2 />, keys: ["preferences", "options"] },
    { id: "automations", icon: <Clock3 />, keys: ["schedule", "cron", "recurring", "timer", "nightly"] },
    { id: "omp", icon: <Bot />, keys: ["omp config", "models", "roles", "model roles", "harness", "tools", "approval", "compaction"] },
    { id: "mcp", icon: <Blocks />, keys: ["mcp", "tools", "servers", "model context protocol", "integrations", "plugins", "oauth"] },
    { id: "accounts", icon: <KeyRound />, keys: ["accounts", "login", "sign in", "subscription", "provider", "claude", "chatgpt", "codex", "link account"] },
  ];
  for (const v of views) {
    const def: ActionDef = VIEWS[v.id];
    entries.push({ id: `view:${v.id}`, title: def.label, group: "Views", keywords: v.keys, icon: v.icon, shortcut: def.shortcut, hint: def.description, run: () => navigate({ name: v.id } as Route) });
  }
  if (defaultHost) {
    entries.push({ id: "view:terminal", title: "Terminal", group: "Views", keywords: ["shell", "tty", "herdr"], icon: <SquareTerminal />, run: () => navigate({ name: "terminal", hostId: defaultHost }) });
  }

  for (const a of agents) {
    entries.push({
      id: `agent:${a.key}`,
      title: a.name,
      group: "Agents",
      keywords: [a.title, a.repo ?? "", a.branch ?? "", a.kind, hostName(a.hostId), a.column],
      icon: <StatusOrb status={COLUMN_STATUS[a.column]} size={9} label={null} />,
      hint: [a.title, a.repo && a.branch ? `${a.repo} · ${a.branch}` : a.repo].filter(Boolean).join(" — "),
      run: () => navigate({ name: "agent", hostId: a.hostId, agentId: a.id }),
    });
  }

  for (const { hostId, ws } of workspaces) {
    const repo = ws.repo?.name;
    const branch = ws.worktree?.branch ?? ws.repo?.branch;
    entries.push({
      id: `ws:${hostId}:${ws.id}`,
      title: ws.label,
      group: "Workspaces",
      keywords: [repo ?? "", branch ?? "", ws.cwd, hostName(hostId)],
      icon: ws.worktree ? <FolderGit2 /> : <FolderOpen />,
      hint: [repo, branch].filter(Boolean).join(" · ") || ws.cwd,
      run: () => (ws.repo ? navigate({ name: "review", hostId, workspaceId: ws.id }) : ui.openDialog({ kind: "newAgent", hostId, workspaceId: ws.id })),
    });
  }

  // Existing panes no agent owns: attaching never creates a pane.
  for (const { hostId, ws } of workspaces) {
    for (const tab of ws.tabs) {
      for (const pane of tab.panes) {
        if (pane.agentId) continue;
        const name = paneName(pane);
        entries.push({
          id: `pane:${hostId}:${pane.id}`,
          title: `Shell · ${name} · ${ws.label}`,
          group: "Shells",
          keywords: ["shell", "terminal", "pane", tab.label, pane.process ?? "", pane.title ?? "", pane.cwd ?? "", hostName(hostId)],
          icon: <SquareTerminal />,
          hint: [profiles.length > 1 ? hostName(hostId) : null, `tab ${tab.label}`, paneDetail(pane, undefined, ws.cwd)].filter(Boolean).join(" · "),
          run: () => navigate({ name: "terminal", hostId, paneId: pane.id }),
        });
      }
    }
  }

  for (const p of profiles) {
    const phase = status[p.id]?.phase ?? "idle";
    const online = phase === "online";
    entries.push({
      id: `host:${p.id}`,
      title: online ? `Show only ${p.name}` : `Connect ${p.name}`,
      group: "Hosts",
      keywords: ["host", "filter", "connect", p.address ?? "", p.kind],
      icon: online ? <StatusOrb status={PHASE_STATUS[phase]} size={9} label={null} /> : <Plug />,
      hint: phase,
      run: () => (online ? setFilter(p.id) : connect(p.id)),
    });
  }
  if (profiles.length > 1) {
    entries.push({ id: "host:all", title: "Show all hosts", group: "Hosts", keywords: ["filter", "everything"], icon: <PlugZap />, run: () => setFilter("all") });
  }

  for (const cmds of Object.values(contributed)) {
    for (const c of cmds as PaletteCommand[]) {
      entries.push({ id: `c:${c.id}`, title: c.title, group: c.group ?? "Contributed", keywords: c.keywords ?? [], icon: c.icon ?? <Sparkles />, hint: c.hint, shortcut: c.shortcut, run: c.run });
    }
  }
  return entries;
}

/** Rank and group entries for a query. Empty query: recents first, then every group in order. */
function arrange(entries: Entry[], query: string, recents: string[]): [string, Entry[]][] {
  const q = query.trim();
  if (!q) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const recent = recents.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
    const groups = new Map<string, Entry[]>();
    if (recent.length) groups.set("Recent", recent);
    for (const e of entries) {
      if (recent.includes(e)) continue;
      const list = groups.get(e.group) ?? [];
      list.push(e);
      groups.set(e.group, list);
    }
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i < 0 ? GROUP_ORDER.length - 1 : i;
    };
    return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }
  const scored: { e: Entry; s: number }[] = [];
  for (const e of entries) {
    const s = rankItem(q, e.title, e.keywords);
    if (s === null) continue;
    // recently used entries float up a little
    const r = recents.indexOf(e.id);
    scored.push({ e, s: s + (r >= 0 ? 60 - r * 6 : 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, MAX_RESULTS);
  const groups = new Map<string, { best: number; list: Entry[] }>();
  for (const { e, s } of top) {
    const g = groups.get(e.group) ?? { best: s, list: [] };
    g.list.push(e);
    groups.set(e.group, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].best - a[1].best).map(([g, v]) => [g, v.list]);
}

function ModelPage({ hostId, agentId, query, done }: { hostId: string; agentId: string; query: string; done: () => void }) {
  const [models, setModels] = useState<{ value: string; label: string; hint: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    core
      .host(hostId)
      .call("host.models", {})
      .then(
        (c) => live && setModels(c.models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider }))),
        () => live && setModels([]),
      );
    return () => {
      live = false;
    };
  }, [hostId]);
  if (!models) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-mute">
        <Spinner /> Loading models…
      </div>
    );
  }
  const ranked = models
    .map((m) => ({ m, s: rankItem(query, m.label, [m.value, m.hint]) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => (b.s ?? 0) - (a.s ?? 0));
  return (
    <CommandGroup heading="Models">
      {ranked.map(({ m }) => (
        <CommandItem
          key={m.value}
          value={m.value}
          icon={<Bot />}
          onSelect={() => {
            done();
            void hostCall(`Switched to ${m.label}`, core.host(hostId).call("agent.setModel", { agentId, model: m.value }));
          }}
        >
          {m.label} <span className="ml-1 text-xs text-mute-2">{m.hint}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function ThinkingPage({ hostId, agentId, query, done }: { hostId: string; agentId: string; query: string; done: () => void }) {
  return (
    <CommandGroup heading="Thinking level">
      {THINKING.filter((t) => rankItem(query, t) !== null).map((level) => (
        <CommandItem
          key={level}
          value={level}
          icon={<Sparkles />}
          onSelect={() => {
            done();
            void hostCall(`Thinking: ${level}`, core.host(hostId).call("agent.setThinking", { agentId, level }));
          }}
        >
          {level}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/**
 * The command palette (Ctrl+K): ranked fuzzy search over agents, workspaces, shells (existing panes), hosts, views and
 * actions; slash commands for the current session with argument pages; recents first.
 */
export function CommandPalette() {
  const { paletteOpen, setPalette } = useUi();
  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPalette} commandProps={{ shouldFilter: false, loop: true }}>
      {paletteOpen && <PaletteBody close={() => setPalette(false)} />}
    </CommandDialog>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const entries = useEntries();
  const recents = useRecents((s) => s.ids);
  const pushRecent = useRecents((s) => s.push);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PalettePage | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // cmdk scrolls the newly selected first result into view before React re-orders the ranked list,
  // which left the list scrolled deep into the old order with the top match out of sight.
  useEffect(() => {
    const raf = requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(raf);
  }, [query, page]);

  const choose = (e: Entry) => {
    pushRecent(e.id);
    if (e.page) {
      setPage(e.page);
      setQuery("");
      return;
    }
    close();
    const r = e.run?.();
    if (r instanceof Promise) r.catch((err: unknown) => toast({ title: `${e.title} failed`, description: String(err), status: "error" }));
  };

  const back = () => {
    setPage(null);
    setQuery("");
  };

  const placeholder = page
    ? page.kind === "text"
      ? page.placeholder
      : page.kind === "model"
        ? "Search models…"
        : "Pick a thinking level…"
    : "Search agents, workspaces, shells, hosts, or run a command…";

  return (
    <>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (page && e.key === "Backspace" && query === "") {
            e.preventDefault();
            back();
          }
          if (page && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            back();
          }
        }}
      />
      {page && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={spring.snappy} className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-mute">
          <button type="button" onClick={back} className="inline-flex items-center gap-1 rounded-xs font-bold text-ink-2 focus-ring hover:text-ink">
            <ArrowLeft className="size-3.5" /> Back
          </button>
          <span className="kicker">{page.kind === "text" ? page.title : page.kind === "model" ? "Switch model" : "Thinking"}</span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>⌫</Kbd> to go back
          </span>
        </motion.div>
      )}
      <CommandList ref={listRef}>
        {page?.kind === "model" && <ModelPage hostId={page.hostId} agentId={page.agentId} query={query} done={close} />}
        {page?.kind === "thinking" && <ThinkingPage hostId={page.hostId} agentId={page.agentId} query={query} done={close} />}
        {page?.kind === "text" && (
          <CommandGroup heading={page.title}>
            <CommandItem
              value="submit"
              icon={busy ? <Spinner size={14} /> : <CornerDownLeft />}
              disabled={busy || (!page.allowEmpty && !query.trim())}
              onSelect={() => {
                setBusy(true);
                page.run(query.trim()).finally(() => {
                  setBusy(false);
                  close();
                });
              }}
            >
              {query.trim() ? `${page.submitLabel}: “${query.trim()}”` : page.allowEmpty ? page.submitLabel : `Type to ${page.submitLabel.toLowerCase()}`}
            </CommandItem>
          </CommandGroup>
        )}
        {!page && (
          <>
            <CommandEmpty>No matches. Try an agent name, a repo, or “new”.</CommandEmpty>
            {arrange(entries, query, recents).map(([group, list]) => (
              <CommandGroup key={group} heading={group}>
                {list.map((e) => (
                  <CommandItem key={`${group}:${e.id}`} value={`${group}:${e.id}`} icon={e.icon} shortcut={e.shortcut} onSelect={() => choose(e)}>
                    {e.title}
                    {e.hint && <span className="ml-2 text-xs font-medium text-mute-2">{e.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-2xs text-mute-2">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> run
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
        <span className="ml-auto">fuzzy · recents first</span>
      </div>
    </>
  );
}
