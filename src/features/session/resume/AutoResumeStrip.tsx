import { Hand, Hourglass, PowerOff, RotateCw, TimerOff, X } from "lucide-react";
import { useAgent } from "@/core";
import type { AgentEnded, AutoResume } from "@/core/gen";
import { Button, cn, Tooltip, useNow } from "@/design";
import { useHerdrDown } from "@/features/hosts/HerdrControls";
import { cancelAutoResume, resumeNow, useResumePending } from "./actions";
import { endedWords, stripWords, ticketTickMs } from "./words";

const BASE = "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-2.5 py-1.5 text-xs";
const MOBILE = "mx-2 mb-1.5 shrink-0";

/**
 * An agent's auto-resume ticket (`Agent.autoResume`, every kind) under its session header, desktop
 * and phone: what stopped it and when it resumes ("Usage limit · resumes ~03:00", "Bringing it back
 * in 0:05", "Ended: herdr stopped"), with Resume now / Continue and Don't auto-resume / Dismiss. An
 * ended card without a ticket (herdr is down, §3.25) gets a status line instead: "Ended at 13:58
 * (herdr stopped) · comes back when herdr runs again". Static; the minute clock (seconds only for a
 * restart's short countdown).
 */
export function AutoResumeStrip({ agentKey, mobile = false }: { agentKey: string; mobile?: boolean }) {
  const agent = useAgent(agentKey);
  const ended = agent?.parked?.ended;
  if (agent?.autoResume) return <Strip agentKey={agentKey} ar={agent.autoResume} ended={ended} mobile={mobile} />;
  return agent && ended ? <EndedStrip hostId={agent.hostId} ended={ended} mobile={mobile} /> : null;
}

function Detail({ lines }: { lines: string[] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {lines.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </span>
  );
}

function Strip({ agentKey, ar, ended, mobile }: { agentKey: string; ar: AutoResume; ended?: AgentEnded; mobile: boolean }) {
  const now = useNow(ticketTickMs(ar));
  const pending = useResumePending(agentKey);
  const w = stripWords(ar, now, { ended });
  const Icon = w.tone === "manual" ? Hand : w.tone === "busy" ? RotateCw : Hourglass;
  const a = w.actions;
  return (
    <div
      role="status"
      data-testid="auto-resume"
      className={cn(BASE, w.tone === "busy" ? "bg-white/5 text-ink-2" : "bg-warn/10 text-warn shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]", mobile && MOBILE)}
    >
      <Tooltip content={<Detail lines={w.detail} />}>
        <span tabIndex={0} className="focus-ring flex min-w-0 flex-[1_1_12rem] items-center gap-1.5 rounded-xs font-bold">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className={cn("min-w-0", mobile ? "line-clamp-2" : "truncate")}>{w.text}</span>
        </span>
      </Tooltip>
      {a && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" icon={<RotateCw />} loading={pending} title={a.resumeHint} onClick={() => void resumeNow(agentKey)}>
            {a.resume}
          </Button>
          <Button size="sm" variant="ghost" icon={a.dismiss ? <X /> : <TimerOff />} title={a.cancelHint} onClick={() => void cancelAutoResume(agentKey, a.dismiss)}>
            {a.cancel}
          </Button>
        </span>
      )}
    </div>
  );
}

/** An ended card without a ticket: hostd makes none while herdr is down, and brings it back once herdr runs. Nothing to press. */
function EndedStrip({ hostId, ended, mobile }: { hostId: string; ended: AgentEnded; mobile: boolean }) {
  const herdr = useHerdrDown(hostId);
  const now = useNow(60_000);
  const w = endedWords(ended, now, { herdrDown: herdr !== undefined });
  return (
    <div role="status" data-testid="auto-resume" className={cn(BASE, "bg-white/5 text-ink-2", mobile && MOBILE)}>
      <Tooltip content={<Detail lines={w.detail} />}>
        <span tabIndex={0} className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-xs font-bold">
          <PowerOff className="size-3.5 shrink-0" aria-hidden />
          <span className={cn("min-w-0", mobile ? "line-clamp-2" : "truncate")}>{w.text}</span>
        </span>
      </Tooltip>
    </div>
  );
}
