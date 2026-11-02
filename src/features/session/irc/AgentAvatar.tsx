import { User } from "lucide-react";
import { AgentGlyph } from "@/design";
import { SUB_STATUS } from "../subagents/Subagents";
import type { ChatAgent } from "./chat";

/**
 * A board participant's mark: the agent's glyph (a subagent's status in the corner from 24 px), or You.
 * The glyph takes the short name: a nested subagent's dotted id would give every agent under the
 * same parent the same initials (`PoolBench.Sweep`, `PoolBench.Summary`: "PS").
 */
export function AgentAvatar({ who, size }: { who: ChatAgent; size: number }) {
  if (who.kind === "user") {
    return (
      <span
        className="grid shrink-0 place-items-center bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
        style={{ width: size, height: size, borderRadius: size * 0.32 }}
        role="img"
        aria-label="You"
      >
        <User style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }
  return <AgentGlyph name={who.label} size={size} status={who.sub && size >= 24 ? SUB_STATUS[who.sub.status] : undefined} />;
}
