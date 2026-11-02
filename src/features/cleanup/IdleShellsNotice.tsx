import { Terminal, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { navigate, useCore, useHosts } from "@/core";
import { Button, IconButton, cn, useNow } from "@/design";
import { NoticeLine, noticeRank, noticeRise, noticeRow, useNoticeView } from "@/features/board/notice";
import { andList, shellsText, showShellsNotice, SNOOZE_MS, spanText } from "./idleShells";
import { closeIdleShells } from "./idleShellControls";
import { useIdleShellsPrefs } from "./idleShellsStore";

/**
 * Board notice: an online host lists idle shells and doesn't close them by itself (`HostInfo.idleShells`,
 * `auto` off): which workspaces, Close all (asks first) and Review (its Cleanup page). Hiding it lasts a day,
 * or until more shells go idle.
 */
export function IdleShellsNotice({ hostId, order }: { hostId: string; order: number }) {
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const idle = useCore((s) => s.hosts[hostId]?.state.info.idleShells);
  const home = useCore((s) => s.hosts[hostId]?.state.info.home);
  const snooze = useIdleShellsPrefs((s) => s.snooze[hostId]);
  const snoozeShells = useIdleShellsPrefs((s) => s.snoozeShells);
  const setFocus = useIdleShellsPrefs((s) => s.setFocus);
  const now = useNow(snooze ? 60_000 : null);
  const [closing, setClosing] = useState(false);
  const show = online && showShellsNotice(idle, snooze, now);
  const view = useNoticeView(`shells:${hostId}`, show ? noticeRank("shells", order) : null);
  if (!view || !idle) return null;
  const n = idle.shells.length;
  const icon = <Terminal className="size-3.5 shrink-0 text-accent-hi" aria-hidden />;
  const closeAll = (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0"
      loading={closing}
      onClick={() => void closeIdleShells(hostId, name, idle.shells, { ask: true, home, onStart: () => setClosing(true) }).finally(() => setClosing(false))}
    >
      Close all…
    </Button>
  );
  if (view === "line")
    return (
      <NoticeLine icon={icon} action={closeAll} className="bg-accent/6">
        <b className="text-ink">{name}</b> · {shellsText(n)}
      </NoticeLine>
    );
  return (
    <motion.div layout layoutDependency={n} {...noticeRise} role="status" data-notice="shells" className={cn(noticeRow, "bg-accent/6")}>
      {icon}
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">{name}</b> · {shellsText(n)} in {andList([...new Set(idle.shells.map((s) => s.workspace))])}
        {/* phones keep the row to the names: three actions share its width */}
        <span className="max-md:hidden">: no agent, nothing running, no input or output for {spanText(idle.minutes)}</span>
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {closeAll}
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => {
            setFocus(hostId);
            navigate({ name: "cleanup", hostId });
          }}
        >
          Review
        </Button>
        <IconButton label={`Hide this for ${name} for a day`} size="sm" onClick={() => snoozeShells(hostId, { count: n, until: Date.now() + SNOOZE_MS })}>
          <X />
        </IconButton>
      </span>
    </motion.div>
  );
}
