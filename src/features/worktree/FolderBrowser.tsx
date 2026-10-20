import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ChevronRight, Clock, CornerDownLeft, Eye, EyeOff, Folder, FolderGit2, GitBranch, Home, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useWorkspaces } from "@/core";
import type { FsEntry, GitBadge } from "@/core/gen";
import { Button, Chip, IconButton, Input, Skeleton, cn, spring, tween } from "@/design";
import { basename, crumbs, expandTilde, tildify } from "../workspace/shared/paths";
import { useHostQuery } from "../workspace/shared/useHostQuery";

export interface FolderPick {
  path: string;
  git?: GitBadge;
}

export interface FolderBrowserProps {
  hostId: string;
  /**
   * `repo`: clicking a repository selects it (other folders open). `folder`: clicking opens,
   * "Use this folder" selects the current directory.
   */
  mode: "repo" | "folder";
  /** Currently selected path (highlighted). */
  value?: string;
  onSelect: (pick: FolderPick) => void;
  /** Double-click / Ctrl+Enter on a selection: "pick and continue". */
  onConfirm?: (pick: FolderPick) => void;
  /** Start here instead of `$HOME`. */
  initialPath?: string;
  autoFocus?: boolean;
  className?: string;
}

interface Row {
  key: string;
  path: string;
  name: string;
  git?: GitBadge;
  recent?: boolean;
}

/**
 * Remote folder browser over `fs.home` / `fs.list`: breadcrumb, git badges, filter-or-path input,
 * recent repositories from open workspaces, full keyboard navigation (↑↓ · Enter/→ open/select ·
 * ←/Backspace up · Ctrl+Enter confirm).
 */
