import { Copy } from "lucide-react";
import { useHosts, useUi } from "@/core";
import { DropdownMenuItem } from "@/design";
import { haptic } from "@/features/shell/haptics";

/** Opens "Make <hostId> like another host"; without `hostId` the dialog asks which host to change. */
export function openHostSync(hostId?: string, sourceHostId?: string): void {
  useUi.getState().openDialog({ kind: "hostSync", ...(hostId ? { hostId } : {}), ...(sourceHostId ? { sourceHostId } : {}) });
}

/** The omp area strip's trailing "Copy from host…" (`OmpAreaNav`), when there is another host to copy from. */
export function CopyFromHostButton({ hostId }: { hostId?: string }) {
  const many = useHosts((h) => h.profiles.length > 1);
  if (!many) return null;
  return (
    <button
      type="button"
      title="Make this host like another: copy omp settings, model roles and MCP servers after reviewing each change"
      onClick={() => {
        haptic("tick");
        openHostSync(hostId);
      }}
      className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-mute transition-colors hover:bg-white/6 hover:text-ink focus-ring"
    >
      <Copy className="size-3.5" />
      Copy from host…
    </button>
  );
}

/** The host card's ⋯ item (the card offers it for online hosts), when there is another host to copy from. */
export function HostSyncMenuItem({ hostId }: { hostId: string }) {
  const many = useHosts((h) => h.profiles.length > 1);
  if (!many) return null;
  return (
    <DropdownMenuItem icon={<Copy />} onSelect={() => openHostSync(hostId)}>
      Make like another host…
    </DropdownMenuItem>
  );
}
