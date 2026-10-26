import { FolderOpen, GitBranchPlus, History, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { core, navigate, toApiError } from "@/core";
import type { Automation } from "@/core/gen";
import { Badge, Button, Chip, IconButton, Switch, Tile, cn, formatAge, toast, useIsMobile } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import { describeCron } from "@/core/cron";
import { formatIn, formatWhen } from "./format";
import { RunChip } from "./parts";
import { toDraft } from "./useAutomations";

export interface AutomationCardProps {
  hostId: string;
  automation: Automation;
  home?: string;
  now: number;
  onEdit(): void;
  /** Show this automation's runs. */
  onHistory(): void;
  /** Something changed on the host: refetch the list. */
  onChanged(): void;
}

/** Run now on the host; the toast links to the started agent. */
async function runNow(hostId: string, a: Automation): Promise<void> {
  try {
    const run = await core.host(hostId).call("automation.run", { id: a.id });
    if (run.status === "started") {
      const agentId = run.agentId;
      toast({
        title: `“${a.name}” started`,
        description: run.branch ?? run.path,
        status: "done",
        action: agentId ? { label: "Open agent", onClick: () => navigate({ name: "agent", hostId, agentId }) } : undefined,
      });
    } else {
      toast({ title: `“${a.name}” ${run.status === "failed" ? "failed to start" : "was skipped"}`, description: run.error, status: run.status === "failed" ? "error" : "idle" });
    }
  } catch (e) {
    toast({ title: `Couldn't run “${a.name}”`, description: toApiError(e).message, status: "error" });
  }
}

/** One automation: schedule, next/last run, enable switch and actions. */
export function AutomationCard({ hostId, automation: a, home, now, onEdit, onHistory, onChanged }: AutomationCardProps) {
  const mobile = useIsMobile();
  const [running, setRunning] = useState(false);
  // The switch shows the requested state until the saved automation (new updatedAt) arrives.
  const [pending, setPending] = useState<{ enabled: boolean; since: number } | null>(null);
  if (pending && a.updatedAt !== pending.since) setPending(null);
  const enabled = pending?.enabled ?? a.enabled;
  const description = describeCron(a.schedule) ?? a.schedule;

  const toggle = async (v: boolean) => {
    setPending({ enabled: v, since: a.updatedAt });
    try {
      await core.host(hostId).call("automation.save", { ...toDraft(a), enabled: v });
      toast({ title: v ? `“${a.name}” is on` : `“${a.name}” is paused`, status: v ? "done" : "idle", duration: 2200 });
    } catch (e) {
      setPending(null);
      toast({ title: `Couldn't ${v ? "enable" : "pause"} “${a.name}”`, description: toApiError(e).message, status: "error" });
    }
    onChanged();
  };

  const run = async () => {
    setRunning(true);
    await runNow(hostId, a);
    setRunning(false);
    onChanged();
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete “${a.name}”?`,
      body: "Its schedule stops and its run history is removed. Agents and worktrees it already started stay as they are.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await core.host(hostId).call("automation.delete", { id: a.id });
      toast({ title: `Deleted “${a.name}”`, status: "idle", duration: 2500 });
    } catch (e) {
      toast({ title: `Couldn't delete “${a.name}”`, description: toApiError(e).message, status: "error" });
    }
    onChanged();
  };

  const next = !enabled ? (
    <span className="text-mute-2">Paused</span>
  ) : a.nextRunAt !== undefined ? (
    <span title={formatWhen(a.nextRunAt)} className="text-ink-2">
      {formatIn(a.nextRunAt - now)}
    </span>
  ) : (
    <span className="text-mute-2">—</span>
  );
  const last = a.lastRun ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <RunChip hostId={hostId} run={a.lastRun} />
      <span className="truncate text-2xs text-mute" title={formatWhen(a.lastRun.at)}>
        {formatAge(now - a.lastRun.at)}
      </span>
    </span>
  ) : (
    <span className="text-xs text-mute-2">Never</span>
  );
  const sw = <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} label={enabled ? `Pause ${a.name}` : `Enable ${a.name}`} />;

  const info = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className={cn("min-w-0 truncate text-md font-bold", enabled ? "text-ink" : "text-ink-2")}>{a.name}</h3>
        <Chip icon={a.worktree ? <GitBranchPlus /> : <FolderOpen />} className="h-5 px-2 text-2xs">
          {a.worktree ? "Worktree" : "In place"}
        </Chip>
        {!enabled && <Badge>Paused</Badge>}
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-ink-2">
        <span>{description}</span>
        <code className="font-mono text-2xs text-mute-2">{a.schedule}</code>
      </p>
      <p className="flex min-w-0 items-center gap-2 text-2xs text-mute-2">
        <span className="min-w-0 truncate font-mono" title={a.cwd}>
          {tildify(a.cwd, home)}
        </span>
        {a.model && <span className="shrink-0">· {a.model.split("/").pop()}</span>}
        {a.plan && <span className="shrink-0">· plan</span>}
      </p>
    </div>
  );

  if (mobile) {
    return (
      <Tile className={cn("flex flex-col gap-3 p-3.5", !enabled && "opacity-85")}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">{info}</div>
          <div className="pt-1">{sw}</div>
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-md bg-black/15 px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="kicker">Next run</span>
            <span className="text-sm font-semibold">{next}</span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="kicker">Last run</span>
            {last}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={<Play />} loading={running} onClick={() => void run()} className="flex-1">
            Run now
          </Button>
          <IconButton label="Runs" size="md" onClick={onHistory}>
            <History />
          </IconButton>
          <IconButton label="Edit" size="md" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label="Delete" size="md" variant="danger" onClick={() => void remove()}>
            <Trash2 />
          </IconButton>
        </div>
      </Tile>
    );
  }

  return (
    <Tile className={cn("grid grid-cols-[minmax(0,1fr)_8.5rem_10.5rem_auto] items-center gap-5 px-5 py-4", !enabled && "opacity-85")}>
      {info}
      <div className="flex flex-col gap-1">
        <span className="kicker">Next run</span>
        <span className="text-sm font-semibold">{next}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <button type="button" onClick={onHistory} className="kicker self-start rounded-xs text-left focus-ring hover:text-ink" title="Show this automation's runs">
          Last run
        </button>
        {last}
      </div>
      <div className="flex items-center gap-1.5">
        {sw}
        <Button size="sm" variant="secondary" icon={<Play />} loading={running} onClick={() => void run()} className="ml-2">
          Run now
        </Button>
        <IconButton label="Edit" size="sm" onClick={onEdit}>
          <Pencil />
        </IconButton>
        <IconButton label="Delete" size="sm" variant="danger" onClick={() => void remove()}>
          <Trash2 />
        </IconButton>
      </div>
    </Tile>
  );
}
