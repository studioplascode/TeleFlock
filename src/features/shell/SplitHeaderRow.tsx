import { Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useUi } from "@/core";
import { IconButton, Tooltip } from "@/design";
import { HostBadge } from "@/features/hosts/HostBadge";

export interface SplitHeaderRowProps {
  /** Leading glyph (a status orb, the panel's icon). */
  icon?: ReactNode;
  title: ReactNode;
  /** The host chip (shown with several hosts). */
  hostId?: string;
  /** Controls between the title and the expand/close buttons. */
  children?: ReactNode;
  /** "Open full view" (the route, or full screen); hidden without it. */
  onExpand?: () => void;
  expandLabel?: string;
}

/**
 * The title row of the split panel (`SplitFrame`): every panel kind uses it, the ones that render
 * their own header (artifacts, the browser) from inside their body. Close ends the split.
 */
export function SplitHeaderRow({ icon, title, hostId, children, onExpand, expandLabel = "Open full view" }: SplitHeaderRowProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink-2">{title}</span>
      {hostId && <HostBadge hostId={hostId} className="max-w-[40%]" />}
      {children}
      {onExpand && (
        <Tooltip content={expandLabel}>
          <IconButton label={expandLabel} size="sm" onClick={onExpand}>
            <Maximize2 />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip content="Close split" shortcut="Ctrl \">
        <IconButton label="Close split" size="sm" onClick={() => useUi.getState().setSplit(null)}>
          <X />
        </IconButton>
      </Tooltip>
    </div>
  );
}
