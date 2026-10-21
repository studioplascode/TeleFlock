import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Ellipsis,
  FileDiff,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Plus,
  RefreshCw,
  Rows3,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { draftKey, navigate, useHostState, useUi, useWorkspaces } from "@/core";
import type { Agent } from "@/core/gen";
import { BottomSheet, Button, Chip, EmptyState, IconButton, SegmentedControl, Shimmer, Skeleton, StatusOrb, Tooltip, cn, spring, useIsMobile } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { tildify } from "../workspace/shared/paths";
import { useHostQuery } from "../workspace/shared/useHostQuery";
import { WorkspaceActionsMenu } from "../workspace/workspaceActions";
import { FanOutSiblings } from "./FanOutSiblings";
import { DiffBar, type DiffLayout, DiffViewer } from "./diff/DiffViewer";
import { type DiffFile, mergeFiles, parsePatch } from "./diff/parse";
import { FileTree } from "./FileTree";
import { ShipPanel, ShipStepper, ShipStrip, shipState, usePrStatus } from "./ShipPanel";

/** Generated/lock files start collapsed; they're noise in review. */
const NOISY = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.snap$/;

/** Desktop rails: explicit user choice (persisted) wins over the width-based default. */
const RAILS_KEY = "tf.review.rails";
type Rails = { files?: boolean; ship?: boolean };
const FILES_MIN_WIDTH = 900;
const SHIP_MIN_WIDTH = 1360;

/** Same order as the file tree: folders before files at each level, then by name. */
function treeOrder(a: DiffFile, b: DiffFile): number {
  const as = a.path.split("/");
  const bs = b.path.split("/");
  for (let i = 0; ; i++) {
    const x = as[i] ?? "";
    const y = bs[i] ?? "";
    if (x === y) {
      if (i >= as.length - 1 || i >= bs.length - 1) return as.length - bs.length;
      continue;
    }
    const xDir = i < as.length - 1;
    const yDir = i < bs.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return x.localeCompare(y);
  }
}

/** A file stays "viewed" only while its diff is unchanged (an agent edit un-views it). */
const viewSig = (f: DiffFile) => `${f.added}:${f.removed}:${f.hunks.length}:${f.status}`;

/** `origin/main (50fc366)` → ref + sha; a bare sha stays a sha. */
function BaseRef({ base }: { base: string }) {
  const m = base.match(/^(.+?) \(([0-9a-f]{6,40})\)$/);
  const ref = m?.[1] ?? (/^[0-9a-f]{12,40}$/.test(base) ? base.slice(0, 7) : base);
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-2xs text-mute" title={`Compared against ${base}`}>
      <span className="text-mute-2">vs</span>
      <span className="truncate text-ink-2">{ref}</span>
      {m?.[2] && <span className="hidden text-mute-2 xl:inline">{m[2].slice(0, 7)}</span>}
    </span>
  );
}

function ViewedProgress({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const all = done === total;
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-2xs font-semibold tabular", all ? "text-done" : "text-mute")} aria-label={`${done} of ${total} files viewed`}>
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-white/8" aria-hidden>
        <motion.span className="absolute inset-y-0 left-0 rounded-full bg-done" initial={false} animate={{ width: `${(done / total) * 100}%` }} transition={spring.smooth} />
      </span>
      {all ? (
        <span className="flex items-center gap-0.5">
          <Check className="size-3" strokeWidth={3} /> all viewed
        </span>
      ) : (
        `${done}/${total} viewed`
      )}
    </span>
  );
}

function LiveBanner({ hostId, working, compact }: { hostId: string; working: Agent[]; compact?: boolean }) {
  const first = working[0];
  if (!first) return null;
  const who = working.length === 1 ? `${first.name} is` : `${working.map((a) => a.name).join(", ")} are`;
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="shrink-0 overflow-hidden">
      <div className="relative flex items-center gap-2.5 overflow-hidden rounded-md bg-accent/[0.08] py-1.5 pr-1.5 pl-3 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]" role="status">
        <span className="tf-loop pointer-events-none absolute inset-x-0 bottom-0 h-px animate-gradient-pan bg-omp bg-[length:200%_100%]" aria-hidden />
        <StatusOrb status="running" size={8} label={null} />
        <span className="shrink-0 text-xs font-bold text-ink">{who} still working</span>
        <Shimmer className="min-w-0 flex-1 truncate text-xs">{first.live.line ?? "editing files…"}</Shimmer>
        {!compact && <span className="hidden shrink-0 text-2xs text-mute-2 lg:inline">The diff refreshes after each turn</span>}
        <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => navigate({ name: "agent", hostId, agentId: first.id })}>
          Watch
        </Button>
      </div>
    </motion.div>
  );
}

