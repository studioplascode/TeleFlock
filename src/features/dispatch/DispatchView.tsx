import { AnimatePresence, motion } from "motion/react";
import { Eraser, FolderGit2, FolderSearch, MoreHorizontal, Send, Server } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { draftKey, navigate, useHostIds, useHostState, useHosts, useSettings, useUi } from "@/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  StatusPill,
  cn,
  spring,
  useIsMobile,
} from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";
import { DispatchComposer, type DispatchComposerHandle } from "./DispatchComposer";
import { DispatchItem, type ThreadContext, ThreadCtx } from "./DispatchItem";
import { BasePicker, HostPicker, RepoBrowser, RepoPicker } from "./RepoBar";
import {
  type DispatchEntry,
  type DispatchOptions,
  dispatchTask,
  isInFlight,
  onDispatchSettled,
  retryDispatch,
  threadKey,
  useDispatch,
} from "./store";
import { recentRepos, resolveAgent } from "./thread";

const EMPTY: DispatchEntry[] = [];
/** Entries rendered before "Show earlier". */
const PAGE = 60;
const COUNT_LABEL = { needs: "need you", running: "running", review: "to review" } as const;

/**
 * `#/dispatch`: pick a repo, then every message creates a fresh worktree (`dispatch/<slug>`) with
 * an omp agent running it. The thread shows each message with its agent's live reply card.
 */
