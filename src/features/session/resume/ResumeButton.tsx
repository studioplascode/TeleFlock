import { RotateCw } from "lucide-react";
import { parseAgentKey, useAgent, useCore } from "@/core";
import { lastTurnRetryable } from "@/core/retryable";
import { Button, Tooltip } from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { retryTurn, useResumePending } from "./actions";

/** The session's last loaded turn failed or was stopped; re-renders only when that flips. */
export function useLastTurnRetryable(key: string): boolean {
  return useCore((s) => {
    const e = s.sessions[key];
    return e != null && lastTurnRetryable(e.itemIds.length, (i) => e.items[e.itemIds[i] ?? ""]);
  });
}

/**
 * "Resume" in the session header (desktop and phone): omp's F5 for a turn that failed or was stopped,
 * while the agent is idle (not running, nothing asked). An auto-resume ticket offers "Resume now" in
 * its strip instead. `caps.retry` false hides it; older metas without the flag show it.
 */
export function ResumeButton({ agentKey, mobile = false }: { agentKey: string; mobile?: boolean }) {
  const { hostId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const online = useCore((s) => s.status[hostId]?.phase === "online");
  const allowed = useCore((s) => s.sessions[agentKey]?.meta?.caps.retry !== false);
  const retryable = useLastTurnRetryable(agentKey);
  const pending = useResumePending(agentKey);
  if (!agent || !online || agent.omp?.link !== "live" || !allowed) return null;
  if (agent.column === "running" || agent.needs || agent.autoResume || !(retryable || pending)) return null;
  return (
    <Tooltip content={ACTIONS.resumeTurn.description} shortcut={mobile ? undefined : ACTIONS.resumeTurn.shortcut}>
      <Button size="sm" variant="primary" icon={<RotateCw />} loading={pending} onClick={() => void retryTurn(agentKey)} className="shrink-0">
        {ACTIONS.resumeTurn.label}
      </Button>
    </Tooltip>
  );
}
