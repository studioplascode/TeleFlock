import { useMemo } from "react";
import { useAgent, useHosts } from "@/core";
import type { HostProfile, ParkedMove } from "@/core/gen";

/** The hosts an agent of `srcHostId` can move to: the other connected ones. */
export function useMoveTargets(srcHostId: string): HostProfile[] {
  const profiles = useHosts((h) => h.profiles);
  const status = useHosts((h) => h.status);
  return useMemo(() => profiles.filter((p) => p.id !== srcHostId && status[p.id]?.phase === "online"), [profiles, status, srcHostId]);
}

/** Whether "Move to host…" is offered: an omp agent, a second connected host, no move running for it. */
export function useCanMove(agentKey: string): boolean {
  const agent = useAgent(agentKey);
  const targets = useMoveTargets(agent?.hostId ?? "");
  return !!agent && agent.kind === "omp" && targets.length > 0 && agent.parked?.moved?.state !== "moving";
}

/** The host a parked agent moved to: by the id the moving app recorded, else by the name. */
export function movedTarget(moved: ParkedMove, profiles: readonly HostProfile[]): HostProfile | undefined {
  return (moved.hostId ? profiles.find((p) => p.id === moved.hostId) : undefined) ?? profiles.find((p) => p.name === moved.to);
}

/** The host of `parked.moved` this app knows (see `movedTarget`). */
export function useMovedTarget(moved: ParkedMove | undefined): HostProfile | undefined {
  const profiles = useHosts((h) => h.profiles);
  return moved ? movedTarget(moved, profiles) : undefined;
}