export function FolderBrowser({ hostId, mode, value, onSelect, onConfirm, initialPath, autoFocus, className }: FolderBrowserProps) {
  const home = useHostQuery(hostId, "fs.home", {});
  const homePath = home.data?.path;
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cwd = path ?? homePath;
  const listing = useHostQuery(hostId, "fs.list", cwd ? { path: cwd, hidden } : null);
  const workspaces = useWorkspaces(hostId);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const recent = useMemo<Row[]>(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const ws of workspaces) {
      const root = mode === "repo" ? ws.repo?.root : ws.cwd;
      if (!root || seen.has(root) || ws.worktree) continue;
      seen.add(root);
      out.push({
        key: `recent:${root}`,
        path: root,
        name: ws.repo?.name ?? basename(root),
        git: ws.repo ? { repoRoot: true, worktree: false, branch: ws.repo.branch, dirty: ws.repo.dirty } : undefined,
        recent: true,
      });
    }
    return out.slice(0, 8);
  }, [workspaces, mode]);

  const isPathInput = /^[~/]/.test(filter) || /^[A-Za-z]:[\\/]/.test(filter);
  const q = isPathInput ? "" : filter.trim().toLowerCase();
  const entries = listing.data?.entries;
  const rows = useMemo<Row[]>(() => {
    const dirs = (entries ?? []).filter((e: FsEntry) => e.kind === "dir" || (e.kind === "symlink" && e.git));
    const matched = q ? dirs.filter((e) => e.name.toLowerCase().includes(q)) : dirs;
    matched.sort((a, b) => Number(!!b.git?.repoRoot) - Number(!!a.git?.repoRoot) || a.name.localeCompare(b.name));
    return matched.map((e) => ({ key: e.path, path: e.path, name: e.name, git: e.git }));
  }, [entries, q]);
  const recentRows = recent.filter((r) => (!q || r.name.toLowerCase().includes(q)) && !rows.some((row) => row.path === r.path));
  const allRows = [...rows, ...recentRows];
  const fileCount = (entries ?? []).filter((e) => e.kind === "file").length;
  const clampedActive = Math.min(active, Math.max(0, allRows.length - 1));

  const go = (next: string, dir: 1 | -1) => {
    setDirection(dir);
    setPath(next);
    setFilter("");
    setActive(0);
  };

  const activate = (row: Row, confirm = false) => {
    if (mode === "repo" && row.git?.repoRoot) {
      onSelect({ path: row.path, git: row.git });
      if (confirm) onConfirm?.({ path: row.path, git: row.git });
      return;
    }
    if (confirm && mode === "folder") {
      onSelect({ path: row.path, git: row.git });
      onConfirm?.({ path: row.path, git: row.git });
      return;
    }
    go(row.path, 1);
  };

  const up = () => {
    const parent = listing.data?.parent;
    if (parent && parent !== cwd) go(parent, -1);
  };

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${clampedActive}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedActive]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const row = allRows[clampedActive];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(allRows.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "ArrowRight":
        if (row && (filter === "" || e.currentTarget.selectionStart === filter.length)) {
          e.preventDefault();
          go(row.path, 1);
        }
        break;
      case "ArrowLeft":
        if (filter === "") {
          e.preventDefault();
          up();
        }
        break;
      case "Backspace":
        if (filter === "") {
          e.preventDefault();
          up();
        }
        break;
      case "Enter":
        e.preventDefault();
        if (isPathInput) {
          go(expandTilde(filter.trim(), homePath), 1);
        } else if (e.ctrlKey || e.metaKey) {
          if (row) activate(row, true);
          else if (cwd) onConfirm?.({ path: cwd, git: listing.data?.git });
        } else if (row) {
          activate(row);
        }
        break;
      case "Escape":
        if (filter) {
          e.preventDefault();
          e.stopPropagation();
          setFilter("");
        }
        break;
    }
  };

  const here = listing.data?.git;
  const trail = cwd ? crumbs(cwd, homePath) : [];
  const currentSelectable = mode === "folder" || !!here?.repoRoot;

  return (
    <div className={cn("flex min-h-0 flex-col gap-2.5", className)}>
      {/* breadcrumb */}
      <div className="flex items-center gap-1">
        <IconButton label="Home" size="sm" onClick={() => homePath && go(homePath, -1)} disabled={!homePath || cwd === homePath}>
          <Home />
        </IconButton>
        <IconButton label="Up one folder (Backspace)" size="sm" onClick={up} disabled={!listing.data?.parent}>
          <ArrowUp />
        </IconButton>
        <nav aria-label="Folder path" className="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto rounded-sm well px-1.5 py-1">
          {trail.length === 0 && <Skeleton className="h-5 w-40" />}
          {trail.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight className="size-3 text-mute-2" aria-hidden />}
              <button
                type="button"
                onClick={() => go(c.path, -1)}
                aria-current={i === trail.length - 1 ? "location" : undefined}
                className={cn(
                  "rounded-xs px-1.5 py-0.5 font-mono text-xs transition-colors focus-ring hover:bg-white/8",
                  i === trail.length - 1 ? "font-bold text-ink" : "text-mute hover:text-ink",
                )}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <IconButton label={hidden ? "Hide hidden folders" : "Show hidden folders"} size="sm" onClick={() => setHidden((h) => !h)} aria-pressed={hidden}>
          {hidden ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>

      {/* filter / path */}
      <Input
        ref={inputRef}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={mode === "repo" ? "Filter, or type a path like ~/code/app" : "Filter folders, or type a path"}
        leading={<Search />}
        trailing={isPathInput ? <Chip icon={<CornerDownLeft />}>Go</Chip> : undefined}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={allRows[clampedActive] ? `${listId}-${clampedActive}` : undefined}
        aria-label="Filter folders or enter a path"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />

      {/* current folder is a repo */}
      <AnimatePresence initial={false}>
        {here?.repoRoot && mode === "repo" && cwd && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            <button
              type="button"
              onClick={() => {
                onSelect({ path: cwd, git: here });
              }}
              onDoubleClick={() => onConfirm?.({ path: cwd, git: here })}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors focus-ring pressable",
                value === cwd ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "bg-white/4 hover:bg-white/7",
              )}
            >
              <FolderGit2 className="size-4 text-accent" />
              <span className="min-w-0 flex-1 text-sm font-semibold">This folder is a repository</span>
              {here.branch && <Chip icon={<GitBranch />}>{here.branch}</Chip>}
              <span className="text-2xs font-bold text-accent-ink">{value === cwd ? "Selected" : "Use it"}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* listing */}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={cwd ? `Folders in ${tildify(cwd, homePath)}` : "Folders"}
        className="relative min-h-[220px] flex-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg well p-1.5 md:h-[340px] md:flex-none"
      >
        {listing.error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <TriangleAlert className="size-6 text-warn" />
            <p className="text-sm font-semibold">Can't open {cwd ? tildify(cwd, homePath) : "folder"}</p>
            <p className="text-xs text-mute">{listing.error.message}</p>
            <div className="mt-1 flex gap-2">
              <Button size="sm" onClick={up} disabled={!listing.data?.parent && !homePath}>
                Go back
              </Button>
              <Button size="sm" variant="ghost" onClick={listing.reload}>
                Retry
              </Button>
            </div>
          </div>
        ) : !listing.data ? (
          <div className="flex flex-col gap-1.5 p-1" aria-busy>
            {[64, 48, 72, 56, 40, 60].map((w, i) => (
              <div key={i} className="flex h-9 items-center gap-2.5 px-2">
                <Skeleton className="size-4 rounded-xs" />
                <Skeleton className="h-3.5 rounded-xs" style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }} />
              </div>
            ))}
          </div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            <motion.div
              key={`${cwd}:${hidden}`}
              custom={direction}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: 28 * d }),
                center: { opacity: 1, x: 0 },
                exit: (d: number) => ({ opacity: 0, x: -28 * d }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ x: spring.smooth, opacity: tween.fast }}
            >
              {rows.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-mute">
                  {q ? `No folder matches “${filter}”` : "No sub-folders here"}
                  {fileCount > 0 && <span className="block text-2xs text-mute-2">{fileCount} files hidden</span>}
                </p>
              )}
              {rows.map((row, i) => (
                <FolderRow
                  key={row.key}
                  id={`${listId}-${i}`}
                  index={i}
                  row={row}
                  active={i === clampedActive}
                  selected={value === row.path}
                  mode={mode}
                  onHover={() => setActive(i)}
                  onActivate={() => activate(row)}
                  onConfirm={() => activate(row, true)}
                  onOpen={() => go(row.path, 1)}
                />
              ))}
              {rows.length > 0 && fileCount > 0 && !q && (
                <p className="px-3 pt-1.5 pb-1 text-2xs text-mute-2">
                  {fileCount} file{fileCount === 1 ? "" : "s"} not shown
                </p>
              )}
              {recentRows.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1">
                    <Clock className="size-3 text-mute-2" />
                    <span className="kicker">{mode === "repo" ? "Recent repositories" : "Open workspaces"}</span>
                  </div>
                  {recentRows.map((row, j) => {
                    const i = rows.length + j;
                    return (
                      <FolderRow
                        key={row.key}
                        id={`${listId}-${i}`}
                        index={i}
                        row={row}
                        active={i === clampedActive}
                        selected={value === row.path}
                        mode={mode}
                        onHover={() => setActive(i)}
                        onActivate={() => activate(row)}
                        onConfirm={() => activate(row, true)}
                        onOpen={() => go(row.path, 1)}
                        homePath={homePath}
                      />
                    );
                  })}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        )}
        {listing.loading && listing.data && <div className="tf-skeleton tf-loop pointer-events-none absolute inset-x-0 top-0 h-0.5" aria-hidden />}
      </div>

      {mode === "folder" && cwd && (
        <Button
          variant={value === cwd ? "primary" : "secondary"}
          onClick={() => onSelect({ path: cwd, git: here })}
          onDoubleClick={() => onConfirm?.({ path: cwd, git: here })}
          disabled={!currentSelectable || !listing.data}
          icon={<Folder />}
          className="w-full"
        >
          {value === cwd ? "Selected: " : "Use "}
          <span className="truncate font-mono text-xs">{tildify(cwd, homePath)}</span>
        </Button>
      )}
    </div>
  );
}

