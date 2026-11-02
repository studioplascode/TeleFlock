import { FolderGit2, HardDrive, RotateCw, Server, Sparkles, Trash2, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { navigate, useCore, useHostIds, useHostState, useHosts } from "@/core";
import type { CleanupOwner, CleanupRepo, CleanupWorktree } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, EmptyState, IconButton, PageHeader, SegmentedControl, Select, Skeleton, Spinner, Tile, cn, formatAge, useIsMobile, useNow } from "@/design";
import { OutdatedHost } from "@/features/automations/parts";
import { ChatCleanup } from "@/features/chats/ChatCleanup";
import { HostPicker } from "@/features/dispatch/RepoBar";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { tildify } from "@/features/workspace/shared/paths";
import { removeMany, removeOne } from "./actions";
import { AgentSection } from "./AgentSection";
import { type BulkKind, STALE_DAYS, bulkSet, classify, sortForPage, totals } from "./classify";
import { type AgentGroup, groupByOwner, ownerLabel } from "./groups";
import { diskLevel } from "./disk";
import { IdleShellsSection } from "./IdleShellsSection";
import { StorageSection } from "./StorageSection";
import { type CleanupGrouping, useCleanupPrefs } from "./store";
import { useCleanupReport, useCleanupStorage } from "./useCleanup";
import { WorktreeRow } from "./WorktreeRow";

