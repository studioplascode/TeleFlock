import { Gauge } from "lucide-react";
import { cn, formatAge, useNow } from "@/design";
import { useCore } from "@/core";
import { priorityLine } from "./priority";

/**
 * One plain line on the host card: what this host's tf-hostd runs above the agents' work so the
 * host stays responsive while they load it (`HostInfo.priority`), and why something is not.
 * Hidden for hosts whose tf-hostd predates it.
 */
export function PriorityRow({ hostId }: { hostId: string }) {
  // `priority` only: the card doesn't re-render on every host patch.
  const priority = useCore((s) => s.hosts[hostId]?.state.info.priority);
  const now = useNow(60_000);
  const line = priorityLine(priority);
  if (!line || !priority) return null;
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs" data-testid="host-priority" title={`Checked ${formatAge(now - priority.checkedAt)}; tf-hostd checks every few minutes`}>
      <Gauge className={cn("mt-px size-3.5 shrink-0", line.raised ? "text-done" : "text-mute")} aria-hidden />
      <span className="min-w-0 break-words text-mute">
        <span className="font-semibold text-ink-2">{line.text}</span>
        {line.note && <> · {line.note}</>}
      </span>
    </div>
  );
}
