import { ExternalLink, FolderOpen, GitBranch, History } from "lucide-react";
import { navigate, useHostState } from "@/core";
import type { Automation, AutomationRun } from "@/core/gen";
import { Button, EmptyState, Select, Tile, cn, formatAge, useNow } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { TRIGGER_LABEL, formatWhen } from "./format";
import { RunChip } from "./parts";

const ALL = "all";

export interface RunsListProps {
  hostId: string;
  runs: readonly AutomationRun[];
  automations: readonly Automation[];
  /** Automation id, or "all". */
  filter: string;
  onFilter(id: string): void;
  className?: string;
}

/** Recent runs of one automation or all of them, newest first. */
export function RunsList({ hostId, runs, automations, filter, onFilter, className }: RunsListProps) {
  const now = useNow(30_000);
  const home = useHostState(hostId)?.info.home;
  const agents = useHostState(hostId)?.agents;
  const names = new Map(automations.map((a) => [a.id, a.name]));
  const shown = filter === ALL ? runs : runs.filter((r) => r.automationId === filter);
  const options = [{ value: ALL, label: "All automations" }, ...automations.map((a) => ({ value: a.id, label: a.name }))];

  return (
    <section id="automation-runs" aria-label="Recent runs" className={cn("flex scroll-mt-16 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold">
          <History className="size-4 text-mute" /> Recent runs
        </h2>
        <Select value={names.has(filter) ? filter : ALL} onValueChange={onFilter} options={options} aria-label="Show runs of" className="ml-auto h-9 max-w-[16rem] min-w-44 max-md:max-w-[60%]" />
      </div>
      {shown.length === 0 ? (
        <Tile className="p-0">
          <EmptyState compact icon={<History />} title="No runs yet" description="Runs show up here when a schedule fires or you press Run now." />
        </Tile>
      ) : (
        <Tile className="overflow-hidden p-0">
          <ol className="flex flex-col divide-y divide-line">
            {shown.map((r) => {
              const live = !!r.agentId && !!agents?.some((a) => a.id === r.agentId);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 max-md:px-3.5">
                  <RunChip hostId={hostId} run={r} className="min-w-[78px] justify-center" />
                  <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      {filter === ALL && <span className="min-w-0 truncate text-sm font-bold text-ink">{names.get(r.automationId) ?? "Deleted automation"}</span>}
                      <span className="text-xs text-mute" title={formatWhen(r.at)}>
                        {TRIGGER_LABEL[r.trigger]} · {formatAge(now - r.at)}
                      </span>
                    </div>
                    {(r.branch || r.path) && (
                      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-mute-2">
                        {r.branch ? <GitBranch className="size-3 shrink-0" /> : <FolderOpen className="size-3 shrink-0" />}
                        <span className="min-w-0 truncate font-mono" title={r.path}>
                          {r.branch ?? tildify(r.path ?? "", home)}
                        </span>
                      </div>
                    )}
                    {r.error && <p className="text-xs break-words text-error/90">{r.error}</p>}
                  </div>
                  {r.agentId &&
                    (live ? (
                      <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => navigate({ name: "agent", hostId, agentId: r.agentId as string })} className="max-md:ml-auto">
                        Open agent
                      </Button>
                    ) : (
                      <span className="text-2xs text-mute-2 max-md:ml-auto">agent closed</span>
                    ))}
                </li>
              );
            })}
          </ol>
        </Tile>
      )}
    </section>
  );
}
