import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { Check, CloudDownload, FolderTree, GitBranch, GitBranchPlus, GitFork, Lock, Search, Tag, TriangleAlert, Wand2 } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { BranchInfo, BranchList } from "@/core/gen";
import { Button, Chip, Field, Input, Select, type SelectOption, SegmentedControl, Skeleton, Switch, cn, formatAge, spring } from "@/design";
import { branchNameError, tildify } from "../workspace/shared/paths";

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

const PREFIXES = ["feat/", "fix/", "chore/", "spike/"] as const;
const ROW_H = 46;

/** Strip `origin/` from remote-tracking names so they can be checked out as a local branch. */
function localName(b: BranchInfo): string {
  return b.remote ? b.name.replace(/^[^/]+\//, "") : b.name;
}

/** Best-effort repair of a typed branch name into one git accepts (`My fix..` → `my-fix`). */
export function sanitizeBranch(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/@\{|[~^:?*[\\]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+/, "")
    .replace(/(\.lock)+$/i, "")
    .replace(/[/.-]+$/, "");
}

/** `name-2`, `name-3`, … — the first that isn't a local branch yet. */
function nextFreeName(name: string, taken: ReadonlySet<string>): string {
  for (let i = 2; ; i++) {
    const candidate = `${name}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function BranchStep({ branches, loading, error, draft, onChange, branch, defaultPath, nameError, home, onSubmit }: BranchStepProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const all = branches?.branches ?? [];
    const locals = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    const items = all.filter((b) => !b.remote || !locals.has(localName(b))).filter((b) => !/\/HEAD$/.test(b.name));
    // pickable first; branches checked out in another worktree sink to a dimmed tail
    items.sort(
      (a, b) =>
        Number(!!a.worktreePath) - Number(!!b.worktreePath) ||
        Number(b.name === branches?.defaultBranch) - Number(a.name === branches?.defaultBranch) ||
        Number(a.remote) - Number(b.remote) ||
        (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0),
    );
    return items;
  }, [branches]);
  const localNames = useMemo(() => new Set((branches?.branches ?? []).filter((b) => !b.remote).map((b) => b.name)), [branches]);

  const filtered = q ? list.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())) : list;
  const baseOptions = useMemo<SelectOption[]>(() => {
    const def = branches?.defaultBranch;
    const all = (branches?.branches ?? []).filter((b) => b.name !== def && !/\/HEAD$/.test(b.name));
    all.sort((a, b) => Number(a.remote) - Number(b.remote) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
    const opts: SelectOption[] = [];
    if (def) opts.push({ value: def, label: def, hint: "default branch", icon: <GitBranch /> });
    for (const b of all) {
      opts.push({
        value: b.name,
        label: b.name,
        hint: `${b.remote ? "remote" : b.current ? "checked out here" : "local"}${b.lastCommitAt ? ` · ${formatAge(Date.now() - b.lastCommitAt)}` : ""}`,
        icon: b.remote ? <CloudDownload /> : <GitBranch />,
      });
    }
    opts.push({ value: "HEAD", label: "HEAD", hint: "current commit of the repo", icon: <GitFork /> });
    return opts;
  }, [branches]);

  const typedMatch = draft.mode === "new" ? (branches?.branches ?? []).find((b) => !b.remote && b.name === draft.name.trim()) : undefined;
  const syntaxError = draft.mode === "new" && draft.name ? branchNameError(draft.name) : null;
  const suggestion = syntaxError ? sanitizeBranch(draft.name) : "";
  const canSuggest = !!suggestion && suggestion !== draft.name && !branchNameError(suggestion);

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
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const b = filtered[active];
      if (b && !b.worktreePath) {
        if (draft.existing === localName(b)) onSubmit();
        else pick(b);
      }
    } else if (e.key === "Escape" && q) {
      e.preventDefault();
      e.stopPropagation();
      setQ("");
      setActive(0);
    }
  };

  const branchOff = (from: string) => {
    onChange({ name: nextFreeName(from, localNames), base: from });
    nameRef.current?.focus();
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
          <Field
            label="Branch name"
            error={draft.name ? nameError : undefined}
            description={
              !draft.name ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  {PREFIXES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        onChange({ name: p });
                        nameRef.current?.focus();
                      }}
                      className="rounded-xs bg-white/5 px-2 py-0.5 font-mono text-2xs font-semibold text-mute shadow-hairline transition-colors focus-ring pressable hover:bg-accent/14 hover:text-accent-ink"
                    >
                      {p}
                    </button>
                  ))}
                </span>
              ) : undefined
            }
          >
            {(id) => (
              <Input
                ref={nameRef}
                id={id}
                autoFocus
                value={draft.name}
                placeholder="feat/my-change"
                leading={<GitBranchPlus />}
                invalid={!!draft.name && !!nameError}
                trailing={
                  !nameError && draft.name ? (
                    <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy} className="text-done" aria-hidden>
                      <Check className="size-4" strokeWidth={2.6} />
                    </motion.span>
                  ) : undefined
                }
                onChange={(e) => onChange({ name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                enterKeyHint="next"
              />
            )}
          </Field>
          <Field label="Base" hint="branch from" description={error && !branches ? "Couldn't list branches; branching from HEAD" : undefined}>
            {(id) =>
              loading && !branches ? (
                <Skeleton className="h-10 w-full rounded-md" />
              ) : (
                <Select id={id} value={draft.base || baseOptions[0]?.value} onValueChange={(v) => onChange({ base: v })} options={baseOptions} className="w-full" aria-label="Base ref" />
              )
            }
          </Field>
          <AnimatePresence initial={false}>
            {canSuggest && (
              <Notice key="fix" tone="accent" icon={<Wand2 className="size-3.5 text-accent" />}>
                <span className="min-w-0 flex-1">
                  git would reject that. Try <b className="font-mono text-ink">{suggestion}</b>
                </span>
                <Button size="sm" onClick={() => onChange({ name: suggestion })}>
                  Use it
                </Button>
              </Notice>
            )}
            {typedMatch && (
              <Notice key="exists" tone="warn" icon={typedMatch.worktreePath ? <Lock className="size-3.5 text-warn" /> : <GitBranch className="size-3.5 text-warn" />}>
                <span className="min-w-0 flex-1">
                  {typedMatch.worktreePath ? (
                    <>
                      Checked out at <span className="font-mono text-ink">{tildify(typedMatch.worktreePath, home)}</span>; git allows one worktree per branch.
                    </>
                  ) : (
                    <>
                      <b className="font-mono text-ink">{typedMatch.name}</b> already exists. Check it out instead, or branch off it.
                    </>
                  )}
                </span>
                <span className="flex shrink-0 gap-1.5">
                  {!typedMatch.worktreePath && (
                    <Button size="sm" variant="primary" onClick={() => onChange({ mode: "existing", existing: typedMatch.name })}>
                      Use existing
                    </Button>
                  )}
                  <Button size="sm" icon={<GitFork />} onClick={() => branchOff(typedMatch.name)}>
                    Branch off it
                  </Button>
                </span>
              </Notice>
            )}
          </AnimatePresence>
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
            data-esc-clears
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <div className="relative min-h-[160px] overflow-hidden rounded-lg well">
            {error ? (
              <div role="alert" className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                <TriangleAlert className="size-5 text-warn" />
                <p className="text-sm font-semibold">Couldn't list branches</p>
                <p className="max-w-sm text-xs text-mute">{error}</p>
              </div>
            ) : !branches ? (
              <div className="p-1.5" aria-hidden>
                {[70, 52, 64, 44].map((w, i) => (
                  <div key={i} className="flex h-10 items-center gap-2.5 px-2.5">
                    <Skeleton className="size-4 rounded-xs" />
                    <Skeleton className="h-3.5 rounded-xs" style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }} />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-mute">{q ? `No branch matches “${q}”` : "No branches yet"}</p>
            ) : (
              <BranchRows
                rows={filtered}
                active={Math.min(active, filtered.length - 1)}
                selected={draft.existing}
                defaultBranch={branches.defaultBranch}
                home={home}
                onHover={setActive}
                onPick={pick}
                onSubmit={onSubmit}
              />
            )}
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

function Notice({ tone, icon, children }: { tone: "warn" | "accent"; icon: ReactNode; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={spring.smooth}
      className="overflow-hidden md:col-span-2"
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs text-ink-2",
          tone === "warn" ? "bg-warn/10 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]" : "bg-accent/10 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]",
        )}
      >
        {icon}
        {children}
      </div>
    </motion.div>
  );
}

interface BranchRowsProps {
  rows: BranchInfo[];
  active: number;
  selected: string;
  defaultBranch?: string;
  home?: string;
  onHover: (i: number) => void;
  onPick: (b: BranchInfo) => void;
  onSubmit: () => void;
}

/** Virtualized branch listbox (big repos carry thousands of remote branches). */
function BranchRows({ rows, active, selected, defaultBranch, home, onHover, onPick, onSubmit }: BranchRowsProps) {
  // TanStack Virtual mutates one virtualizer instance per scroll; compiler memoization would freeze it.
  "use no memo";
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstLocked = rows.findIndex((b) => b.worktreePath);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 8 });

  useEffect(() => {
    virtualizer.scrollToIndex(active, { align: "auto" });
  }, [active, virtualizer]);

  return (
    <div ref={scrollRef} role="listbox" aria-label="Branches" className="max-h-[min(300px,40dvh)] min-h-[160px] overflow-y-auto overscroll-contain p-1.5">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const b = rows[vi.index] as BranchInfo;
          const i = vi.index;
          const name = localName(b);
          const isSel = selected === name;
          const busy = !!b.worktreePath;
          return (
            <div
              key={b.name}
              role="option"
              aria-selected={isSel}
              aria-disabled={busy || undefined}
              onPointerMove={() => onHover(i)}
              onClick={() => onPick(b)}
              onDoubleClick={() => !busy && onSubmit()}
              className={cn(
                "absolute inset-x-0 top-0 flex items-center gap-2.5 rounded-md px-2.5 text-sm select-none",
                busy ? "cursor-not-allowed" : "cursor-pointer",
                i === firstLocked && i > 0 && "border-t border-line",
              )}
              style={{ height: ROW_H, transform: `translateY(${vi.start}px)` }}
            >
              {(isSel || i === active) && (
                <motion.span
                  layoutId={isSel ? undefined : "br-active"}
                  transition={spring.snappy}
                  className={cn("absolute inset-0 rounded-md", isSel ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "bg-white/6")}
                  aria-hidden
                />
              )}
              <span className={cn("relative", busy && "opacity-55")}>
                {b.remote ? <CloudDownload className="size-4 text-omp-blue" /> : busy ? <Lock className="size-4 text-mute" /> : <GitBranch className="size-4 text-accent" />}
              </span>
              <span className={cn("relative flex min-w-0 flex-1 flex-col", busy && "opacity-55")}>
                <span className="truncate font-mono text-xs font-bold">{b.name}</span>
                <span className="truncate text-2xs text-mute-2">
                  {busy ? `checked out at ${tildify(b.worktreePath ?? "", home)}` : b.remote ? `creates local ${name}` : (b.upstream ?? "no upstream")}
                  {b.lastCommitAt ? ` · ${formatAge(Date.now() - b.lastCommitAt)}` : ""}
                </span>
              </span>
              <span className="relative flex shrink-0 items-center gap-1.5">
                {b.name === defaultBranch && <Chip className="h-5 px-2 text-2xs">default</Chip>}
                {b.current && <Chip className="h-5 px-2 text-2xs">HEAD</Chip>}
                {isSel && (
                  <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy}>
                    <Check className="size-4 text-accent" />
                  </motion.span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The path with the branch slug highlighted; it re-renders live as the branch is typed. */
function PathPreview({ path, branch }: { path: string; branch: string }) {
  if (!branch) {
    return (
      <span className="min-w-0 truncate font-mono text-xs text-mute" title={path}>
        {path.replace(/\/$/, "")}/<span className="text-mute-2 italic">&lt;branch&gt;</span>
      </span>
    );
  }
  const i = path.lastIndexOf("/");
  const head = i >= 0 ? path.slice(0, i + 1) : "";
  const tail = i >= 0 ? path.slice(i + 1) : path;
  return (
    <span className="flex min-w-0 font-mono text-xs text-mute" title={path} dir="ltr">
      <span className="min-w-0 truncate">{head}</span>
      <motion.span key={tail} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="shrink-0 font-bold text-accent-ink">
        {tail}
      </motion.span>
    </span>
  );
}
