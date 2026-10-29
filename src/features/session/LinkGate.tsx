import { CircleAlert, PlugZap, RefreshCw, ShieldCheck, SquareTerminal, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { type AgentView, navigate, parseAgentKey, useAgent, useCore, useSession, useUi } from "@/core";
import type { LinkReason } from "@/core/gen";
import { Button, EmptyState, Shimmer, Skeleton, Spinner, useNow } from "@/design";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { PHASE_TEXT } from "@/features/shell/status";
import { hostCall, usePending } from "./api";
import { ParkedGate } from "./ParkedGate";

function openTerminal(agentKey: string, paneId?: string) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId });
}

/** A wait this long without progress gets the "still waiting" explanation (slow hosts take minutes). */
const STUCK_MS = 20_000;

/** What a `connecting` link is doing, in words (hostd's `linkError` adds the precise cause). */
const WAITING: Partial<Record<LinkReason, { title: string; explain: string; stuck?: string; retry?: true }>> = {
  starting: {
    title: "omp is starting…",
    explain: "Waiting for omp to load the TeleFlock bridge (TeleFlock's omp extension) or to open its collab room. This usually takes a few seconds.",
    stuck: "Still starting. omp may be waiting on something in its terminal, such as a trust prompt or an error.",
  },
  syncing: { title: "Loading the session…", explain: "Reading omp's session file and what is in flight right now." },
  joining: { title: "Joining omp's collab room…", explain: "TeleFlock is attaching to the session's room on the host's relay." },
  joinFailed: { title: "Couldn't join yet, retrying", explain: "The last attempt to join omp's collab room failed; TeleFlock keeps trying.", retry: true },
  reconnecting: { title: "Reconnecting to the collab room…", explain: "The connection to omp's room dropped. The transcript stays while it comes back.", retry: true },
  bridgeLost: {
    title: "Reconnecting to omp…",
    explain: "The TeleFlock bridge lost its connection (omp restarting or reloading its extensions). The transcript stays; if the bridge isn't back within ~10 s, TeleFlock switches to omp's collab room when one is open.",
    stuck: "omp hasn't come back. Check its terminal; the session may have exited.",
  },
  roomClosed: {
    title: "omp closed its collab room",
    explain: "Waiting for omp to open it again. Sending is paused until then.",
    stuck: "omp hasn't reopened the room. Check its terminal, or reconnect.",
    retry: true,
  },
};

/** Seconds since the link entered its current state (host clock), ticking once a second. */
function useLinkWait(agent: AgentView | undefined): number {
  const now = useNow(1000);
  const since = agent?.omp?.linkSince;
  return since == null ? 0 : Math.max(0, now - since);
}

