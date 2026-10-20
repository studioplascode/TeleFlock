import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, FolderOpen, History, MessagesSquare, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { core, navigate, useHostIds, useHostState, useHosts, useUi } from "@/core";
import type { PastSession, Started, StartTarget } from "@/core/gen";
import { Badge, Button, EmptyState, Input, SegmentedControl, Select, Skeleton, StatusOrb, cn, formatAge, spring, useIsMobile, useNow } from "@/design";
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

/** Mounted once by the shell; renders while `useUi().dialog.kind === "pastSessions"`. */
export function PastSessionsDialog() {
  const { open, payload, gen, close } = useDialogSession("pastSessions");
  if (!payload) return null;
  return <PastSessionsBody key={gen} open={open} initialHostId={payload.hostId} onClose={close} />;
}

type Submit = { phase: "idle" } | { phase: "working"; since: number; title: string } | { phase: "failed"; title: string; hint?: string } | { phase: "done"; started: Started; title: string };

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
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [target, setTarget] = useState<string>(NEW_AT_CWD);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });
  const now = useNow(30000);
  const listRef = useRef<HTMLDivElement>(null);

  const sessions = useHostQuery(hostId, "host.sessions", { cwd: scoped ? scope?.cwd : undefined, limit: LIMIT });
  const filtered = useMemo(() => {
    const all = sessions.data?.sessions ?? [];
    const needle = q.trim().toLowerCase();
    const list = needle ? all.filter((s) => `${s.title ?? ""} ${s.cwd ?? ""} ${s.id}`.toLowerCase().includes(needle)) : all;
    return [...list].sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt);
  }, [sessions.data, q]);
  const current = filtered.find((s) => s.file === selected);
  const workspaces = host?.workspaces ?? [];

  const select = (s: PastSession) => {
    setSelected(s.file);
    const match = workspaces.find((w) => w.id === scope?.workspaceId) ?? workspaces.find((w) => s.cwd && (w.cwd === s.cwd || w.worktree?.path === s.cwd));
    setTarget(match?.id ?? NEW_AT_CWD);
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const resume = async (s: PastSession) => {
    if (!hostId) return;
    const t: StartTarget = target === NEW_AT_CWD ? { kind: "cwd", cwd: s.cwd ?? home ?? "~", label: null } : { kind: "workspace", workspaceId: target, split: "right" };
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
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = filtered[active];
      if (!s) return;
      if (selected === s.file) {
        if (s.live && s.agentId && !e.ctrlKey) openLive(s);
        else void resume(s);
      } else select(s);
    }
  };

  const busy = submit.phase === "working" || submit.phase === "done";
  const targetOptions = [
    { value: NEW_AT_CWD, label: current?.cwd ? `New workspace at ${tildify(current.cwd, home)}` : "New workspace", icon: <FolderOpen /> },
    ...workspaces.map((w) => ({ value: w.id, label: w.label, hint: `split right · ${tildify(w.cwd, home)}` })),
  ];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Past sessions"
      description="Resume any omp session on the host in a new pane"
      icon={<History />}
      width={720}
      maxHeight="94dvh"
    >
      {submit.phase === "done" && hostId ? (
        <LaunchSuccess hostId={hostId} started={submit.started} title={`Resuming ${submit.title}`} onClose={onClose} />
      ) : submit.phase === "working" ? (
        <WorkingPanel since={submit.since} label={`Resuming ${submit.title}`} detail="omp --resume" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
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
                }}
                options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
                aria-label="Host"
              />
            )}
          </div>

          {submit.phase === "failed" && (
            <div role="alert" className="flex gap-3 rounded-lg bg-error/10 p-3 text-xs shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]">
              <TriangleAlert className="size-4 shrink-0 text-error" />
              <div>
                <p className="font-bold">Couldn't resume: {submit.title}</p>
                {submit.hint && <p className="text-mute">{submit.hint}</p>}
              </div>
            </div>
          )}

          <div ref={listRef} role="listbox" aria-label="Sessions" className="max-h-[min(460px,58dvh)] min-h-[240px] overflow-y-auto overscroll-contain rounded-lg well p-1.5">
            {sessions.error ? (
              <EmptyState compact icon={<TriangleAlert />} title="Couldn't list sessions" description={sessions.error.message} action={<Button onClick={sessions.reload}>Retry</Button>} />
            ) : !sessions.data ? (
              [60, 44, 72, 52, 38].map((w, i) => (
                <div key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
                  <Skeleton className="h-3.5 rounded-xs" style={{ width: `${w}%` }} />
                  <Skeleton className="h-2.5 w-1/3 rounded-xs" />
                </div>
              ))
            ) : filtered.length === 0 ? (
              <EmptyState compact icon={<MessagesSquare />} title={q ? `Nothing matches “${q}”` : "No past sessions"} description={scoped ? "Try All folders." : undefined} />
            ) : (
              filtered.map((s, i) => {
                const isSel = s.file === selected;
                return (
                  <div key={s.file} data-index={i} role="option" aria-selected={isSel} className="relative">
                    {i === active && !isSel && <motion.span layoutId="ps-active" transition={spring.snappy} className="absolute inset-0 rounded-md bg-white/5" aria-hidden />}
                    <button
                      type="button"
                      onPointerMove={() => setActive(i)}
                      onClick={() => (isSel ? setSelected(null) : select(s))}
                      onDoubleClick={() => (s.live && s.agentId ? openLive(s) : void resume(s))}
                      className={cn(
                        "relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-ring",
                        isSel && "bg-accent/14 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5)]",
                      )}
                    >
                      {s.live ? <StatusOrb status="running" size={9} label="Live" /> : <MessagesSquare className="size-4 shrink-0 text-mute-2" />}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-bold">{s.title || <span className="text-mute italic">Untitled session</span>}</span>
                        <span className="truncate font-mono text-2xs text-mute-2">
                          {s.cwd ? tildify(s.cwd, home) : s.file}
                          {s.messages !== undefined && ` · ${s.messages} msgs`}
                        </span>
                      </span>
                      {s.live && <Badge tone="running">Live</Badge>}
                      <span className="shrink-0 text-2xs text-mute tabular">{formatAge(now - s.updatedAt)}</span>
                    </button>
                    <AnimatePresence initial={false}>
                      {isSel && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={spring.smooth}
                          className="overflow-hidden"
                        >
                          <div className="flex flex-col gap-2.5 px-3 pt-2 pb-3">
                            {s.live && (
                              <p className="text-xs text-mute">
                                Open in an omp process right now. Resuming it elsewhere <b className="text-ink-2">forks</b> the session.
                              </p>
                            )}
                            <div className="flex flex-col gap-2 md:flex-row md:items-center">
                              <Select value={target} onValueChange={setTarget} options={targetOptions} className="w-full md:flex-1" aria-label="Resume into" />
                              {s.live && s.agentId ? (
                                <>
                                  <Button variant="primary" icon={<ArrowUpRight />} onClick={() => openLive(s)}>
                                    Open live agent
                                  </Button>
                                  <Button icon={<RotateCcw />} onClick={() => void resume(s)}>
                                    Resume a fork
                                  </Button>
                                </>
                              ) : (
                                <Button variant="primary" icon={<RotateCcw />} onClick={() => void resume(s)}>
                                  Resume
                                </Button>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })
            )}
          </div>
          {sessions.data && (
            <p className="text-2xs text-mute-2">
              {filtered.length} of {sessions.data.sessions.length} sessions
              {sessions.data.sessions.length >= LIMIT && ` (newest ${LIMIT})`} · ↑↓ to move · Enter to select, Enter again to resume
            </p>
          )}
        </div>
      )}
    </ResponsiveDialog>
  );
}