interface FolderRowProps {
  id: string;
  index: number;
  row: Row;
  active: boolean;
  selected: boolean;
  mode: "repo" | "folder";
  homePath?: string;
  onHover: () => void;
  onActivate: () => void;
  onConfirm: () => void;
  onOpen: () => void;
}

function FolderRow({ id, index, row, active, selected, mode, homePath, onHover, onActivate, onConfirm, onOpen }: FolderRowProps) {
  const repo = !!row.git?.repoRoot;
  const pickable = mode === "repo" ? repo : true;
  return (
    <div
      id={id}
      data-index={index}
      role="option"
      aria-selected={selected}
      onPointerMove={onHover}
      onClick={onActivate}
      onDoubleClick={onConfirm}
      className={cn(
        "group relative flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm select-none",
        selected ? "text-ink" : "text-ink-2",
      )}
    >
      {(active || selected) && (
        <motion.span
          layoutId={selected ? undefined : "fb-active"}
          transition={spring.snappy}
          className={cn(
            "absolute inset-0 rounded-md",
            selected ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55),0_0_22px_-8px_rgb(163_92_240/0.8)]" : "bg-white/6",
          )}
          aria-hidden
        />
      )}
      <span className="relative flex min-w-0 flex-1 items-center gap-2.5">
        {repo ? (
          <FolderGit2 className={cn("size-4 shrink-0", selected ? "text-accent-hi" : "text-accent")} />
        ) : (
          <Folder className="size-4 shrink-0 text-mute" />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold">{row.name}</span>
          {row.recent && <span className="truncate font-mono text-2xs text-mute-2">{tildify(row.path, homePath)}</span>}
        </span>
      </span>
      <span className="relative flex shrink-0 items-center gap-1.5">
        {row.git?.worktree && <Chip className="h-5 px-2 text-2xs">worktree</Chip>}
        {row.git?.branch && (
          <Chip icon={<GitBranch />} className="h-5 max-w-36 px-2 text-2xs">
            <span className="truncate">{row.git.branch}</span>
          </Chip>
        )}
        {repo &&
          (row.git?.dirty === undefined ? (
            <span className="text-2xs font-bold text-mute-2" title="Change count not available (status check timed out)">
              …
            </span>
          ) : row.git.dirty > 0 ? (
            <span className="inline-flex items-center gap-1 text-2xs font-bold text-warn" title={`${row.git.dirty} changed files`}>
              <span className="size-1.5 rounded-full bg-warn" />
              {row.git.dirty}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-2xs font-bold text-done/80" title="Clean">
              <span className="size-1.5 rounded-full bg-done/80" />
              clean
            </span>
          ))}
        {pickable && mode === "repo" ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Open ${row.name}`}
            title="Browse inside"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="grid size-6 place-items-center rounded-xs text-mute-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/8 hover:text-ink"
          >
            <ChevronRight className="size-3.5" />
          </button>
        ) : (
          <ChevronRight className="size-3.5 text-mute-2" aria-hidden />
        )}
      </span>
    </div>
  );
}
