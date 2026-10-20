import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Maximize2, Send } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { navigate, parseAgentKey, useAgent } from "@/core";
import { AgentGlyph, Chip, cn, Elapsed, Heartbeat, IconButton, Input, StatusPill, useActivity, useIsMobile } from "@/design";
import { TerminalPane, type TerminalHandle } from "@/features/terminal";
import { agentStatus, hostCall, useBeat } from "./api";

const HERDR_LABEL: Record<string, string> = { working: "Working", blocked: "Blocked", idle: "Idle", done: "Done", unknown: "Unknown" };

const KEYS: { keys: string[]; label: ReactNode; aria: string }[] = [
  { keys: ["esc"], label: "Esc", aria: "Escape" },
  { keys: ["ctrl+c"], label: "^C", aria: "Control C" },
  { keys: ["tab"], label: "Tab", aria: "Tab" },
  { keys: ["up"], label: <ArrowUp className="size-3.5" />, aria: "Up" },
  { keys: ["down"], label: <ArrowDown className="size-3.5" />, aria: "Down" },
  { keys: ["left"], label: <ArrowLeft className="size-3.5" />, aria: "Left" },
  { keys: ["right"], label: <ArrowRight className="size-3.5" />, aria: "Right" },
  { keys: ["enter"], label: <CornerDownLeft className="size-3.5" />, aria: "Enter" },
  { keys: ["y", "enter"], label: "y ⏎", aria: "Yes" },
  { keys: ["n", "enter"], label: "n ⏎", aria: "No" },
];

/** Claude Code, Codex, …: herdr state, the real terminal, and a quick send-keys bar. */
export function NonOmpView({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const mobile = useIsMobile();
  const beat = useBeat(agentKey);
  const { tier } = useActivity(beat);
  const term = useRef<TerminalHandle>(null);
  const [line, setLine] = useState("");
  if (!agent) return null;
  const status = agentStatus(agent);
  const sendLine = () => {
    if (!line) return;
    term.current?.send(`${line}\r`);
    setLine("");
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-status={status}>
      {!mobile && (
        <header className="flex items-center gap-3 rounded-[22px] glass px-3.5 py-2.5">
          <AgentGlyph name={agent.name} size={36} status={status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h2 className="truncate font-display text-[19px] font-bold tracking-[-0.02em]">{agent.name}</h2>
              <Chip>{agent.kind}</Chip>
              <StatusPill status={status} activity={tier} size="sm">
                {HERDR_LABEL[agent.state]}
              </StatusPill>
              <span className="text-[11px] font-bold text-mute tabular">
                <Elapsed since={agent.stateSince} />
              </span>
            </div>
            <div className="truncate font-mono text-[11px] text-mute">
              {agent.title !== agent.name && <span className="mr-2 font-sans font-semibold text-ink-2">{agent.title}</span>}
              {[agent.repo, agent.branch].filter(Boolean).join(" · ")} {agent.paneId}
            </div>
          </div>
          <div className="hidden w-[140px] lg:block">
            <Heartbeat beat={beat} lastEventAt={agent.live.lastEventAt} status={status} height={26} />
          </div>
          <IconButton label="Open full terminal" onClick={() => navigate({ name: "terminal", hostId, paneId: agent.paneId, agentId })}>
            <Maximize2 />
          </IconButton>
        </header>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-tile bg-bg-deep shadow-[var(--shadow-d2),inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        <TerminalPane hostId={hostId} target={{ kind: "agent", agentId }} handleRef={term} className="absolute inset-0" />
      </div>
      <div className={cn("flex items-center gap-2", mobile && "flex-col items-stretch")}>
        <div className="flex shrink-0 gap-1 overflow-x-auto no-scrollbar" role="toolbar" aria-label="Send keys">
          {KEYS.map((k) => (
            <button
              key={k.aria}
              type="button"
              aria-label={k.aria}
              onClick={() => void hostCall(hostId, "agent.keys", { agentId, keys: k.keys }, { failure: "Keys not sent" })}
              className="pressable focus-ring grid h-9 min-w-9 shrink-0 place-items-center rounded-sm bg-tile-3 px-2.5 font-mono text-xs font-bold text-ink-2 shadow-key hover:bg-tile-4"
            >
              {k.label}
            </button>
          ))}
        </div>
        <Input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendLine();
            }
          }}
          placeholder={`Type a line for ${agent.kind}…`}
          aria-label="Send a line to the terminal"
          boxClassName="min-w-0 flex-1"
          trailing={
            <IconButton label="Send line" size="sm" variant="primary" onClick={sendLine} disabled={!line}>
              <Send />
            </IconButton>
          }
        />
      </div>
    </div>
  );
}
