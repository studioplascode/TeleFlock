import { CircleAlert, PlugZap, RefreshCw, SquareTerminal, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { navigate, parseAgentKey, useAgent, useSession, useUi } from "@/core";
import { Button, EmptyState, Shimmer, Skeleton, Spinner } from "@/design";
import { hostCall, usePending } from "./api";
import { ParkedGate } from "./ParkedGate";

function openTerminal(agentKey: string, paneId?: string) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId });
}

/**
 * Renders the structured session only when TeleFlock's collab link is live; otherwise shows
 * what's wrong and the one action that fixes it (connect, retry, or the real terminal).
 */
export function LinkGate({ agentKey, onRetry, children }: { agentKey: string; onRetry: () => void; children: ReactNode }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const session = useSession(agentKey);
  const [busy, run] = usePending();
  const link = agent?.omp?.link;
  const terminalBtn = (
    <Button icon={<SquareTerminal />} onClick={() => openTerminal(agentKey, agent?.paneId)}>
      Open terminal
    </Button>
  );
  if (!agent) return null;

  // Marked done and its pane closed: read-only until it resumes (a message resumes it too).
  if (agent.parked) return <ParkedGate agentKey={agentKey}>{children}</ParkedGate>;

  if (link === "connecting")
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <Spinner size={28} label="Joining session" />
        <div>
          <div className="font-display text-xl font-bold text-ink">
            <Shimmer>Joining the omp session…</Shimmer>
          </div>
          <div className="mt-1 text-sm text-mute">TeleFlock is attaching to the session's collab room on the host.</div>
        </div>
        <div className="flex w-full max-w-[520px] flex-col gap-3 opacity-60">
          <Skeleton className="ml-auto h-10 w-2/5 rounded-[20px]" />
          <Skeleton className="h-16 rounded-[16px]" />
        </div>
      </div>
    );

  if (link === "notShared")
    return (
      <EmptyState
        className="flex-1"
        icon={<PlugZap />}
        title="This session isn't shared with TeleFlock yet"
        description="omp is running but not hosting a room on the TeleFlock relay (it was started outside TeleFlock, or restored by herdr). Connect injects /collab into the session while it's idle — nothing else changes."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<PlugZap />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.connect", { agentId }, { success: "Connecting…", failure: "Connect failed" }))}>
              Connect session
            </Button>
            {terminalBtn}
          </div>
        }
      />
    );

  if (link === "unsupported")
    return (
      <EmptyState
        className="flex-1"
        icon={<Unplug />}
        title="This omp can't be driven natively"
        description={`omp ${agent.omp?.version ?? "(unknown version)"} doesn't speak the collab protocol TeleFlock needs. Update omp on the host, or use the terminal.`}
        action={terminalBtn}
      />
    );

  if (link === "error")
    return (
      <EmptyState
        className="flex-1"
        icon={<CircleAlert className="text-error" />}
        title="Lost the link to this session"
        description={agent.omp?.linkError ?? "The collab link failed."}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<RefreshCw />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.connect", { agentId }, { success: "Reconnecting…", failure: "Reconnect failed" }))}>
              Reconnect
            </Button>
            {terminalBtn}
          </div>
        }
      />
    );

  if (session.status === "error")
    return (
      <EmptyState
        className="flex-1"
        icon={<CircleAlert className="text-error" />}
        title="Couldn't open the session"
        description={session.error ? `${session.error.message}${session.error.hint ? ` — ${session.error.hint}` : ""}` : undefined}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              icon={<RefreshCw />}
              onClick={onRetry}
            >
              Retry
            </Button>
            {terminalBtn}
          </div>
        }
      />
    );

  if (session.status === "ended")
    return (
      <EmptyState
        className="flex-1"
        icon={<Unplug />}
        title="Session ended"
        description={session.endedReason ?? "omp closed this session."}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => navigate({ name: "board" })}>Back to board</Button>
            {terminalBtn}
          </div>
        }
      />
    );

  return <>{children}</>;
}
