import { MessagesSquare } from "lucide-react";
import { useMemo } from "react";
import { useAgent, useSession } from "@/core";
import type { Subagent } from "@/core/gen";
import { Button, cn, formatAge, useNow } from "@/design";
import { AgentAvatar } from "./AgentAvatar";
import { agentNamer, MAIN, participants, previewText, recipientsText, USER } from "./chat";
import { type AgentChatView, useSeenMark } from "./store";

/** Messages the card lists, newest last. */
const LATEST = 3;
const NO_SUBS: Subagent[] = [];

/**
 * The inspector's Agent chat card: the newest messages of the session's whole agent tree (who
 * wrote to whom, unread ones marked), how many messages and agents, and the way into the message
 * board; a preview opens the board at its message.
 */
export function ChatSummary({ agentKey, chat, onOpen }: { agentKey: string; chat: AgentChatView; onOpen: (messageId?: string) => void }) {
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const subs = meta?.subagents ?? NO_SUBS;
  const mainName = agent?.name ?? MAIN;
  const agentOf = useMemo(() => agentNamer(subs, mainName), [subs, mainName]);
  const agents = useMemo(() => participants(chat.messages, subs, agentOf).filter((p) => p.agent.kind !== "user").length, [chat.messages, subs, agentOf]);
  const seenAt = useSeenMark(agentKey).at;
  const now = useNow(30_000);
  const latest = chat.messages.slice(-LATEST);
  return (
    <div className="flex flex-col gap-0.5">
      {latest.map((m) => {
        const from = agentOf(m.from);
        const unread = m.at > seenAt && m.from !== USER;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onOpen(m.id)}
            title="Show on the message board"
            className="focus-ring flex w-full min-w-0 items-start gap-2 rounded-[12px] px-1.5 py-1 text-left hover:bg-ink/[0.04]"
          >
            <span className="mt-0.5">
              <AgentAvatar who={from} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-1 text-[11.5px]">
                <b className={cn("max-w-[45%] shrink-0 truncate font-extrabold", unread ? "text-ink" : "text-ink-2")}>{from.label}</b>
                <span className="shrink-0 text-mute-2">→</span>
                <span className="min-w-0 truncate font-bold text-ink-2">{recipientsText(m.to, m.broadcast, agentOf)}</span>
                <span className="ml-auto shrink-0 pl-1 text-[10.5px] font-semibold text-mute-2 tabular">{formatAge(now - m.at)}</span>
              </span>
              <span className={cn("block truncate text-[11.5px]", unread ? "font-semibold text-ink-2" : "text-mute", m.progress && "italic")}>{previewText(m.text) || "(empty)"}</span>
            </span>
            {unread && <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent)_80%,transparent)]" aria-label="unread" />}
          </button>
        );
      })}
      <div className="mt-1.5 flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[11px] font-semibold text-mute-2 tabular">
          {chat.messages.length} message{chat.messages.length === 1 ? "" : "s"} · {agents} agent{agents === 1 ? "" : "s"}
        </span>
        <Button size="sm" icon={<MessagesSquare />} className="ml-auto shrink-0" onClick={() => onOpen()}>
          Open message board
        </Button>
      </div>
      {chat.source === "transcript" && !meta?.agentChat && <p className="mt-1 text-[10.5px] text-mute-2">Only {mainName}'s own messages: the host runs a TeleFlock before 0.9.0.</p>}
    </div>
  );
}
