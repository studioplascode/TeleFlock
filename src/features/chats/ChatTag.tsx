import { MessagesSquare } from "lucide-react";
import { useCore } from "@/core";
import { cn } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";

export interface ChatTagProps {
  /** Host of the chat (its folder reads `~`-shortened in the tooltip). */
  hostId?: string;
  /** The chat's folder (`Agent.cwd`), for the tooltip. */
  folder?: string;
  /** On the sunset hero card: white on a dark tint, like the card's state pill. */
  sunset?: boolean;
  className?: string;
}

/**
 * Where a chat works: a neutral "Chat" chip in the place of the repo or folder chip (cards, phone rows,
 * the session header and the phone session's subtitle). A chat has no repository, branch or worktree.
 */
export function ChatTag({ hostId, folder, sunset = false, className }: ChatTagProps) {
  const home = useCore((s) => (hostId && folder ? s.hosts[hostId]?.state.info.home : undefined));
  return (
    <span
      title={folder ? `Chat · no repository · folder ${tildify(folder, home)}` : "Chat · no repository"}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-xs py-px pr-1.5 pl-1 font-sans text-2xs font-bold",
        sunset ? "bg-[rgb(40_0_20/0.28)] text-white" : "bg-ink/6 text-ink-2",
        className,
      )}
    >
      <MessagesSquare className={cn("size-3 shrink-0", !sunset && "text-mute")} aria-hidden />
      Chat
    </span>
  );
}
