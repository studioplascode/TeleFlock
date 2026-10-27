import { AnimatePresence, motion } from "motion/react";
import { Eraser, FolderGit2, FolderSearch, MoreHorizontal, Send, Server, Shuffle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DraftImage, draftKey, navigate, useHostIds, useHostStates, useHosts, useSettings, useUi } from "@/core";
import type { ConnStatus, HostState } from "@/core/gen";
import { IMAGES_TOO_LARGE, imageChars, MAX_PROMPT_IMAGE_CHARS } from "@/core/clipboardImages";
import { describeLoad, type HostLoad, hostLoad, pickHost, rankHosts } from "@/core/workload";
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
  toast,
  useIsMobile,
} from "@/design";
import { hostGroups, versionBelow } from "@/features/hosts/kinds";
import { ACTIONS } from "@/features/shell/vocab";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";
import { autoTarget, canonicalRemote, findGroupRepo, groupHosts, groupOf, groupRepos, localRepoIds, remoteKey } from "./auto";
import { DispatchComposer, type DispatchComposerHandle } from "./DispatchComposer";
import { DispatchItem, type ThreadContext, ThreadCtx } from "./DispatchItem";
import { BasePicker, type GroupChoice, HostPicker, RepoBrowser, type RepoChoice, RepoPicker } from "./RepoBar";
import {
  type DispatchEntry,
  type DispatchOptions,
  dispatchTask,
  entryHost,
  entryRepo,
  isInFlight,
  onDispatchSettled,
  pendingByHost,
  retryDispatch,
  threadKey,
  useDispatch,
} from "./store";
import { recentRepos, resolveAgent, threadBase } from "./thread";

const EMPTY: DispatchEntry[] = [];
const NO_HOSTS: string[] = [];
/** Entries rendered before "Show earlier". */
const PAGE = 60;
const COUNT_LABEL = { needs: "need you", running: "running", review: "to review" } as const;
/** Image prompts need hostd 0.5 (older daemons ignore `agent.images`). */
const IMAGES_MIN_HOSTD = "0.5";

/** Current load of `ids` (Auto): health, agents, and the dispatches on their way to each. */
function loadsOf(ids: readonly string[], states: Readonly<Record<string, HostState>>, status: Readonly<Record<string, ConnStatus>>, threads: Readonly<Record<string, DispatchEntry[]>>): HostLoad[] {
  const running = new Set<string>();
  for (const h of ids) for (const a of states[h]?.agents ?? []) if (a.column === "running") running.add(a.id);
  const pending = pendingByHost(threads, running, Date.now());
  return ids.map((h) => {
    const agents = states[h]?.agents ?? [];
    return hostLoad({
      hostId: h,
      online: status[h]?.phase === "online",
      health: states[h]?.health,
      running: agents.filter((a) => a.column === "running").length,
      needs: agents.filter((a) => a.column === "needs").length,
      pending: pending[h] ?? 0,
    });
  });
}

/**
 * `#/dispatch`: pick a repo, then every message creates a fresh worktree (`dispatch/<slug>`) with
 * an omp agent running it. The thread shows each message with its agent's live reply card. The
 * target is one host, or a host group in Auto mode (each task goes to its least busy host).
 */
