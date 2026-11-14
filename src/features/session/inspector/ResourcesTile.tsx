import { parseAgentKey } from "@/core";
import { formatBytes } from "@/core/upload";
import { Sparkline, Tooltip } from "@/design";
import { coresUsed, describeLoad, formatCores, formatShare, loadLevel, useAgentLoad } from "@/features/hosts/agentLoad";
import { useHostName } from "@/features/hosts/HerdrControls";
import { CollapsibleTile } from "./InspectorCard";
import { Meter } from "./LimitsTile";

/**
 * The Session card's Resources tile (hosts ≥ 0.9.5): what the agent's process and everything it
 * started use of the host, CPU over the last minutes. Hidden while it runs no process.
 */
export function ResourcesTile({ agentKey }: { agentKey: string }) {
  const { load, health, cpu } = useAgentLoad(agentKey);
  const hostName = useHostName(parseAgentKey(agentKey).hostId);
  if (!load || !health) return null;
  const level = loadLevel(load, health);
  const memPct = health.memTotal > 0 ? (load.mem / health.memTotal) * 100 : 0;
  const peak = Math.max(load.cpuPct, ...cpu);
  return (
    <CollapsibleTile
      id="resources"
      title="Resources"
      className="rounded-lg bg-bg-deep/45 px-3 pt-2 pb-1.5 shadow-hairline"
      aside={
        <span className="text-mute-2 tabular">
          cpu {formatShare(load.cpuPct)} · {formatBytes(load.mem)}
        </span>
      }
    >
      <Tooltip content={<span className="block max-w-72">{`${describeLoad(load, health, hostName)}: the agent and every process it started (shells, tests, builds, servers, browsers). CPU counts every core of the host as 100%.`}</span>}>
        <div tabIndex={0} className="focus-ring flex gap-4 rounded-sm" aria-label="Resources of this agent">
          <Meter
            term="cpu"
            reading={`${formatShare(load.cpuPct)} of host`}
            fill={load.cpuPct}
            status={level.cpu >= 1 ? "needs-you" : undefined}
            label={`CPU ${formatShare(load.cpuPct)} of the host`}
            detail={`${formatCores(coresUsed(load.cpuPct, health.cores))} of ${health.cores} cores`}
          />
          <Meter
            term="ram"
            reading={formatBytes(load.mem)}
            fill={memPct}
            status={level.mem >= 1 ? "needs-you" : undefined}
            label={`Memory ${formatBytes(load.mem)}, ${formatShare(memPct)} of the host`}
            detail={`${formatShare(memPct)} of ${formatBytes(health.memTotal)} · ${load.procs} process${load.procs === 1 ? "" : "es"}`}
          />
        </div>
      </Tooltip>
      <div className="relative">
        <Sparkline values={peak < 1 ? [0, 0] : cpu.length > 1 ? cpu : [load.cpuPct, load.cpuPct]} height={26} live={load.cpuPct >= 1} status={level.cpu >= 1 ? "needs-you" : "running"} aria-label="CPU over the last minutes" />
        {peak < 1 && <span className="absolute inset-0 grid place-items-center text-[10.5px] font-semibold text-mute-2">idle · under 1% of the host's CPU</span>}
      </div>
    </CollapsibleTile>
  );
}
