import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { navigate, useHostIds, useHostStale, useHostState, useHosts } from "@/core";
import type { ConnPhase } from "@/core/gen";
import { Button, IconButton, StatusOrb, cn, formatAge, spring, useNow } from "@/design";
import { connAction } from "@/features/hosts/ConnStatusCard";

/** "<host> …" for a host that isn't online. */
const PHASE_TEXT: Record<ConnPhase, string> = {
  idle: "is not connected",
  connecting: "is connecting…",
  authenticating: "is authenticating…",
  authRequired: "needs Tailscale sign-in",
  hostKey: "needs you to verify its host key",
  deploying: "is updating tf-hostd…",
  starting: "is starting…",
  online: "is online",
  reconnecting: "is reconnecting…",
  offline: "is offline",
  error: "couldn't connect",
};

const BUSY: Partial<Record<ConnPhase, true>> = { connecting: true, authenticating: true, deploying: true, starting: true, reconnecting: true };

const strip = "flex items-center gap-3 rounded-lg px-4 py-2 text-xs max-md:px-3";

function StaleHost({ hostId }: { hostId: string }) {
  const stale = useHostStale(hostId);
  const st = useHosts((s) => s.status[hostId]);
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const now = useNow(1000);
  if (!stale || !st) return null;
  const retryIn = st.nextRetryAt ? Math.max(0, Math.ceil((st.nextRetryAt - now) / 1000)) : null;
  const action = connAction(st, hostId);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={spring.smooth}
      role="status"
      // The text wraps inside its own column; the action stays pinned on the right (no extra row on phones).
      className={cn(strip, "bg-warn/8 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.25)]")}
    >
      <StatusOrb status={st.phase === "authRequired" || st.phase === "hostKey" || st.phase === "error" ? "error" : "idle"} size={8} label={null} className="shrink-0" />
      <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn("text-mute", BUSY[st.phase] && "tf-shimmer-text")}>
          <b className="text-ink">{name}</b> {st.phase === "reconnecting" && retryIn !== null ? `reconnects in ${retryIn}s` : PHASE_TEXT[st.phase]}
          {" · "}
          showing its snapshot{st.lastOnlineAt ? ` from ${formatAge(now - st.lastOnlineAt)}` : ""} · cards are read-only until it reconnects
        </span>
        {st.error && (
          <span className="max-w-full min-w-0 truncate text-[#ff9fb2]" title={st.error.message}>
            {st.error.message}
          </span>
        )}
      </p>
      <span className="flex shrink-0 items-center gap-1.5">
        {st.phase === "authRequired" && (
          <button type="button" className="rounded-xs px-1 text-2xs font-bold text-mute focus-ring hover:text-ink hover:underline" onClick={() => navigate({ name: "hosts" })}>
            Details
          </button>
        )}
        {action && (
          <Button size="sm" variant="secondary" onClick={action.run}>
            {action.label}
          </Button>
        )}
      </span>
    </motion.div>
  );
}

/** Hosts whose setup-gap strip was dismissed (the Hosts view keeps showing the gap). */
const useDismissedGaps = create<{ hostIds: string[]; dismiss(hostId: string): void }>()(
  persist((set) => ({ hostIds: [], dismiss: (hostId) => set((s) => ({ hostIds: [...s.hostIds, hostId] })) }), { name: "tf.board.setupGaps" }),
);

/** Online host whose setup hides agents or their state: what's missing, in consequences, with a Fix… link. */
function SetupGap({ hostId }: { hostId: string }) {
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const setup = useHostState(hostId)?.info.setup;
  const dismissed = useDismissedGaps((s) => s.hostIds.includes(hostId));
  const dismiss = useDismissedGaps((s) => s.dismiss);
  if (!online || !setup || dismissed || (setup.globalSharing && setup.herdrIntegration)) return null;
  const gap = !setup.globalSharing
    ? "omp sessions you start by hand won't show up until session sharing is on"
    : "agents' working / waiting / done states stay unknown until herdr's omp integration is installed";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={spring.smooth}
      role="status"
      className={cn(strip, "bg-accent/8 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.25)]")}
    >
      <StatusOrb status="idle" size={8} label={null} className="shrink-0" />
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">{name}</b> · {gap}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="secondary" onClick={() => (window.location.hash = `#/hosts?setup=${encodeURIComponent(hostId)}`)}>
          Fix…
        </Button>
        <IconButton label={`Hide this for ${name}`} size="sm" onClick={() => dismiss(hostId)}>
          <X />
        </IconButton>
      </span>
    </motion.div>
  );
}

/** Hosts in view (title-bar host filter). */
function useShownHosts(): string[] {
  const filter = useHosts((s) => s.filter);
  const ids = useHostIds();
  return filter === "all" ? ids : ids.filter((id) => id === filter);
}

/** Setup-gap strips for the hosts in view (board, phone Flock): dismissible per host. */
export function SetupGaps() {
  const shown = useShownHosts();
  return (
    <AnimatePresence initial={false}>
      {shown.map((id) => (
        <SetupGap key={id} hostId={id} />
      ))}
    </AnimatePresence>
  );
}

/**
 * Host strips above the lanes: one per disconnected host in view (cards below are cached, desaturated
 * and read-only), then the setup gaps of online hosts.
 */
export function StaleHosts() {
  const shown = useShownHosts();
  return (
    <>
      <AnimatePresence initial={false}>
        {shown.map((id) => (
          <StaleHost key={id} hostId={id} />
        ))}
      </AnimatePresence>
      <SetupGaps />
    </>
  );
}
