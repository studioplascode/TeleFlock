import { motion } from "motion/react";
import { Check, ChevronRight, Folder, FolderOpen, Search, X } from "lucide-react";
import { type KeyboardEvent, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { Input, cn, spring } from "@/design";
import { DiffBar } from "./diff/DiffViewer";
import type { DiffFile } from "./diff/parse";
import { FileStatusIcon } from "./fileStatus";

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: DiffFile[];
}

function buildTree(files: DiffFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop();
    let node = root;
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      let next = node.dirs.get(p);
      if (!next) {
        next = { name: p, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(p, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  // compress chains of single-child directories: src/ → features/ → review/ becomes src/features/review
  const compress = (n: DirNode): DirNode => {
    for (const [k, d] of n.dirs) n.dirs.set(k, compress(d));
    if (n.path && n.files.length === 0 && n.dirs.size === 1) {
      const only = [...n.dirs.values()][0];
      if (only) return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return compress(root);
}

export interface FileTreeProps {
  files: DiffFile[];
  active?: string;
  collapsed: ReadonlySet<string>;
  viewed?: ReadonlySet<string>;
  onSelect: (path: string) => void;
  /** Touch layout: taller rows, larger type. */
  comfortable?: boolean;
  /** The filter input (the review view focuses it on `/`). */
  filterRef?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * Changed files as a compressed directory tree with ± counts; the file on screen is highlighted.
 * Keyboard: ↑/↓ move, ←/→ fold/unfold folders (or jump to the parent), Home/End, Enter opens;
 * ↓ from the filter enters the tree.
 */
export function FileTree({ files, active, collapsed, viewed, onSelect, comfortable = false, filterRef, className }: FileTreeProps) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())) : files), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const toggleDir = (p: string, open?: boolean) =>
    setClosed((s) => {
      const isOpen = !s.has(p);
      if (open === isOpen) return s;
      const n = new Set(s);
      if (isOpen) n.add(p);
      else n.delete(p);
      return n;
    });

  // Keep the file on screen visible in the list as the diff scrolls.
  useEffect(() => {
    if (!active) return;
    listRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tree-item]") ?? [])];
  const onTreeKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const all = items();
    const el = document.activeElement as HTMLElement | null;
    const i = el ? all.indexOf(el) : -1;
    if (i < 0) return;
    const go = (n: number) => {
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, n))]?.focus();
    };
    const dir = el?.dataset.dir;
    const level = Number(el?.getAttribute("aria-level") ?? 1);
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        return go(i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(all.length - 1);
      case "ArrowRight":
        if (dir !== undefined) {
          e.preventDefault();
          if (closed.has(dir)) toggleDir(dir, true);
          else all[i + 1]?.focus();
        }
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (dir !== undefined && !closed.has(dir)) return toggleDir(dir, false);
        // jump to the enclosing folder
        for (let j = i - 1; j >= 0; j--) if (Number(all[j]?.getAttribute("aria-level")) < level) return all[j]?.focus();
        return;
      }
    }
  };

  const row = comfortable ? "h-11 text-sm" : "h-7 text-xs";
  const indent = comfortable ? 16 : 12;

  const renderDir = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fs = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    return (
      <>
        {dirs.map((d) => {
          const open = !closed.has(d.path);
          return (
            <li key={`d:${d.path}`} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={open}
                data-tree-item
                tabIndex={-1}
                data-dir={d.path}
                onClick={() => toggleDir(d.path)}
                className={cn("flex w-full items-center gap-1.5 rounded-sm pr-2 text-left text-mute transition-colors focus-ring hover:bg-white/5 hover:text-ink", row)}
                style={{ paddingLeft: 6 + depth * indent }}
              >
                <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-300 ease-spring", open && "rotate-90")} />
                {open ? <FolderOpen className="size-3.5 shrink-0 text-mute-2" /> : <Folder className="size-3.5 shrink-0 text-mute-2" />}
                <span className="min-w-0 flex-1 truncate font-semibold">{d.name}</span>
              </button>
              {open && <ul role="group">{renderDir(d, depth + 1)}</ul>}
            </li>
          );
        })}
        {fs.map((f) => {
          const on = f.path === active;
          const seen = viewed?.has(f.path);
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          return (
            <li key={f.path} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={on}
                aria-current={on ? "true" : undefined}
                data-tree-item
                data-file={f.path}
                tabIndex={-1}
                onClick={() => onSelect(f.path)}
                title={f.path}
                className={cn("group relative flex w-full items-center gap-2 rounded-sm pr-2 text-left focus-ring", row, on ? "text-ink" : "text-ink-2 hover:bg-white/5")}
                style={{ paddingLeft: 6 + depth * indent + 4 }}
              >
                {on && (
                  <motion.span
                    layoutId="ft-active"
                    transition={spring.snappy}
                    className="absolute inset-0 rounded-sm bg-accent/16 shadow-[inset_2px_0_0_var(--color-accent),inset_0_0_0_1px_rgb(163_92_240/0.4)]"
                    aria-hidden
                  />
                )}
                <FileStatusIcon status={f.status} className="relative" />
                <span
                  className={cn(
                    "relative min-w-0 flex-1 truncate font-mono",
                    (collapsed.has(f.path) || seen) && "text-mute",
                    f.status === "deleted" && "line-through decoration-del/60",
                  )}
                >
                  {name}
                </span>
                <span className="relative flex items-center gap-1.5">
                  {seen ? (
                    <span className="flex items-center gap-1 text-2xs font-bold text-done" aria-label="viewed">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : (
                    <DiffBar added={f.added} removed={f.removed} compact />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </>
    );
  };

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {files.length > 6 && (
        <Input
          ref={filterRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              items()[0]?.focus();
            } else if (e.key === "Escape" && q) {
              e.stopPropagation();
              setQ("");
            } else if (e.key === "Enter" && shown[0]) onSelect(shown[0].path);
          }}
          placeholder="Filter files"
          leading={<Search />}
          trailing={
            q ? (
              <button type="button" onClick={() => setQ("")} aria-label="Clear filter" className="grid size-5 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-ink [&_svg]:size-3">
                <X />
              </button>
            ) : undefined
          }
          boxClassName={comfortable ? "h-10" : "h-8"}
          aria-label="Filter changed files"
        />
      )}
      <ul
        ref={listRef}
        role="tree"
        aria-label="Changed files"
        tabIndex={0}
        onKeyDown={onTreeKey}
        // Tab enters the tree once (on the active file); arrows move inside it.
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          const all = items();
          (all.find((el) => el.dataset.file === active) ?? all[0])?.focus();
        }}
        className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-0.5 outline-none"
      >
        {renderDir(tree, 0)}
        {shown.length === 0 && (
          <li role="none" className="px-2 py-4 text-center text-xs text-mute">
            {files.length === 0 ? "No changes" : `No file matches “${q}”`}
          </li>
        )}
      </ul>
    </div>
  );
}
