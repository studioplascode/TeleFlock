import { Bot, Cpu, FolderGit2, FolderOpen, GitBranch, HardDrive, Package, Search, TriangleAlert, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useHostState } from "@/core";
import type { MoveCheck, MoveIssue, MoveProbe, MoveRepo } from "@/core/gen";
import { blockersOf, chosenRepo, issuesFor, type MoveChoice } from "@/core/move";
import { formatBytes } from "@/core/upload";
import { Button, cn, Skeleton } from "@/design";
import { hostAccent } from "@/features/hosts/kinds";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { FolderBrowser } from "@/features/worktree/FolderBrowser";
import type { Preflight } from "./usePreflight";

/* The pre-move checklist: what will travel, where it lands, and what stands in the way. */

export interface TargetHost {
  id: string;
  name: string;
  color?: string | null;
}

/** Radio list of the connected hosts the agent can go to. */
export function TargetPicker({ hosts, value, onChange }: { hosts: TargetHost[]; value?: string; onChange(id: string): void }) {
  return (
    <div role="radiogroup" aria-label="Move to" className="flex flex-wrap gap-1.5">
      {hosts.map((h) => {
        const on = h.id === value;
        return (
          <button
            key={h.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(h.id)}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-bold transition-colors focus-ring pressable",
              on ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "well hover:bg-white/6",
            )}
          >
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: hostAccent(h.color) }} aria-hidden />
            <span className="truncate">{h.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-mute [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-2xs font-bold tracking-wide text-mute-2 uppercase">{label}</div>
        <div className="text-sm text-ink-2 [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Issues({ issues }: { issues: MoveIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Things to know">
      {[...issues].sort((a, b) => Number(b.level === "blocker") - Number(a.level === "blocker")).map((i, n) => {
        const blocker = i.level === "blocker";
        return (
          <li
            key={`${i.code}:${n}`}
            data-level={i.level}
            className={cn("flex gap-2.5 rounded-lg p-3 text-xs", blocker ? "bg-error/10 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]" : "bg-warn/10 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]")}
          >
            <TriangleAlert className={cn("mt-px size-4 shrink-0", blocker ? "text-error" : "text-warn")} aria-hidden />
            <div className="min-w-0">
              <p className="font-bold text-ink">
                <span className="sr-only">{blocker ? "Blocker: " : "Warning: "}</span>
                {i.message}
              </p>
              {i.hint && <p className="mt-0.5 text-mute">{i.hint}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function repoNote(r: MoveRepo, home?: string): string {
  const where = r.checkout === "existing" && r.checkoutPath ? `continues in ${tildify(r.checkoutPath, home)}` : "new worktree";
  return r.branchExists && r.checkout === "newWorktree" ? `${where} (its branch is fast-forwarded)` : where;
}

/** Where the agent will land on the target: radio over the clones, a fresh clone, another folder. */
function RepoChoice({ pre, source, probe, home, hostId }: { pre: Preflight; source: MoveCheck; probe: MoveProbe; home?: string; hostId: string }) {
  const [browsing, setBrowsing] = useState(false);
  const choice = pre.choice;
  const option = (key: string, on: boolean, disabled: boolean, onPick: () => void, title: string, note: string, reason?: string) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors focus-ring pressable disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "hover:bg-white/6",
      )}
    >
      <FolderGit2 className="mt-0.5 size-4 shrink-0 text-mute" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-bold">{title}</span>
        <span className="block text-2xs text-mute-2">{reason ?? note}</span>
      </span>
    </button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Repository on the target" className="flex flex-col gap-1 rounded-lg well p-1.5">
        {probe.repos.map((r) => {
          const blocked = blockersOf(r.issues)[0];
          return option(`repo:${r.path}`, choice.repoPath === r.path, !!blocked, () => pre.setChoice({ repoPath: r.path }), tildify(r.path, home), repoNote(r, home), blocked?.message);
        })}
        {probe.clonePath &&
          option("clone", choice.cloneTo === probe.clonePath, false, () => pre.setChoice({ cloneTo: probe.clonePath }), `Clone into ${tildify(probe.clonePath, home)}`, `${source.git?.remoteUrl ?? "the remote"}, then a worktree of the branch`)}
        {probe.repos.length === 0 && !probe.clonePath && <p className="px-3 py-2 text-xs text-mute">No clone of {source.git?.repoName ?? "the repository"} found here. Choose a folder.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => setBrowsing((b) => !b)}>
          {browsing ? "Hide folders" : "Choose another folder…"}
        </Button>
        {pre.pickedPath && (
          <Button size="sm" variant="ghost" icon={<Search />} onClick={() => pre.pickRepo(undefined)}>
            Search automatically
          </Button>
        )}
      </div>
      {browsing && (
        <FolderBrowser
          hostId={hostId}
          mode="repo"
          value={pre.pickedPath}
          onSelect={(p) => {
            pre.pickRepo(p.path);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

/** The checklist, once `move.check` (and the target's `move.probe`) answered. */
export function PreflightView({ pre, dstHostId, dstLabel, srcLabel }: { pre: Preflight; dstHostId: string; dstLabel: string; srcLabel: string }) {
  const { source, probe } = pre;
  const home = useHostState(dstHostId)?.info.home;
  const [pickingCwd, setPickingCwd] = useState(false);
  if (!source) return pre.error ? null : <PreflightSkeleton />;
  const git = source.git;
  const repo = probe ? chosenRepo(probe, pre.choice) : undefined;
  const issues = probe ? issuesFor(source, probe, pre.choice) : source.issues;
  const choice: MoveChoice = pre.choice;
  return (
    <div className="flex flex-col gap-4">
      <div className="divide-y divide-white/6 rounded-lg well px-3.5">
        <Fact icon={<Bot />} label="Agent">
          {source.parked ? "Parked: its pane is closed already." : "Running on " + srcLabel + ". Its pane closes when the move starts."}
          {source.model && <span className="block text-xs text-mute">{source.model}{source.thinking ? ` · ${source.thinking}` : ""}</span>}
        </Fact>
        <Fact icon={<Package />} label="Session">
          {formatBytes(source.sessionBytes)}
          {source.artifactFiles > 0 && ` · ${plural(source.artifactFiles, "artifact file")}`}
          {source.subagentTranscripts > 0 && ` · ${plural(source.subagentTranscripts, "subagent transcript")}`}
        </Fact>
        {git ? (
          <Fact icon={<GitBranch />} label="Code">
            <span className="font-mono text-xs font-bold">{git.branch}</span> <span className="font-mono text-xs text-mute">{git.head.slice(0, 7)}</span>
            <span className="block text-xs text-mute">
              {git.ahead === undefined
                ? `Pushes the whole branch to ${git.remote} (it isn't there yet)`
                : git.ahead === 0
                  ? `Already on ${git.remote}/${git.branch}`
                  : `Pushes ${plural(git.ahead, "commit")} to ${git.remote}/${git.branch}`}
              {" · "}
              {git.dirty > 0 ? `${plural(git.dirty, "uncommitted file")} carried (up to ${formatBytes(source.changesBytes)})` : "no uncommitted changes"}
            </span>
          </Fact>
        ) : (
          <Fact icon={<GitBranch />} label="Code">
            Not in a git repository: only the conversation moves. It continues in a folder you pick on {dstLabel}.
          </Fact>
        )}
        <Fact icon={<FolderGit2 />} label={`On ${dstLabel}`}>
          {!probe ? (
            <Skeleton className="h-4 w-48" />
          ) : git ? (
            choice.cloneTo ? (
              <>Clones the repository into {tildify(choice.cloneTo, home)}</>
            ) : repo ? (
              <>
                {tildify(repo.path, home)} <span className="text-xs text-mute">· {repoNote(repo, home)}</span>
              </>
            ) : (
              <span className="text-mute">Pick where it continues below.</span>
            )
          ) : choice.cwd ? (
            <>Continues in {tildify(choice.cwd, home)}</>
          ) : (
            <span className="text-mute">Pick an existing folder below.</span>
          )}
        </Fact>
        <Fact icon={<Cpu />} label="omp">
          {source.ompVersion ?? "unknown"} on {srcLabel} → {probe ? (probe.ompVersion ?? "unknown") : "…"} on {dstLabel}
        </Fact>
        {probe?.freeBytes !== undefined && (
          <Fact icon={<HardDrive />} label={`Free on ${dstLabel}`}>
            {formatBytes(probe.freeBytes)}
          </Fact>
        )}
      </div>

      {probe && git && <RepoChoice pre={pre} source={source} probe={probe} home={home} hostId={dstHostId} />}
      {probe && !git && (
        <div className="flex flex-col gap-1.5">
          {choice.cwd && !pickingCwd ? (
            <div className="flex items-center gap-2 text-xs text-mute">
              <span className="min-w-0 truncate font-mono">{basename(choice.cwd)}</span>
              <Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => setPickingCwd(true)}>
                Change folder
              </Button>
            </div>
          ) : (
            <FolderBrowser
              hostId={dstHostId}
              mode="folder"
              value={choice.cwd}
              onSelect={(p) => pre.setChoice({ cwd: p.path })}
              onConfirm={(p) => {
                pre.setChoice({ cwd: p.path });
                setPickingCwd(false);
              }}
            />
          )}
        </div>
      )}

      <Issues issues={issues} />
      {issues.length === 0 && probe && (
        <p className="flex items-center gap-2 text-xs text-mute">
          <Info className="size-3.5" aria-hidden /> Nothing in the way. A rollback puts {source.name} back on {srcLabel} if the move fails.
        </p>
      )}
    </div>
  );
}

export function PreflightSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Checking the agent">
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  );
}
