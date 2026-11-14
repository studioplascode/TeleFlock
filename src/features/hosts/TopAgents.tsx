import { useState } from "react";
import { agentKey, navigate, useAgent, useCore } from "@/core";
import type { AgentLoad, HostHealth } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { AgentGlyph, cn, SegmentedControl } from "@/design";
import { coresUsed, formatCores, formatShare } from "./agentLoad";

/** Agents listed; the rest are counted. */
const TOP = 5;

type By = "cpu" | "mem";

const BY_OPTIONS = [
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "Memory" },
] as const;

/**
 * Hosts page, under the host's CPU and memory: the agents using most of them (hosts ≥ 0.9.5), each
 * opening its session. Hidden while no agent runs a process (and for older daemons).
 */
export function TopAgents({ hostId }: { hostId: string }) {
  const health = useCore((s) => s.hosts[hostId]?.state.health);
  const [by, setBy] = useState<By>("cpu");
  const agents = health?.agents;
  if (!health || !agents?.length) return null;
  // hostd lists the busiest first.
  const list = by === "cpu" ? agents : [...agents].sort((a, b) => b.mem - a.mem || b.cpuPct - a.cpuPct);
  const cpu = agents.reduce((n, a) => n + a.cpuPct, 0);
  const mem = agents.reduce((n, a) => n + a.mem, 0);
  return (
    <section className="min-w-0 rounded-md well p-2.5" aria-label="Agents on this host">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="kicker">Agents</div>
          <div className="font-mono text-2xs text-mute-2 tabular" title="What the agents and every process they started use together, of this host's CPU (all cores) and memory">
            {agents.length} agent{agents.length === 1 ? "" : "s"} together: cpu {formatShare(cpu)} · {formatBytes(mem)}
          </div>
        </div>
        <SegmentedControl size="sm" value={by} onValueChange={setBy} options={BY_OPTIONS} aria-label="Sort agents by" />
      </div>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {list.slice(0, TOP).map((a) => (
          <AgentRow key={a.agentId} hostId={hostId} load={a} health={health} by={by} />
        ))}
      </ul>
      {list.length > TOP && (
        <div className="mt-1 px-1.5 text-2xs font-semibold text-mute-2">
          and {list.length - TOP} more: cpu {formatShare(list.slice(TOP).reduce((n, a) => n + a.cpuPct, 0))} · {formatBytes(list.slice(TOP).reduce((n, a) => n + a.mem, 0))}
        </div>
      )}
    </section>
  );
}

function AgentRow({ hostId, load, health, by }: { hostId: string; load: AgentLoad; health: HostHealth; by: By }) {
  const agent = useAgent(agentKey(hostId, load.agentId));
  const name = agent?.name ?? load.agentId;
  const memPct = health.memTotal > 0 ? (load.mem / health.memTotal) * 100 : 0;
  const fill = by === "cpu" ? load.cpuPct : memPct;
  return (
    <li>
      <button
        type="button"
        className="group relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1.5 py-1 text-left focus-ring hover:bg-ink/5"
        title={`Open ${name}: ${formatCores(coresUsed(load.cpuPct, health.cores))} of ${health.cores} cores, ${formatShare(memPct)} of the memory, ${load.procs} process${load.procs === 1 ? "" : "es"}`}
        onClick={() => navigate({ name: "agent", hostId, agentId: load.agentId })}
      >
        <AgentGlyph name={name} size={18} />
        <span className="min-w-0 truncate text-xs font-bold text-ink-2 group-hover:text-ink">{name}</span>
        <span className="font-mono text-2xs text-mute tabular">
          <span className={cn(by === "cpu" && "text-ink-2")}>
            cpu <b className="font-bold">{formatShare(load.cpuPct)}</b>
          </span>
          {" · "}
          <span className={cn(by === "mem" && "text-ink-2")}>
            <b className="font-bold">{formatBytes(load.mem)}</b>
          </span>
        </span>
        <span className="col-span-3 mt-0.5 h-1 overflow-hidden rounded-full bg-ink/6" aria-hidden>
          <span className={cn("block h-full rounded-full transition-[width] duration-700", by === "cpu" ? "bg-run-solid/70" : "bg-review/70")} style={{ width: `${Math.min(100, Math.max(fill, fill > 0 ? 1 : 0))}%` }} />
        </span>
      </button>
    </li>
  );
}
