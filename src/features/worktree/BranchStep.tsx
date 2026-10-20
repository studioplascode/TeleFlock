import { motion } from "motion/react";
import { Check, CloudDownload, FolderTree, GitBranch, GitBranchPlus, Lock, Search, Tag } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import type { BranchInfo, BranchList } from "@/core/gen";
import { Button, Chip, Field, Input, Select, type SelectOption, SegmentedControl, Skeleton, Switch, cn, formatAge, spring } from "@/design";
import { tildify } from "../workspace/shared/paths";

export interface BranchDraft {
  mode: "new" | "existing";
  /** New branch name (mode new). */
  name: string;
  /** Base ref for a new branch ("" = HEAD). */
  base: string;
  /** Existing branch to check out (mode existing); local name. */
  existing: string;
  customPath: boolean;
  path: string;
  label: string;
}

export interface BranchStepProps {
  branches: BranchList | undefined;
  loading: boolean;
  error?: string;
  draft: BranchDraft;
  onChange: (patch: Partial<BranchDraft>) => void;
  /** Effective branch name (mode-dependent). */
  branch: string;
  /** Default checkout path herdr will use for `branch`. */
  defaultPath: string;
  nameError: string | null;
  home?: string;
  onSubmit: () => void;
}

/** Strip `origin/` from remote-tracking names so they can be checked out as a local branch. */
function localName(b: BranchInfo): string {
  return b.remote ? b.name.replace(/^[^/]+\//, "") : b.name;
}

export function BranchStep({ branches, loading, error, draft, onChange, branch, defaultPath, nameError, home, onSubmit }: BranchStepProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const list = useMemo(() => {
    const all = branches?.branches ?? [];
    const locals = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    const items = all.filter((b) => !b.remote || !locals.has(localName(b)) ).filter((b) => !/\/HEAD$/.test(b.name));
    items.sort(
      (a, b) =>
        Number(b.name === branches?.defaultBranch) - Number(a.name === branches?.defaultBranch) ||
        Number(a.remote) - Number(b.remote) ||
        (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0),
    );
    return items;
  }, [branches]);

  const filtered = q ? list.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())) : list;
  const baseOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [];
    const def = branches?.defaultBranch;
    if (def) opts.push({ value: def, label: def, hint: "default branch" });
    for (const b of branches?.branches ?? []) {
      if (b.name === def || /\/HEAD$/.test(b.name)) continue;
      opts.push({ value: b.name, label: b.name, hint: b.remote ? "remote" : b.current ? "checked out here" : undefined });
    }
    opts.push({ value: "HEAD", label: "HEAD", hint: "current commit of the repo" });
    return opts;
  }, [branches]);

  const typedMatch = draft.mode === "new" ? (branches?.branches ?? []).find((b) => !b.remote && b.name === draft.name.trim()) : undefined;

  const pick = (b: BranchInfo) => {
    if (b.worktreePath) return;
    onChange({ existing: localName(b) });
  };

  const onListKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = filtered[active];
      if (b && !b.worktreePath) {
        if (draft.existing === localName(b)) onSubmit();
        else pick(b);
      }
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        fill
        value={draft.mode}
        onValueChange={(mode) => onChange({ mode })}
        options={[
          { value: "new", label: "New branch", icon: <GitBranchPlus /> },
          { value: "existing", label: "Existing branch", icon: <GitBranch /> },
        ]}
        aria-label="Branch mode"
      />

      {draft.mode === "new" ? (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1.3fr_1fr]">
          <Field label="Branch name" error={draft.name ? nameError : undefined}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={draft.name}
                placeholder="feat/my-change"
                leading={<GitBranchPlus />}
                invalid={!!draft.name && !!nameError}
                onChange={(e) => onChange({ name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            )}
          </Field>
          <Field label="Base" hint="branch from">
            {(id) =>
              loading && !branches ? (
                <Skeleton className="h-10 w-full rounded-md" />
              ) : (
                <Select id={id} value={draft.base || baseOptions[0]?.value} onValueChange={(v) => onChange({ base: v })} options={baseOptions} className="w-full" aria-label="Base ref" />
              )
            }
          </Field>
          {typedMatch && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.smooth}
              className="flex flex-wrap items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-ink-2 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)] md:col-span-2"
            >
              <GitBranch className="size-3.5 text-warn" />
              <span className="min-w-0 flex-1">
                <b className="font-mono">{typedMatch.name}</b> already exists
                {typedMatch.worktreePath ? <> and is checked out at <span className="font-mono">{tildify(typedMatch.worktreePath, home)}</span></> : ""}.
              </span>
              {!typedMatch.worktreePath && (
                <Button size="sm" onClick={() => onChange({ mode: "existing", existing: typedMatch.name })}>
                  Use existing branch
                </Button>
              )}
            </motion.div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onListKey}
            placeholder="Filter branches"
            leading={<Search />}
            aria-label="Filter branches"
            spellCheck={false}
          />
          <div role="listbox" aria-label="Branches" className="max-h-[260px] min-h-[160px] overflow-y-auto overscroll-contain rounded-lg well p-1.5">
            {error && <p className="px-3 py-6 text-center text-sm text-error">{error}</p>}
            {!branches && !error &&
              [70, 52, 64, 44].map((w, i) => (
                <div key={i} className="flex h-10 items-center gap-2.5 px-2.5">
                  <Skeleton className="size-4 rounded-xs" />
                  <Skeleton className="h-3.5 rounded-xs" style={{ width: `${w}%` }} />
                </div>
              ))}
            {branches && filtered.length === 0 && <p className="px-3 py-6 text-center text-sm text-mute">No branch matches “{q}”</p>}
            {filtered.map((b, i) => {
              const name = localName(b);
              const selected = draft.existing === name;
              const busy = !!b.worktreePath;
              return (
                <div
                  key={b.name}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={busy || undefined}
                  onPointerMove={() => setActive(i)}
                  onClick={() => pick(b)}
                  onDoubleClick={() => !busy && onSubmit()}
                  className={cn(
                    "relative flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm select-none",
                    busy ? "cursor-not-allowed opacity-55" : "cursor-pointer",
                  )}
                >
                  {(selected || i === active) && (
                    <motion.span
                      layoutId={selected ? undefined : "br-active"}
                      transition={spring.snappy}
                      className={cn("absolute inset-0 rounded-md", selected ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "bg-white/6")}
                      aria-hidden
                    />
                  )}
                  <span className="relative">{b.remote ? <CloudDownload className="size-4 text-omp-blue" /> : busy ? <Lock className="size-4 text-mute" /> : <GitBranch className="size-4 text-accent" />}</span>
                  <span className="relative flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs font-bold">{b.name}</span>
                    <span className="truncate text-2xs text-mute-2">
                      {busy ? `checked out at ${tildify(b.worktreePath ?? "", home)}` : b.remote ? `tracks into local ${name}` : (b.upstream ?? "no upstream")}
                      {b.lastCommitAt ? ` · ${formatAge(Date.now() - b.lastCommitAt)}` : ""}
                    </span>
                  </span>
                  <span className="relative flex shrink-0 items-center gap-1.5">
                    {b.name === branches?.defaultBranch && <Chip className="h-5 px-2 text-2xs">default</Chip>}
                    {b.current && <Chip className="h-5 px-2 text-2xs">HEAD</Chip>}
                    {selected && <Check className="size-4 text-accent" />}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* path + label */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-2xs font-bold tracking-[0.02em] text-mute">Checkout path</span>
            <label className="ml-auto flex items-center gap-1.5 text-2xs font-semibold text-mute-2">
              Custom
              <Switch
                checked={draft.customPath}
                onCheckedChange={(v) => onChange({ customPath: v, path: v && !draft.path ? defaultPath : draft.path })}
                label="Custom checkout path"
              />
            </label>
          </div>
          {draft.customPath ? (
            <Input value={draft.path} onChange={(e) => onChange({ path: e.target.value })} leading={<FolderTree />} className="font-mono text-xs" spellCheck={false} aria-label="Checkout path" />
          ) : (
            <div className="flex h-10 items-center gap-2 overflow-hidden rounded-md bg-white/3 px-3 shadow-hairline" aria-live="polite">
              <FolderTree className="size-4 shrink-0 text-mute-2" />
              <PathPreview path={tildify(defaultPath, home)} branch={branch} />
            </div>
          )}
        </div>
        <Field label="Workspace label" hint="optional">
          {(id) => (
            <Input id={id} value={draft.label} placeholder={branch || "same as the branch"} leading={<Tag />} onChange={(e) => onChange({ label: e.target.value })} />
          )}
        </Field>
      </div>
    </div>
  );
}

/** The path with the branch slug highlighted; it re-renders live as the branch is typed. */
function PathPreview({ path, branch }: { path: string; branch: string }) {
  const i = path.lastIndexOf("/");
  const head = i >= 0 ? path.slice(0, i + 1) : "";
  const tail = i >= 0 ? path.slice(i + 1) : path;
  return (
    <span className="min-w-0 truncate font-mono text-xs text-mute" title={path}>
      {head}
      {branch ? (
        <motion.span key={tail} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="font-bold text-accent-ink">
          {tail}
        </motion.span>
      ) : (
        <span className="text-mute-2 italic">&lt;branch&gt;</span>
      )}
    </span>
  );
}
