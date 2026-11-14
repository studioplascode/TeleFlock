import { parseAgentKey } from "@/core";
import { formatBytes } from "@/core/upload";
import { Tooltip } from "@/design";
import { describeLoad, formatShare, loadLevel, NOTABLE_KEEP, useAgentLoad } from "@/features/hosts/agentLoad";
import { useHostName } from "@/features/hosts/HerdrControls";

/**
 * Card meter `cpu 38% · ram 2.4 GB` while the agent's processes take a notable share of its host
 * (`useNotableLoad`): only the resources near the threshold, CPU as a share of the whole host.
 */
export function LoadChip({ agentKey }: { agentKey: string }) {
  const { load, health } = useAgentLoad(agentKey);
  const hostName = useHostName(parseAgentKey(agentKey).hostId);
  if (!load || !health) return null;
  const level = loadLevel(load, health);
  if (Math.max(level.cpu, level.mem) < NOTABLE_KEEP) return null;
  return (
    <Tooltip content={<span className="block max-w-64">{`${describeLoad(load, health, hostName)}: this agent and everything it started. Its Resources tile shows the last minutes.`}</span>}>
      <span data-load-chip className="inline-flex shrink-0 items-center gap-1.5 font-mono text-2xs text-mute tabular">
        {level.cpu >= NOTABLE_KEEP && (
          <span>
            cpu <b className="font-bold text-warn">{formatShare(load.cpuPct)}</b>
          </span>
        )}
        {level.mem >= NOTABLE_KEEP && (
          <span>
            ram <b className="font-bold text-warn">{formatBytes(load.mem)}</b>
          </span>
        )}
      </span>
    </Tooltip>
  );
}
