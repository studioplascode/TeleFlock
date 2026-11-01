import { useAgent } from "@/core";
import { AgentGlyph, Elapsed, Shimmer, cn } from "@/design";
import { HostTag } from "@/features/board/AgentCard";
import { RepoTag } from "@/features/board/RepoTag";
import { AgentSaid } from "@/features/session/ask/AgentSaid";
import { clipContext, withoutQuestion } from "@/features/session/ask/askContext";
import { NEEDS_WORD } from "@/features/shell/vocab";
import { askText } from "./askText";
import { useLastAssistant } from "./useLastAssistant";

/** Agent identity row for a needs-you item: glyph, name, repo chip · branch, host, waiting timer. */
export function NeedsHeader({ agentKey, className }: { agentKey: string; className?: string }) {
  const agent = useAgent(agentKey);
  if (!agent) return null;
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <AgentGlyph name={agent.name} size={30} status="needs-you" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-extrabold text-ink">{agent.name}</span>
          {agent.needs && (
            <span data-status="needs-you" className="rounded-full st-bg px-2 py-px font-display text-[9.5px] font-bold tracking-[0.12em] uppercase">
              {NEEDS_WORD[agent.needs.kind]}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} />
          <HostTag hostId={agent.hostId} />
        </div>
      </div>
      {agent.needs && (
        <span className="shrink-0 text-xs font-bold text-sun-ink tabular">
          waiting <Elapsed since={agent.needs.since} />
        </span>
      )}
    </div>
  );
}

/**
 * What the agent said right before asking, without the question itself: the host's `needs.context`
 * when it sends one (asks, hosts ≥ 0.8.0; empty = it wrote nothing; the session stays closed), else
 * the end of its last assistant message from the transcript (held open while this is shown).
 */
export function LastAssistantText({ agentKey, enabled = true, className }: { agentKey: string; enabled?: boolean; className?: string }) {
  const needs = useAgent(agentKey)?.needs;
  const context = needs?.context;
  const { text, loading } = useLastAssistant(agentKey, enabled && context === undefined);
  const question = needs ? askText({ title: needs.title, message: needs.question, command: needs.command, approval: needs.kind === "approval" }).headline : "";
  const said = withoutQuestion(context ?? clipContext(text ?? ""), question);
  if (said) return <AgentSaid key={needs?.requestId} text={said} variant="panel" className={className} />;
  if (context !== undefined || text || !loading) return null;
  return (
    <div className={cn("relative rounded-md well px-3.5 py-2.5 max-md:px-3 max-md:py-2", className)}>
      <span className="kicker">Agent said</span>
      <p className="mt-1 text-sm">
        <Shimmer>Loading the conversation…</Shimmer>
      </p>
    </div>
  );
}

/** The question itself and any command under approval (option descriptions live in the option buttons). */
export function NeedsQuestion({ agentKey, className }: { agentKey: string; className?: string }) {
  const n = useAgent(agentKey)?.needs;
  if (!n) return null;
  const { headline, body } = askText({ title: n.title, message: n.question, command: n.command, approval: n.kind === "approval" });
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {headline && <p className="font-display text-xl leading-snug font-bold text-ink max-md:text-lg">{headline}</p>}
      {body && <p className="text-sm whitespace-pre-wrap text-ink-2">{body}</p>}
      {n.detail && <p className="text-sm whitespace-pre-wrap text-ink-2">{n.detail}</p>}
      {n.command && <pre className="overflow-x-auto rounded-md well px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink">{n.command}</pre>}
      {!n.answerable && <p className="text-xs font-semibold text-warn">This prompt can only be answered in the terminal.</p>}
    </div>
  );
}
