import { Check, ChevronDown, FolderGit2, FolderSearch, GitBranch, Server, Shuffle } from "lucide-react";
import { useRef, useState } from "react";
import { useHosts } from "@/core";
import type { BranchList } from "@/core/gen";
import { describeLoad, type HostLoad } from "@/core/workload";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusOrb,
  cn,
  useIsMobile,
} from "@/design";
import { PHASE_LABEL, PHASE_STATUS } from "@/features/shell/status";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { FolderBrowser, type FolderPick } from "@/features/worktree/FolderBrowser";
import { autoTarget, groupOf } from "./auto";

const chip =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-white/[0.04] px-3 text-xs font-bold text-ink-2 shadow-hairline pressable focus-ring hover:bg-white/8 hover:text-ink data-[state=open]:bg-white/10 data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A host group offered as one Auto target, with its hosts' current load (least busy first). */
export interface GroupChoice {
  group: string;
  loads: readonly HostLoad[];
}

/**
 * Target chip (more than one host, or any group): single hosts, and each host group as
 * "Auto · <group>" with the load of every host in it.
 */
export function HostPicker({
  target,
  hostIds,
  groups,
  onChange,
  className,
}: {
  target: string;
  hostIds: readonly string[];
  groups: readonly GroupChoice[];
  onChange(target: string): void;
  className?: string;
}) {
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const group = groupOf(target);
  const choice = group ? groups.find((g) => g.group === group) : undefined;
  const anyOnline = choice?.loads.some((l) => l.available);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(chip, "max-w-[13rem] shrink", className)} aria-label="Host" title={group ? `Auto · ${group}: each task goes to the least busy host of the group` : nameOf(target)}>
        {group ? <Shuffle className="text-accent-hi" /> : <StatusOrb status={PHASE_STATUS[status[target]?.phase ?? "idle"]} size={7} label={null} />}
        <span className="min-w-0 truncate">{group ? `Auto · ${group}` : nameOf(target)}</span>
        {group && !anyOnline && <span className="text-2xs text-mute">offline</span>}
        <ChevronDown className="text-mute" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(340px,calc(100vw-24px))]">
        {groups.length > 0 && <DropdownMenuLabel>Auto — least busy host of a group</DropdownMenuLabel>}
        {groups.map((g) => (
          <DropdownMenuItem key={g.group} icon={<Shuffle />} onSelect={() => onChange(autoTarget(g.group))}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">Auto · {g.group}</span>
              {g.loads.map((l) => (
                <span key={l.hostId} className="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-mute-2">
                  <StatusOrb status={PHASE_STATUS[status[l.hostId]?.phase ?? "idle"]} size={6} label={null} />
                  <span className="shrink-0 font-semibold text-mute">{nameOf(l.hostId)}</span>
                  <span className="truncate">{l.available ? describeLoad(l) : PHASE_LABEL[status[l.hostId]?.phase ?? "idle"]}</span>
                </span>
              ))}
            </span>
            {target === autoTarget(g.group) && <Check className="size-4 shrink-0 text-accent-hi" />}
          </DropdownMenuItem>
        ))}
        {groups.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuLabel>Host</DropdownMenuLabel>
        {hostIds.map((id) => (
          <DropdownMenuItem key={id} icon={<Server />} onSelect={() => onChange(id)}>
            <span className="flex-1 truncate">{nameOf(id)}</span>
            <span className="text-2xs text-mute">{PHASE_LABEL[status[id]?.phase ?? "idle"]}</span>
            {id === target && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A repository in the picker: `id` is its root (single host) or Auto's repo id; `detail` the line under its name. */
export interface RepoChoice {
  id: string;
  name: string;
  detail: string;
}

/**
 * Repo chip: recent repositories, plus "Browse…" (folder browser in repo mode on `browseHostId`;
 * hidden without one). `onFocusAfterPick` runs once the menu / browser has closed after a pick
 * (instead of focus returning to the chip, where a typed `n` would open the New worktree wizard).
 */
export function RepoPicker({
  browseHostId,
  repo,
  repos,
  emptyHint,
  onChange,
  onFocusAfterPick,
  className,
}: {
  browseHostId: string | null;
  repo: string | null;
  repos: readonly RepoChoice[];
  /** Shown when there is nothing to pick and no Browse… */
  emptyHint?: string;
  onChange(id: string): void;
  onFocusAfterPick?(): void;
  className?: string;
}) {
  const mobile = useIsMobile();
  const [browsing, setBrowsing] = useState(false);
  const picked = useRef(false);
  const current = repos.find((r) => r.id === repo);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(chip, repo ? "" : "bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]", className)} aria-label="Repository">
          <FolderGit2 className={repo ? "text-accent-hi" : undefined} />
          <span className="min-w-0 truncate">{repo ? (current?.name ?? repo.split(/[\\/]/).pop()) : "Pick a repository"}</span>
          {current && !mobile && <span className="min-w-0 truncate font-mono text-2xs font-medium text-mute-2 max-lg:hidden">{current.detail}</span>}
          <ChevronDown className="text-mute" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-[min(380px,calc(100vw-24px))] overflow-y-auto"
          onCloseAutoFocus={(e) => {
            if (!picked.current) return;
            picked.current = false;
            e.preventDefault();
            onFocusAfterPick?.();
          }}
        >
          {repos.length > 0 && <DropdownMenuLabel>Recent repositories</DropdownMenuLabel>}
          {repos.map((r) => (
            <DropdownMenuItem
              key={r.id}
              icon={<FolderGit2 />}
              onSelect={() => {
                picked.current = true;
                onChange(r.id);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{r.name}</span>
                <span className="truncate font-mono text-2xs font-medium text-mute-2">{r.detail}</span>
              </span>
              {r.id === repo && <Check className="size-4 shrink-0 text-accent-hi" />}
            </DropdownMenuItem>
          ))}
          {repos.length === 0 && emptyHint && <p className="max-w-[320px] px-2.5 py-2 text-xs text-mute">{emptyHint}</p>}
          {browseHostId && repos.length > 0 && <DropdownMenuSeparator />}
          {browseHostId && (
            <DropdownMenuItem icon={<FolderSearch />} onSelect={() => setBrowsing(true)}>
              Browse…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {browseHostId && <RepoBrowser hostId={browseHostId} repo={repo} open={browsing} onOpenChange={setBrowsing} onPick={onChange} onFocusAfterPick={onFocusAfterPick} />}
    </>
  );
}

/** "Pick a repository": the folder browser in repo mode, in a dialog (sheet on phones). */
export function RepoBrowser({
  hostId,
  repo,
  open,
  onOpenChange,
  onPick,
  onFocusAfterPick,
}: {
  hostId: string;
  repo: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(root: string): void;
  onFocusAfterPick?(): void;
}) {
  const mobile = useIsMobile();
  const [pick, setPick] = useState<FolderPick | null>(null);
  const picked = useRef(false);
  // Each opening starts at the current repo.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPick(repo ? { path: repo } : null);
  }
  const confirm = (p: FolderPick | null) => {
    if (!p) return;
    picked.current = true;
    onPick(p.path);
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pick a repository"
      description="Every message you dispatch creates a new worktree of it."
      icon={<FolderGit2 />}
      width={640}
      tall
      onCloseAutoFocus={(e) => {
        if (!picked.current) return;
        picked.current = false;
        e.preventDefault();
        onFocusAfterPick?.();
      }}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {!mobile && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button variant="primary" disabled={!pick} onClick={() => confirm(pick)} className={mobile ? "flex-1" : undefined}>
            {pick ? `Use ${pick.path.split(/[\\/]/).pop()}` : "Select a repository"}
          </Button>
        </div>
      }
    >
      {open && <FolderBrowser hostId={hostId} mode="repo" value={pick?.path} initialPath={repo ?? undefined} autoFocus={!mobile} onSelect={setPick} onConfirm={confirm} />}
    </ResponsiveDialog>
  );
}

/** Base-branch chip: the host's default base (`origin/<default>`, fetched first) unless changed. */
export function BasePicker({
  value,
  branches,
  onChange,
  disabled,
  className,
}: {
  value: string;
  branches: BranchList | undefined;
  onChange(base: string | null): void;
  disabled?: boolean;
  className?: string;
}) {
  const def = branches?.defaultBase ?? branches?.defaultBranch;
  const others = (branches?.branches ?? []).filter((b) => b.name !== def && !/\/HEAD$/.test(b.name) && !b.name.startsWith("dispatch/")).slice(0, 40);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(chip, "max-w-[11rem] shrink font-mono text-2xs", className)}
        disabled={disabled}
        aria-label="Base branch"
        title={`New worktrees branch from ${value}`}
      >
        <GitBranch className="text-mute" />
        <span className="min-w-0 truncate">{value}</span>
        <ChevronDown className="text-mute" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-56 overflow-y-auto">
        <DropdownMenuLabel>Branch from</DropdownMenuLabel>
        {def && (
          <DropdownMenuItem icon={<GitBranch />} onSelect={() => onChange(null)}>
            <span className="flex-1 truncate font-mono text-xs">{def}</span>
            <span className="text-2xs text-mute">default</span>
            {value === def && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        )}
        {others.map((b) => (
          <DropdownMenuItem key={b.name} icon={<GitBranch />} onSelect={() => onChange(b.name)}>
            <span className="flex-1 truncate font-mono text-xs">{b.name}</span>
            {b.remote && <span className="text-2xs text-mute">remote</span>}
            {value === b.name && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem icon={<GitBranch />} onSelect={() => onChange("HEAD")}>
          <span className="flex-1 font-mono text-xs">HEAD</span>
          {value === "HEAD" && <Check className="size-4 text-accent-hi" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
