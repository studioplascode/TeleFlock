import { SquareTerminal } from "lucide-react";
import type { NeedsYou } from "@/core/gen";
import { cn, Elapsed } from "@/design";
import { openTerminal } from "@/features/board/agentActions";
import { Ticks } from "@/features/shell/Ticks";
import { NEEDS_WORD } from "@/features/shell/vocab";

/**
 * The wait the session shows in its own card: the agent needs the user, only its terminal can answer
 * (`answerable` false), and no dialog of it is open in the session (an open one is the ask card).
 */
export function terminalWait(needs: NeedsYou | undefined, dialogOpen: boolean): NeedsYou | null {
  return needs && !needs.answerable && !dialogOpen ? needs : null;
}

/**
 * A wait only the agent's terminal can answer (an omp prompt the host can't bring here, herdr's
 * `blocked`): what it asks, and Answer in terminal (desktop: the terminal beside the session; phone:
 * the terminal view), as the board, Inbox and Answer-next HUD offer it.
 */
export function TerminalWaitCard({ agentKey, needs, mobile }: { agentKey: string; needs: NeedsYou; mobile: boolean }) {
  const title = needs.title || NEEDS_WORD[needs.kind];
  return (
    <section aria-label={title} data-status="needs-you" className={cn("relative st-soft st-ring", mobile ? "rounded-[22px] px-3.5 pt-3 pb-3.5" : "rounded-tile px-5 pt-4 pb-4")}>
      <div className="flex items-center gap-2 text-[11px] font-extrabold tracking-wide">
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0 font-semibold opacity-80">
          · <Elapsed since={needs.since} />
        </span>
      </div>
      <h3 className={cn("mt-1.5 font-display leading-snug font-bold text-balance text-ink", mobile ? "text-[17px]" : "text-xl")}>
        <Ticks text={needs.question} className="text-[0.85em]" />
      </h3>
      {needs.detail && (
        <p className="mt-1 text-[13px] leading-[1.5] whitespace-pre-wrap text-ink-2">
          <Ticks text={needs.detail} className="text-[0.88em]" />
        </p>
      )}
      <button
        type="button"
        onClick={() => openTerminal(agentKey, mobile)}
        className={cn(
          "pressable focus-ring mt-3 flex items-center justify-center gap-2 rounded-full bg-sun font-extrabold text-on-sun shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-sun)]",
          mobile ? "h-11 w-full text-sm" : "h-9 px-4 text-xs",
        )}
      >
        <SquareTerminal className="size-4" aria-hidden />
        Answer in terminal
      </button>
    </section>
  );
}
