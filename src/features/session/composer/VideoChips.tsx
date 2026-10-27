import { Check, Film, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import type { DraftVideo } from "@/core/draftVideos";
import { formatBytes } from "@/core/upload";
import { cn, spring } from "@/design";

/** Where a video stands, in a few words (the chip's second line). */
function stateText(v: DraftVideo): string {
  switch (v.phase) {
    case "pending":
      return "uploads when sent";
    case "queued":
      return "waiting";
    case "uploading":
      return `${v.size ? Math.floor((v.sent / v.size) * 100) : 0}%`;
    case "done":
      return "uploaded";
    case "failed":
      return "didn't upload";
  }
}

/**
 * Attached videos as chips: name, size, upload progress (a bar along the bottom), retry when the
 * upload failed, remove. `onRemove` absent: read-only (a sent Dispatch task's uploads).
 */
export function VideoChips({ videos, onRemove, onRetry, mobile = false, className }: { videos: readonly DraftVideo[]; onRemove?(id: string): void; onRetry?(id: string): void; mobile?: boolean; className?: string }) {
  if (!videos.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label={videos.length === 1 ? "1 video" : `${videos.length} videos`}>
      {videos.map((v) => {
        const failed = v.phase === "failed";
        const pct = v.size ? Math.min(100, (v.sent / v.size) * 100) : 0;
        return (
          <motion.div
            key={v.id}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
            role="group"
            aria-label={`Video ${v.name}, ${formatBytes(v.size)}, ${stateText(v)}`}
            title={failed ? v.error : v.path ?? v.name}
            className={cn(
              "relative flex max-w-[260px] min-w-0 items-center gap-2 overflow-hidden rounded-[12px] py-1.5 pr-1 pl-2.5 shadow-hairline",
              mobile ? "h-11" : "h-10",
              failed ? "bg-error/10 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)]" : "bg-tile-4",
            )}
          >
            <Film className={cn("size-4 shrink-0", failed ? "text-error" : "text-accent-hi")} aria-hidden />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12px] font-bold text-ink">{v.name}</span>
              <span className={cn("flex items-center gap-1 truncate text-[10.5px] font-semibold tabular", failed ? "text-error" : "text-mute")}>
                {formatBytes(v.size)} · {stateText(v)}
                {v.phase === "done" && <Check className="size-3 shrink-0 text-done" aria-hidden />}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              {failed && onRetry && (
                <button type="button" aria-label={`Retry uploading ${v.name}`} title={v.error} onClick={() => onRetry(v.id)} className={cn("pressable focus-ring grid place-items-center rounded-full text-ink-2 hover:bg-white/8 hover:text-ink", mobile ? "size-8" : "size-6")}>
                  <RotateCcw className="size-3.5" />
                </button>
              )}
              {onRemove && (
                <button type="button" aria-label={`Remove video ${v.name}`} onClick={() => onRemove(v.id)} className={cn("pressable focus-ring grid place-items-center rounded-full text-mute hover:bg-white/8 hover:text-ink", mobile ? "size-8" : "size-6")}>
                  <X className="size-3.5" />
                </button>
              )}
            </span>
            {(v.phase === "uploading" || v.phase === "queued") && (
              <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/8" aria-hidden>
                <span className="block h-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
              </span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
