import { ChevronRight } from "lucide-react";
import { useId } from "react";
import type { Subagent } from "@/core/gen";
import { cn } from "@/design";
import { useSessionUi } from "../state";
import { completedSummary, groupSubagents } from "./grouping";
import { SubagentCard } from "./Subagents";

/**
 * The session's subagents as the Subagents panel shows them (sidebar and the phone's Agents tab):
 * running and failed ones always visible, the finished ones collected into a collapsed
 * "N completed" group. The group stays as the user left it for the session while the app runs.
 */
export function SubagentList({ agentKey, subs }: { agentKey: string; subs: readonly Subagent[] }) {
  const open = useSessionUi((s) => s.completedSubsOpen[agentKey] ?? false);
  const panelId = useId();
  const g = groupSubagents(subs);
  const card = (s: Subagent) => <SubagentCard key={s.id} sub={s} dense onOpen={() => useSessionUi.getState().openSubagent(agentKey, s.id)} />;
  return (
    <div className="flex flex-col gap-1">
      {g.active.map(card)}
      {g.completed.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => useSessionUi.getState().setCompletedSubsOpen(agentKey, !open)}
            className={cn("focus-ring pressable flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]", g.active.length > 0 && "mt-0.5")}
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-mute transition-transform", open && "rotate-90")} aria-hidden />
            <b className="shrink-0 text-[12.5px] font-extrabold text-ink">{g.completed.length} completed</b>
            <span className="min-w-0 truncate text-2xs font-bold text-mute tabular">{completedSummary(g)}</span>
          </button>
          {open && (
            <div id={panelId} className="flex flex-col gap-1 border-l border-white/[0.06] pl-2">
              {g.completed.map(card)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
