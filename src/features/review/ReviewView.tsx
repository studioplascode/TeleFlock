import { AnimatePresence, motion } from "motion/react";
import { ChevronsDownUp, ChevronsUpDown, Columns2, FileDiff, FolderTree, GitBranch, RefreshCw, Rows3, TriangleAlert, WrapText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHostState, useWorkspaces } from "@/core";
import { BottomSheet, Button, Chip, EmptyState, IconButton, SegmentedControl, Shimmer, Skeleton, StatusOrb, Tooltip, cn, spring, useIsMobile } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { tildify } from "../workspace/shared/paths";
import { useHostQuery } from "../workspace/shared/useHostQuery";
import { WorkspaceActionsMenu } from "../workspace/workspaceActions";
import { DiffBar, type DiffLayout, DiffViewer } from "./diff/DiffViewer";
import { mergeFiles, parsePatch } from "./diff/parse";
import { FileTree } from "./FileTree";
import { ShipPanel } from "./ShipPanel";

/** Generated/lock files start collapsed; they're noise in review. */
const NOISY = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.snap$/;

export function ReviewView({ hostId, workspaceId }: { hostId: string; workspaceId: string }) {
  const mobile = useIsMobile();
  const workspaces = useWorkspaces(hostId);
  const host = useHostState(hostId);
  const ws = workspaces.find((w) => w.id === workspaceId);
  const cwd = ws ? (ws.worktree?.path ?? ws.cwd) : undefined;
  const agents = useMemo(() => host?.agents.filter((a) => a.workspaceId === workspaceId) ?? [], [host?.agents, workspaceId]);
  const working = agents.filter((a) => a.column === "running");

  const status = useHostQuery(hostId, "git.status", cwd ? { cwd } : null);
  const diff = useHostQuery(hostId, "git.diff", cwd ? { cwd } : null);
  const reload = useCallback(() => {
    status.reload();
    diff.reload();
  }, [status.reload, diff.reload]);

  // Refresh when an agent in this workspace finishes a turn (it probably edited files).
  const turns = agents.reduce((n, a) => n + a.turns, 0);
  useEffect(() => {
    if (turns > 0) reload();
  }, [turns, reload]);

  const files = useMemo(() => (diff.data ? mergeFiles(parsePatch(diff.data.patch), diff.data.files) : []), [diff.data]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [seeded, setSeeded] = useState<typeof files | null>(null);
  if (files !== seeded) {
    setSeeded(files);
    setCollapsed((prev) => {
      const next = new Set([...prev].filter((p) => files.some((f) => f.path === p)));
      for (const f of files) if (NOISY.test(f.path) && !seeded?.some((s) => s.path === f.path)) next.add(f.path);
      return next;
    });
  }
  const toggle = useCallback(
    (p: string) =>
      setCollapsed((s) => {
        const n = new Set(s);
        if (n.has(p)) n.delete(p);
        else n.add(p);
        return n;
      }),
    [],
  );
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [wrap, setWrap] = useState(mobile);
  const [scrollTo, setScrollTo] = useState<{ path: string; nonce: number }>();
  const [topFile, setTopFile] = useState<string>();
  const [tab, setTab] = useState<"changes" | "ship">("changes");
  const [filesOpen, setFilesOpen] = useState(false);
  const effectiveLayout = mobile ? "unified" : layout;

  const totals = useMemo(() => files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed }), { a: 0, r: 0 }), [files]);
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path));
  const jump = (path: string) => {
    if (collapsed.has(path)) toggle(path);
    setScrollTo({ path, nonce: Date.now() });
    setFilesOpen(false);
  };

  if (!ws) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState icon={<TriangleAlert />} title="Workspace not found" description={host ? `It may have been closed on ${host.info.hostname}.` : "Waiting for the host…"} />
      </div>
    );
  }

  const branch = status.data?.branch ?? ws.worktree?.branch ?? ws.repo?.branch;
  const base = diff.data?.base ?? status.data?.base;
  const refreshing = status.loading || diff.loading;

  const liveBanner = working.length > 0 && (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={spring.smooth}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-2.5 rounded-md bg-accent/[0.08] px-3 py-2 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]">
        <StatusOrb status="running" size={8} label={null} />
        <Shimmer className="min-w-0 flex-1 truncate text-xs font-semibold">
          {working.map((a) => a.name).join(", ")} still working{working[0]?.live.line ? ` — ${working[0].live.line}` : ""}
        </Shimmer>
        <span className="text-2xs text-mute-2">refreshes when done</span>
      </div>
    </motion.div>
  );

  const toolbar = (
    <div className="flex items-center gap-1.5">
      {!mobile && (
        <SegmentedControl
          size="sm"
          value={layout}
          onValueChange={setLayout}
          options={[
            { value: "unified", label: "Unified", icon: <Rows3 /> },
            { value: "split", label: "Split", icon: <Columns2 /> },
          ]}
          aria-label="Diff layout"
        />
      )}
      <Tooltip content={wrap ? "Don't wrap lines" : "Wrap long lines"}>
        <IconButton label="Wrap lines" size="sm" variant={wrap ? "secondary" : "ghost"} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          <WrapText />
        </IconButton>
      </Tooltip>
      <Tooltip content={allCollapsed ? "Expand all files" : "Collapse all files"}>
        <IconButton label={allCollapsed ? "Expand all" : "Collapse all"} size="sm" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))} disabled={!files.length}>
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </IconButton>
      </Tooltip>
      <Tooltip content="Refresh">
        <IconButton label="Refresh diff" size="sm" onClick={reload}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </IconButton>
      </Tooltip>
    </div>
  );

  const diffArea = diff.error ? (
    <EmptyState compact icon={<TriangleAlert />} title="Couldn't load the diff" description={diff.error.hint ?? diff.error.message} action={<Button onClick={reload}>Retry</Button>} />
  ) : !diff.data ? (
    <div className="flex flex-col gap-2 p-3" aria-busy>
      {Array.from({ length: 14 }, (_, i) => (
        <Skeleton key={i} className="h-4 rounded-xs" style={{ width: `${30 + ((i * 37) % 60)}%`, animationDelay: `${i * 60}ms` }} />
      ))}
    </div>
  ) : files.length === 0 ? (
    <EmptyState icon={<FileDiff />} title="Nothing to review" description={`No changes against ${base ?? "the base branch"}.`} />
  ) : (
    <DiffViewer files={files} layout={effectiveLayout} wrap={wrap} collapsed={collapsed} onToggle={toggle} scrollTo={scrollTo} onTopFile={setTopFile} className="h-full" />
  );

  const ship = status.data && cwd ? (
    <ShipPanel hostId={hostId} workspace={ws} cwd={cwd} status={status.data} agents={agents} onChanged={reload} />
  ) : status.error ? (
    <p className="text-xs text-error">{status.error.message}</p>
  ) : (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-24 rounded-lg" />
      ))}
    </div>
  );

  const summary = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {branch && <Chip icon={<GitBranch />}>{branch}</Chip>}
      {base && <span className="font-mono text-2xs text-mute-2">vs {base.length > 12 ? base.slice(0, 8) : base}</span>}
      {files.length > 0 && (
        <span className="flex items-center gap-2 text-2xs text-mute">
          {files.length} file{files.length === 1 ? "" : "s"}
          <DiffBar added={totals.a} removed={totals.r} />
        </span>
      )}
      {diff.data?.truncated && <Chip tone="needs-you">patch truncated</Chip>}
    </div>
  );

  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader
          back
          title={ws.label}
          subtitle={tildify(cwd ?? "", host?.info.home)}
          actions={
            <IconButton label="Refresh" size="sm" onClick={reload}>
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </IconButton>
          }
        />
        <div className="flex flex-col gap-2 px-3 pb-2">
          {summary}
          <AnimatePresence>{liveBanner}</AnimatePresence>
          <SegmentedControl
            fill
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "changes", label: `Changes${files.length ? ` · ${files.length}` : ""}`, icon: <FileDiff /> },
              { value: "ship", label: "Ship", icon: <GitBranch /> },
            ]}
            aria-label="Review section"
          />
        </div>
        {tab === "changes" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<FolderTree />} onClick={() => setFilesOpen(true)} disabled={!files.length} className="min-w-0 flex-1 justify-start">
                <span className="truncate font-mono">{topFile ?? "Files"}</span>
              </Button>
              {toolbar}
            </div>
            <div className="min-h-0 flex-1">{diffArea}</div>
            <BottomSheet open={filesOpen} onOpenChange={setFilesOpen} title="Changed files" description={`${files.length} files · +${totals.a} −${totals.r}`}>
              <FileTree files={files} active={topFile} collapsed={collapsed} onSelect={jump} className="h-[60dvh]" />
            </BottomSheet>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">{ship}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="grid size-10 place-items-center rounded-md bg-omp text-white shadow-glow-accent">
          <FileDiff className="size-5" />
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-2xl font-bold">Review {ws.label}</h1>
            <WorkspaceActionsMenu hostId={hostId} workspace={ws} home={host?.info.home}>
              <Button size="sm" variant="ghost">
                Actions
              </Button>
            </WorkspaceActionsMenu>
          </div>
          <span className="truncate font-mono text-2xs text-mute-2">{tildify(cwd ?? "", host?.info.home)}</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {summary}
          {toolbar}
        </div>
      </header>
      <AnimatePresence>{liveBanner}</AnimatePresence>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,260px)_minmax(0,1fr)_minmax(300px,360px)] gap-3">
        <div className="tile flex min-h-0 flex-col p-3">
          <span className="kicker mb-2 px-1">Files</span>
          {diff.data ? <FileTree files={files} active={topFile} collapsed={collapsed} onSelect={jump} className="min-h-0 flex-1" /> : <Skeleton className="h-40 rounded-md" />}
        </div>
        <div className="min-h-0 min-w-0">{diffArea}</div>
        <div className="tile min-h-0 overflow-y-auto p-3">
          <span className="kicker mb-2 block px-1">Ship</span>
          {ship}
        </div>
      </div>
    </div>
  );
}
