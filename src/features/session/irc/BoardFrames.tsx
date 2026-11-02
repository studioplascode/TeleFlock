import { MessagesSquare } from "lucide-react";
import { parseAgentKey, useAgent } from "@/core";
import { cn, useIsMobile } from "@/design";
import { FullscreenFrame } from "@/features/shell/FullscreenFrame";
import { SplitHeaderRow } from "@/features/shell/SplitHeaderRow";
import { closeBoardFull, showBoardFull, useBoardUi } from "./boardUi";
import { MessageBoard } from "./MessageBoard";

function BoardTitle({ name }: { name?: string }) {
  return (
    <>
      Agent chat
      {name && <span className="font-semibold text-mute"> · {name}</span>}
    </>
  );
}

/** The message board beside its session (`SplitState` kind `agentChat`): the shared header row, then the board. */
export function AgentChatSplit({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SplitHeaderRow
        icon={<MessagesSquare className="size-4 text-mute" />}
        title={<BoardTitle name={agent?.name} />}
        hostId={parseAgentKey(agentKey).hostId}
        onExpand={() => showBoardFull(agentKey)}
        expandLabel="Full screen"
      />
      <MessageBoard agentKey={agentKey} mobile={false} />
    </div>
  );
}

/** The message board over the whole app (phones: always; desktop: from the panel or in focus mode). */
export function AgentChatFull({ agentKey }: { agentKey: string }) {
  const mobile = useIsMobile();
  const agent = useAgent(agentKey);
  const open = useBoardUi((s) => s.full === agentKey);
  return (
    <FullscreenFrame open={open} onClose={closeBoardFull} label={`Agent chat${agent ? ` · ${agent.name}` : ""}`} icon={<MessagesSquare className="size-4 shrink-0 text-mute" />} title={<BoardTitle name={agent?.name} />}>
      <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col", !mobile && "max-w-[1040px]")}>
        <MessageBoard agentKey={agentKey} mobile={mobile} />
      </div>
    </FullscreenFrame>
  );
}
