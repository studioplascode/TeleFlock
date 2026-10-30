import { HardDrive, X } from "lucide-react";
import { motion } from "motion/react";
import { navigate, useCore, useHosts } from "@/core";
import { formatBytes } from "@/core/upload";
import { Button, IconButton, cn, useNow } from "@/design";
import { NoticeLine, noticeRank, noticeRise, noticeRow, useNoticeView } from "@/features/board/notice";
import { diskLevel, showDiskNotice, SNOOZE_MS } from "./disk";
import { useCleanupPrefs } from "./store";

/**
 * Board notice: an online host's home file system (omp's sessions, herdr's worktrees) is low on space
 * (`diskLevel`), with a way to its Cleanup page. Hiding it lasts a day, or until it gets worse.
 */
export function LowDiskNotice({ hostId, order }: { hostId: string; order: number }) {
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  // Primitives only: health patches arrive every few seconds; the row changes with the level and the shown size.
  const level = useCore((s) => {
    const h = s.hosts[hostId]?.state.health;
    return h ? diskLevel(h.diskFree, h.diskTotal) : "ok";
  });
  const free = useCore((s) => {
    const f = s.hosts[hostId]?.state.health?.diskFree;
    return f === undefined ? 0 : Math.round(f / 1024 ** 3 * 10) / 10;
  });
  const snooze = useCleanupPrefs((s) => s.diskSnooze[hostId]);
  const snoozeDisk = useCleanupPrefs((s) => s.snoozeDisk);
  const now = useNow(snooze ? 60_000 : null);
  const show = online && showDiskNotice(level, snooze, now);
  const view = useNoticeView(`disk:${hostId}`, show ? noticeRank("disk", order) : null);
  if (!view || level === "ok") return null;
  const tone = level === "critical" ? "error" : "needs-you";
  const icon = <HardDrive className="size-3.5 shrink-0 st-text" data-status={tone} aria-hidden />;
  const words = `${formatBytes(free * 1024 ** 3)} free${level === "critical" ? ": almost full" : ""}`;
  const fix = (
    <Button size="sm" variant="secondary" className="shrink-0" onClick={() => navigate({ name: "cleanup", hostId })}>
      Clean up…
    </Button>
  );
  if (view === "line")
    return (
      <NoticeLine icon={icon} action={fix} className={level === "critical" ? "bg-error/8" : "bg-warn/8"}>
        <b className="text-ink">{name}</b> · {words}
      </NoticeLine>
    );
  return (
    <motion.div layout layoutDependency={level} {...noticeRise} role="status" className={cn(noticeRow, level === "critical" ? "bg-error/8" : "bg-warn/8")}>
      {icon}
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">{name}</b> is low on disk space · {words}. Merged and stale worktrees and omp's unreferenced blobs can go; sessions stay.
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {fix}
        <IconButton label={`Hide this for ${name} for a day`} size="sm" onClick={() => snoozeDisk(hostId, { level, until: Date.now() + SNOOZE_MS })}>
          <X />
        </IconButton>
      </span>
    </motion.div>
  );
}
