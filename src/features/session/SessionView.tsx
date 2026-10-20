import { agentKey, useAgent } from "@/core";
import { useIsMobile } from "@/design";
import { Inspector } from "./inspector/Inspector";
import { MobileSession } from "./mobile/MobileSession";
import { SessionPane } from "./SessionPane";

/**
 * Route view for `#/agent/:hostId/:agentId`. Desktop: session + inspector rail.
 * Phone: full-screen pager between agents with an inspector sheet.
 */
export function SessionView({ hostId, agentId }: { hostId: string; agentId: string }) {
  const mobile = useIsMobile();
  const key = agentKey(hostId, agentId);
  const agent = useAgent(key);
  if (mobile) return <MobileSession hostId={hostId} agentId={agentId} />;
  const rail = agent?.omp?.link === "live";
  return (
    <div className="relative flex h-full min-h-0 gap-5 p-4 pt-3">
      <SessionPane key={key} agentKey={key} />
      {rail && <Inspector agentKey={key} className="w-[336px] shrink-0" />}
    </div>
  );
}