export function DispatchView() {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const lastHost = useDispatch((s) => s.lastHost);
  const hostId = lastHost && hostIds.includes(lastHost) ? lastHost : hostIds[0];
  const repo = useDispatch((s) => (hostId ? (s.lastRepo[hostId] ?? null) : null));
  const select = useDispatch((s) => s.select);
  const host = useHostState(hostId ?? "");
  const online = useHosts((s) => (hostId ? s.status[hostId]?.phase === "online" : false));
  const hostName = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const home = host?.info.home;
  const key = hostId && repo ? threadKey(hostId, repo) : null;
  const entries = useDispatch((s) => (key ? (s.threads[key] ?? EMPTY) : EMPTY));
  const threads = useDispatch((s) => s.threads);

  // Recent repos: the host's workspaces plus repos dispatched to before.
  const dispatched = useMemo(() => {
    const out: Record<string, number> = {};
    const prefix = threadKey(hostId ?? "", "");
    for (const [k, list] of Object.entries(threads)) if (k.startsWith(prefix) && list.length) out[k.slice(prefix.length)] = list[list.length - 1]?.createdAt ?? 0;
    return out;
  }, [threads, hostId]);
  const workspaces = host?.workspaces;
  const agents = host?.agents;
  const recents = useMemo(() => recentRepos(workspaces && agents ? { workspaces, agents } : undefined, dispatched), [workspaces, agents, dispatched]);

  // Base branch: remembered per thread, else the repo's default branch.
  const branches = useHostQuery(hostId, "git.branches", repo ? { cwd: repo } : null);
  const reloadBranches = branches.reload;
  useEffect(() => onDispatchSettled(reloadBranches), [reloadBranches]);
  const storedBase = useDispatch((s) => (key ? s.bases[key] : undefined));
  const known = !branches.data || storedBase === "HEAD" || branches.data.branches.some((b) => b.name === storedBase);
  const base = (storedBase && known ? storedBase : undefined) ?? branches.data?.defaultBranch ?? "HEAD";

  // Composer options: last used, else the Settings defaults.
  const settings = useSettings();
  const stored = useDispatch((s) => s.options);
  const options = useMemo<DispatchOptions>(() => {
    if (stored) return stored.templateId && !settings.templates.some((t) => t.id === stored.templateId) ? { ...stored, templateId: null } : stored;
    return { templateId: null, model: settings.defaultModel ?? "default", thinking: settings.defaultThinking ?? "default", plan: settings.defaultPlan };
  }, [stored, settings.templates, settings.defaultModel, settings.defaultThinking, settings.defaultPlan]);

  // Names that are not free: existing branches and live agents (the store adds the host's dispatches).
  const taken = useRef<string[]>([]);
  taken.current = [...(branches.data?.branches.map((b) => b.name) ?? []), ...(agents?.map((a) => a.name) ?? [])];
  const hostSnapshot = useRef({ agents: agents ?? [], workspaces: workspaces ?? [] });
  hostSnapshot.current = { agents: agents ?? [], workspaces: workspaces ?? [] };

  // Link entries to their agents, only ever inside the entry's own worktree (the id can arrive
  // after `worktree.create` returns; reloads and timeouts lose it).
  const resolved = useMemo(() => {
    const out: Record<string, string> = {};
    if (!agents || !workspaces || !repo) return out;
    for (const e of entries) {
      const a = resolveAgent(e, agents, { repo, workspaces });
      if (a) out[e.id] = a.id;
    }
    return out;
  }, [entries, agents, workspaces, repo]);
  useEffect(() => {
    if (!key || !agents) return;
    const { patch } = useDispatch.getState();
    for (const e of entries) {
      const a = resolved[e.id] ? agents.find((x) => x.id === resolved[e.id]) : undefined;
      if (!a || e.phase === "failed" || isInFlight(e.id)) continue;
      // Interrupted by a reload, or unconfirmed after a timeout: the agent turned up after all.
      const recovered = e.phase === "queued" || e.phase === "creating" || e.phase === "unknown";
      if (e.agentId === a.id && e.paneId === a.paneId && e.workspaceId === a.workspaceId && !recovered) continue;
      patch(key, e.id, { agentId: a.id, paneId: a.paneId, workspaceId: a.workspaceId, ...(recovered ? { phase: "started" as const, error: undefined, startedAt: e.startedAt ?? Date.now() } : {}) });
    }
  }, [key, entries, agents, resolved]);

  const composer = useRef<DispatchComposerHandle>(null);
  const send = (prompt: string) => {
    if (!hostId || !repo) return;
    dispatchTask({ hostId, repo, prompt, base: base === "HEAD" ? undefined : base, options, taken: taken.current });
  };

  const retry = useCallback(
    (id: string, trust: boolean) => {
      if (hostId && repo) void retryDispatch({ hostId, repo, id, trust, taken: taken.current, host: hostSnapshot.current });
    },
    [hostId, repo],
  );
  const dismiss = useCallback((id: string) => key && useDispatch.getState().remove(key, [id]), [key]);
  const ctx = useMemo<ThreadContext | null>(
    () => (hostId && repo ? { hostId, repo, home, mobile, online, retry, dismiss } : null),
    [hostId, repo, home, mobile, online, retry, dismiss],
  );

  // After a repo pick the task box gets focus (not the chip or button that picked it, where a
  // typed `n` would open the New worktree wizard).
  const focusComposer = useCallback(() => composer.current?.focus(), []);
  const focusAfterPick = useRef(false);
  const pickRepo = (root: string) => {
    if (!hostId) return;
    focusAfterPick.current = true;
    select(hostId, root);
  };
  useEffect(() => {
    if (!repo || !focusAfterPick.current) return;
    focusAfterPick.current = false;
    requestAnimationFrame(focusComposer);
  }, [repo, focusComposer]);
  const refocusAfterPick = useCallback(() => {
    focusAfterPick.current = false;
    focusComposer();
  }, [focusComposer]);
  const [browsing, setBrowsing] = useState(false);

  const counts = useMemo(() => {
    const c = { running: 0, needs: 0, review: 0 };
    for (const id of Object.values(resolved)) {
      const a = agents?.find((x) => x.id === id);
      const col = a?.column;
      if (col === "running" || col === "needs" || (col === "review" && (a?.turns ?? 0) > 0)) c[col]++;
    }
    return c;
  }, [resolved, agents]);

  const disabledReason = !hostId ? "Add a host first" : !repo ? "Pick a repository first" : !online ? `${hostName} is offline` : null;
  const repoName = repo ? (recents.find((r) => r.root === repo)?.name ?? repo.split(/[\\/]/).pop()) : null;

  const pickers = hostId && (
    <>
      {hostIds.length > 1 && <HostPicker hostId={hostId} hostIds={hostIds} onChange={(id) => select(id)} className={mobile ? "max-w-[26%]" : undefined} />}
      <RepoPicker
        hostId={hostId}
        repo={repo}
        recents={recents}
        home={home}
        onChange={pickRepo}
        onFocusAfterPick={refocusAfterPick}
        className={mobile ? "min-w-0 flex-1" : "max-w-[min(440px,50%)]"}
      />
      {repo && <BasePicker value={base} branches={branches.data} onChange={(b) => key && useDispatch.getState().setBase(key, b)} className={mobile ? "max-w-[32%]" : undefined} />}
    </>
  );

  const menu = key && entries.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Thread actions" size="sm">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={<Eraser />}
          disabled={!entries.some((e) => e.phase === "failed")}
          onSelect={() => useDispatch.getState().remove(key, entries.filter((e) => e.phase === "failed").map((e) => e.id))}
        >
          Remove failed
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Eraser />}
          danger
          onSelect={async () => {
            const ok = await confirmAction({
              title: `Clear the ${repoName} thread?`,
              body: "Only the messages here are removed. Agents and worktrees keep running; find them on the board.",
              confirmLabel: "Clear thread",
              danger: true,
            });
            if (ok) useDispatch.getState().clear(key);
          }}
        >
          Clear thread…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const thread = !hostId ? (
    <EmptyState
      className="flex-1"
      icon={<Server />}
      title="No host yet"
      description="Dispatch creates worktrees and agents on one of your hosts."
      action={<Button onClick={() => navigate({ name: "hosts" })}>Add a host</Button>}
    />
  ) : !repo || !ctx ? (
    <EmptyState
      className="flex-1"
      icon={<Send />}
      title="Fire tasks at a repository"
      description="Pick a repository. Every message you send here gets a fresh worktree with its own omp agent — send as many as you like, they run side by side."
      action={
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {recents.slice(0, 4).map((r) => (
            <Button key={r.root} size="sm" icon={<FolderGit2 />} onClick={() => pickRepo(r.root)}>
              {r.name}
            </Button>
          ))}
          <Button size="sm" variant={recents.length > 0 ? "ghost" : "primary"} icon={<FolderSearch />} onClick={() => setBrowsing(true)}>
            {recents.length > 0 ? "Browse…" : "Browse for a repository…"}
          </Button>
          <RepoBrowser hostId={hostId} repo={repo} open={browsing} onOpenChange={setBrowsing} onPick={pickRepo} onFocusAfterPick={refocusAfterPick} />
        </div>
      }
    />
  ) : (
    <Thread key={key} entries={entries} resolved={resolved} ctx={ctx} base={base} repoName={repoName ?? ""} mobile={mobile} />
  );

  const composerEl = (
    <DispatchComposer
      ref={composer}
      hostId={hostId}
      repo={repo}
      draftKey={draftKey("dispatch.task", hostId ?? "", repo ?? "")}
      options={options}
      onOptionsChange={useDispatch.getState().setOptions}
      onSend={send}
      disabledReason={disabledReason}
      placeholder={repo ? `Describe a task for ${repoName}…` : "Pick a repository to dispatch to"}
      mobile={mobile}
    />
  );

  // The other launchers, for when Dispatch's one-message flow isn't what's needed.
  const link = "font-bold text-accent-hi rounded-[3px] hover:underline focus-ring";
  const alternatives = hostId && (
    <p className={cn("truncate px-2 text-[11px] font-semibold text-mute-2", mobile ? "mt-1" : "mt-1.5")}>
      Need a specific branch or model?{" "}
      <button type="button" className={link} title={ACTIONS.newWorktree.description} onClick={() => useUi.getState().openDialog({ kind: "newWorktree", hostId, cwd: repo ?? undefined })}>
        {ACTIONS.newWorktree.label}
      </button>
      {" · "}Several attempts?{" "}
      <button
        type="button"
        className={link}
        title={ACTIONS.fanOut.description}
        onClick={() => useUi.getState().openDialog({ kind: "fanOut", hostId, cwd: repo ?? undefined, prompt: composer.current?.text().trim() || undefined })}
      >
        {ACTIONS.fanOut.label}
      </button>
    </p>
  );

  if (mobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-12 min-w-0 shrink-0 items-center gap-1.5 bg-[rgb(11_11_16/0.72)] px-3 py-1.5 backdrop-blur-xl">
          {pickers}
          <span className="shrink-0">{menu}</span>
        </header>
        {thread}
        <div className="shrink-0 px-2 pt-1 pb-2">
          {composerEl}
          {entries.length === 0 && alternatives}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center gap-3 p-4 pt-3">
      <header className="flex w-full max-w-[920px] min-w-0 flex-wrap items-center gap-2">
        <span className="mr-1 flex min-w-0 shrink-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]">
            <Send className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <h1 className="font-display text-lg leading-tight font-bold tracking-[-0.01em] text-ink">Dispatch</h1>
            <p className="max-w-[340px] truncate text-[11px] font-semibold text-mute-2" title={ACTIONS.newTask.description}>
              {ACTIONS.newTask.description}
            </p>
          </span>
        </span>
        {pickers}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <AnimatePresence initial={false}>
            {(["needs", "running", "review"] as const).map(
              (col) =>
                counts[col] > 0 && (
                  <motion.span
                    key={col}
                    title={`${counts[col]} ${COUNT_LABEL[col]}`}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={spring.snappy}
                  >
                    <StatusPill status={col === "needs" ? "needs-you" : col} size="sm">
                      {counts[col]}
                      <span className="max-xl:hidden">{COUNT_LABEL[col]}</span>
                    </StatusPill>
                  </motion.span>
                ),
            )}
          </AnimatePresence>
          {menu}
        </span>
      </header>
      <div className="flex min-h-0 w-full max-w-[920px] flex-1 flex-col overflow-hidden rounded-tile glass">{thread}</div>
      <div className="w-full max-w-[920px] shrink-0">
        {repo && home && (
          <p className="mb-1.5 truncate px-2 text-[11px] font-semibold text-mute-2 [@media(max-height:700px)]:hidden">
            Each message → a worktree of <span className="font-mono">{tildify(repo, home)}</span> from <span className="font-mono">{base}</span> + an omp agent
          </p>
        )}
        {composerEl}
        {alternatives}
      </div>
    </div>
  );
}

