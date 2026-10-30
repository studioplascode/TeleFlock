import { Hand, Hourglass, PowerOff, RotateCw } from "lucide-react";
import { parseAgentKey, useResuming } from "@/core";
import type { AgentEnded, AutoResume } from "@/core/gen";
import { cn, Shimmer, Tooltip, useNow } from "@/design";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { badgeText, endedWords, stripWords, ticketTickMs } from "@/features/session/resume/words";

const base = "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-bold whitespace-nowrap";

/**
 * The one chip of an ended card (`Parked.ended`, §3.25: its omp ended without anyone closing it), board and
 * phone rows, in place of "closed" and of the auto-resume badge: "ended 13:58"; with its `restart` ticket
 * "coming back" / "coming back…", and "ended 13:58" (Hand, warn) while it waits for Continue. The tooltip
 * says why it ended and what it was doing, the ticket's line ("Bringing it back in 0:05"), or, while herdr is
 * down and there is no ticket, that it comes back once herdr runs again. Static; the minute clock (seconds
 * while the ticket counts down, for the tooltip).
 */
export function EndedChip({ agentKey, ended, ar, className }: { agentKey: string; ended: AgentEnded; ar?: AutoResume; className?: string }) {
  const herdr = useHerdrDown(parseAgentKey(agentKey).hostId);
  const resuming = useResuming(agentKey);
  const now = useNow(ar ? ticketTickMs(ar) : 60_000);
  if (resuming) {
    return (
      <span className={cn(base, "bg-white/6 text-mute-2", className)}>
        <Shimmer>resuming…</Shimmer>
      </span>
    );
  }
  const w = ar ? stripWords(ar, now, { ended }) : undefined;
  const e = endedWords(ended, now, { herdrDown: herdr !== undefined });
  const Icon = !w ? PowerOff : w.tone === "manual" ? Hand : w.tone === "busy" ? RotateCw : Hourglass;
  const lines = w ? w.detail : e.detail;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          <b>{w ? w.text : e.text}</b>
          {lines.map((line, i) => (
            <span key={i} className="font-normal text-mute">
              {line}
            </span>
          ))}
        </span>
      }
    >
      <span data-testid="ended-chip" className={cn(base, w && w.tone !== "busy" ? "bg-warn/12 text-warn" : "bg-white/6 text-mute-2", className)}>
        <Icon className="size-2.5" aria-hidden />
        {ar ? badgeText(ar, now, { ended }) : e.chip}
      </span>
    </Tooltip>
  );
}
