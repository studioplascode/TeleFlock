import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { parseAgentKey } from "@/core";
import type { Subagent } from "@/core/gen";
import { cn } from "@/design";
import { sessionScope, type SubMarks, subMarksOf, useInspectorCards } from "../inspector/cards";
import { useSessionUi } from "../state";
import { completedSummary, groupSubagents, opensByDefault, type SubagentNode, tallyTotal } from "./grouping";
import { RollupText, SubagentCard } from "./Subagents";

/**
 * The session's subagents as the Subagents panel shows them (sidebar and the phone's Agents tab): a
 * tree (`groupSubagents`), each subagent's own subagents under it on a rail behind a roll-up line
 * ("3 subagents · 2 running · 1 failed") that folds them. A branch is open while anything below it
 * runs or failed, else folded; what the user picks sticks per session on this device
 * (`tf.inspector`). Branches with anything running or failed are always visible; branches that
 * finished entirely collect in a collapsed "N completed" group, which stays as the user left it for
 * the session while the app runs.
 */
export function SubagentList({ agentKey, sessionId, subs }: { agentKey: string; sessionId?: string; subs: readonly Subagent[] }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const scope = sessionScope(hostId, agentId, sessionId);
  const marks = useInspectorCards((st) => subMarksOf(st.subs, scope));
  const open = useSessionUi((s) => s.completedSubsOpen[agentKey] ?? false);
  const panelId = useId();
  const g = groupSubagents(subs);
  const branch = (n: SubagentNode) => <SubagentBranch key={n.sub.id} node={n} agentKey={agentKey} scope={scope} marks={marks} />;
  return (
    <div className="flex flex-col gap-1">
      {g.active.map(branch)}
      {g.completed.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => useSessionUi.getState().setCompletedSubsOpen(agentKey, !open)}
            className={cn("focus-ring pressable flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-ink/[0.04]", g.active.length > 0 && "mt-0.5")}
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-mute transition-transform", open && "rotate-90")} aria-hidden />
            <b className="shrink-0 text-[12.5px] font-extrabold text-ink">{tallyTotal(g.completedTally)} completed</b>
            <span className="min-w-0 truncate text-2xs font-bold text-mute tabular">{completedSummary(g.completedTally)}</span>
          </button>
          {open && (
            <div id={panelId} className="flex flex-col gap-1 border-l border-ink/[0.06] pl-2">
              {g.completed.map(branch)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A subagent's row; when it has subagents, its roll-up line on a rail under it and, unfolded, its subagents. */
function SubagentBranch({ node, agentKey, scope, marks }: { node: SubagentNode; agentKey: string; scope: string; marks: SubMarks }) {
  const id = node.sub.id;
  const childrenId = useId();
  const open = marks.open.includes(id) || (!marks.closed.includes(id) && opensByDefault(node));
  return (
    <div className="flex min-w-0 flex-col">
      <SubagentCard sub={node.sub} label={node.label} note={node.orphanOf && `from ${node.orphanOf}`} dense onOpen={() => useSessionUi.getState().openSubagent(agentKey, id)} />
      {node.children.length > 0 && (
        // The rail starts under the row's status orb.
        <div className="ml-3 flex min-w-0 flex-col gap-1 border-l border-ink/[0.08] pl-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={childrenId}
            onClick={() => useInspectorCards.getState().markSub(scope, id, !open)}
            className="focus-ring pressable flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-ink/[0.04]"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-mute transition-transform", open && "rotate-90")} aria-hidden />
            <RollupText tally={node.below} className="min-w-0 truncate text-2xs font-bold text-mute" />
          </button>
          {open && (
            <div id={childrenId} role="group" aria-label={`Subagents of ${node.sub.name}`} className="flex min-w-0 flex-col gap-1">
              {node.children.map((c) => (
                <SubagentBranch key={c.sub.id} node={c} agentKey={agentKey} scope={scope} marks={marks} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
