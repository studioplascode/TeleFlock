import { useAgent } from "@/core";
import { AgentGlyph, Elapsed, Shimmer, cn } from "@/design";
import { HostTag } from "@/features/board/AgentCard";
import { NEEDS_LABEL } from "@/features/board/lanes";
import { useLastAssistant } from "./useLastAssistant";

const TAIL_CHARS = 700;

/** Agent identity row for a needs-you item: glyph, name, repo · branch, host, waiting timer. */
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
              {NEEDS_LABEL[agent.needs.kind]}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 font-mono text-2xs text-mute-2">
          <span className="truncate">
            {agent.repo ?? agent.cwd}
            {agent.branch && ` · ${agent.branch}`}
          </span>
          <HostTag hostId={agent.hostId} />
        </div>
      </div>
      {agent.needs && (
        <span className="shrink-0 text-xs font-bold text-[#ffb08a] tabular">
          waiting <Elapsed since={agent.needs.since} />
        </span>
      )}
    </div>
  );
}

/** What the agent said right before asking (tail of its last assistant message). */
export function LastAssistantText({ agentKey, enabled = true, className }: { agentKey: string; enabled?: boolean; className?: string }) {
  const { text, loading } = useLastAssistant(agentKey, enabled);
  if (!text && !loading) return null;
  const tail = text && text.length > TAIL_CHARS ? `…${text.slice(text.length - TAIL_CHARS)}` : text;
  return (
    <div className={cn("relative rounded-md well px-3.5 py-2.5", className)}>
      <span className="kicker">Agent said</span>
      {tail ? (
        <p className="mt-1 max-h-40 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap text-ink-2">{tail}</p>
      ) : (
        <p className="mt-1 text-sm">
          <Shimmer>Loading the conversation…</Shimmer>
        </p>
      )}
    </div>
  );
}

/** The question itself, with option descriptions and any command under approval. */
export function NeedsQuestion({ agentKey, className }: { agentKey: string; className?: string }) {
  const n = useAgent(agentKey)?.needs;
  if (!n) return null;
  const described = n.options.filter((o) => o.description);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {n.title && n.question && n.title !== n.question && <span className="text-xs font-bold text-mute">{n.title}</span>}
      <p className="font-display text-xl leading-snug font-bold text-ink">{n.question || n.title}</p>
      {n.detail && <p className="text-sm whitespace-pre-wrap text-ink-2">{n.detail}</p>}
      {n.command && <pre className="overflow-x-auto rounded-md well px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink">{n.command}</pre>}
      {described.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-mute">
          {described.map((o) => (
            <li key={o.id}>
              <b className="text-ink-2">{o.label}</b> — {o.description}
            </li>
          ))}
        </ul>
      )}
      {!n.answerable && <p className="text-xs font-semibold text-warn">This prompt can only be answered in the terminal.</p>}
    </div>
  );
}
