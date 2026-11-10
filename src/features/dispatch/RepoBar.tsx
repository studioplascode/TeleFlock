import { Check, ChevronDown, FolderGit2, FolderOpen, FolderSearch, GitBranch, GitBranchPlus, MessagesSquare, Server, Shuffle } from "lucide-react";
import { useRef, useState } from "react";
import { useHosts } from "@/core";
import { CHAT_REPO, isChatRepo } from "@/core/chats";
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
  SegmentedControl,
  StatusOrb,
  cn,
  useIsMobile,
} from "@/design";
import { PHASE_LABEL, PHASE_STATUS } from "@/features/shell/status";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { FolderBrowser, type FolderPick } from "@/features/worktree/FolderBrowser";
import { autoTarget, groupOf } from "./auto";
import type { PickedPlace } from "./store";
import { CHAT_CHOICE, LEGACY_BRANCH_PREFIX } from "./thread";

const chip =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-ink/[0.04] px-3 text-xs font-bold text-ink-2 shadow-hairline pressable focus-ring hover:bg-ink/8 hover:text-ink data-[state=open]:bg-ink/10 data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0";

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

/** The repo chip's "No folder · chat" choice: `unavailable` = why the target can't start chats (shown, disabled), `hint` its tooltip. */
export interface ChatChoice {
  unavailable?: string;
  hint?: string;
}

/** Where the picked repository's messages start their agent: "New worktree" (each its own) or "In this folder" (`inPlace`). */
export interface LaunchChoice {
  inPlace: boolean;
  /** The pick is a folder that is no repository root: in place only. */
  folder: boolean;
  /** What "In this folder" does here, in words. */
  where: string;
  onChange(inPlace: boolean): void;
}

/**
 * Repo chip: where each message of the picked repository runs (`launch`: "New worktree" or "In
 * this folder"), "No folder · chat" (`chat`, picks `CHAT_REPO`), recent repositories and folders,
 * plus "Browse…" (the folder browser on `browseHostId`, any folder for "In this folder"; without
 * one, `folderRefusal` says why no folder can be picked). `onFocusAfterPick` runs once the menu /
 * browser has closed after a pick (instead of focus returning to the chip, where a typed `n` would
 * open the New worktree wizard).
 */
