import { Users } from "lucide-react";
import { useMemo } from "react";
import type { Subagent } from "@/core/gen";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, EmptyState, formatAge, StatusOrb, useNow } from "@/design";
import { SUB_LABEL, SUB_STATUS } from "../subagents/Subagents";
import { AgentAvatar } from "./AgentAvatar";
import { AgentMenuItems } from "./AgentMenu";
import { type BoardMessage, type Participant, roleText } from "./chat";
import type { ChatGraph } from "./graph";

/**
 * The board's Members tab: everyone who sent or got a message, in the board's order (the main
 * agent, the subagents in tree order, You last), with where each sits, its status, how many
 * messages it sent and got (and broadcast) and when it last wrote or was written to. A row opens
 * the menu its name has on the board.
 */
export function BoardMembers({
  agentKey,
  mobile,
  people,
  graph,
  byId,
  onFilter,
  onMessage,
}: {
  agentKey: string;
  mobile: boolean;
  people: readonly Participant[];
  graph: ChatGraph;
  byId: ReadonlyMap<string, BoardMessage>;
  onFilter: (id: string) => void;
  onMessage: (sub: Subagent) => void;
}) {
  const now = useNow(30_000);
  const stats = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  if (people.length === 0) {
    return <EmptyState className="mt-10" compact icon={<Users />} title="No members yet" description="An agent joins the board with the first message it sends or gets." />;
  }
  return (
    <ul className={cn("min-h-0 flex-1 overflow-y-auto", mobile ? "p-1.5" : "p-2")} aria-label="Members">
      {people.map(({ agent: a }) => {
        const s = stats.get(a.id);
        const last = s?.last === undefined ? undefined : byId.get(s.last);
        return (
          <li key={a.id}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-[14px] px-2 py-2 text-left hover:bg-ink/[0.04] data-[state=open]:bg-ink/[0.05]">
                  <AgentAvatar who={a} size={mobile ? 28 : 30} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[13px] font-extrabold text-ink">{a.label}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-mute-2">
                      {a.sub && (
                        <>
                          <StatusOrb status={SUB_STATUS[a.sub.status]} size={6} label={null} />
                          <span className="shrink-0">{SUB_LABEL[a.sub.status]} ·</span>
                        </>
                      )}
                      <span className="min-w-0 truncate">{roleText(a)}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] font-semibold text-mute-2 tabular">
                    <span>
                      <b className="font-bold text-ink-2">{s?.sent ?? 0}</b> sent · <b className="font-bold text-ink-2">{s?.got ?? 0}</b> got
                      {s && s.broadcasts > 0 && <> · @all {s.broadcasts}</>}
                    </span>
                    {last && <span>{formatAge(now - last.at)}</span>}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <AgentMenuItems who={a} agentKey={agentKey} onFilter={onFilter} onMessage={onMessage} />
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}
