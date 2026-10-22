import { Minimize2 } from "lucide-react";
import { useAgent, useUi } from "@/core";
import { AgentGlyph, Badge, Heartbeat, IconButton, Kbd, StatusOrb, useActivity } from "@/design";
import { agentStatus, useBeat } from "../api";
import { StateWord } from "./SessionHeader";

/** Focus mode's minimal header: glyph, name, liveness heartbeat, needs-you badge, exit. */
export function FocusHeader({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const beat = useBeat(agentKey);
  const { tier } = useActivity(beat);
  const status = agentStatus(agent);
  if (!agent) return null;
  return (
    <header data-status={status} className="flex items-center gap-3 px-2 py-1">
      <span data-morph="glyph" data-morph-key={agent.key}>
        <AgentGlyph name={agent.name} size={30} status={status} />
      </span>
      <h2 data-morph="name" data-morph-key={agent.key} className="truncate font-display text-lg font-bold tracking-[-0.02em] text-ink">
        {agent.name}
      </h2>
      <StatusOrb status={status} activity={tier} size={8} />
      {agent.needs && (
        <Badge tone="needs-you">
          <StateWord agent={agent} />
        </Badge>
      )}
      <div className="ml-auto w-[160px] shrink-0 opacity-80">
        <Heartbeat beat={beat} lastEventAt={agent.live.lastEventAt} status={status} height={22} />
      </div>
      <span className="hidden items-center gap-1 text-2xs font-semibold text-mute-2 lg:flex">
        <Kbd>Esc</Kbd> exit
      </span>
      <IconButton label="Exit focus mode (Esc)" size="sm" onClick={() => useUi.getState().setFocusMode(false)}>
        <Minimize2 />
      </IconButton>
    </header>
  );
}
