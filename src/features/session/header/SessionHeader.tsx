import { BellOff, Focus, GitBranch, Square, SquareTerminal } from "lucide-react";
import type { Agent } from "@/core/gen";
import { parseAgentKey, useAgent, useCore, useSession, useUi } from "@/core";
import { AgentGlyph, Button, cn, Elapsed, formatUsd, Heartbeat, Kbd, NumberTicker, StatusPill, Swarm, Tooltip, useActivity, useNow } from "@/design";
import { Term } from "@/features/shell/Term";
import { openTerminal } from "@/features/board/agentActions";
import { ACTIONS, agentStateWord, stateTime } from "@/features/shell/vocab";
import { agentStatus, hostCall, useBeat, useMute } from "../api";
import { CostTooltip } from "../spend";
import { ActionsMenu, FastToggle, GoalChip, ModelPicker, PlanToggle, ThinkingPicker } from "./Controls";
import { LimitsChip } from "./LimitsChip";

/** The header pill's words: the state ("Question", "Running", "To review"), plus the wait while it needs you. */
export function StateWord({ agent }: { agent: Agent }) {
  const now = useNow(agent.needs ? 1000 : 60_000);
  const wait = agent.needs ? stateTime("needs", agent.needs.since, now) : null;
  return (
    <>
      {agentStateWord(agent)}
      {wait && <span className="font-semibold opacity-85"> · {wait}</span>}
    </>
  );
}

/**
 * Desktop session header: identity, liveness, and every mode control. `inspector`: the inspector
 * rail is on screen beside it, so the session cost lives there instead of here.
 */
export function SessionHeader({ agentKey, compact = false, inspector = false }: { agentKey: string; compact?: boolean; inspector?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const beat = useBeat(agentKey);
  const { tier } = useActivity(beat);
  const status = agentStatus(agent);
  const { muted } = useMute(agentKey);
  const online = useCore((s) => s.status[hostId]?.phase === "online");
  if (!agent) return null;
  // Controls need the host (offline, the session is the copy saved on this device).
  const live = agent.omp?.link === "live" && online;
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
              <StateWord agent={agent} />
            </StatusPill>
            {muted && (
              <Tooltip content="Notifications muted for this agent">
                <BellOff tabIndex={0} className="focus-ring size-3.5 shrink-0 rounded-xs text-mute" aria-label="Notifications muted" />
              </Tooltip>
            )}
            {working && (
              <span className="hidden shrink-0 items-center gap-1 text-[11px] font-bold text-mute tabular @min-[14rem]/id:flex">
                turn <Elapsed since={agent.omp?.turnStartedAt ?? agent.stateSince} />
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
            {agent.paneId && (
              <Term id="pane" className="shrink-0 text-mute-2">
                pane {agent.paneId}
              </Term>
            )}
          </div>
        </div>
        {!compact && (
          <div className="hidden w-[112px] shrink-0 @min-[36rem]/hdr:block">
            <Heartbeat beat={beat} lastEventAt={agent.live.lastEventAt} status={status} height={26} />
          </div>
        )}
        {cost && !inspector && (
          <Tooltip content={<CostTooltip cost={cost} />}>
            <span tabIndex={0} className="focus-ring flex shrink-0 items-baseline gap-1 rounded-full px-2 py-1 font-display text-sm font-bold text-ink-2 tabular">
              <NumberTicker value={cost.usd} format={formatUsd} />
              <span className="font-sans text-[11px] font-semibold text-mute">session</span>
            </span>
          </Tooltip>
        )}
        {!compact && (
          <Tooltip content={ACTIONS.focusMode.description} shortcut={ACTIONS.focusMode.shortcut}>
            <Button size="sm" variant="ghost" icon={<Focus />} onClick={() => useUi.getState().setFocusMode(true)} aria-label={ACTIONS.focusMode.label} className="shrink-0">
              <span className="hidden @min-[46rem]/hdr:inline">Focus</span>
            </Button>
          </Tooltip>
        )}
        <Tooltip content={ACTIONS.terminalBeside.description} shortcut={ACTIONS.terminalBeside.shortcut}>
          <Button
            size="sm"
            variant="ghost"
            icon={<SquareTerminal />}
            // a parked agent resumes first, then its new pane opens beside
            onClick={() => (agent.parked ? openTerminal(agent.key, false) : useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent.paneId }))}
            aria-label={ACTIONS.terminalBeside.label}
            className="shrink-0"
          >
            <span className={cn("hidden", !compact && "@min-[46rem]/hdr:inline")}>{ACTIONS.terminal.label}</span>
          </Button>
        </Tooltip>
        {working && live && (
          <Tooltip content={ACTIONS.stopTurn.description} shortcut={ACTIONS.stopTurn.shortcut}>
            <Button
              size="sm"
              variant="danger"
              icon={<Square className="fill-current" />}
              onClick={() => void hostCall(hostId, "agent.abort", { agentId }, { success: "Turn stopped", failure: "Stop failed" })}
              trailing={<Kbd className="hidden @min-[40rem]/hdr:inline-flex">Esc</Kbd>}
              className="shrink-0"
            >
              {ACTIONS.stopTurn.label}
            </Button>
          </Tooltip>
        )}
      </div>
      {live && (
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar">
            <ModelPicker agentKey={agentKey} />
            <ThinkingPicker agentKey={agentKey} />
            <span className="mx-0.5 h-4 w-px shrink-0 bg-line-2" aria-hidden />
            <PlanToggle agentKey={agentKey} compact={compact} />
            <FastToggle agentKey={agentKey} compact={compact} />
            <GoalChip agentKey={agentKey} compact={compact} />
          </div>
          <LimitsChip agentKey={agentKey} />
          <ActionsMenu agentKey={agentKey} />
        </div>
      )}
    </header>
  );
}