function waitWords(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Renders the structured session only when TeleFlock's link to omp is live; otherwise says what is
 * happening and why (hostd's link reason and cause), for how long, and offers the action that helps,
 * always with the real terminal as the working fallback. A link that drops while the transcript is
 * loaded keeps the transcript, with a strip above it.
 */
export function LinkGate({ agentKey, onRetry, children }: { agentKey: string; onRetry: () => void; children: ReactNode }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const session = useSession(agentKey);
  const [busy, run] = usePending();
  const waited = useLinkWait(agent);
  const host = useCore((s) => ({ status: s.status[hostId], name: s.profiles.find((p) => p.id === hostId)?.name ?? hostId }), (a, b) => a.status === b.status && a.name === b.name);
  if (!agent) return null;

  // The host isn't online: what shows is the copy of the session saved on this device (the app
  // core answers the open from it), read-only until the host is back and the delta arrives.
  if (host.status?.phase !== "online" && session.status !== "ended") {
    const phase = host.status?.phase ?? "idle";
    const action = connAction(host.status, hostId);
    return (
      <>
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-warn/8 px-4 py-2 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]">
          <Spinner size={14} label={`${host.name} ${PHASE_TEXT[phase]}`} />
          <p className="min-w-0 flex-1 text-mute">
            <b className="text-ink">
              {host.name} {PHASE_TEXT[phase]}
            </b>
            <span className="block truncate">
              {session.itemIds.length > 0 ? `Showing the copy saved on this device: read-only until ${host.name} is online, then it catches up.` : `The session shows here once ${host.name} is online.`}
            </span>
          </p>
          {action && (
            <Button size="sm" variant="secondary" onClick={action.run}>
              {action.label}
            </Button>
          )}
        </div>
        {session.itemIds.length > 0 && children}
      </>
    );
  }

  // Marked done and its pane closed: read-only until it resumes (a message resumes it too).
  if (agent.parked) return <ParkedGate agentKey={agentKey}>{children}</ParkedGate>;

  const omp = agent.omp;
  const link = omp?.link;
  const reason = omp?.linkReason;
  const cause = omp?.linkError;
  const terminalBtn = (
    <Button icon={<SquareTerminal />} onClick={() => openTerminal(agentKey, agent.paneId)}>
      Open terminal
    </Button>
  );
  const connect = (label: string) => (
    <Button variant="primary" icon={link === "notShared" ? <PlugZap /> : <RefreshCw />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.connect", { agentId }, { success: `${label}…`, failure: `${label} failed` }))}>
      {label}
    </Button>
  );
  const actions = (...extra: ReactNode[]) => (
    <div className="flex flex-wrap justify-center gap-2">
      {extra}
      {terminalBtn}
    </div>
  );

  if (link === "connecting") {
    const w = (reason && WAITING[reason]) ?? { title: "Connecting to omp…", explain: "" };
    const stuck = waited >= STUCK_MS;
    // The transcript is already here (a dropped bridge or room keeps it): show it, say what's going on above it.
    if (session.itemIds.length > 0 && session.status !== "error" && session.status !== "ended")
      return (
        <>
          <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-warn/8 px-4 py-2 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]">
            <Spinner size={14} label="Reconnecting" />
            <p className="min-w-0 flex-1 text-mute">
              <b className="text-ink">{w.title}</b> {waited >= 2000 && <span className="tabular">· {waitWords(waited)}</span>}
              <span className="block truncate" title={cause ?? w.explain}>
                {stuck && w.stuck ? w.stuck : (cause ?? w.explain)}
              </span>
            </p>
            {(w.retry || stuck) && (
              <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.connect", { agentId }, { success: "Retrying…", failure: "Retry failed" }))}>
                Retry
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<SquareTerminal />} onClick={() => openTerminal(agentKey, agent.paneId)}>
              Terminal
            </Button>
          </div>
          {children}
        </>
      );
    return (
      <div role="status" className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <Spinner size={28} label={w.title} />
        <div className="max-w-[540px]">
          <div className="font-display text-xl font-bold text-ink">
            <Shimmer>{w.title}</Shimmer>
          </div>
          {w.explain && <p className="mt-1 text-sm text-mute">{w.explain}</p>}
          {cause && <p className="mt-2 text-xs break-words text-mute-2">{cause}</p>}
          {waited >= 2000 && <p className="mt-2 text-2xs font-semibold text-mute-2 tabular">Waiting {waitWords(waited)}</p>}
          {stuck && <p className="mt-2 text-sm font-semibold text-warn">{w.stuck ?? "This is taking longer than usual. The terminal shows what omp is doing."}</p>}
        </div>
        {actions((w.retry || stuck) && <Button key="retry" icon={<RefreshCw />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.connect", { agentId }, { success: "Retrying…", failure: "Retry failed" }))}>Retry now</Button>)}
        <div className="flex w-full max-w-[520px] flex-col gap-3 opacity-60" aria-hidden>
          <Skeleton className="ml-auto h-10 w-2/5 rounded-[20px]" />
          <Skeleton className="h-16 rounded-[16px]" />
        </div>
      </div>
    );
  }

  if (link === "notShared") {
    const copy =
      reason === "sharedElsewhere"
        ? { title: "This session is shared on another relay", description: "omp hosts this session's room on a relay TeleFlock doesn't use. Connect shares it on TeleFlock's relay instead, while it's idle." }
        : reason === "viewOnly"
          ? { title: "This session is shared read-only", description: "omp's room only lets guests watch. Connect shares it again with control, while it's idle." }
          : {
              title: "This session isn't connected to TeleFlock yet",
              description: "omp runs without the TeleFlock bridge (TeleFlock's omp extension) and isn't sharing a room on TeleFlock's relay: it was started outside TeleFlock, or restored by herdr. Connect makes it share itself while it's idle; nothing else changes.",
            };
    return (
      <EmptyState
        className="flex-1"
        icon={<PlugZap />}
        title={copy.title}
        description={
          <>
            {copy.description}
            {reason !== "sharedElsewhere" && reason !== "viewOnly" && !omp?.bridge && (
              <span className="mt-2 block text-xs text-mute-2">Install the TeleFlock bridge for every session (Hosts → Host setup) and sessions show up live by themselves.</span>
            )}
          </>
        }
        action={actions(<span key="connect">{connect("Connect session")}</span>)}
      />
    );
  }

  if (link === "unsupported")
    return (
      <EmptyState
        className="flex-1"
        icon={<Unplug />}
        title="This omp can't be driven natively"
        description={`omp ${omp?.version ?? "(unknown version)"} doesn't speak a protocol TeleFlock needs. Update omp on the host, or use the terminal.`}
        action={actions()}
      />
    );

  if (link === "error") {
    if (reason === "relayDown")
      return (
        <EmptyState
          className="flex-1"
          icon={<CircleAlert className="text-error" />}
          title="TeleFlock's relay isn't running on this host"
          description={cause ?? "Sessions without the TeleFlock bridge reach TeleFlock through its relay. Host setup says what's wrong and fixes it."}
          action={actions(
            <Button key="setup" variant="primary" icon={<ShieldCheck />} onClick={() => (window.location.hash = `#/hosts?setup=${encodeURIComponent(hostId)}`)}>
              Open host setup
            </Button>,
          )}
        />
      );
    return (
      <EmptyState
        className="flex-1"
        icon={<CircleAlert className="text-error" />}
        title="Lost the link to this session"
        description={cause ?? "TeleFlock's link to omp failed."}
        action={actions(<span key="reconnect">{connect("Reconnect")}</span>)}
      />
    );
  }

  if (session.status === "error")
    return (
      <EmptyState
        className="flex-1"
        icon={<CircleAlert className="text-error" />}
        title="Couldn't open the session"
        description={session.error ? `${session.error.message}${session.error.hint ? ` — ${session.error.hint}` : ""}` : undefined}
        action={actions(
          <Button key="retry" variant="primary" icon={<RefreshCw />} onClick={onRetry}>
            Retry
          </Button>,
        )}
      />
    );

  if (session.status === "ended")
    return (
      <EmptyState
        className="flex-1"
        icon={<Unplug />}
        title="Session ended"
        description={session.endedReason ?? "omp closed this session."}
        action={actions(
          <Button key="board" onClick={() => navigate({ name: "board" })}>
            Back to board
          </Button>,
        )}
      />
    );

  // Live, but through omp's collab room because the bridge's connection went away: say so, quietly.
  if (reason === "fallbackCollab")
    return (
      <>
        <p role="status" className="shrink-0 truncate rounded-lg bg-white/[0.03] px-4 py-1.5 text-2xs font-semibold text-mute shadow-hairline" title={cause}>
          Live through omp's collab room: the TeleFlock bridge lost its connection{cause ? ` (${cause})` : ""}.
        </p>
        {children}
      </>
    );

  return <>{children}</>;
}
