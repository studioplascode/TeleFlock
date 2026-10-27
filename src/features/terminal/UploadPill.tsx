import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { ProgressRing, cn, spring } from "@/design";
import { formatBytes } from "@/core/upload";
import type { TermUploads } from "./termUploads";

/**
 * The terminal's upload indicator (top right, beside the status chip): pasted / dropped / picked
 * images and videos on their way to the host, then their paths are pasted. × cancels them all.
 */
export function UploadPill({ uploads, touch }: { uploads: TermUploads; touch: boolean }) {
  const p = useSyncExternalStore(uploads.subscribe, uploads.progress);
  const pct = p && p.total > 0 ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0;
  return (
    <AnimatePresence>
      {p && (
        <motion.span
          key="upload"
          role="status"
          title={`Uploading to the host: ${formatBytes(p.sent)} of ${formatBytes(p.total)}; the path is pasted when it is there`}
          initial={{ opacity: 0, y: -4, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={spring.snappy}
          className="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-full bg-[rgb(20_20_28/0.82)] py-[3px] pr-[3px] pl-[5px] text-2xs font-bold text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)] backdrop-blur"
        >
          <ProgressRing done={p.sent} total={p.total} size={16} stroke={2.5} label={null} ariaLabel={`Uploading ${p.label}`} />
          <span className="max-w-36 truncate">{p.label}</span>
          <span className="font-mono text-mute tabular-nums">{pct}%</span>
          <button
            type="button"
            aria-label="Cancel upload"
            title="Cancel upload"
            className={cn(
              "grid shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-white/10 hover:text-ink active:bg-white/15",
              touch ? "size-7 [&_svg]:size-4" : "size-5 [&_svg]:size-3",
            )}
            onClick={(e) => {
              e.stopPropagation();
              uploads.cancel();
            }}
          >
            <X />
          </button>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
