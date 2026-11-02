import { Download, FolderOpen, X } from "lucide-react";
import { formatCompact, IconButton } from "@/design";
import { revealDownload } from "./actions";
import { browserController, type DownloadItem, useBrowserUi } from "./controller";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressText(d: DownloadItem): string {
  if (d.state === "completed") return size(d.received || d.total);
  if (d.state === "canceled") return "Canceled";
  return d.total > 0 ? `${size(d.received)} of ${size(d.total)}` : size(d.received);
}

/** The latest downloads (every owner's: an agent's downloads land in the same folder), with progress, Show in folder and Cancel. */
export function Downloads({ compact }: { compact: boolean }) {
  const downloads = useBrowserUi((s) => s.downloads);
  const ctl = browserController();
  const shown = downloads.slice(0, compact ? 2 : 4);
  if (shown.length === 0) return null;
  return (
    <div className="flex shrink-0 items-stretch gap-1.5 overflow-x-auto border-t border-line bg-tile-2 px-2 py-1.5 no-scrollbar">
      {shown.map((d) => {
        const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
        const by = d.owner.kind === "agent" ? d.owner.agentName : null;
        return (
          <div key={d.guid} className="relative flex w-60 shrink-0 items-center gap-2 overflow-hidden rounded-md bg-tile-3 py-1.5 pr-1 pl-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
            {d.state === "inProgress" && <span className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${pct ?? 30}%` }} aria-hidden />}
            <Download className="relative size-4 shrink-0 text-mute" />
            <span className="relative min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-ink" title={d.path ?? d.name}>
                {d.name}
              </span>
              <span className="block truncate text-[11px] text-mute">
                {progressText(d)}
                {pct != null && d.state === "inProgress" ? ` · ${formatCompact(pct)} %` : ""}
                {by ? ` · by ${by}` : ""}
              </span>
            </span>
            {d.state === "completed" && d.path && (
              <IconButton label="Show in folder" size="sm" className="relative" onClick={() => d.path && void revealDownload(d.path)}>
                <FolderOpen />
              </IconButton>
            )}
            <IconButton label={d.state === "inProgress" ? "Cancel download" : "Dismiss"} size="sm" className="relative" onClick={() => (d.state === "inProgress" ? ctl.cancelDownload(d.guid) : ctl.dismissDownload(d.guid))}>
              <X />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