/** Shaped like the diff it stands in for: a file header, then gutter + code lines. */
function DiffSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden rounded-lg bg-bg-deep p-1.5 shadow-[inset_0_0_0_1px_var(--color-line)]" aria-busy aria-label="Loading diff">
      <Skeleton className="h-9 shrink-0 rounded-md" />
      <Skeleton className="mx-1 h-5 w-40 shrink-0 rounded-xs" />
      {Array.from({ length: 22 }, (_, i) => (
        <div key={i} className="flex shrink-0 items-center gap-3 px-1">
          <Skeleton className={cn("h-3 shrink-0 rounded-xs opacity-60", compact ? "w-8" : "w-16")} style={{ animationDelay: `${i * 50}ms` }} />
          <Skeleton className="h-3 rounded-xs" style={{ width: `${18 + ((i * 37) % 62)}%`, animationDelay: `${i * 50}ms` }} />
        </div>
      ))}
    </div>
  );
}

function NothingToReview({ hostId, workspaceId, branch, base, agents, working }: { hostId: string; workspaceId: string; branch?: string; base?: string; agents: Agent[]; working: Agent[] }) {
  const ui = useUi();
  const agent = working[0] ?? agents[0];
  const ref = base?.replace(/ \([0-9a-f]+\)$/, "");
  return (
    <div className="grid h-full place-items-center rounded-lg bg-bg-deep/60 p-6 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <EmptyState
        icon={working.length ? <StatusOrb status="running" size={14} label={null} /> : <Check className="text-done" strokeWidth={2.5} />}
        title={working.length ? "No changes yet" : "Nothing to review"}
        description={
          working.length
            ? `${working[0]?.name} is working — edits show up here after its turn.`
            : `${branch ?? "This workspace"} matches ${ref ?? "its base"}. Changes show up here as agents edit files.`
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {agent && (
              <Button size="sm" onClick={() => navigate({ name: "agent", hostId, agentId: agent.id })}>
                Open {agent.name}
              </Button>
            )}
            <Button size="sm" variant={agent ? "ghost" : "primary"} icon={<Plus />} onClick={() => ui.openDialog({ kind: "newAgent", hostId, workspaceId })}>
              New agent
            </Button>
          </div>
        }
      />
    </div>
  );
}