export function RepoPicker({
  browseHostId,
  repo,
  repos,
  folders = [],
  chat,
  launch,
  folderRefusal,
  emptyHint,
  onChange,
  onBrowse,
  onFocusAfterPick,
  className,
}: {
  browseHostId: string | null;
  repo: string | null;
  repos: readonly RepoChoice[];
  /** Folders that are no repository root, dispatched to before (single hosts). */
  folders?: readonly RepoChoice[];
  chat?: ChatChoice;
  /** Absent for a chat, or before anything is picked. */
  launch?: LaunchChoice;
  /** Why no folder can be picked (Auto): shown on a disabled choice. */
  folderRefusal?: string;
  /** Shown when there is nothing to pick and no Browse… */
  emptyHint?: string;
  onChange(id: string): void;
  /** A pick in the browser, with how its thread's messages run. */
  onBrowse(pick: BrowsePick): void;
  onFocusAfterPick?(): void;
  className?: string;
}) {
  const mobile = useIsMobile();
  const [browsing, setBrowsing] = useState(false);
  const picked = useRef(false);
  const chatting = isChatRepo(repo);
  const current = repos.find((r) => r.id === repo) ?? folders.find((r) => r.id === repo);
  const inPlace = launch?.inPlace === true;
  const pick = (id: string) => {
    picked.current = true;
    onChange(id);
  };
  const runIn = (here: boolean) => {
    picked.current = true;
    launch?.onChange(here);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(chip, repo ? "" : "bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]", className)} aria-label="Repository">
          {chatting ? <MessagesSquare className="text-accent-hi" /> : inPlace ? <FolderOpen className="text-accent-hi" /> : <FolderGit2 className={repo ? "text-accent-hi" : undefined} />}
          <span className="min-w-0 truncate">{chatting ? CHAT_CHOICE : repo ? (current?.name ?? repo.split(/[\\/]/).pop()) : "Pick a repository"}</span>
          {inPlace && <span className="shrink-0 text-2xs font-semibold text-mute-2">· no worktree</span>}
          {current && !mobile && <span className="min-w-0 truncate font-mono text-2xs font-medium text-mute-2 max-lg:hidden">{current.detail}</span>}
          <ChevronDown className="text-mute" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(460px,var(--radix-dropdown-menu-content-available-height))] w-[min(380px,calc(100vw-24px))] overflow-y-auto"
          onCloseAutoFocus={(e) => {
            if (!picked.current) return;
            picked.current = false;
            e.preventDefault();
            onFocusAfterPick?.();
          }}
        >
          {launch && (
            <>
              <DropdownMenuLabel>Where each message runs</DropdownMenuLabel>
              <DropdownMenuItem icon={<GitBranchPlus />} disabled={launch.folder} onSelect={() => runIn(false)}>
                <TwoLines title="New worktree" detail={launch.folder ? "Not a repository root" : "Its own branch and checkout"} checked={!inPlace} />
              </DropdownMenuItem>
              <DropdownMenuItem icon={<FolderOpen />} onSelect={() => runIn(true)}>
                <TwoLines title="In this folder" detail={launch.where} checked={inPlace} />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {chat && (
            <DropdownMenuItem icon={<MessagesSquare />} disabled={!!chat.unavailable} title={chat.hint} onSelect={() => pick(CHAT_REPO)}>
              <TwoLines title={CHAT_CHOICE} detail={chat.unavailable ?? "An agent in its own new folder · no repository"} checked={chatting} />
            </DropdownMenuItem>
          )}
          {chat && (repos.length > 0 || folders.length > 0 || emptyHint || browseHostId || folderRefusal) && <DropdownMenuSeparator />}
          {repos.length > 0 && <DropdownMenuLabel>Recent repositories</DropdownMenuLabel>}
          {repos.map((r) => (
            <DropdownMenuItem key={r.id} icon={<FolderGit2 />} onSelect={() => pick(r.id)}>
              <TwoLines title={r.name} detail={r.detail} mono checked={r.id === repo} />
            </DropdownMenuItem>
          ))}
          {folders.length > 0 && <DropdownMenuLabel>Recent folders</DropdownMenuLabel>}
          {folders.map((r) => (
            <DropdownMenuItem key={r.id} icon={<FolderOpen />} onSelect={() => pick(r.id)}>
              <TwoLines title={r.name} detail={r.detail} mono checked={r.id === repo} />
            </DropdownMenuItem>
          ))}
          {repos.length === 0 && emptyHint && <p className="max-w-[320px] px-2.5 py-2 text-xs text-mute">{emptyHint}</p>}
          {(browseHostId || folderRefusal) && repos.length + folders.length > 0 && <DropdownMenuSeparator />}
          {browseHostId ? (
            <DropdownMenuItem icon={<FolderSearch />} onSelect={() => setBrowsing(true)}>
              Browse…
            </DropdownMenuItem>
          ) : (
            folderRefusal && (
              <DropdownMenuItem icon={<FolderSearch />} disabled>
                <TwoLines title="Any folder…" detail={folderRefusal} />
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {browseHostId && (
        <RepoBrowser
          hostId={browseHostId}
          repo={chatting ? null : repo}
          inPlace={inPlace}
          folder={launch?.folder === true}
          open={browsing}
          onOpenChange={setBrowsing}
          onPick={onBrowse}
          onFocusAfterPick={onFocusAfterPick}
        />
      )}
    </>
  );
}

/** A repo menu item's name over what it is (`mono`: a path), with the check of the current pick at the right. */
function TwoLines({ title, detail, mono, checked }: { title: string; detail: string; mono?: boolean; checked?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        <span className={cn("truncate text-2xs font-medium text-mute-2", mono && "font-mono")}>{detail}</span>
      </span>
      {checked && <Check className="size-4 shrink-0 text-accent-hi" />}
    </span>
  );
}

/** A place picked in the browser: its path, and how its thread's messages run. */
export interface BrowsePick extends PickedPlace {
  path: string;
}

/**
 * "Browse…": the folder browser in a dialog (sheet on phones), with where each message runs on top:
 * "New worktree" browses for a repository (repo mode), "In this folder" takes any folder (folder
 * mode). Each opening starts at the current pick, in its thread's mode (`inPlace`).
 */
export function RepoBrowser({
  hostId,
  repo,
  inPlace,
  folder,
  open,
  onOpenChange,
  onPick,
  onFocusAfterPick,
}: {
  hostId: string;
  repo: string | null;
  inPlace: boolean;
  /** The current pick is a folder that is no repository root. */
  folder: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(pick: BrowsePick): void;
  onFocusAfterPick?(): void;
}) {
  const mobile = useIsMobile();
  const [pick, setPick] = useState<FolderPick | null>(null);
  const [here, setHere] = useState(inPlace);
  const picked = useRef(false);
  // Each opening starts at the current repo, in its mode.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPick(repo ? { path: repo } : null);
      setHere(inPlace);
    }
  }
  // No repository root: the browser's badge says so; the current pick, preset without one, is what it was.
  const noRepo = (p: FolderPick) => (p.git ? !p.git.repoRoot : p.path !== repo || folder);
  const confirm = (p: FolderPick | null) => {
    if (!p) return;
    picked.current = true;
    const f = noRepo(p);
    onPick({ path: p.path, inPlace: here || f, folder: f });
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={here ? "Pick a folder" : "Pick a repository"}
      description={here ? "Every message starts an omp agent right in it: no worktree, no branch. Any folder works." : "Every message you dispatch creates a new worktree of it."}
      icon={here ? <FolderOpen /> : <FolderGit2 />}
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
            {pick ? `Use ${pick.path.split(/[\\/]/).pop()}` : here ? "Select a folder" : "Select a repository"}
          </Button>
        </div>
      }
    >
      {open && (
        <div className="flex h-full min-h-0 flex-col gap-3">
          <SegmentedControl<"worktree" | "inPlace">
            value={here ? "inPlace" : "worktree"}
            onValueChange={(v) => {
              setHere(v === "inPlace");
              // New worktrees need a repository: a folder that is none can't stay picked.
              if (v === "worktree" && pick && noRepo(pick)) setPick(null);
            }}
            options={[
              { value: "worktree", label: "New worktree", icon: <GitBranchPlus /> },
              { value: "inPlace", label: "In this folder", icon: <FolderOpen /> },
            ]}
            fill
            aria-label="Where each message runs"
          />
          <FolderBrowser
            className="flex-1"
            hostId={hostId}
            mode={here ? "folder" : "repo"}
            value={pick?.path}
            initialPath={repo ?? undefined}
            autoFocus={!mobile}
            onSelect={setPick}
            onConfirm={confirm}
          />
        </div>
      )}
    </ResponsiveDialog>
  );
}

/**
 * Base-branch chip: the host's default base (`origin/<default>`, fetched first) unless changed. The
 * menu leaves out the branches of Dispatch's own worktrees (`own`) and those from before, `dispatch/*`.
 */
export function BasePicker({
  value,
  branches,
  own,
  onChange,
  disabled,
  className,
}: {
  value: string;
  branches: BranchList | undefined;
  /** Branches of the repository's Dispatch entries. */
  own: ReadonlySet<string>;
  onChange(base: string | null): void;
  disabled?: boolean;
  className?: string;
}) {
  const def = branches?.defaultBase ?? branches?.defaultBranch;
  const others = (branches?.branches ?? []).filter((b) => b.name !== def && !/\/HEAD$/.test(b.name) && !own.has(b.name) && !b.name.startsWith(LEGACY_BRANCH_PREFIX)).slice(0, 40);
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
