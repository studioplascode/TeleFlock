import { Check, FileText, Film, MonitorPlay, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import type { DraftUpload } from "@/core/draftUploads";
import { formatBytes } from "@/core/upload";
import { cn, spring } from "@/design";

/** Where an upload stands, in a few words (the chip's second line). */
function stateText(u: DraftUpload): string {
  switch (u.phase) {
    case "pending":
      return "uploads when sent";
    case "queued":
      return "waiting";
    case "uploading":
      return `${u.size ? Math.floor((u.sent / u.size) * 100) : 0}%`;
    case "done":
      return "uploaded";
    case "failed":
      return "didn't upload";
  }
}

/** What each kind is called and shown as (absent kind: a video). */
const KINDS = {
  video: { label: "Video", Icon: Film },
  recording: { label: "Recording", Icon: MonitorPlay },
  file: { label: "File", Icon: FileText },
} as const;

/**
 * Attached uploads (videos, recordings, other files) as chips: name, size, upload progress (a bar
 * along the bottom), retry when the upload failed, remove. `onRemove` absent: read-only (a sent
 * Dispatch task's uploads).
 */
export function UploadChips({ uploads, onRemove, onRetry, mobile = false, className }: { uploads: readonly DraftUpload[]; onRemove?(id: string): void; onRetry?(id: string): void; mobile?: boolean; className?: string }) {
  if (!uploads.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label={uploads.length === 1 ? "1 attached file" : `${uploads.length} attached files`}>
      {uploads.map((u) => {
        const failed = u.phase === "failed";
        const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
        const { label, Icon } = KINDS[u.kind ?? "video"];
        return (
          <motion.div
            key={u.id}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
            role="group"
            aria-label={`${label} ${u.name}, ${formatBytes(u.size)}, ${stateText(u)}`}
            title={failed ? u.error : u.path ?? u.name}
            className={cn(
              "relative flex max-w-[260px] min-w-0 items-center gap-2 overflow-hidden rounded-[12px] py-1.5 pr-1 pl-2.5 shadow-hairline",
              mobile ? "h-11" : "h-10",
              failed ? "bg-error/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_35%,transparent)]" : "bg-tile-4",
            )}
          >
            <Icon className={cn("size-4 shrink-0", failed ? "text-error" : "text-accent-hi")} aria-hidden />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12px] font-bold text-ink">{u.name}</span>
              <span className={cn("flex items-center gap-1 truncate text-[10.5px] font-semibold tabular", failed ? "text-error" : "text-mute")}>
                {formatBytes(u.size)} · {stateText(u)}
                {u.phase === "done" && <Check className="size-3 shrink-0 text-done" aria-hidden />}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              {failed && onRetry && (
                <button type="button" aria-label={`Retry uploading ${u.name}`} title={u.error} onClick={() => onRetry(u.id)} className={cn("pressable focus-ring grid place-items-center rounded-full text-ink-2 hover:bg-ink/8 hover:text-ink", mobile ? "size-8" : "size-6")}>
                  <RotateCcw className="size-3.5" />
                </button>
              )}
              {onRemove && (
                <button type="button" aria-label={`Remove ${label.toLowerCase()} ${u.name}`} onClick={() => onRemove(u.id)} className={cn("pressable focus-ring grid place-items-center rounded-full text-mute hover:bg-ink/8 hover:text-ink", mobile ? "size-8" : "size-6")}>
                  <X className="size-3.5" />
                </button>
              )}
            </span>
            {(u.phase === "uploading" || u.phase === "queued") && (
              <span className="absolute inset-x-0 bottom-0 h-[3px] bg-ink/8" aria-hidden>
                <span className="block h-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
              </span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