function readRails(): Rails {
  try {
    return JSON.parse(localStorage.getItem(RAILS_KEY) ?? "{}") as Rails;
  } catch {
    return {};
  }
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

export function ReviewView({ hostId, workspaceId }: { hostId: string; workspaceId: string }) {
  const mobile = useIsMobile();
  const workspaces = useWorkspaces(hostId);
  const host = useHostState(hostId);
  const ws = workspaces.find((w) => w.id === workspaceId);
  const cwd = ws ? (ws.worktree?.path ?? ws.cwd) : undefined;
  const fileFilterKey = cwd ? draftKey("review.fileFilter", hostId, cwd) : undefined;
  const agents = useMemo(() => host?.agents.filter((a) => a.workspaceId === workspaceId) ?? [], [host?.agents, workspaceId]);
  const working = agents.filter((a) => a.column === "running");

  const status = useHostQuery(hostId, "git.status", cwd ? { cwd } : null);
  const diff = useHostQuery(hostId, "git.diff", cwd ? { cwd } : null);
  const pr = usePrStatus(hostId, cwd);
  const reload = useCallback(() => {
    status.reload();
    diff.reload();
  }, [status.reload, diff.reload]);

  // Refresh when an agent in this workspace finishes a turn (it probably edited files).
  const turns = agents.reduce((n, a) => n + a.turns, 0);
  useEffect(() => {
    if (turns > 0) reload();
  }, [turns, reload]);

  const files = useMemo(() => (diff.data ? mergeFiles(parsePatch(diff.data.patch), diff.data.files).sort(treeOrder) : []), [diff.data]);
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
  const [viewedSigs, setViewedSigs] = useState<ReadonlyMap<string, string>>(new Map());
  const viewed = useMemo(() => new Set(files.filter((f) => viewedSigs.get(f.path) === viewSig(f)).map((f) => f.path)), [files, viewedSigs]);

  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [wrap, setWrap] = useState(mobile);
  const [scrollTo, setScrollTo] = useState<{ path: string; nonce: number }>();
  const [topFile, setTopFile] = useState<string>();
  const [shipOpen, setShipOpen] = useState(false);
  const effectiveLayout = mobile ? "unified" : layout;
  // Side-by-side halves can't share one horizontal scroll, so split view always wraps.
  const effectiveWrap = wrap || effectiveLayout === "split";

  // ---- desktop rails
  const bodyRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [rails, setRails] = useState<Rails>(readRails);
  const [auto, setAuto] = useState<Required<Rails>>({ files: true, ship: true });
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setAuto((a) => (a.files === w >= FILES_MIN_WIDTH && a.ship === w >= SHIP_MIN_WIDTH ? a : { files: w >= FILES_MIN_WIDTH, ship: w >= SHIP_MIN_WIDTH }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile, !!ws]);
  const filesRail = rails.files ?? auto.files;
  const shipRail = rails.ship ?? auto.ship;
  const setRail = useCallback((k: keyof Rails, open: boolean) => {
    setRails((r) => {
      const next = { ...r, [k]: open };
      localStorage.setItem(RAILS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // ---- mobile drill-in: a history entry per open file, so Back (and Android back) returns to the list
  const [openFile, setOpenFile] = useState<string | null>(() => (window.history.state as { tfReviewFile?: string } | null)?.tfReviewFile ?? null);
  useEffect(() => {
    const onPop = () => setOpenFile((window.history.state as { tfReviewFile?: string } | null)?.tfReviewFile ?? null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const totals = useMemo(() => files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed }), { a: 0, r: 0 }), [files]);
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path));
  const jump = (path: string) => {
    if (collapsed.has(path)) toggle(path);
    if (mobile) {
      const state = { ...(window.history.state as object | null), tfReviewFile: path };
      if (openFile) window.history.replaceState(state, "");
      else window.history.pushState(state, "");
      setOpenFile(path);
    } else setScrollTo({ path, nonce: Date.now() });
  };
  const toggleViewed = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f) return;
    const marking = !viewed.has(path);
    setViewedSigs((m) => {
      const n = new Map(m);
      if (marking) n.set(path, viewSig(f));
      else n.delete(path);
      return n;
    });
    // GitHub-style: a viewed file folds away (desktop); un-viewing unfolds it.
    if (!mobile && marking !== collapsed.has(path)) toggle(path);
  };

  // ---- desktop keyboard map (spec §6 style: single keys, ignored while typing or under a modal)
  const live = useRef({ files, topFile, jump, toggle, toggleViewed, reload, filesRail, shipRail, setRail, viewed });
  useEffect(() => {
    live.current = { files, topFile, jump, toggle, toggleViewed, reload, filesRail, shipRail, setRail, viewed };
  });
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"]')) return;
      const s = live.current;
      const i = s.files.findIndex((f) => f.path === s.topFile);
      const cur = s.files[i];
      const act = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (e.key) {
        case "j":
          return act(() => {
            const n = s.files[Math.min(s.files.length - 1, i + 1)];
            if (n) s.jump(n.path);
          });
        case "k":
          return act(() => {
            const n = s.files[Math.max(0, i - 1)];
            if (n) s.jump(n.path);
          });
        case "x":
          return cur && act(() => s.toggle(cur.path));
        case "v":
          return (
            cur &&
            act(() => {
              const marking = !s.viewed.has(cur.path);
              s.toggleViewed(cur.path);
              const next = marking ? s.files.slice(i + 1).find((f) => !s.viewed.has(f.path)) : undefined;
              if (next) s.jump(next.path);
            })
          );
        case "s":
          return act(() => setLayout((l) => (l === "split" ? "unified" : "split")));
        case "w":
          return act(() => setWrap((w) => !w));
        case "r":
          return act(s.reload);
        case "[":
          return act(() => s.setRail("files", !s.filesRail));
        case "]":
          return act(() => s.setRail("ship", !s.shipRail));
        case "/":
          return act(() => {
            if (!s.filesRail) s.setRail("files", true);
            requestAnimationFrame(() => filterRef.current?.focus());
          });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  if (!ws) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState
          icon={<TriangleAlert />}
          title="Workspace not found"
          description={host ? `It may have been closed on ${host.info.hostname}.` : "Waiting for the host…"}
          action={
            <Button size="sm" onClick={() => navigate({ name: "board" })}>
              Back to the board
            </Button>
          }
        />
      </div>
    );
  }

  const branch = status.data?.branch ?? ws.worktree?.branch ?? ws.repo?.branch;
  const base = diff.data?.base ?? status.data?.base;
  const refreshing = status.loading || diff.loading;
  const ship = status.data ? shipState(status.data, pr.data?.pr) : undefined;
  const hasFiles = files.length > 0;

  const diffArea = diff.error ? (
    <div className="grid h-full place-items-center rounded-lg bg-bg-deep/60 p-6 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <EmptyState
        icon={<TriangleAlert className="text-warn" />}
        title="Couldn't load the diff"
        description={
          <>
            {diff.error.hint && <span className="block">{diff.error.hint}</span>}
            <code className="mt-1.5 block font-mono text-2xs break-words text-mute-2">{diff.error.message}</code>
          </>
        }
        action={
          <Button size="sm" icon={<RefreshCw />} onClick={reload}>
            Retry
          </Button>
        }
      />
    </div>
  ) : !diff.data ? (
    <DiffSkeleton compact={mobile} />
  ) : !hasFiles ? (
    <NothingToReview hostId={hostId} workspaceId={workspaceId} branch={branch} base={base} agents={agents} working={working} />
  ) : null;

  const shipBody: ReactNode = status.data && cwd ? (
    <ShipPanel hostId={hostId} workspace={ws} cwd={cwd} status={status.data} pr={pr} agents={agents} onChanged={reload} />
  ) : status.error ? (
    <EmptyState compact icon={<TriangleAlert className="text-warn" />} title="Couldn't read git status" description={status.error.hint ?? status.error.message} action={<Button size="sm" onClick={status.reload}>Retry</Button>} />
  ) : (
    <div className="flex flex-col gap-3" aria-busy aria-label="Loading git status">
      <Skeleton className="h-12 rounded-lg" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 rounded-lg" />
      ))}
    </div>
  );

  // ------------------------------------------------------------------ mobile
  if (mobile) {
    const open = openFile ? files.find((f) => f.path === openFile) : undefined;
    if (open) {
      const i = files.indexOf(open);
      const prev = files[i - 1];
      const next = files[i + 1];
      const slash = open.path.lastIndexOf("/");
      const seen = viewed.has(open.path);
      return (
        <div className="flex h-full flex-col">
          <MobileHeader
            back
            title={<span className="font-mono text-md">{open.path.slice(slash + 1)}</span>}
            subtitle={<span className="font-mono">{slash > 0 ? open.path.slice(0, slash) : ws.label}</span>}
            actions={
              <IconButton label={wrap ? "Don't wrap lines" : "Wrap lines"} size="sm" variant={wrap ? "secondary" : "ghost"} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
                <WrapText />
              </IconButton>
            }
          />
          <div className="min-h-0 flex-1 px-2">
            <DiffViewer key={open.path} files={[open]} layout="unified" wrap={wrap} collapsed={collapsed} onToggle={toggle} onWrap={() => setWrap(true)} compact busy={refreshing} className="h-full" />
          </div>
          <nav className="flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-2" aria-label="File navigation">
            <IconButton label={prev ? `Previous: ${prev.path}` : "No previous file"} variant="secondary" disabled={!prev} onClick={() => prev && jump(prev.path)} className="size-10">
              <ChevronLeft />
            </IconButton>
            <button
              type="button"
              role="checkbox"
              aria-checked={seen}
              onClick={() => toggleViewed(open.path)}
              className={cn(
                "pressable flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-md text-sm font-bold transition-colors focus-ring",
                seen ? "bg-done/14 text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.35)]" : "bg-tile-3 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]",
              )}
            >
              <span className={cn("grid size-4 place-items-center rounded-[5px] [&_svg]:size-3", seen ? "bg-done text-bg-deep" : "shadow-[inset_0_0_0_1.5px_var(--color-mute)]")} aria-hidden>
                {seen && <Check strokeWidth={4} />}
              </span>
              {seen ? "Viewed" : "Mark viewed"}
              <span className="font-normal text-mute tabular">
                {i + 1}/{files.length}
              </span>
            </button>
            <IconButton
              label={next ? `Next: ${next.path}` : "No next file"}
              variant={seen && next ? "primary" : "secondary"}
              disabled={!next}
              onClick={() => next && jump(next.path)}
              className="size-10"
            >
              <ChevronRight />
            </IconButton>
          </nav>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <MobileHeader
          back
          title={ws.label}
          subtitle={
            <span className="flex items-center gap-1.5">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{branch ?? tildify(cwd ?? "", host?.info.home)}</span>
            </span>
          }
          actions={
            <IconButton label="Refresh" size="sm" onClick={reload}>
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </IconButton>
          }
        />
        <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {base && <BaseRef base={base} />}
            {hasFiles && <DiffBar added={totals.a} removed={totals.r} />}
            <span className="flex-1" />
            {hasFiles && <ViewedProgress done={viewed.size} total={files.length} />}
          </div>
          {diff.data?.truncated && <Chip tone="needs-you">Patch truncated: very large diff</Chip>}
          <FanOutSiblings hostId={hostId} workspaceId={workspaceId} />
          <AnimatePresence>{working.length > 0 && <LiveBanner hostId={hostId} working={working} compact />}</AnimatePresence>
        </div>
        <div className="min-h-0 flex-1 px-3">
          {diffArea ?? <FileTree files={files} collapsed={collapsed} viewed={viewed} onSelect={jump} filterKey={fileFilterKey} comfortable className="h-full" />}
        </div>
        <div className="shrink-0 px-3 pt-1.5 pb-2">
          <button
            type="button"
            onClick={() => setShipOpen(true)}
            disabled={!ship}
            className="pressable glass flex w-full items-center gap-3 rounded-lg py-2 pr-3 pl-3.5 text-left focus-ring disabled:opacity-60"
            aria-label={ship ? `Ship. Next: ${ship.next}` : "Ship"}
          >
            <span className="w-[140px] shrink-0">{ship ? <ShipStepper stage={ship.stage} blocked={!!ship.blocked} dots /> : <Skeleton className="h-5 rounded-full" />}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="kicker text-[10px]">Ship</span>
              <span className={cn("truncate text-sm font-bold", ship?.blocked ? "text-warn" : ship?.stage === 4 ? "text-done" : "text-ink")}>{ship?.next ?? "Reading git status…"}</span>
            </span>
            <ChevronUp className="size-4 shrink-0 text-mute" />
          </button>
        </div>
        <BottomSheet open={shipOpen} onOpenChange={setShipOpen} title={`Ship ${branch ?? ws.label}`} description={ship?.next} autoFocus={false}>
          {shipBody}
        </BottomSheet>
      </div>
    );
  }

  // ------------------------------------------------------------------ desktop
  const toolbar = (
    <div className="flex shrink-0 items-center gap-1">
      {hasFiles && (
        <Tooltip content={filesRail ? "Hide files" : "Show files"} shortcut="[">
          <IconButton label={filesRail ? "Hide files" : "Show files"} size="sm" aria-pressed={filesRail} onClick={() => setRail("files", !filesRail)}>
            {filesRail ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
        </Tooltip>
      )}
      <SegmentedControl
        size="sm"
        value={layout}
        onValueChange={setLayout}
        options={[
          { value: "unified", label: <span className="max-xl:sr-only">Unified</span>, icon: <Rows3 /> },
          { value: "split", label: <span className="max-xl:sr-only">Split</span>, icon: <Columns2 /> },
        ]}
        aria-label="Diff layout (S)"
      />
      <Tooltip content={effectiveLayout === "split" ? "Split view always wraps" : effectiveWrap ? "Stop wrapping long lines" : "Wrap long lines"} shortcut="W">
        <span>
          <Button
            size="sm"
            variant={effectiveWrap ? "secondary" : "ghost"}
            icon={<WrapText />}
            aria-pressed={effectiveWrap}
            disabled={effectiveLayout === "split"}
            onClick={() => setWrap((w) => !w)}
            className="px-2.5"
          >
            <span className="max-xl:sr-only">Wrap</span>
          </Button>
        </span>
      </Tooltip>
      <Tooltip content={allCollapsed ? "Expand all files" : "Collapse all files"}>
        <IconButton label={allCollapsed ? "Expand all" : "Collapse all"} size="sm" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))} disabled={!hasFiles}>
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </IconButton>
      </Tooltip>
      <Tooltip content="Refresh" shortcut="R">
        <IconButton label="Refresh diff" size="sm" onClick={reload}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </IconButton>
      </Tooltip>
      <WorkspaceActionsMenu hostId={hostId} workspace={ws} home={host?.info.home}>
        <IconButton label="Workspace actions" size="sm">
          <Ellipsis />
        </IconButton>
      </WorkspaceActionsMenu>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-omp text-white shadow-glow-accent">
          <FileDiff className="size-5" />
        </div>
        <div className="@container flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate font-display text-2xl leading-tight font-bold" title={tildify(cwd ?? "", host?.info.home)}>
            Review <span className="text-accent-ink">{ws.label}</span>
          </h1>
          <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
            {branch && (
              <Chip icon={<GitBranch />} className="max-w-56 min-w-0 shrink [&_svg]:shrink-0">
                <span className="truncate">{branch}</span>
              </Chip>
            )}
            {base && (
              <span className="hidden min-w-0 @2xl:flex">
                <BaseRef base={base} />
              </span>
            )}
            {hasFiles && (
              <span className="flex shrink-0 items-center gap-2 text-2xs text-mute">
                <span className="text-line-3">·</span>
                {files.length} file{files.length === 1 ? "" : "s"}
                <DiffBar added={totals.a} removed={totals.r} />
              </span>
            )}
            {hasFiles && (
              <span className="hidden shrink-0 items-center gap-2.5 @md:flex">
                <span className="text-2xs text-line-3">·</span>
                <ViewedProgress done={viewed.size} total={files.length} />
              </span>
            )}
            {diff.data?.truncated && <Chip tone="needs-you">patch truncated</Chip>}
          </div>
        </div>
        {toolbar}
      </header>
      <FanOutSiblings hostId={hostId} workspaceId={workspaceId} />
      <AnimatePresence>{working.length > 0 && <LiveBanner hostId={hostId} working={working} />}</AnimatePresence>
      <div ref={bodyRef} className="flex min-h-0 flex-1 gap-3">
        <AnimatePresence initial={false}>
          {hasFiles && filesRail && (
            <motion.aside
              key="files"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16, transition: { duration: 0.12 } }}
              transition={spring.smooth}
              className="tile flex w-[236px] shrink-0 flex-col gap-2 p-3"
              aria-label="Changed files"
            >
              <div className="flex items-center gap-2 px-1">
                <span className="kicker">Files</span>
                <span className="text-2xs font-bold text-mute-2 tabular">{files.length}</span>
              </div>
              <FileTree files={files} active={topFile} collapsed={collapsed} viewed={viewed} onSelect={jump} filterRef={filterRef} filterKey={fileFilterKey} className="min-h-0 flex-1" />
            </motion.aside>
          )}
        </AnimatePresence>
        <div className="min-h-0 min-w-0 flex-1">
          {diffArea ?? (
            <DiffViewer
              files={files}
              layout={effectiveLayout}
              wrap={effectiveWrap}
              collapsed={collapsed}
              onToggle={toggle}
              viewed={viewed}
              onToggleViewed={toggleViewed}
              onWrap={() => setWrap(true)}
              scrollTo={scrollTo}
              onTopFile={setTopFile}
              busy={refreshing}
              className="h-full"
            />
          )}
        </div>
        {shipRail ? (
          <motion.aside
            key="ship"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={spring.smooth}
            className="tile flex w-[332px] shrink-0 flex-col"
            aria-label="Ship"
          >
            <div className="flex items-center gap-2 px-4 pt-3 pb-1">
              <span className="kicker">Ship</span>
              <span className="flex-1" />
              <Tooltip content="Collapse" shortcut="]">
                <IconButton label="Collapse ship panel" size="sm" onClick={() => setRail("ship", false)}>
                  <PanelRightClose />
                </IconButton>
              </Tooltip>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-3">{shipBody}</div>
          </motion.aside>
        ) : ship ? (
          <ShipStrip state={ship} onOpen={() => setRail("ship", true)} />
        ) : (
          <Skeleton className="w-[52px] shrink-0 rounded-tile" />
        )}
      </div>
    </div>
  );
}
