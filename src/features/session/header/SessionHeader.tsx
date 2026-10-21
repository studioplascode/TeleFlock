import { BellOff, Focus, GitBranch, Square, SquareTerminal } from "lucide-react";
import { parseAgentKey, useAgent, useSession, useUi } from "@/core";
import { AgentGlyph, Button, cn, Elapsed, formatUsd, Heartbeat, Kbd, NumberTicker, StatusPill, Swarm, Tooltip, useActivity } from "@/design";
import { agentStatus, hostCall, useBeat, useMute } from "../api";
import { CostTooltip } from "../spend";
import { ActionsMenu, FastToggle, GoalChip, ModelPicker, PlanToggle, ThinkingPicker } from "./Controls";
import { LimitsChip } from "./LimitsChip";

/** Desktop session header: identity, liveness, and every mode control. */
export function SessionHeader({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const beat = useBeat(agentKey);
  const { tier } = useActivity(beat);
  const status = agentStatus(agent);
  const { muted } = useMute(agentKey);
  if (!agent) return null;
  const live = agent.omp?.link === "live";
  const working = agent.column === "running";
  const subs = meta?.subagents.filter((s) => s.status === "running").length ?? agent.omp?.subagents?.live ?? 0;
  const cost = meta?.cost ?? agent.omp?.cost;
  return (
    <header
      data-status={status}
      data-morph="surface"
      data-morph-key={agent.key}
      className={cn("@container/hdr relative flex flex-col gap-2 rounded-[22px] glass px-3.5 py-2.5", compact && "rounded-[18px] px-3 py-2")}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Swarm count={subs} size={44}>
          <span className="shrink-0" data-morph="glyph" data-morph-key={agent.key}>
            <AgentGlyph name={agent.name} size={36} status={status} />
          </span>
        </Swarm>
        {/* Its own container: lower-priority bits drop out as the identity column narrows, so nothing spills under the cost/actions. */}
        <div className="@container/id -my-1.5 min-w-0 flex-1 overflow-hidden py-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 data-morph="name" data-morph-key={agent.key} className="min-w-[3.5rem] truncate font-display text-[19px] font-bold tracking-[-0.02em] text-ink">
              {agent.name}
            </h2>
            <StatusPill status={status} activity={tier} size="sm" className="hidden shrink-0 @min-[9.5rem]/id:inline-flex">
              {agent.needs ? agent.needs.title : undefined}
            </StatusPill>
            {muted && (
              <Tooltip content="Notifications muted for this agent">
                <BellOff tabIndex={0} className="focus-ring size-3.5 shrink-0 rounded-xs text-mute" aria-label="Notifications muted" />
              </Tooltip>
            )}
            {working && (
              <span className="hidden shrink-0 items-center gap-1 text-[11px] font-bold text-mute tabular @min-[14rem]/id:flex">
                <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} />
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-mute">
            {agent.title && agent.title !== agent.name && (
              <span title={agent.title} className="min-w-0 truncate font-sans text-xs font-semibold text-ink-2">
                {agent.title}
              </span>
            )}
            {(agent.repo || agent.branch) && (
              <span title={[agent.repo, agent.branch].filter(Boolean).join(" · ")} className="flex min-w-[80px] shrink-[3] items-center gap-1 truncate">
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
          <div className="hidden w-[132px] shrink-0 @min-[50rem]/hdr:block">
            <Heartbeat beat={beat} lastEventAt={agent.live.lastEventAt} status={status} height={26} />
          </div>
        )}
        <LimitsChip agentKey={agentKey} />
        {cost && (
          <Tooltip content={<CostTooltip cost={cost} />}>
            <span tabIndex={0} className="focus-ring shrink-0 rounded-full px-2 py-1 font-display text-sm font-bold text-ink-2 tabular">
              <NumberTicker value={cost.usd} format={formatUsd} />
            </span>
          </Tooltip>
        )}
        {!compact && (
          <Tooltip content="Focus mode" shortcut="F">
            <Button size="sm" variant="ghost" icon={<Focus />} onClick={() => useUi.getState().setFocusMode(true)} aria-label="Focus mode" />
          </Tooltip>
        )}
        <Tooltip content="Open terminal in split" shortcut="Ctrl \">
          <Button size="sm" variant="ghost" icon={<SquareTerminal />} onClick={() => useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent.paneId })} aria-label="Open terminal in split" />
        </Tooltip>
        {working && live && (
          <Button
            size="sm"
            variant="danger"
            icon={<Square className="fill-current" />}
            onClick={() => void hostCall(hostId, "agent.abort", { agentId }, { failure: "Stop failed" })}
            trailing={<Kbd className="hidden @min-[40rem]/hdr:inline-flex">Esc</Kbd>}
            className="shrink-0"
          >
            Stop
          </Button>
        )}
      </div>
      {live && (
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar">
            <ModelPicker agentKey={agentKey} />
            <ThinkingPicker agentKey={agentKey} />
            <PlanToggle agentKey={agentKey} compact={compact} />
            <FastToggle agentKey={agentKey} compact={compact} />
            <GoalChip agentKey={agentKey} compact={compact} />
          </div>
          <ActionsMenu agentKey={agentKey} />
        </div>
      )}
    </header>
  );
}
