import { Timer } from "lucide-react";
import { cn, Tooltip } from "@/design";
import { useCountdown } from "./hooks";

/**
 * Decide for me's countdown on a needs-you card (board card, its sunset hero, phone Flock card):
 * "auto-picks in 12:40", "when no app · 12:40 left", "auto-picking…"; the tooltip says what it picks.
 * Nothing without a countdown on the question shown, or once cancelled. Static; the second clock
 * only while it counts down to a deadline (`useCountdown`).
 */
export function CountdownChip({ agentKey, sunset = false, className }: { agentKey: string; sunset?: boolean; className?: string }) {
  const cd = useCountdown(agentKey);
  if (!cd || cd.view.phase === "cancelled") return null;
  return (
    <Tooltip content={cd.view.detail}>
      <span
        data-testid="auto-answer-chip"
        className={cn(
          // block-level and only as wide as its text: it sits on a line of its own in the card's body
          "flex w-fit max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold whitespace-nowrap tabular",
          // the hero card: white on a dark tint, like its state pill
          sunset ? "bg-[rgb(40_0_20/0.28)] text-white" : "bg-sun-1/12 text-sun-1 shadow-[inset_0_0_0_1px_rgb(255_122_24/0.3)]",
          className,
        )}
      >
        <Timer className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{cd.view.compact}</span>
      </span>
    </Tooltip>
  );
}