export function DispatchView() {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const states = useHostStates();
  const threads = useDispatch((s) => s.threads);
  const remotes = useDispatch((s) => s.remotes);
  const lastHost = useDispatch((s) => s.lastHost);
  const select = useDispatch((s) => s.select);
  const nameOf = useCallback((id: string) => profiles.find((p) => p.id === id)?.name ?? id, [profiles]);

  // Target: the last host or group used, else the first host.
  const groups = useMemo(() => hostGroups(profiles), [profiles]);
  const lastGroup = groupOf(lastHost)?.toLowerCase();
  const auto = lastGroup ? (groups.find((g) => g.toLowerCase() === lastGroup) ?? null) : null;
  const target = auto ? autoTarget(auto) : lastHost && hostIds.includes(lastHost) ? lastHost : hostIds[0];
  const members = useMemo(() => (auto ? groupHosts(profiles, auto).map((p) => p.id) : NO_HOSTS), [auto, profiles]);
  const repo = useDispatch((s) => (target ? (s.lastRepo[target] ?? null) : null));
  const key = target && repo ? threadKey(target, repo) : null;
  const entries = useDispatch((s) => (key ? (s.threads[key] ?? EMPTY) : EMPTY));

  // Clones are matched across hosts by their origin remote, learned from workspaces.
  useEffect(() => {
    const found: Record<string, string> = {};
    for (const [h, st] of Object.entries(states)) {
      for (const ws of st.workspaces) {
        const id = canonicalRemote(ws.repo?.remoteUrl);
        if (ws.repo && id) found[remoteKey(h, ws.repo.root)] = id;
      }
    }
    useDispatch.getState().learnRemotes(found);
  }, [states]);

  // Repos dispatched to, per host (single-host and Auto threads alike).
  const dispatched = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const [k, list] of Object.entries(threads)) {
      for (const e of list) {
        const per = (out[entryHost(k, e)] ??= {});
        const root = entryRepo(k, e);
        per[root] = Math.max(per[root] ?? 0, e.createdAt);
      }
    }
    return out;
  }, [threads]);

  // Single host: its recent repos. Auto: the union over the group, one row per repository.
  const hostId = auto ? null : (target ?? null);
  const single = hostId ? states[hostId] : undefined;
  const home = single?.info.home;
  const recents = useMemo(() => (hostId ? recentRepos(single, dispatched[hostId] ?? {}) : []), [hostId, single, dispatched]);
  const pooled = useMemo(
    () => (auto ? groupRepos(members.map((h) => ({ hostId: h, recents: recentRepos(states[h], dispatched[h] ?? {}) })), remotes) : []),
    [auto, members, states, dispatched, remotes],
  );
  // A thread keeps the repo id it was started under (a host-local one until the remote was known).
  const autoRepo = auto && repo ? findGroupRepo(pooled, repo) : undefined;
  const candidates = useMemo(() => (autoRepo ? members.filter((h) => autoRepo.roots[h]) : NO_HOSTS), [autoRepo, members]);
  const repoChoices = useMemo<RepoChoice[]>(
    () =>
      auto
        ? pooled.map((r) => ({ id: r.id, name: r.name, detail: members.filter((h) => r.roots[h]).map(nameOf).join(" · ") }))
        : recents.map((r) => ({ id: r.root, name: r.name, detail: tildify(r.root, home) })),
    [auto, pooled, members, nameOf, recents, home],
  );

  // Workload: each group's hosts for the picker; the repo's hosts for Auto sends (`preview` = the
  // host the next send would go to; its branches and naming stand in for the group's).
  const groupChoices = useMemo<GroupChoice[]>(
    () => groups.map((g) => ({ group: g, loads: rankHosts(loadsOf(groupHosts(profiles, g).map((p) => p.id), states, status, threads)) })),
    [groups, profiles, states, status, threads],
  );
  const preview = useMemo(() => (candidates.length ? pickHost(loadsOf(candidates, states, status, threads)) : null), [candidates, states, status, threads]);
  const workHost = hostId ?? preview?.hostId ?? candidates[0];
  const workRepo = hostId ? repo : workHost ? autoRepo?.roots[workHost] : undefined;

  // Base branch: remembered per thread, else the host's default base (`origin/<default>`). Auto
  // resolves it again on the host each send goes to (as does a send before the list is in).
  const branches = useHostQuery(workHost, "git.branches", workRepo ? { cwd: workRepo } : null);
  const reloadBranches = branches.reload;
  useEffect(() => onDispatchSettled(reloadBranches), [reloadBranches]);
  const storedBase = useDispatch((s) => (key ? s.bases[key] : undefined));
  const legacyBase = useDispatch((s) => (key ? s.legacyBases[key] === true : false));
  const base = threadBase(branches.data, storedBase, legacyBase);

  // Composer options: last used, else the Settings defaults.
  const settings = useSettings();
  const stored = useDispatch((s) => s.options);
  const options = useMemo<DispatchOptions>(() => {
    if (stored) return stored.templateId && !settings.templates.some((t) => t.id === stored.templateId) ? { ...stored, templateId: null } : stored;
    return { templateId: null, model: settings.defaultModel ?? "default", thinking: settings.defaultThinking ?? "default", plan: settings.defaultPlan };
  }, [stored, settings.templates, settings.defaultModel, settings.defaultThinking, settings.defaultPlan]);

  // Names that are not free on the single host: existing branches and live agents (the store adds
  // the host's dispatches; Auto sends look the picked host's branches up themselves).
  const taken = useRef<string[]>([]);
  taken.current = hostId ? [...(branches.data?.branches.map((b) => b.name) ?? []), ...(single?.agents.map((a) => a.name) ?? [])] : [];
  const statesRef = useRef(states);
  statesRef.current = states;

  // Link entries to their agents on each entry's own host, only ever inside the entry's own
  // worktree (the id can arrive after `worktree.create` returns; reloads and timeouts lose it).
  const { resolved, counts } = useMemo(() => {
    const ids: Record<string, string> = {};
    const c = { running: 0, needs: 0, review: 0 };
    if (!key) return { resolved: ids, counts: c };
    for (const e of entries) {
      const st = states[entryHost(key, e)];
      if (!st) continue;
      const a = resolveAgent(e, st.agents, { repo: entryRepo(key, e), workspaces: st.workspaces });
      if (!a) continue;
      ids[e.id] = a.id;
      if (a.column === "running" || a.column === "needs" || (a.column === "review" && a.turns > 0)) c[a.column]++;
    }
    return { resolved: ids, counts: c };
  }, [entries, states, key]);
  useEffect(() => {
    if (!key) return;
    const { patch } = useDispatch.getState();
    for (const e of entries) {
      const a = resolved[e.id] ? states[entryHost(key, e)]?.agents.find((x) => x.id === resolved[e.id]) : undefined;
      if (!a || e.phase === "failed" || isInFlight(e.id)) continue;
      // Interrupted by a reload, or unconfirmed after a timeout: the agent turned up after all.
      const recovered = e.phase === "queued" || e.phase === "creating" || e.phase === "unknown";
      if (e.agentId === a.id && e.paneId === a.paneId && e.workspaceId === a.workspaceId && !recovered) continue;
      patch(key, e.id, { agentId: a.id, paneId: a.paneId, workspaceId: a.workspaceId, ...(recovered ? { phase: "started" as const, error: undefined, startedAt: e.startedAt ?? Date.now() } : {}) });
    }
  }, [key, entries, states, resolved]);

  const repoName = repo ? (auto ? autoRepo?.name : recents.find((r) => r.root === repo)?.name) ?? basename(repo) : null;

  const composer = useRef<DispatchComposerHandle>(null);
  const send = (prompt: string, images: readonly DraftImage[], videos: readonly string[]): boolean => {
    if (!target || !repo || !key) return false;
    if (imageChars(images) > MAX_PROMPT_IMAGE_CHARS) {
      toast({ title: "The images are too large", description: `${IMAGES_TOO_LARGE} Remove some.`, status: "error" });
      return false;
    }
    // Image prompts need a hostd known to be 0.5+ (older ones drop `agent.images` silently).
    const takesImages = (h: string) => {
      const version = states[h]?.info.hostdVersion;
      return profiles.find((p) => p.id === h)?.kind === "demo" || (!!version && !versionBelow(version, IMAGES_MIN_HOSTD));
    };
    let to = hostId;
    let root = repo;
    let placed: string | undefined;
    if (auto) {
      if (!autoRepo || !candidates.length) {
        toast({ title: `No host of ${auto} has ${repoName}`, description: "Pick another repository, or a single host to browse for it.", status: "error" });
        return false;
      }
      const able = images.length ? candidates.filter(takesImages) : candidates;
      if (!able.length) {
        toast({ title: `No host of ${auto} with ${repoName} can take images yet`, description: `Images need TeleFlock host daemon ${IMAGES_MIN_HOSTD} or newer on ${candidates.map(nameOf).join(", ")}: update one from Hosts, or send the task without images.`, status: "error" });
        return false;
      }
      // Fresh numbers: the dispatches just sent count against their host right away.
      const ranked = rankHosts(loadsOf(able, states, status, useDispatch.getState().threads));
      const pick = pickHost(ranked);
      if (!pick) {
        toast({ title: `No host of ${auto} with ${repoName}${able.length < candidates.length ? " that takes images" : ""} is online`, description: able.map(nameOf).join(", "), status: "error" });
        return false;
      }
      to = pick.hostId;
      root = autoRepo.roots[pick.hostId] ?? repo;
      const others = ranked.filter((l) => l !== pick && l.available).map((l) => `${nameOf(l.hostId)}: ${describeLoad(l)}`);
      placed = `least busy of ${able.length}: ${describeLoad(pick)}${others.length ? ` (${others.join("; ")})` : ""}`;
    }
    if (!to) return false;
    if (images.length && !takesImages(to)) {
      const version = states[to]?.info.hostdVersion;
      toast({
        title: `${nameOf(to)} can't take images yet`,
        description: `${version ? `Its TeleFlock host daemon (${version}) is older than ${IMAGES_MIN_HOSTD}` : `Its TeleFlock host daemon version isn't known yet (images need ${IMAGES_MIN_HOSTD} or newer)`}: update it from Hosts, or send the task without images.`,
        status: "error",
      });
      return false;
    }
    // The view's branch list is the preview host's (Auto) or not in yet: resolve the base on `to`.
    const resolveBase = auto || !branches.data ? { stored: storedBase, legacy: legacyBase } : undefined;
    dispatchTask({
      key,
      hostId: to,
      repo: root,
      prompt,
      images,
      videos,
      base: base.param,
      baseLabel: base.shown,
      placed,
      options,
      taken: auto ? (states[to]?.agents.map((a) => a.name) ?? []) : taken.current,
      resolveBase,
    });
    return true;
  };

  const retry = useCallback(
    (id: string, trust: boolean) => {
      if (!key) return;
      const e = useDispatch.getState().threads[key]?.find((x) => x.id === id);
      if (!e) return;
      const st = statesRef.current[entryHost(key, e)];
      const host = { agents: st?.agents ?? [], workspaces: st?.workspaces ?? [] };
      void retryDispatch({ key, id, trust, taken: host.agents.map((a) => a.name), host });
    },
    [key],
  );
  const dismiss = useCallback((id: string) => key && useDispatch.getState().remove(key, [id]), [key]);
  const homes = useMemo(() => Object.fromEntries(Object.entries(states).map(([h, st]) => [h, st.info.home])), [states]);
  const online = useMemo(() => Object.fromEntries(Object.entries(status).map(([h, s]) => [h, s.phase === "online"])), [status]);
  const ctx = useMemo<ThreadContext | null>(
    () => (key && target ? { threadKey: key, auto: !!auto, homes, online, hostName: nameOf, mobile, retry, dismiss } : null),
    [key, target, auto, homes, online, nameOf, mobile, retry, dismiss],
  );

  // After a repo pick the task box gets focus (not the chip or button that picked it, where a
  // typed `n` would open the New worktree wizard).
  const focusComposer = useCallback(() => composer.current?.focus(), []);
  const focusAfterPick = useRef(false);
  const pickRepo = (id: string) => {
    if (!target) return;
    focusAfterPick.current = true;
    // Auto: back to the thread started under the repo's host-local id, if that's where it is.
    const picked = auto ? pooled.find((r) => r.id === id) : undefined;
    const ids = picked ? [id, ...localRepoIds(picked)] : [id];
    select(target, ids.find((x) => x === repo || (threads[threadKey(target, x)]?.length ?? 0) > 0) ?? id);
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

  const autoOnline = candidates.some((h) => online[h]);
  const disabledReason = !target
    ? "Add a host first"
    : !repo
      ? "Pick a repository first"
      : auto
        ? !autoRepo
          ? `No host of ${auto} has ${repoName} now`
          : autoOnline
            ? null
            : `No host of ${auto} with ${repoName} is online`
        : hostId && !online[hostId]
          ? `${nameOf(hostId)} is offline`
          : null;

  const pickers = target && (
    <>
      {(hostIds.length > 1 || groups.length > 0) && (
        <HostPicker target={target} hostIds={hostIds} groups={groupChoices} onChange={(t) => select(t)} className={mobile ? "max-w-[30%]" : undefined} />
      )}
      <RepoPicker
        browseHostId={hostId}
        repo={autoRepo?.id ?? repo}
        repos={repoChoices}
        emptyHint={auto ? `No repositories on ${auto}'s hosts yet. Pick a single host to browse for one; once it has a worktree or dispatch there, Auto offers it.` : undefined}
        onChange={pickRepo}
        onFocusAfterPick={refocusAfterPick}
        className={mobile ? "min-w-0 flex-1" : "max-w-[min(440px,50%)]"}
      />
      {repo && <BasePicker value={base.shown} branches={branches.data} onChange={(b) => key && useDispatch.getState().setBase(key, b)} className={mobile ? "max-w-[32%]" : undefined} />}
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

  const thread = !target ? (
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
      icon={auto ? <Shuffle /> : <Send />}
      title={auto ? `Fire tasks at ${auto}` : "Fire tasks at a repository"}
      description={
        auto
          ? `Pick a repository. Each message goes to the least busy online host of ${auto} that has it, in a fresh worktree with its own omp agent.`
          : "Pick a repository. Every message you send here gets a fresh worktree with its own omp agent — send as many as you like, they run side by side."
      }
      action={
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {repoChoices.slice(0, 4).map((r) => (
            <Button key={r.id} size="sm" icon={<FolderGit2 />} onClick={() => pickRepo(r.id)}>
              {r.name}
            </Button>
          ))}
          {hostId && (
            <>
              <Button size="sm" variant={repoChoices.length > 0 ? "ghost" : "primary"} icon={<FolderSearch />} onClick={() => setBrowsing(true)}>
                {repoChoices.length > 0 ? "Browse…" : "Browse for a repository…"}
              </Button>
              <RepoBrowser hostId={hostId} repo={repo} open={browsing} onOpenChange={setBrowsing} onPick={pickRepo} onFocusAfterPick={refocusAfterPick} />
            </>
          )}
        </div>
      }
    />
  ) : (
    <Thread key={key} entries={entries} resolved={resolved} ctx={ctx} base={base.shown} repoName={repoName ?? ""} mobile={mobile} />
  );

  const composerEl = (
    <DispatchComposer
      ref={composer}
      hostId={workHost}
      repo={workRepo}
      draftKey={draftKey("dispatch.task", target ?? "", repo ?? "")}
      uploadHost={hostId}
      options={options}
      onOptionsChange={useDispatch.getState().setOptions}
      onSend={send}
      disabledReason={disabledReason}
      placeholder={repo ? `Describe a task for ${repoName}… (paste or drop images and videos)` : "Pick a repository to dispatch to"}
      mobile={mobile}
    />
  );

  // The other launchers, for when Dispatch's one-message flow isn't what's needed.
  const link = "font-bold text-accent-hi rounded-[3px] hover:underline focus-ring";
  // Phone: wraps between the two offers (each stays whole) rather than truncating "Fan out" away.
  const offer = mobile ? "whitespace-nowrap" : undefined;
  const alternatives = workHost && (
    <p className={cn("px-2 text-[11px] font-semibold text-mute-2", mobile ? "mt-1 leading-relaxed" : "mt-1.5 truncate")}>
      <span className={offer}>
        Need a specific branch or model?{" "}
        <button type="button" className={link} title={ACTIONS.newWorktree.description} onClick={() => useUi.getState().openDialog({ kind: "newWorktree", hostId: workHost, cwd: workRepo ?? undefined })}>
          {ACTIONS.newWorktree.label}
        </button>
      </span>
      {" · "}
      <span className={offer}>
        Several attempts?{" "}
        <button
          type="button"
          className={link}
          title={ACTIONS.fanOut.description}
          onClick={() => useUi.getState().openDialog({ kind: "fanOut", hostId: workHost, cwd: workRepo ?? undefined, prompt: composer.current?.text().trim() || undefined })}
        >
          {ACTIONS.fanOut.label}
        </button>
      </span>
    </p>
  );

  const hint =
    repo &&
    (auto ? (
      <>
        Each message → the least busy of <span className="font-semibold text-mute">{candidates.map(nameOf).join(", ") || "no host"}</span>
        {preview && <> (next: {nameOf(preview.hostId)})</>} · from <span className="font-mono">{base.shown}</span> + an omp agent
      </>
    ) : (
      home && (
        <>
          Each message → a worktree of <span className="font-mono">{tildify(repo, home)}</span> from <span className="font-mono">{base.shown}</span> + an omp agent
        </>
      )
    ));

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
        {hint && <p className="mb-1.5 truncate px-2 text-[11px] font-semibold text-mute-2 [@media(max-height:700px)]:hidden">{hint}</p>}
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
          icon={ctx.auto ? <Shuffle /> : <Send />}
          title={`Nothing dispatched to ${repoName} yet`}
          description={`Each message becomes a dispatch/<slug> branch from ${base}, in its own worktree, with an omp agent working on it.${ctx.auto ? " Auto sends each one to the least busy host that has the repository." : ""}`}
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
            {visible.map((e, i) => (
              <DispatchItem key={e.id} entry={e} agentId={resolved[e.id]} index={i} />
            ))}
          </ul>
        </ThreadCtx.Provider>
      )}
    </div>
  );
}
