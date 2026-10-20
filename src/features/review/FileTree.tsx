import { motion } from "motion/react";
import { ChevronRight, Folder, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input, cn, spring } from "@/design";
import { DiffBar } from "./diff/DiffViewer";
import type { DiffFile } from "./diff/parse";
import { FileStatusIcon } from "./fileStatus";

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: DiffFile[];
  added: number;
  removed: number;
}

function buildTree(files: DiffFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], added: 0, removed: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop();
    let node = root;
    node.added += f.added;
    node.removed += f.removed;
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      let next = node.dirs.get(p);
      if (!next) {
        next = { name: p, path: acc, dirs: new Map(), files: [], added: 0, removed: 0 };
        node.dirs.set(p, next);
      }
      next.added += f.added;
      next.removed += f.removed;
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
  onSelect: (path: string) => void;
  className?: string;
}

/** Changed files as a compressed directory tree with ± counts; the file on screen is highlighted. */
export function FileTree({ files, active, collapsed, onSelect, className }: FileTreeProps) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())) : files), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggleDir = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const renderDir = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const fs = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    return (
      <>
        {dirs.map((d) => {
          const open = !closed.has(d.path);
          return (
            <li key={`d:${d.path}`}>
              <button
                type="button"
                onClick={() => toggleDir(d.path)}
                aria-expanded={open}
                className="flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs text-mute transition-colors focus-ring hover:bg-white/5 hover:text-ink"
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-300 ease-spring", open && "rotate-90")} />
                <Folder className="size-3.5 shrink-0 text-mute-2" />
                <span className="min-w-0 flex-1 truncate font-semibold">{d.name}</span>
              </button>
              {open && <ul>{renderDir(d, depth + 1)}</ul>}
            </li>
          );
        })}
        {fs.map((f) => {
          const on = f.path === active;
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onSelect(f.path)}
                aria-current={on ? "true" : undefined}
                title={f.path}
                className={cn("relative flex h-7 w-full items-center gap-2 rounded-sm pr-2 text-left text-xs focus-ring", on ? "text-ink" : "text-ink-2 hover:bg-white/5")}
                style={{ paddingLeft: 6 + depth * 12 + 4 }}
              >
                {on && <motion.span layoutId="ft-active" transition={spring.snappy} className="absolute inset-0 rounded-sm bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)]" aria-hidden />}
                <FileStatusIcon status={f.status} className="relative" />
                <span className={cn("relative min-w-0 flex-1 truncate font-mono", collapsed.has(f.path) && "text-mute-2")}>{name}</span>
                <span className="relative">
                  <DiffBar added={f.added} removed={f.removed} compact />
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
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files" leading={<Search />} boxClassName="h-8" aria-label="Filter changed files" />
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5" aria-label="Changed files">
        {renderDir(tree, 0)}
        {shown.length === 0 && <li className="px-2 py-4 text-center text-xs text-mute">{files.length === 0 ? "No changes" : "No file matches"}</li>}
      </ul>
    </div>
  );
}
