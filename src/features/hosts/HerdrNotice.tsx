import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useHosts } from "@/core";
import type { HerdrHealth } from "@/core/gen";
import { cn, StatusOrb, useNow } from "@/design";
import { NoticeLine, noticeRank, noticeRise, noticeRow, useNoticeView } from "@/features/board/notice";
import { HerdrStatusText, RestartHerdrButton, useHerdrHealth, useHostName } from "./HerdrControls";
import { BACK_UP_MS, herdrBackUp, herdrDown, herdrHeadline, herdrNotUp } from "./herdrHealth";

/** How the orb reads: a stopped server is an error, a stuck one needs you, work in flight runs. */
function orbStatus(state: HerdrHealth["state"]): "error" | "needs-you" | "running" {
  if (state === "down") return "error";
  return state === "unresponsive" ? "needs-you" : "running";
}

/**
 * The herdr state the notice has to say something about: the current health while the server is not up,
 * and for a minute the "running again" note after a server this window saw down came back.
 */
function useHerdrNote(hostId: string): { health: HerdrHealth; back: string | null } | null {
  const health = useHerdrHealth(hostId);
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const wasDown = useRef(false);
  const [backAt, setBackAt] = useState<number | null>(null);
  const state = health?.state;
  useEffect(() => {
    if (!state) return;
    if (state !== "up") {
      wasDown.current = true;
      setBackAt(null);
    } else if (wasDown.current) {
      wasDown.current = false;
      setBackAt(Date.now());
    }
  }, [state]);
  const now = useNow(backAt === null ? null : 5000);
  if (!health || !online) return null;
  if (herdrNotUp(health)) return { health, back: null };
  const back = backAt !== null && now - backAt < BACK_UP_MS ? herdrBackUp(health) : null;
  return back ? { health, back } : null;
}

/**
 * Board notice: an online host's herdr server is not up (stopped, crashed, not answering, being restarted or
 * handing its panes to a newer herdr): what happened, what TeleFlock does about it and Restart herdr.
 * For a minute after it is back, "herdr is running again".
 */
export function HerdrNotice({ hostId, order }: { hostId: string; order: number }) {
  const note = useHerdrNote(hostId);
  const name = useHostName(hostId);
  const view = useNoticeView(`herdr:${hostId}`, note ? noticeRank("herdr", order) : null);
  if (!view || !note) return null;
  const { health, back } = note;
  const tone = back ? "bg-done/8" : health.state === "down" ? "bg-error/8" : "bg-warn/8";
  const orb = <StatusOrb status={back ? "done" : orbStatus(health.state)} size={8} label={null} className="shrink-0" />;
  const act = !back && herdrDown(health) && <RestartHerdrButton hostId={hostId} health={health} />;
  const busy = health.state === "starting" || health.state === "restarting" || health.state === "updating";
  if (view === "line")
    return (
      <NoticeLine icon={orb} action={act} className={tone}>
        <b className="text-ink">{name}</b> · {back ?? herdrHeadline(health)}
      </NoticeLine>
    );
  return (
    <motion.div layout layoutDependency={`${health.state}/${back ? 1 : 0}/${health.error ? 1 : 0}`} {...noticeRise} role="status" data-testid="herdr-notice" data-state={health.state} className={cn(noticeRow, tone)}>
      {orb}
      <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-mute">
          <b className="text-ink">{name}</b> · <span className={cn("font-semibold text-ink-2", busy && "tf-shimmer-text")}>{back ?? herdrHeadline(health)}</span>
        </span>
        {!back && <HerdrStatusText health={health} className={cn("min-w-0 text-mute", health.error && health.state === "down" && "text-[#ff9fb2]")} />}
      </p>
      {act}
    </motion.div>
  );
}
