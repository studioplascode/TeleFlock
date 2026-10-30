import { Timer, TimerOff } from "lucide-react";
import { useCore } from "@/core";
import { cn, Tooltip } from "@/design";
import { cancelCountdown, postponeCountdown, useAutoAnswerPending } from "./actions";
import { countdownActions } from "./countdownActions";
import type { CountdownView } from "./format";
import { useCountdown } from "./hooks";

export interface AskCountdownProps {
  agentKey: string;
  /** The card's request: the strip shows only for the countdown on this very question. */
  requestId: string;
  /** Phone layout: the buttons wrap under the text and stand 32 px tall. */
  compact?: boolean;
}

/**
 * Decide for me on the sunset ask card (desktop and phone): one line saying what it picks and when
 * ("auto-picks ★ Use SQLite in 12:40", "… when no app is connected · 25:00 left") with Cancel, +10 min
 * and +1 h; once cancelled "Won't auto-pick this question" with Restart (the policy's whole wait); no
 * buttons while it picks. The buttons are off while a call is on its way and handle no keys: 1–9 and
 * Enter stay the card's. Static; the second clock only while it counts down (`useCountdown`).
 */
export function AskCountdown({ agentKey, requestId, compact = false }: AskCountdownProps) {
  const cd = useCountdown(agentKey);
  if (!cd || cd.countdown.requestId !== requestId) return null;
  return <Strip agentKey={agentKey} requestId={requestId} view={cd.view} compact={compact} />;
}

function Strip({ agentKey, requestId, view, compact }: { agentKey: string; requestId: string; view: CountdownView; compact: boolean }) {
  const afterSecs = useCore((s) => s.agents[agentKey]?.autoAnswer?.policy.afterSecs);
  const pending = useAutoAnswerPending(agentKey);
  const actions = countdownActions(view.phase, afterSecs);
  const Icon = view.phase === "cancelled" ? TimerOff : Timer;
  return (
    <div
      role="group"
      aria-label="Decide for me"
      aria-busy={pending || undefined}
      data-testid="auto-answer-countdown"
      className={cn("relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[16px] bg-black/20 py-1.5 pr-1.5 pl-3 text-xs font-bold", compact ? "mt-2" : "mt-2.5")}
    >
      <Tooltip content={view.detail}>
        {/* as tall as the buttons, so the strip keeps its height when they go */}
        <span tabIndex={0} className={cn("focus-ring flex min-w-0 flex-[1_1_12rem] items-center gap-1.5 rounded-xs tabular", compact ? "min-h-8" : "min-h-7")}>
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{view.text}</span>
        </span>
      </Tooltip>
      {actions.length > 0 && (
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {actions.map((a) => (
            <button
              key={a.kind === "cancel" ? a.kind : `${a.kind}-${a.secs}`}
              type="button"
              disabled={pending}
              title={a.title}
              onClick={() => void (a.kind === "cancel" ? cancelCountdown(agentKey, requestId) : postponeCountdown(agentKey, requestId, a.secs))}
              className={cn(
                "pressable focus-ring relative inline-flex touch-hit items-center rounded-full bg-white/15 px-3 whitespace-nowrap hover:bg-white/25 disabled:opacity-60",
                compact ? "h-8" : "h-7",
              )}
            >
              {a.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
