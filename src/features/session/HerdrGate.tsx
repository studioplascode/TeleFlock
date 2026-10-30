import { Power, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { parseAgentKey, useSession, useUi } from "@/core";
import type { HerdrHealth } from "@/core/gen";
import { Button, EmptyState } from "@/design";
import { HerdrStatusText, RestartHerdrButton } from "@/features/hosts/HerdrControls";
import { herdrAgentLine } from "@/features/hosts/herdrHealth";

/**
 * An agent shown while its host's herdr server is not up: the reason is herdr, not omp's collab room.
 * With a transcript the session stays readable under a strip (what happened, what TeleFlock does,
 * Restart herdr); without one the strip is the whole view. Nothing here says the agent is running.
 */
export function HerdrGate({ agentKey, health, children }: { agentKey: string; health: HerdrHealth; children: ReactNode }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const session = useSession(agentKey);
  const line = herdrAgentLine(health);
  const terminal = (
    <Button size="sm" variant="ghost" icon={<SquareTerminal />} onClick={() => useUi.getState().setSplit({ kind: "terminal", hostId, agentId })}>
      Terminal
    </Button>
  );
  if (session.itemIds.length > 0 && session.status !== "error")
    return (
      <>
        {/* max-md:mt-6 keeps the phone pager's floating dots off the first line */}
        <div role="status" data-testid="herdr-gate" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-warn/8 px-4 py-2 text-xs max-md:mt-6 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]">
          <Power className="size-3.5 shrink-0 text-warn" aria-hidden />
          {/* basis, not 0: on a phone the buttons wrap below the text instead of squeezing it into a sliver */}
          <p className="min-w-0 flex-[1_1_16rem] text-mute">
            <b className="text-ink">{line}</b>
            <HerdrStatusText health={health} className="mt-0.5 block" />
          </p>
          <RestartHerdrButton hostId={hostId} health={health} />
          {terminal}
        </div>
        {children}
      </>
    );
  return (
    <EmptyState
      className="flex-1"
      icon={<Power />}
      title="herdr isn't running"
      description={
        <>
          {line}
          <HerdrStatusText health={health} className="mt-2 block text-xs text-mute-2" />
        </>
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <RestartHerdrButton hostId={hostId} health={health} size="md" variant="primary" />
          {terminal}
        </div>
      }
    />
  );
}