/** Free space of the host's home file system, with the low-disk level's tone. */
function DiskTile({ hostId }: { hostId: string }) {
  const free = useCore((s) => s.hosts[hostId]?.state.health?.diskFree);
  const total = useCore((s) => s.hosts[hostId]?.state.health?.diskTotal);
  if (free === undefined || total === undefined || total <= 0) return null;
  const level = diskLevel(free, total);
  const used = Math.min(100, Math.max(0, (1 - free / total) * 100));
  return (
    <Tile data-status={level === "ok" ? undefined : level === "critical" ? "error" : "needs-you"} className="flex flex-col gap-1.5 p-4 max-md:p-3.5">
      <div className="kicker flex items-center gap-1.5">
        <HardDrive className="size-3.5" /> Disk
      </div>
      <div className="font-display text-lg font-bold tabular">
        {formatBytes(free)} <span className="text-xs font-semibold text-mute">free of {formatBytes(total)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/8">
        <div className={cn("h-full rounded-full", level === "ok" ? "bg-done" : "st-bg")} style={{ width: `${used}%` }} />
      </div>
      {level !== "ok" && <p className="text-2xs font-semibold st-text">{level === "critical" ? "Almost full: builds and agents start failing." : "Running low."}</p>}
    </Tile>
  );
}

interface BulkTileProps {
  title: string;
  about: string;
  count: number;
  held: number;
  bytes: number;
  label: string;
  disabled: boolean;
  progress: string | null;
  onRun(): void;
  children?: ReactNode;
}

function BulkTile({ title, about, count, held, bytes, label, disabled, progress, onRun, children }: BulkTileProps) {
  return (
    <Tile className="flex flex-col gap-1.5 p-4 max-md:p-3.5">
      <div className="kicker">{title}</div>
      <div className="font-display text-lg font-bold tabular">
        {count} <span className="text-xs font-semibold text-mute">worktree{count === 1 ? "" : "s"}{bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}</span>
      </div>
      <p className="text-2xs text-mute-2">
        {about}
        {held > 0 && ` ${held} more left alone (uncommitted changes, locked, or unsaved commits).`}
      </p>
      {children}
      <Button size="sm" variant="danger" icon={progress ? <Spinner /> : <Trash2 />} className="mt-auto self-start" disabled={disabled || count === 0} onClick={onRun}>
        {progress ?? label}
      </Button>
    </Tile>
  );
}

function RepoSection({
  hostId,
  repo,
  owners,
  home,
  now,
  staleDays,
  removing,
  onDelete,
}: {
  hostId: string;
  repo: CleanupRepo;
  /** The report's owners by key (hosts ≥ 0.9.0): rows name the agent they belong to. */
  owners?: ReadonlyMap<string, CleanupOwner>;
  home?: string;
  now: number;
  staleDays: number;
  removing: ReadonlySet<string>;
  onDelete(w: CleanupWorktree): void;
}) {
  const agentIds = useCore((s) => (s.hosts[hostId]?.state.agents ?? []).map((a) => a.id).join("\n"));
  const live = new Set(agentIds.split("\n"));
  const bytes = repo.worktrees.reduce((n, w) => n + (w.size ?? 0), 0);
  return (
    <section aria-label={repo.name} className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-ink">
          <FolderGit2 className="size-4 text-mute" aria-hidden /> {repo.name}
        </h3>
        <span className="min-w-0 truncate font-mono text-2xs text-mute-2">{tildify(repo.root, home)}</span>
        <span className="ml-auto text-2xs text-mute">
          {repo.worktrees.length} worktree{repo.worktrees.length === 1 ? "" : "s"}
          {bytes > 0 && ` · ${formatBytes(bytes)}`}
          {repo.prError && ` · pull requests unknown (${repo.prError})`}
        </span>
      </div>
      {repo.error ? (
        <Tile className="px-4 py-3 text-xs text-error/90">{repo.error}</Tile>
      ) : (
        <Tile className="overflow-hidden p-0">
          <ol className="flex flex-col divide-y divide-line">
            {sortForPage(repo.worktrees, now, staleDays).map((w) => {
              const owner = w.owner && owners?.get(w.owner.key);
              const named = owner ? owner.agentId : w.lastAgent?.agentId;
              return (
                <WorktreeRow
                  key={w.path}
                  hostId={hostId}
                  worktree={w}
                  verdict={classify(w, now, staleDays)}
                  home={home}
                  now={now}
                  removing={removing.has(w.path)}
                  liveAgent={!!named && live.has(named)}
                  owner={owner}
                  onDelete={() => onDelete(w)}
                />
              );
            })}
          </ol>
        </Tile>
      )}
    </section>
  );
}

/**
 * Route `#/cleanup[/:hostId]`: one host's linked worktrees with their pull request, age, changes, size and
 * last agent; bulk "Delete merged/closed" and "Prune stale"; omp's own storage cleanup (never sessions).
 */
export function CleanupView({ hostId: routeHost }: { hostId?: string }) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const status = useHosts((s) => s.status);
  const profiles = useHosts((s) => s.profiles);
  const { lastHost, setLastHost, staleDays, setStaleDays, groupBy, setGroupBy } = useCleanupPrefs();
  const hostId =
    routeHost && hostIds.includes(routeHost)
      ? routeHost
      : lastHost && hostIds.includes(lastHost)
        ? lastHost
        : (hostIds.find((id) => status[id]?.phase === "online") ?? hostIds[0]);
  const hostName = profiles.find((p) => p.id === hostId)?.name ?? hostId ?? "";
  const home = useHostState(hostId ?? "")?.info.home;
  const phase = hostId ? (status[hostId]?.phase ?? "idle") : "idle";
  useEffect(() => {
    if (routeHost && routeHost === hostId) setLastHost(routeHost);
  }, [routeHost, hostId, setLastHost]);
  const pickHost = (id: string) => {
    setLastHost(id);
    navigate({ name: "cleanup", hostId: id }, { replace: true });
  };

  const q = useCleanupReport(hostId);
  const storage = useCleanupStorage(hostId);
  const now = useNow(60_000);
  const [removing, setRemoving] = useState<{ hostId?: string; paths: Set<string>; bulk?: { which: BulkKind; group?: string | null; done: number; of: number } }>({
    paths: new Set(),
  });
  const busyPaths = removing.hostId === hostId ? removing.paths : new Set<string>();
  const bulkRun = removing.hostId === hostId ? removing.bulk : undefined;
  // Groups the user opened or closed; the rest follow the page's size (open while it is small).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const report = q.data;
  const t = totals(report, now, staleDays);
  const shipped = bulkSet(report, "shipped", now, staleDays);
  const stale = bulkSet(report, "stale", now, staleDays);
  const scanning = !!report?.scanning;
  // Hosts ≥ 0.9.0 say who each worktree belongs to; older ones are listed by repository only.
  const byAgent = groupBy === "agent" && report?.owners !== undefined;
  const groups = byAgent ? groupByOwner(report, now, staleDays) : [];
  const owners = report?.owners ? new Map(report.owners.map((o) => [o.key, o])) : undefined;

  const deleteOne = async (w: CleanupWorktree) => {
    if (!hostId) return;
    setRemoving((r) => ({ hostId, paths: new Set([...(r.hostId === hostId ? r.paths : []), w.path]), bulk: r.bulk }));
    const gone = await removeOne(hostId, w, home);
    setRemoving((r) => ({ ...r, paths: new Set([...r.paths].filter((p) => p !== w.path)) }));
    if (gone) q.reload();
  };

  const runBulk = async (which: BulkKind) => {
    if (!hostId) return;
    const set = which === "shipped" ? shipped : stale;
    const paths = new Set(set.items.map((w) => w.path));
    const out = await removeMany(hostId, which, set, home, (done) => setRemoving({ hostId, paths, bulk: { which, done, of: set.items.length } }));
    setRemoving({ hostId, paths: new Set() });
    if (out) q.reload();
  };

  /** An agent group's "Delete merged, closed and stale". */
  const cleanGroup = async (g: AgentGroup) => {
    if (!hostId) return;
    const set = g.cleanable;
    const paths = new Set(set.items.map((w) => w.path));
    const n = set.items.length;
    const title = g.key === null ? `Delete ${n} worktree${n === 1 ? "" : "s"} no agent worked in?` : `Delete ${n} worktree${n === 1 ? "" : "s"} of ${ownerLabel(g.owner)}?`;
    const out = await removeMany(hostId, "cleanable", set, home, (done) => setRemoving({ hostId, paths, bulk: { which: "cleanable", group: g.key, done, of: n } }), title);
    setRemoving({ hostId, paths: new Set() });
    if (out) q.reload();
  };

  const hostPicker = hostId && hostIds.length > 1 ? <HostPicker target={hostId} hostIds={hostIds} groups={[]} onChange={pickHost} /> : null;
  const counter = (run: NonNullable<typeof bulkRun>) => `Removing ${Math.min(run.done + 1, run.of)}/${run.of}…`;
  const progress = (which: BulkKind) => (bulkRun?.which === which ? counter(bulkRun) : null);
  const groupProgress = (key: string | null) => (bulkRun?.which === "cleanable" && bulkRun.group === key ? counter(bulkRun) : null);

  let body;
  if (!hostId) {
    body = (
      <EmptyState
        icon={<Server />}
        title="No hosts yet"
        description="Cleanup works on a host's worktrees. Add one first."
        action={<Button onClick={() => navigate({ name: "hosts" })}>Add a host</Button>}
        className="mt-6"
      />
    );
  } else if (q.outdated) {
    body = <OutdatedHost hostName={hostName} />;
  } else if (!report && (q.waiting || (q.error && phase !== "online"))) {
    body = (
      <EmptyState
        icon={<WifiOff />}
        title={`Waiting for ${hostName}`}
        description={`The host is ${phase}. Its worktrees show up here once it's connected.`}
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Hosts
          </Button>
        }
        className="mt-6"
      />
    );
  } else if (!report && q.error) {
    body = (
      <EmptyState
        icon={<FolderGit2 />}
        title="Couldn't list the worktrees"
        description={q.error.hint ? `${q.error.message} · ${q.error.hint}` : q.error.message}
        action={
          <Button variant="secondary" icon={<RotateCw />} onClick={q.reload}>
            Retry
          </Button>
        }
        className="mt-6"
      />
    );
  } else if (!report || (report.scannedAt === undefined && report.repos.length === 0)) {
    body = (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-[120px] rounded-tile" />
        <Skeleton className="h-[220px] rounded-tile" />
      </div>
    );
  } else {
    const repos = report.repos;
    body = (
      <>
        <div className="grid gap-3 sm:grid-cols-3">
          <DiskTile hostId={hostId} />
          <BulkTile
            title="Merged or closed"
            about="Their pull request is merged or closed."
            count={shipped.items.length}
            held={shipped.held.length}
            bytes={shipped.bytes}
            label="Delete merged/closed…"
            disabled={scanning || !!bulkRun}
            progress={progress("shipped")}
            onRun={() => void runBulk("shipped")}
          />
          <BulkTile
            title="Stale"
            about={`No pull request, not open in herdr, no agent, untouched for ${staleDays} days. Folders already gone are left to "Forget" one by one.`}
            count={stale.items.length}
            held={stale.held.length}
            bytes={stale.bytes}
            label="Prune stale…"
            disabled={scanning || !!bulkRun}
            progress={progress("stale")}
            onRun={() => void runBulk("stale")}
          >
            <Select
              aria-label="Stale after"
              className="h-8 min-w-0 self-start text-xs"
              value={String(staleDays)}
              onValueChange={(v) => setStaleDays(Number(v))}
              options={STALE_DAYS.map((d) => ({ value: String(d), label: `Untouched ${d}+ days` }))}
            />
          </BulkTile>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-mute">
          <span>
            <b className="text-ink">{t.worktrees}</b> linked worktree{t.worktrees === 1 ? "" : "s"} in {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
            {t.bytes > 0 && (
              <>
                {" "}
                · <b className="text-ink">{t.partial ? "≥ " : ""}{formatBytes(t.bytes)}</b>
              </>
            )}
          </span>
          {scanning ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner /> sizes and pull requests are filling in…
            </span>
          ) : (
            report.scannedAt !== undefined && <span>scanned {formatAge(now - report.scannedAt)}</span>
          )}
          {report.owners !== undefined && repos.length > 0 && (
            <SegmentedControl<CleanupGrouping>
              aria-label="Group worktrees by"
              size="sm"
              className="ml-auto max-md:ml-0"
              value={groupBy}
              onValueChange={setGroupBy}
              options={[
                { value: "agent", label: "By agent" },
                { value: "repo", label: "By repository" },
              ]}
            />
          )}
        </div>
        {byAgent && (report.sessionsPending ?? 0) > 0 && (
          <p className="px-1 text-2xs text-mute-2">
            Still reading {report.sessionsPending} of omp's session files on {hostName}: some worktrees may find their agent on the next scan.
          </p>
        )}
        {report.ghError && (
          <Tile data-status="needs-you" className="flex items-start gap-3 p-4 text-xs text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--st-solid)_35%,transparent)] max-md:p-3.5">
            <Sparkles className="mt-0.5 size-4 shrink-0 st-text" aria-hidden />
            <span>
              <b className="text-ink">No pull requests from gh on {hostName}:</b> {report.ghError}. Merged and closed worktrees can't be told apart until gh is signed in
              there (run <span className="font-mono">gh auth login</span>); stale ones are judged by age alone.
            </span>
          </Tile>
        )}
        {repos.length === 0 ? (
          <Tile className="p-0">
            <EmptyState
              compact
              icon={<FolderGit2 />}
              title="No linked worktrees"
              description="The repositories TeleFlock knows on this host (its workspaces, done agents and automations) have no linked worktrees."
            />
          </Tile>
        ) : byAgent ? (
          groups.map((g) => {
            const key = g.key ?? "";
            return (
              <AgentSection
                key={key}
                hostId={hostId}
                group={g}
                home={home}
                now={now}
                staleDays={staleDays}
                removing={busyPaths}
                multiRepo={repos.length > 1}
                open={toggled[key] ?? t.worktrees <= 24}
                onToggle={() => setToggled((o) => ({ ...o, [key]: !(o[key] ?? t.worktrees <= 24) }))}
                onDelete={(w) => void deleteOne(w)}
                onClean={() => void cleanGroup(g)}
                progress={groupProgress(g.key)}
                disabled={scanning || !!bulkRun}
              />
            );
          })
        ) : (
          repos.map((r) => <RepoSection key={r.root} hostId={hostId} repo={r} owners={owners} home={home} now={now} staleDays={staleDays} removing={busyPaths} onDelete={(w) => void deleteOne(w)} />)
        )}
        <ChatCleanup hostId={hostId} hostName={hostName} home={home} />
        <IdleShellsSection hostId={hostId} />
        <StorageSection q={storage} hostName={hostName} home={home} />
      </>
    );
  }

  const rescan = hostId && report && !q.outdated && (
    <Button variant="secondary" icon={scanning ? <Spinner /> : <RotateCw />} disabled={scanning} onClick={q.rescan}>
      {scanning ? "Scanning…" : "Rescan"}
    </Button>
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader
          title="Cleanup"
          subtitle={hostName}
          back
          actions={
            hostId && report && !q.outdated ? (
              <IconButton label="Rescan" size="lg" disabled={scanning} onClick={q.rescan}>
                {scanning ? <Spinner /> : <RotateCw />}
              </IconButton>
            ) : undefined
          }
        />
        {hostPicker && <div className="px-3 pt-1 pb-1">{hostPicker}</div>}
        <div className="flex flex-col gap-3 px-3 pt-1 pb-6">{body}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-8 pt-7 pb-12">
      <PageHeader
        kicker="Housekeeping"
        title="Cleanup"
        meta={hostPicker}
        description={`Worktrees on ${hostName || "a host"}: pull request, age, uncommitted changes, size and last agent. Deleting one keeps its branch; omp's sessions are never deleted here.`}
        actions={rescan || undefined}
        className="mb-1"
      />
      {body}
    </div>
  );
}