/** The scrolling thread: oldest → newest, pinned to the newest while you're at the bottom. */
function Thread({
  entries,
  resolved,
  ctx,
  base,
  repoName,
  mobile,
}: {
  entries: readonly DispatchEntry[];
  resolved: Readonly<Record<string, string>>;
  ctx: ThreadContext;
  base: string;
  repoName: string;
  mobile: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);
  const [limit, setLimit] = useState(PAGE);
  const visible = entries.length > limit ? entries.slice(-limit) : entries;
  const count = entries.length;
  const hasItems = count > 0;
  const newest = entries[count - 1];
  const newestId = newest?.id;
  const newestAt = newest?.createdAt ?? 0;

  // Start at the newest; a new message always scrolls to it. Keyed on the newest entry (the count
  // stops growing at the cap); dismissing the newest one doesn't count as a new message.
  const prevNewest = useRef<{ id?: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prev = prevNewest.current;
    if (!prev || (newestId !== prev.id && newestAt >= prev.at)) {
      pinned.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: prev ? "smooth" : "auto" });
    }
    prevNewest.current = { id: newestId, at: newestAt };
  }, [newestId, newestAt]);

  // Cards grow as agents report in: stay pinned to the bottom while the reader is there.
  useEffect(() => {
    const el = scroller.current;
    const inner = list.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [hasItems]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", mobile ? "px-3 py-3" : "px-6 py-5")}
    >
      {count === 0 ? (
        <EmptyState
          className="h-full"
          icon={<Send />}
          title={`Nothing dispatched to ${repoName} yet`}
          description={`Each message becomes a dispatch/<slug> branch from ${base}, in its own worktree, with an omp agent working on it.`}
        />
      ) : (
        <ThreadCtx.Provider value={ctx}>
          {entries.length > visible.length && (
            <div className="mb-4 flex justify-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, entries.length - visible.length)} earlier
              </Button>
            </div>
          )}
          <ul ref={list} className={cn("flex flex-col", mobile ? "gap-5" : "gap-6")}>
            {visible.map((e) => (
              <DispatchItem key={e.id} entry={e} agentId={resolved[e.id]} />
            ))}
          </ul>
        </ThreadCtx.Provider>
      )}
    </div>
  );
}
