import { motion } from "motion/react";
import { ArrowUpRight, CalendarDays, FolderGit2, FolderOpen, History, MessagesSquare, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { agentKey, core, draftKey, navigate, useDraft, useHostIds, useHostState, useHosts, useUi } from "@/core";
import type { PastSession, SearchSnippet, Started, StartTarget, Workspace } from "@/core/gen";
import { Button, EmptyState, Input, Kbd, SegmentedControl, Select, Skeleton, Spinner, spring, useIsMobile, useNow } from "@/design";
import { openFind } from "../session/find/store";
import { ACTIONS } from "@/features/shell/vocab";
import { describeError } from "../workspace/shared/errors";
import { LaunchSuccess, WorkingPanel } from "../workspace/shared/LaunchProgress";
import { basename, tildify } from "../workspace/shared/paths";
import { ResponsiveDialog } from "../workspace/shared/ResponsiveDialog";
import { useDialogSession } from "../workspace/shared/useDialogSession";
import { useHostQuery } from "../workspace/shared/useHostQuery";
import { type Entry, mergeEntries, searchNote, searchQuery } from "./searchModel";
import { type GroupBy, type ListRow, SessionList, stopId } from "./SessionList";
import { type PreviewTarget, SessionPreview } from "./SessionPreview";
import { useSessionSearch } from "./useSessionSearch";

/** Scope for the next open (the ui dialog payload only carries the host). */
let pendingScope: { cwd?: string; workspaceId?: string } | null = null;

/** Open Past sessions, optionally scoped to a workspace's folder (the sidebar's "Past sessions…"). */
export function openPastSessions(opts: { hostId?: string; cwd?: string; workspaceId?: string } = {}) {
  pendingScope = { cwd: opts.cwd, workspaceId: opts.workspaceId };
  useUi.getState().openDialog({ kind: "pastSessions", hostId: opts.hostId });
}

const LIMIT = 200;
const NEW_AT_CWD = "__new";
const DAY = 86_400_000;

/** Mounted once by the shell; renders while `useUi().dialog.kind === "pastSessions"`. */
export function PastSessionsDialog() {
  const { open, payload, gen, close } = useDialogSession("pastSessions");
  if (!payload) return null;
  return <PastSessionsBody key={gen} open={open} initialHostId={payload.hostId} onClose={close} />;
}

/** A keyboard position: a session row (`k` -1) or one of its snippets. */
type Stop = { s: PastSession; k: number; sn?: SearchSnippet };
type Submit = { phase: "idle" } | { phase: "working"; since: number; title: string } | { phase: "failed"; title: string; hint?: string } | { phase: "done"; started: Started; title: string };

/** Repository a session belongs to: its workspace's repo, herdr's worktree dir layout, else the folder. */
function repoOf(s: PastSession, workspaces: readonly Workspace[]): string {
  if (!s.cwd) return "No folder";
  const ws = workspaces.find((w) => w.cwd === s.cwd || w.worktree?.path === s.cwd);
  if (ws?.repo?.name) return ws.repo.name;
  return s.cwd.match(/[\\/]\.herdr[\\/]worktrees[\\/]([^\\/]+)[\\/]/)?.[1] ?? basename(s.cwd);
}

function dateBucket(at: number, startOfToday: number): string {
  if (at >= startOfToday) return "Today";
  if (at >= startOfToday - DAY) return "Yesterday";
  if (at >= startOfToday - 6 * DAY) return "This week";
  if (at >= startOfToday - 29 * DAY) return "This month";
  return "Older";
}

function PastSessionsBody({ open, initialHostId, onClose }: { open: boolean; initialHostId?: string; onClose: () => void }) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const profiles = useHosts((s) => s.profiles);
  const [scope] = useState(() => pendingScope);
  useEffect(() => {
    pendingScope = null;
  }, []);
  const [hostId, setHostId] = useState<string | undefined>(initialHostId ?? hostIds[0]);
  const host = useHostState(hostId ?? "");
  const home = host?.info.home;
  const [scoped, setScoped] = useState(!!scope?.cwd);
  // the search is kept: one for the global list, one per folder the dialog was opened scoped to
  const [q, setQ] = useDraft(scope?.cwd ? draftKey("history.search", initialHostId ?? "", scope.cwd) : draftKey("history.search"));
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [selected, setSelected] = useState<string | null>(null);
  // keyboard position: a session row, then its snippets (see `stops`)
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [target, setTarget] = useState<string>(NEW_AT_CWD);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });
  const now = useNow(30000);
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaces = useMemo(() => host?.workspaces ?? [], [host?.workspaces]);

  const sessions = useHostQuery(hostId, "host.sessions", { cwd: scoped ? scope?.cwd : undefined, limit: LIMIT });
  const needle = q.trim().toLowerCase();
  // message search (hosts ≥ 0.7.0): hits are merged into the list below
  const contentQuery = searchQuery(q);
  const search = useSessionSearch(hostId, q, scoped ? scope?.cwd : undefined, open);

  // flat render list: group headers + sessions; `stops` is the keyboard order (a session, then its snippets)
  const { rows, stops } = useMemo(() => {
    const matched = mergeEntries(sessions.data?.sessions ?? [], search.hits, needle);
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const groups = new Map<string, { label: string; live?: boolean; items: { e: Entry; repo: string }[]; latest: number }>();
    for (const e of [...matched].sort((a, b) => Number(b.s.live) - Number(a.s.live) || b.s.updatedAt - a.s.updatedAt)) {
      const { s } = e;
      const repo = repoOf(s, workspaces);
      const key = groupBy === "repo" ? `r:${repo}` : s.live ? "live" : `d:${dateBucket(s.updatedAt, startOfToday)}`;
      let g = groups.get(key);
      if (!g) {
        g = { label: groupBy === "repo" ? repo : s.live ? "Live now" : dateBucket(s.updatedAt, startOfToday), live: groupBy === "date" && s.live, items: [], latest: s.updatedAt };
        groups.set(key, g);
      }
      g.items.push({ e, repo });
    }
    // date buckets are already chronological (insertion order); repos sort by their newest session
    const ordered = [...groups.entries()];
    if (groupBy === "repo") ordered.sort((a, b) => b[1].latest - a[1].latest);
    const out: ListRow[] = [];
    const flat: Stop[] = [];
    let sessionsSeen = 0;
    for (const [key, g] of ordered) {
      out.push({ t: "head", key: `h:${key}`, label: g.label, count: g.items.length, live: g.live });
      for (const { e, repo } of g.items) {
        out.push({ t: "item", key: e.s.file, e, repo, i: sessionsSeen++, stop: flat.length });
        flat.push({ s: e.s, k: -1 });
        e.hit?.snippets.forEach((sn, k) => flat.push({ s: e.s, k, sn }));
      }
    }
    return { rows: out, stops: flat };
  }, [sessions.data, search.hits, needle, groupBy, workspaces, now]);
  const sessionCount = rows.filter((r) => r.t === "item").length;

  const current = stops.find((st) => st.k < 0 && st.s.file === selected)?.s ?? (preview && preview.session.file === selected ? preview.session : undefined);
  const clampedActive = Math.min(active, Math.max(0, stops.length - 1));
  const activeStop = stops[clampedActive];

  const select = (s: PastSession) => {
    setSelected(s.file);
    setActive(Math.max(0, stops.findIndex((st) => st.k < 0 && st.s.file === s.file)));
    const match = workspaces.find((w) => w.id === scope?.workspaceId) ?? workspaces.find((w) => s.cwd && (w.cwd === s.cwd || w.worktree?.path === s.cwd));
    setTarget(match?.id ?? NEW_AT_CWD);
    if (submit.phase === "failed") setSubmit({ phase: "idle" });
  };

  const resume = async (s: PastSession) => {
    if (!hostId) return;
    const t: StartTarget = target === NEW_AT_CWD || s.file !== selected ? { kind: "cwd", cwd: s.cwd ?? home ?? "~", label: null } : { kind: "workspace", workspaceId: target, split: "right" };
    const title = s.title || basename(s.cwd ?? s.file);
    setSubmit({ phase: "working", since: Date.now(), title });
    try {
      const started = await core.host(hostId).call("host.resume", { sessionFile: s.file, target: t });
      setSubmit({ phase: "done", started, title });
    } catch (e) {
      setSubmit({ phase: "failed", ...describeError(e) });
    }
  };

  /** The agent whose session view shows this file: the live one, or the parked agent that ran it. */
  const agentOf = (s: PastSession): string | undefined => (s.live && s.agentId ? s.agentId : host?.agents.find((a) => a.parked?.sessionFile === s.file)?.id);

  const openLive = (s: PastSession) => {
    if (!hostId || !s.agentId) return;
    onClose();
    navigate({ name: "agent", hostId, agentId: s.agentId });
  };

  /** A snippet was picked: the session view with Find on the match, or the preview of its file. */
  const openAtMatch = (s: PastSession, sn: SearchSnippet) => {
    if (!hostId) return;
    const query = contentQuery ?? q.trim();
    const agentId = agentOf(s);
    if (agentId) {
      openFind(agentKey(hostId, agentId), { query, target: { rowId: sn.rowId, at: sn.at } });
      onClose();
      navigate({ name: "agent", hostId, agentId });
      return;
    }
    select(s);
    setPreview({ session: s, query, rowId: sn.rowId, at: sn.at });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(stops.length - 1, clampedActive + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, clampedActive - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!activeStop) return;
      const { s, sn } = activeStop;
      if (sn) openAtMatch(s, sn);
      else if (selected === s.file) {
        if (s.live && s.agentId && !e.ctrlKey && !e.metaKey) openLive(s);
        else void resume(s);
      } else select(s);
    } else if (e.key === "Escape" && q) {
      e.preventDefault();
      setQ("");
      setActive(0);
    }
  };

  const busy = submit.phase === "working" || submit.phase === "done";
  const targetOptions = [
    { value: NEW_AT_CWD, label: current?.cwd ? `New workspace at ${tildify(current.cwd, home)}` : "New workspace", icon: <FolderOpen /> },
    ...workspaces.map((w) => ({ value: w.id, label: w.label, hint: `split right · ${tildify(w.cwd, home)}` })),
  ];

  const footer =
    submit.phase === "working" || submit.phase === "done" ? undefined : current ? (
      <div className="flex w-full flex-col gap-2.5">
        {current.live && (
          <p className="text-xs text-mute">
            Open in an omp process right now. Resuming it elsewhere <b className="text-ink-2">forks</b> the session.
          </p>
        )}
        <div className="flex w-full flex-col gap-2 md:flex-row md:items-center">
          <Select value={target} onValueChange={setTarget} options={targetOptions} className="w-full md:min-w-0 md:flex-1" aria-label="Resume into" />
          <div className="flex gap-2">
            {current.live && current.agentId ? (
              <>
                <Button icon={<RotateCcw />} onClick={() => void resume(current)} className={mobile ? "flex-1" : undefined}>
                  Fork
                </Button>
                <Button variant="primary" icon={<ArrowUpRight />} onClick={() => openLive(current)} className={mobile ? "flex-[2]" : undefined}>
                  Open live agent
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<RotateCcw />} onClick={() => void resume(current)} className={mobile ? "flex-1" : undefined}>
                {submit.phase === "failed" ? "Try again" : "Resume"}
              </Button>
            )}
          </div>
        </div>
      </div>
    ) : (
      <div className="flex w-full items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-mute-2">
          {sessions.data ? `${sessionCount === sessions.data.sessions.length ? sessionCount : `${sessionCount} of ${sessions.data.sessions.length}`} sessions${sessions.data.sessions.length >= LIMIT ? ` (newest ${LIMIT})` : ""}` : "Loading sessions…"}
        </p>
        {!mobile && (
          <span className="flex items-center gap-2 text-2xs text-mute-2" aria-hidden>
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </span>
            move
            <Kbd>Enter</Kbd>
            select, again to resume · matches open in place
          </span>
        )}
        <Button variant="primary" icon={<RotateCcw />} disabled className={mobile ? "flex-1" : undefined}>
          {mobile ? "Pick a session" : "Resume"}
        </Button>
      </div>
    );

  const failure =
    submit.phase === "failed" ? (
            <motion.div
              role="alert"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0, x: [0, -6, 5, -3, 0] }}
              transition={{ ...spring.smooth, x: { duration: 0.4 } }}
              className="flex gap-3 rounded-lg bg-error/10 p-3 text-xs shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]"
            >
              <TriangleAlert className="size-4 shrink-0 text-error" />
              <div className="min-w-0">
                <p className="font-bold">Couldn't resume: {submit.title}</p>
                {submit.hint && <p className="text-mute">{submit.hint}</p>}
              </div>
            </motion.div>
    ) : null;

  let body: ReactNode;
  if (sessions.waiting) {
    body = (
      <EmptyState
        compact
        className="h-full"
        icon={<Spinner size={20} label="Waiting for the host" />}
        title={`Waiting for ${profiles.find((p) => p.id === hostId)?.name ?? hostId} to connect`}
        description="Sessions load as soon as the host is online."
        action={
          <Button variant="ghost" onClick={sessions.reload}>
            Try now
          </Button>
        }
      />
    );
  } else if (sessions.error) {
    body = (
      <EmptyState compact icon={<TriangleAlert />} title="Couldn't list sessions" description={sessions.error.message} action={<Button onClick={sessions.reload}>Retry</Button>} className="h-full" />
    );
  } else if (!sessions.data) {
    body = (
      <div className="p-1.5" aria-hidden>
        <Skeleton className="mx-2.5 mt-2.5 mb-2 h-2.5 w-20 rounded-xs" />
        {[60, 44, 72, 52, 38, 66].map((w, i) => (
          <div key={i} className="flex h-[58px] items-center gap-3 px-3">
            <Skeleton className="size-4 shrink-0 rounded-full" style={{ animationDelay: `${i * 90}ms` }} />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 rounded-xs" style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }} />
              <Skeleton className="h-2.5 w-1/3 rounded-xs" style={{ animationDelay: `${i * 90 + 45}ms` }} />
            </div>
            <Skeleton className="h-2.5 w-10 rounded-xs" />
          </div>
        ))}
      </div>
    );
  } else if (sessionCount === 0 && search.status === "searching") {
    body = <EmptyState compact className="h-full" icon={<Spinner size={20} label="Searching messages" />} title={`Searching for “${q.trim()}”`} description={searchNote(search)} />;
  } else if (sessionCount === 0) {
    body = (
      <EmptyState
        compact
        className="h-full"
        icon={q ? <Search /> : <MessagesSquare />}
        title={q ? `Nothing matches “${q}”` : scoped ? `No sessions in ${basename(scope?.cwd ?? "")}` : "No past sessions yet"}
        description={q ? (search.status === "unsupported" ? "Titles, folders and session ids are searched. This host's TeleFlock is too old to search messages." : search.status === "error" ? `Titles, folders and session ids were searched. ${searchNote(search)}` : contentQuery ? "Titles, folders, session ids and messages were searched." : "Titles, folders and session ids are searched. Type two or more characters to search messages too.") : scoped ? "Sessions from other folders are one tap away." : "omp sessions you run on this host show up here, ready to resume."}
        action={
          q ? (
            <Button
              onClick={() => {
                setQ("");
                searchRef.current?.focus();
              }}
            >
              Clear search
            </Button>
          ) : scoped ? (
            <Button onClick={() => setScoped(false)}>Show all folders</Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <SessionList
        rows={rows}
        active={clampedActive}
        selected={selected}
        needle={needle}
        groupBy={groupBy}
        home={home}
        now={now}
        onHover={setActive}
        onSelect={(s) => (s.file === selected ? setSelected(null) : select(s))}
        onOpen={(s) => (s.live && s.agentId ? openLive(s) : void resume(s))}
        onSnippet={openAtMatch}
      />
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Past sessions"
      description={ACTIONS.pastSessions.description}
      icon={<History />}
      width={760}
      maxHeight="94dvh"
      tall
      footer={footer}
    >
      {submit.phase === "done" && hostId ? (
        <div className="flex h-full flex-col">
          <LaunchSuccess hostId={hostId} started={submit.started} title={() => `Resuming ${submit.title}`} onClose={onClose} />
        </div>
      ) : submit.phase === "working" ? (
        <div className="flex h-full flex-col">
          <WorkingPanel since={submit.since} label={`Resuming ${submit.title}`} detail="omp --resume" />
        </div>
      ) : preview && hostId ? (
        <div className="flex h-full min-h-[320px] flex-col gap-3">
          {failure}
          <div className="min-h-0 flex-1">
            <SessionPreview key={`${preview.session.file}:${preview.rowId ?? ""}`} hostId={hostId} target={preview} home={home} mobile={mobile} now={now} onBack={() => setPreview(null)} />
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-[320px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={searchRef}
              autoFocus={!mobile}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={search.status === "unsupported" ? "Search titles and folders" : "Search titles, folders and messages"}
              leading={<Search />}
              boxClassName="min-w-0 flex-1 basis-60"
              aria-label="Search past sessions"
              data-esc-clears
              enterKeyHint="search"
              role="combobox"
              aria-expanded
              aria-controls="past-sessions-list"
              aria-activedescendant={activeStop ? stopId(activeStop.s, activeStop.k) : undefined}
            />
            <SegmentedControl
              size="sm"
              value={groupBy}
              onValueChange={setGroupBy}
              options={[
                { value: "date", label: "Date", icon: <CalendarDays /> },
                { value: "repo", label: "Repo", icon: <FolderGit2 /> },
              ]}
              aria-label="Group by"
            />
            {scope?.cwd && (
              <SegmentedControl
                size="sm"
                value={scoped ? "here" : "all"}
                onValueChange={(v) => setScoped(v === "here")}
                options={[
                  { value: "here", label: basename(scope.cwd) },
                  { value: "all", label: "All folders" },
                ]}
                aria-label="Scope"
              />
            )}
            {hostIds.length > 1 && (
              <SegmentedControl
                size="sm"
                value={hostId ?? ""}
                onValueChange={(id) => {
                  setHostId(id);
                  setPreview(null);
                  setSelected(null);
                  setActive(0);
                }}
                options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
                aria-label="Host"
              />
            )}
          </div>

          {failure}

          {searchNote(search) && (
            <p role="status" className="flex items-center gap-2 text-2xs font-semibold text-mute-2">
              {search.status === "searching" && <Spinner size={12} label="Searching messages" />}
              {searchNote(search)}
            </p>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg well">{body}</div>
        </div>
      )}
    </ResponsiveDialog>
  );
}
