import { ChevronDown, Globe, Hourglass, Unplug } from "lucide-react";
import { useState } from "react";
import type { BrowserAttachment, BrowserStatus } from "@/core/gen";
import { Button, cn } from "@/design";
import { attachAgent, detachAgent } from "./actions";
import { browserController } from "./controller";
import { isDriving, type TabGroup } from "./owners";
import { RequestButtons } from "./RequestCard";
import { type RequestView, requestViews, waitingText } from "./requests";

interface AgentBarProps {
  status: BrowserStatus;
  groups: TabGroup[];
  now: number;
  hostName(hostId: string): string | null;
  /** Beside a session: its agent, offered "Let <agent> use my browser". */
  beside?: { hostId: string; agentId: string; name: string } | null;
  compact: boolean;
}

/**
 * Above the page: who can control this browser (each attached agent with Detach and a live
 * "driving now"), the agents asking for it, the ones waiting at the cap, and, beside a session,
 * "Let <agent> use my browser".
 */
export function AgentBar({ status, groups, now, hostName, beside, compact }: AgentBarProps) {
  const [open, setOpen] = useState(false);
  const requests = requestViews(status);
  const attachments = status.attachments;
  const colorOf = (a: BrowserAttachment) => groups.find((g) => g.key === `${a.hostId}::${a.agentId}`)?.color;
  const besideAttached = beside && attachments.some((a) => a.hostId === beside.hostId && a.agentId === beside.agentId);
  const besideAsks = beside && requests.some((r) => r.hostId === beside.hostId && r.agentId === beside.agentId);
  const many = attachments.length > (compact ? 1 : 2);
  const shown = many && !open ? [] : attachments;
  if (attachments.length === 0 && requests.length === 0 && (!beside || besideAttached || besideAsks)) return null;
  return (
    <div className="flex shrink-0 flex-col gap-px border-b border-line bg-tile-2 text-[13px]">
      {requests.map((r) => (
        <RequestRow key={r.requestId} view={r} hostName={hostName(r.hostId)} compact={compact} />
      ))}
      {many && (
        <button type="button" onClick={() => setOpen(!open)} className="flex h-9 items-center gap-2 px-3 text-left hover:bg-ink/4">
          <span className="flex -space-x-1">
            {attachments.slice(0, 4).map((a) => (
              <span key={`${a.hostId}::${a.agentId}`} className="size-2.5 rounded-full ring-2 ring-tile-2" style={{ background: colorOf(a) }} />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-2">
            <b className="text-ink">{attachments.length} agents</b> can control this browser
            {attachments.some((a) => isDriving(a.activeAt, now)) ? " · driving now" : ""}
          </span>
          <ChevronDown className={cn("size-4 text-mute transition-transform", open && "rotate-180")} />
        </button>
      )}
      {shown.map((a) => (
        <AttachmentRow key={`${a.hostId}::${a.agentId}`} attachment={a} color={colorOf(a)} hostName={hostName(a.hostId)} now={now} groups={groups} compact={compact} />
      ))}
      {beside && !besideAttached && !besideAsks && (
        <div className="flex h-10 items-center gap-2 px-3">
          <Globe className="size-4 shrink-0 text-mute" />
          <span className="min-w-0 flex-1 truncate text-mute">{beside.name} can't use this browser.</span>
          <Button size="sm" variant="secondary" onClick={() => void attachAgent(beside.hostId, beside.agentId, beside.name)}>
            Let {beside.name} use my browser
          </Button>
        </div>
      )}
    </div>
  );
}

/** "<agent> on <host> can control this browser", with its live state, Show its tabs and Detach. */
function AttachmentRow({ attachment: a, color, hostName, now, groups, compact }: { attachment: BrowserAttachment; color?: string; hostName: string | null; now: number; groups: TabGroup[]; compact: boolean }) {
  const driving = isDriving(a.activeAt, now);
  const group = groups.find((g) => g.key === `${a.hostId}::${a.agentId}`);
  const firstTab = group?.tabs[0]?.id;
  return (
    <div className="flex min-h-10 items-center gap-2.5 px-3 py-1.5" style={{ background: `linear-gradient(90deg, color-mix(in srgb, ${color ?? "var(--color-accent)"} 14%, transparent), transparent 70%)` }}>
      <span className="relative grid size-2.5 shrink-0 place-items-center">
        {driving && <span className="absolute inline-flex size-full animate-ping rounded-full opacity-70" style={{ background: color }} />}
        <span className="relative size-2.5 rounded-full" style={{ background: color }} />
      </span>
      <span className="min-w-0 flex-1 text-ink-2">
        <span className="line-clamp-2">
          <b className="text-ink">{a.agentName}</b>
          {hostName ? ` on ${hostName}` : ""} can control this browser
          {a.scope === "turn" ? " until its turn ends" : ""}
        </span>
        <span className={cn("text-xs", driving ? "font-semibold text-ink" : "text-mute")}>{driving ? "Driving now" : a.connections > 0 ? "Connected" : "Not connected yet"}</span>
      </span>
      {firstTab && !compact && (
        <Button size="sm" variant="ghost" onClick={() => browserController().activate(firstTab)}>
          Watch
        </Button>
      )}
      <Button size="sm" variant="secondary" icon={<Unplug />} onClick={() => void detachAgent(a.hostId, a.agentId, a.agentName)}>
        Detach
      </Button>
    </div>
  );
}

/** An agent asks for the browser, or waits at the cap. */
function RequestRow({ view, hostName, compact }: { view: RequestView; hostName: string | null; compact: boolean }) {
  const waiting = view.phase === "waiting";
  return (
    <div className={cn("flex gap-2.5 bg-sun/8 px-3 py-2", compact ? "flex-col" : "items-center")}>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {waiting ? <Hourglass className="mt-0.5 size-4 shrink-0 text-sun-ink" /> : <Globe className="mt-0.5 size-4 shrink-0 text-sun-ink" />}
        <span className="min-w-0 flex-1">
          <span className="block text-ink-2">
            <b className="text-ink">{view.agentName}</b>
            {hostName ? ` on ${hostName}` : ""} {waiting ? "is allowed and waits" : "wants to use your browser"}
          </span>
          <span className="line-clamp-2 text-xs text-mute">{waiting ? waitingText(view.using, view.cap) : view.reason}</span>
        </span>
      </div>
      <RequestButtons view={view} className={compact ? "pl-6.5" : "shrink-0"} />
    </div>
  );
}
