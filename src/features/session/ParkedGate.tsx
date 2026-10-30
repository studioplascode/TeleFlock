import { MoonStar, Play, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useAgent, useResuming, useSession } from "@/core";
import { Button, EmptyState, Shimmer, Spinner, cn, useIsMobile } from "@/design";
import { openTerminal, resumeParked } from "@/features/board/agentActions";
import { ACTIONS } from "@/features/shell/vocab";
import { Composer } from "./composer/Composer";
import { TRANSCRIPT_MAX_WIDTH } from "./transcript/Transcript";

const WHY = "Its pane closed when it was marked done. The omp session is kept: Resume reopens it (omp --resume) in a new pane, and a message resumes it with that message.";

function ResumeButton({ agentKey, size = "md" }: { agentKey: string; size?: "sm" | "md" }) {
  const resuming = useResuming(agentKey);
  return (
    <Button variant="primary" size={size} icon={<Play />} loading={resuming} onClick={() => void resumeParked(agentKey)}>
      {resuming ? "Resuming…" : ACTIONS.resume.label}
    </Button>
  );
}

/**
 * The full "closed" state of a parked agent (no transcript to show): what happened and the way
 * back. Session view (when the host has no read-only transcript) and terminal view (`terminal`
 * false: the view follows the agent to its new pane by itself).
 */
export function ParkedNotice({ agentKey, terminal = true, className }: { agentKey: string; terminal?: boolean; className?: string }) {
  const name = useAgent(agentKey)?.name ?? "This agent";
  const mobile = useIsMobile();
  return (
    <EmptyState
      className={className}
      icon={<MoonStar />}
      title={`${name} is done and closed`}
      description={WHY}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <ResumeButton agentKey={agentKey} />
          {terminal && (
            <Button icon={<SquareTerminal />} onClick={() => openTerminal(agentKey, mobile)} title="Resume it, then open its new terminal">
              {ACTIONS.terminal.label}
            </Button>
          )}
        </div>
      }
    />
  );
}

/**
 * LinkGate for a parked agent. With the read-only transcript the host sent at `session.open`, the
 * session shows as usual under a "closed" strip (none for an ended card: the header's auto-resume
 * strip says what happened and offers Continue); without one (older host, or `parked` error), the
 * notice. Either way the composer works: sending resumes the agent with that prompt, and the view
 * follows it to its new id.
 */
export function ParkedGate({ agentKey, children }: { agentKey: string; children: ReactNode }) {
  const session = useSession(agentKey);
  const resuming = useResuming(agentKey);
  const ended = useAgent(agentKey)?.parked?.ended;
  const mobile = useIsMobile();
  if (session.status === "error") {
    return (
      <>
        <ParkedNotice agentKey={agentKey} className="min-h-0 flex-1" />
        <div className="mx-auto w-full" style={{ maxWidth: TRANSCRIPT_MAX_WIDTH }}>
          <Composer agentKey={agentKey} mobile={mobile} />
        </div>
      </>
    );
  }
  if (ended && !resuming) return <>{children}</>;
  return (
    <>
      <div
        role="status"
        className={cn("mx-auto flex w-full items-center gap-3 rounded-tile bg-white/[0.035] shadow-hairline", mobile ? "mt-6 px-3 py-2" : "px-4 py-2.5")}
        style={{ maxWidth: TRANSCRIPT_MAX_WIDTH }}
      >
        {resuming ? <Spinner size={16} label="Resuming" /> : <MoonStar className="size-4 shrink-0 text-mute" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-ink">{resuming ? <Shimmer>Resuming in a new pane…</Shimmer> : "Done and closed"}</div>
          {!mobile && <div className="truncate text-2xs text-mute" title={WHY}>Read-only transcript · send a message or press Resume to pick it up again</div>}
        </div>
        <ResumeButton agentKey={agentKey} size="sm" />
      </div>
      {children}
    </>
  );
}
