import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { ArrowUpRight, CalendarDays, FolderGit2, FolderOpen, History, MessagesSquare, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { core, navigate, useHostIds, useHostState, useHosts, useUi } from "@/core";
import type { PastSession, Started, StartTarget, Workspace } from "@/core/gen";
import { Button, EmptyState, Input, Kbd, SegmentedControl, Select, Skeleton, Spinner, StatusOrb, cn, formatAge, spring, useIsMobile, useNow } from "@/design";
import { describeError } from "../workspace/shared/errors";
import { LaunchSuccess, WorkingPanel } from "../workspace/shared/LaunchProgress";
import { basename, tildify } from "../workspace/shared/paths";
import { ResponsiveDialog } from "../workspace/shared/ResponsiveDialog";
import { useDialogSession } from "../workspace/shared/useDialogSession";
import { useHostQuery } from "../workspace/shared/useHostQuery";

/** Scope for the next open (the ui dialog payload only carries the host). */
let pendingScope: { cwd?: string; workspaceId?: string } | null = null;

/** Open Past sessions, optionally scoped to a workspace's folder (the sidebar's "Past sessions…"). */
export function openPastSessions(opts: { hostId?: string; cwd?: string; workspaceId?: string } = {}) {
  pendingScope = { cwd: opts.cwd, workspaceId: opts.workspaceId };
  useUi.getState().openDialog({ kind: "pastSessions", hostId: opts.hostId });
}

const LIMIT = 200;
const NEW_AT_CWD = "__new";
const HEADER_H = 34;
const ROW_H = 58;
const DAY = 86_400_000;

/** Mounted once by the shell; renders while `useUi().dialog.kind === "pastSessions"`. */
export function PastSessionsDialog() {
  const { open, payload, gen, close } = useDialogSession("pastSessions");
  if (!payload) return null;
  return <PastSessionsBody key={gen} open={open} initialHostId={payload.hostId} onClose={close} />;
}

type Submit = { phase: "idle" } | { phase: "working"; since: number; title: string } | { phase: "failed"; title: string; hint?: string } | { phase: "done"; started: Started; title: string };
type GroupBy = "date" | "repo";
type ListRow = { t: "head"; key: string; label: string; count: number; live?: boolean } | { t: "item"; key: string; s: PastSession; repo: string; i: number };

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
  const [q, setQ] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [target, setTarget] = useState<string>(NEW_AT_CWD);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });
  const now = useNow(30000);
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaces = useMemo(() => host?.workspaces ?? [], [host?.workspaces]);

  const sessions = useHostQuery(hostId, "host.sessions", { cwd: scoped ? scope?.cwd : undefined, limit: LIMIT });
  const needle = q.trim().toLowerCase();

  // flat render list: group headers + sessions; `order` is the keyboard order (sessions only)
  const { rows, order } = useMemo(() => {
    const all = sessions.data?.sessions ?? [];
    const matched = needle ? all.filter((s) => `${s.title ?? ""} ${s.cwd ?? ""} ${s.id}`.toLowerCase().includes(needle)) : all;
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const groups = new Map<string, { label: string; live?: boolean; items: { s: PastSession; repo: string }[]; latest: number }>();
    for (const s of [...matched].sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt)) {
      const repo = repoOf(s, workspaces);
      const key = groupBy === "repo" ? `r:${repo}` : s.live ? "live" : `d:${dateBucket(s.updatedAt, startOfToday)}`;
      let g = groups.get(key);
      if (!g) {
        g = { label: groupBy === "repo" ? repo : s.live ? "Live now" : dateBucket(s.updatedAt, startOfToday), live: groupBy === "date" && s.live, items: [], latest: s.updatedAt };
        groups.set(key, g);
      }
      g.items.push({ s, repo });
    }
    // date buckets are already chronological (insertion order); repos sort by their newest session
    const ordered = [...groups.entries()];
    if (groupBy === "repo") ordered.sort((a, b) => b[1].latest - a[1].latest);
    const out: ListRow[] = [];
    const flat: PastSession[] = [];
    for (const [key, g] of ordered) {
      out.push({ t: "head", key: `h:${key}`, label: g.label, count: g.items.length, live: g.live });
      for (const { s, repo } of g.items) {
        out.push({ t: "item", key: s.file, s, repo, i: flat.length });
        flat.push(s);
      }
    }
    return { rows: out, order: flat };
  }, [sessions.data, needle, groupBy, workspaces, now]);

  const current = order.find((s) => s.file === selected);
  const clampedActive = Math.min(active, Math.max(0, order.length - 1));

  const select = (s: PastSession) => {
    setSelected(s.file);
    setActive(order.indexOf(s));
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

  const openLive = (s: PastSession) => {
    if (!hostId || !s.agentId) return;
    onClose();
    navigate({ name: "agent", hostId, agentId: s.agentId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(order.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = order[clampedActive];
      if (!s) return;
      if (selected === s.file) {
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
          {sessions.data ? `${order.length === sessions.data.sessions.length ? order.length : `${order.length} of ${sessions.data.sessions.length}`} sessions${sessions.data.sessions.length >= LIMIT ? ` (newest ${LIMIT})` : ""}` : "Loading sessions…"}
        </p>
        {!mobile && (
          <span className="flex items-center gap-2 text-2xs text-mute-2" aria-hidden>
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </span>
            move
            <Kbd>Enter</Kbd>
            select, again to resume
          </span>
        )}
        <Button variant="primary" icon={<RotateCcw />} disabled className={mobile ? "flex-1" : undefined}>
          {mobile ? "Pick a session" : "Resume"}
        </Button>
      </div>
    );

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
  } else if (order.length === 0) {
    body = (
      <EmptyState
        compact
        className="h-full"
        icon={q ? <Search /> : <MessagesSquare />}
        title={q ? `Nothing matches “${q}”` : scoped ? `No sessions in ${basename(scope?.cwd ?? "")}` : "No past sessions yet"}
        description={q ? "Titles, folders and session ids are searched." : scoped ? "Sessions from other folders are one tap away." : "omp sessions you run on this host show up here, ready to resume."}
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
      />
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Past sessions"
      description="Resume any omp session on the host in a new pane"
      icon={<History />}
      width={760}
      maxHeight="94dvh"
      tall
      footer={footer}
    >
      {submit.phase === "done" && hostId ? (
        <div className="flex h-full flex-col">
          <LaunchSuccess hostId={hostId} started={submit.started} title={`Resuming ${submit.title}`} onClose={onClose} />
        </div>
      ) : submit.phase === "working" ? (
        <div className="flex h-full flex-col">
          <WorkingPanel since={submit.since} label={`Resuming ${submit.title}`} detail="omp --resume" />
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
              placeholder="Search titles and folders"
              leading={<Search />}
              boxClassName="min-w-0 flex-1 basis-60"
              aria-label="Search past sessions"
              data-esc-clears
              enterKeyHint="search"
              role="combobox"
              aria-expanded
              aria-controls="past-sessions-list"
              aria-activedescendant={order[clampedActive] ? `ps-${order[clampedActive]?.id}` : undefined}
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
                  setSelected(null);
                  setActive(0);
                }}
                options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
                aria-label="Host"
              />
            )}
          </div>

          {submit.phase === "failed" && (
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
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg well">{body}</div>
        </div>
      )}
    </ResponsiveDialog>
  );
}

interface SessionListProps {
  rows: ListRow[];
  active: number;
  selected: string | null;
  needle: string;
  groupBy: GroupBy;
  home?: string;
  now: number;
  onHover: (i: number) => void;
  onSelect: (s: PastSession) => void;
  onOpen: (s: PastSession) => void;
}

/** Virtualized, grouped session list (up to LIMIT rows). */
function SessionList({ rows, active, selected, needle, groupBy, home, now, onHover, onSelect, onOpen }: SessionListProps) {
  // TanStack Virtual mutates one virtualizer instance per scroll; compiler memoization would freeze it.
  "use no memo";
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.t === "head" ? HEADER_H : ROW_H),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
  });
  const activeRow = rows.findIndex((r) => r.t === "item" && r.i === active);

  useEffect(() => {
    if (activeRow < 0) return;
    // keep the group header visible when moving onto a group's first session
    virtualizer.scrollToIndex(rows[activeRow - 1]?.t === "head" ? activeRow - 1 : activeRow, { align: "auto" });
  }, [activeRow, rows, virtualizer]);

  return (
    <div ref={scrollRef} id="past-sessions-list" role="listbox" aria-label="Sessions" className="h-full overflow-y-auto overscroll-contain p-1.5">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const r = rows[vi.index] as ListRow;
          const style = { height: vi.size, transform: `translateY(${vi.start}px)` };
          if (r.t === "head") {
            return (
              <div key={vi.key} role="presentation" className="absolute inset-x-0 top-0 flex items-center gap-2 px-2.5 pt-2" style={style}>
                {r.live ? <StatusOrb status="running" size={6} label={null} /> : groupBy === "repo" ? <FolderGit2 className="size-3 text-mute-2" /> : null}
                <span className={cn("kicker", r.live && "text-accent-hi")}>{r.label}</span>
                <span className="text-2xs font-semibold text-mute-2 tabular">{r.count}</span>
              </div>
            );
          }
          const { s } = r;
          const isSel = s.file === selected;
          const isActive = r.i === active;
          return (
            <div
              key={vi.key}
              id={`ps-${s.id}`}
              role="option"
              aria-selected={isSel}
              onPointerMove={() => onHover(r.i)}
              onClick={() => onSelect(s)}
              onDoubleClick={() => onOpen(s)}
              className="absolute inset-x-0 top-0 cursor-pointer select-none"
              style={style}
            >
              {(isActive || isSel) && (
                <motion.span
                  layoutId={isSel ? undefined : "ps-active"}
                  transition={spring.snappy}
                  className={cn("absolute inset-0.5 rounded-md", isSel ? "bg-accent/14 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5),0_0_22px_-10px_rgb(163_92_240/0.9)]" : "bg-white/5")}
                  aria-hidden
                />
              )}
              <div className="relative flex h-full items-center gap-3 px-3">
                <span className="grid size-5 shrink-0 place-items-center">
                  {s.live ? <StatusOrb status="running" size={9} label={null} /> : <MessagesSquare className={cn("size-4", isSel ? "text-accent" : "text-mute-2")} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-bold">{s.title ? <Highlight text={s.title} needle={needle} /> : <span className="font-semibold text-mute italic">Untitled session</span>}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-2xs text-mute-2">
                    {groupBy === "date" && <span className="shrink-0 rounded-xs bg-white/6 px-1.5 py-px font-semibold text-ink-2">{r.repo}</span>}
                    <span className="truncate font-mono">{s.cwd ? <Highlight text={tildify(s.cwd, home)} needle={needle} /> : s.file}</span>
                    {s.messages !== undefined && <span className="shrink-0 tabular">· {s.messages} msgs</span>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="text-2xs text-mute tabular">{formatAge(now - s.updatedAt)}</span>
                  {s.live && <span className="text-2xs font-bold text-accent-hi">live</span>}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** First case-insensitive occurrence of `needle` in `text`, marked. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent/30 text-ink">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
