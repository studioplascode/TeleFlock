import { GitBranch, Square, SquareTerminal } from "lucide-react";
import { parseAgentKey, useAgent, useSession, useUi } from "@/core";
import { AgentGlyph, Button, cn, Elapsed, formatUsd, Heartbeat, Kbd, NumberTicker, StatusPill, Swarm, Tooltip, useActivity } from "@/design";
import { agentStatus, hostCall, useBeat } from "../api";
import { ActionsMenu, FastToggle, GoalChip, ModelPicker, PlanToggle, ThinkingPicker } from "./Controls";

/** Desktop session header: identity, liveness, and every mode control. */
export function SessionHeader({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const beat = useBeat(agentKey);
  const { tier } = useActivity(beat);
  const status = agentStatus(agent);
  if (!agent) return null;
  const live = agent.omp?.link === "live";
  const working = agent.column === "running";
  const subs = meta?.subagents.filter((s) => s.status === "running").length ?? agent.omp?.subagents?.live ?? 0;
  const cost = meta?.cost?.usd ?? agent.omp?.cost?.usd;
  return (
    <header
      data-status={status}
      data-morph="surface"
      data-morph-key={agent.key}
      className={cn("relative flex flex-col gap-2 rounded-[22px] glass px-3.5 py-2.5", compact && "rounded-[18px] px-3 py-2")}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Swarm count={subs} size={44}>
          <span className="shrink-0" data-morph="glyph" data-morph-key={agent.key}>
            <AgentGlyph name={agent.name} size={36} status={status} />
          </span>
        </Swarm>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 data-morph="name" data-morph-key={agent.key} className="truncate font-display text-[19px] font-bold tracking-[-0.02em] text-ink">
              {agent.name}
            </h2>
            <StatusPill status={status} activity={tier} size="sm">
              {agent.needs ? agent.needs.title : undefined}
            </StatusPill>
            {working && (
              <span className="flex items-center gap-1 text-[11px] font-bold text-mute tabular">
                <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} />
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-mute">
            {agent.title && agent.title !== agent.name && <span className="min-w-0 truncate font-sans text-xs font-semibold text-ink-2">{agent.title}</span>}
            {(agent.repo || agent.branch) && (
              <span className="flex min-w-[80px] shrink-[3] items-center gap-1 truncate">
                <GitBranch className="size-3" />
                {agent.repo}
                {agent.repo && agent.branch && " · "}
                {agent.branch}
              </span>
            )}
            <span className="shrink-0 text-mute-2">{agent.paneId}</span>
          </div>
        </div>
        {!compact && (
          <div className="hidden w-[132px] shrink-0 lg:block">
            <Heartbeat beat={beat} lastEventAt={agent.live.lastEventAt} status={status} height={26} />
          </div>
        )}
        {cost != null && (
          <Tooltip content="Session cost">
            <span tabIndex={0} className="focus-ring shrink-0 rounded-full px-2 py-1 font-display text-sm font-bold text-ink-2 tabular">
              <NumberTicker value={cost} format={formatUsd} />
            </span>
          </Tooltip>
        )}
        <Tooltip content="Open terminal in split" shortcut="Ctrl \">
          <Button size="sm" variant="ghost" icon={<SquareTerminal />} onClick={() => useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent.paneId })} aria-label="Open terminal in split" />
        </Tooltip>
        {working && live && (
          <Button size="sm" variant="danger" icon={<Square className="fill-current" />} onClick={() => void hostCall(hostId, "agent.abort", { agentId }, { failure: "Stop failed" })} trailing={<Kbd>Esc</Kbd>}>
            Stop
          </Button>
        )}
      </div>
      {live && (
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar">
          <ModelPicker agentKey={agentKey} />
          <ThinkingPicker agentKey={agentKey} />
          <PlanToggle agentKey={agentKey} compact={compact} />
          <FastToggle agentKey={agentKey} compact={compact} />
          <GoalChip agentKey={agentKey} compact={compact} />
          <span className="ml-auto" />
          <ActionsMenu agentKey={agentKey} />
        </div>
      )}
    </header>
  );
}
