import { Hand, Hourglass, RotateCw } from "lucide-react";
import { useAgent } from "@/core";
import type { AutoResume } from "@/core/gen";
import { cn, Tooltip, useNow } from "@/design";
import { badgeText, stripWords, ticketTickMs } from "@/features/session/resume/words";

/**
 * Auto-resume chip on board cards and phone rows, every lane (`Agent.autoResume`): "Limit · ~03:00",
 * "Limit · checking", "Resuming…", "Resume by hand", "Continuing soon". An ended card (`Parked.ended`)
 * shows its ticket in its `EndedChip` instead. Static styles; the minute clock (seconds while a restart
 * counts down, for the tooltip's countdown).
 */
export function AutoResumeBadge({ agentKey, className }: { agentKey: string; className?: string }) {
  const agent = useAgent(agentKey);
  return agent?.autoResume && !agent.parked?.ended ? <Chip ar={agent.autoResume} className={className} /> : null;
}

function Chip({ ar, className }: { ar: AutoResume; className?: string }) {
  const now = useNow(ticketTickMs(ar));
  const w = stripWords(ar, now);
  const Icon = w.tone === "manual" ? Hand : w.tone === "busy" ? RotateCw : Hourglass;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          <b>{w.text}</b>
          {w.detail.map((line, i) => (
            <span key={i} className="font-normal text-mute">
              {line}
            </span>
          ))}
        </span>
      }
    >
      <span
        data-testid="auto-resume-badge"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-bold whitespace-nowrap",
          w.tone === "busy" ? "bg-white/6 text-mute" : "bg-warn/12 text-warn",
          className,
        )}
      >
        <Icon className="size-2.5" aria-hidden />
        {badgeText(ar, now)}
      </span>
    </Tooltip>
  );
}
