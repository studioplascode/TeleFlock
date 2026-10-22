import { Brain, MessageSquareDashed, Sparkles } from "lucide-react";
import { drafts, useAgent, useSession } from "@/core";
import { EmptyState } from "@/design";
import { Term } from "@/features/shell/Term";
import { isFresh } from "@/features/shell/vocab";
import { composerDraftKey, useSessionUi } from "../state";

const STARTERS = ["Explain this repository", "Find a failing test and fix it", "Review my uncommitted changes"] as const;

/**
 * The empty transcript. A fresh agent (never prompted) gets starter prompts that fill the composer
 * (never send) and a one-line legend of the header chips.
 */
export function EmptyTranscript({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  if (!agent || !isFresh(agent))
    return <EmptyState className="mt-16" icon={<MessageSquareDashed />} title="No messages yet" description="Send a prompt to get this agent going." />;
  const model = meta?.model ?? agent.omp?.model;
  const thinking = meta?.thinking ?? agent.omp?.thinking;
  return (
    <div className="mx-auto mt-12 flex max-w-[560px] flex-col items-center gap-4 px-4 text-center">
      <div>
        <div className="font-display text-xl font-bold text-ink">Waiting for its first prompt</div>
        <div className="mt-1 text-sm text-mute">Type below, or start from one of these. They fill the box; nothing is sent until you press Enter.</div>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              drafts.set(composerDraftKey(agentKey), s);
              useSessionUi.getState().focusComposer(agentKey);
            }}
            className="pressable focus-ring rounded-full bg-white/[0.05] px-3.5 py-2 text-[13px] font-semibold text-ink-2 shadow-hairline hover:bg-white/[0.09] hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-mute">
        <span className="inline-flex items-center gap-1">
          <Sparkles className="size-3 text-accent-hi" />
          {model ? (model.label ?? model.id) : "model"} = model
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1">
          <Brain className="size-3 text-omp-blue" />
          {thinking ?? "high"} = <Term id="thinking">thinking effort</Term>
        </span>
        <span aria-hidden>·</span>
        <span>
          <Term id="plan">Plan</Term> = plan before editing
        </span>
        <span aria-hidden>·</span>
        <span>
          <Term id="fast">Fast</Term> = priority tier
        </span>
        <span aria-hidden>·</span>
        <span>
          <Term id="goal">Goal</Term> = long-running objective
        </span>
      </p>
    </div>
  );
}
