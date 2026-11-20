import { ExternalLink, ListFilter, Send } from "lucide-react";
import type { Subagent } from "@/core/gen";
import { DropdownMenuItem } from "@/design";
import { useSessionUi } from "../state";
import { SUB_LABEL } from "../subagents/Subagents";
import type { ChatAgent } from "./chat";

/** A board agent's menu (its name on a row, its row under Members): only its messages; a subagent also opens, or takes a message. */
export function AgentMenuItems({ who, agentKey, onFilter, onMessage }: { who: ChatAgent; agentKey: string; onFilter: (id: string) => void; onMessage: (sub: Subagent) => void }) {
  const sub = who.sub;
  return (
    <>
      <DropdownMenuItem icon={<ListFilter />} onSelect={() => onFilter(who.id)}>
        Only {who.kind === "user" ? "your" : `${who.label}'s`} messages
      </DropdownMenuItem>
      {sub && (
        <>
          <DropdownMenuItem icon={<ExternalLink />} onSelect={() => useSessionUi.getState().openSubagent(agentKey, sub.id)}>
            Open {who.label} · {SUB_LABEL[sub.status]}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Send />} onSelect={() => onMessage(sub)}>
            Message {who.label}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
