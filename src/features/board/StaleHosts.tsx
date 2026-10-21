import { AnimatePresence, motion } from "motion/react";
import { core, navigate, useHostIds, useHostStale, useHosts } from "@/core";
import type { ConnPhase } from "@/core/gen";
import { Button, StatusOrb, cn, formatAge, spring, useNow } from "@/design";
import { reportError } from "./agentActions";

const PHASE_TEXT: Record<ConnPhase, string> = {
  idle: "not connected",
  connecting: "connecting…",
  authenticating: "authenticating…",
  authRequired: "needs Tailscale sign-in",
  hostKey: "needs you to verify its host key",
  deploying: "updating tf-hostd…",
  starting: "starting…",
  online: "online",
  reconnecting: "reconnecting…",
  offline: "offline",
  error: "connection failed",
};

function StaleHost({ hostId }: { hostId: string }) {
  const stale = useHostStale(hostId);
  const st = useHosts((s) => s.status[hostId]);
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const now = useNow(1000);
  if (!stale || !st) return null;
  const busy = st.phase === "connecting" || st.phase === "authenticating" || st.phase === "deploying" || st.phase === "starting" || st.phase === "reconnecting";
  const retryIn = st.nextRetryAt ? Math.max(0, Math.ceil((st.nextRetryAt - now) / 1000)) : null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={spring.smooth}
      role="status"
      // The text wraps inside its own column; the action stays pinned on the right (no extra row on phones).
      className="flex items-center gap-3 rounded-lg bg-warn/8 px-4 py-2 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)] max-md:px-3"
    >
      <StatusOrb status={st.phase === "authRequired" || st.phase === "hostKey" || st.phase === "error" ? "error" : "idle"} size={8} label={null} className="shrink-0" />
      <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-bold text-ink">{name}</span>
        <span className={cn("text-mute", busy && "tf-shimmer-text")}>
          {st.phase === "authRequired"
            ? "needs Tailscale sign-in"
            : st.phase === "reconnecting" && retryIn !== null
              ? `reconnecting in ${retryIn}s`
              : PHASE_TEXT[st.phase]}
          {" · "}
          showing the last snapshot{st.lastOnlineAt ? ` from ${formatAge(now - st.lastOnlineAt)}` : ""}
        </span>
        {st.error && (
          <span className="max-w-full min-w-0 truncate text-[#ff9fb2]" title={st.error.message}>
            {st.error.message}
          </span>
        )}
      </p>
      <span className="flex shrink-0 gap-1.5">
        {st.phase === "authRequired" || st.phase === "hostKey" ? (
          <Button size="sm" variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            {st.phase === "hostKey" ? "Verify" : "Sign in"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void core.app("hosts.connect", { hostId }).catch((err) => reportError(`Couldn't reconnect ${name}`, err))}
          >
            Retry now
          </Button>
        )}
      </span>
    </motion.div>
  );
}

/** One strip per disconnected host in view: cards below are cached, desaturated and marked "last seen". */
export function StaleHosts() {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  const shown = filter === "all" ? ids : ids.filter((id) => id === filter);
  return (
    <AnimatePresence initial={false}>
      {shown.map((id) => (
        <StaleHost key={id} hostId={id} />
      ))}
    </AnimatePresence>
  );
}
