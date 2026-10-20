import type { FileStatus } from "@/core/gen";
import { cn } from "@/design";

export const FILE_STATUS: Record<FileStatus, { letter: string; label: string; text: string; bg: string }> = {
  modified: { letter: "M", label: "modified", text: "text-warn", bg: "bg-warn/15" },
  added: { letter: "A", label: "added", text: "text-add", bg: "bg-add/15" },
  deleted: { letter: "D", label: "deleted", text: "text-del", bg: "bg-del/15" },
  renamed: { letter: "R", label: "renamed", text: "text-review", bg: "bg-review/15" },
  untracked: { letter: "U", label: "untracked", text: "text-omp-blue", bg: "bg-omp-blue/15" },
};

/** Square status letter (M/A/D/R/U) in the status tint. */
export function FileStatusIcon({ status, className }: { status: FileStatus; className?: string }) {
  const m = FILE_STATUS[status];
  return (
    <span
      className={cn("grid size-[18px] shrink-0 place-items-center rounded-[5px] font-mono text-[10px] font-extrabold", m.text, m.bg, className)}
      title={m.label}
      aria-label={m.label}
    >
      {m.letter}
    </span>
  );
}
