import { FlaskConical, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { core, navigate, useCore, useHostIds, useHostStale, useHosts, useUi } from "@/core";
import type { ConnPhase } from "@/core/gen";
import { Button, IconButton, StatusOrb, cn, formatAge, toast, useNow } from "@/design";
import { LinkAccountNudge } from "@/features/accounts/LinkAccountNudge";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { noticeRise as rise, noticeRow as row } from "./notice";

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

function StaleHost({ hostId }: { hostId: string }) {
  const stale = useHostStale(hostId);
  const st = useHosts((s) => s.status[hostId]);
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const now = useNow(1000);
  if (!stale || !st) return null;
  const retryIn = st.nextRetryAt ? Math.max(0, Math.ceil((st.nextRetryAt - now) / 1000)) : null;
  const action = connAction(st, hostId);
  return (
    // Re-renders every second (countdown, age): measure layout only when the row can change size,
    // or every tick re-measures every card on the board (motion measures the whole layout tree).
    <motion.div layout layoutDependency={`${st.phase}/${st.error ? 1 : 0}`} {...rise} role="status" className={cn(row, "bg-warn/8")}>
      <StatusOrb status={st.phase === "authRequired" || st.phase === "hostKey" || st.phase === "error" ? "error" : "idle"} size={8} label={null} className="shrink-0" />
      {/* The text wraps inside its own column; the action stays pinned on the right (no extra row on phones). */}
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

/** Notices the user hid (per host for setup gaps, `demo` for the demo notice; the Hosts view keeps showing gaps). */
const useDismissedGaps = create<{ hostIds: string[]; dismiss(hostId: string): void }>()(
  persist((set) => ({ hostIds: [], dismiss: (hostId) => set((s) => ({ hostIds: [...s.hostIds, hostId] })) }), { name: "tf.board.setupGaps" }),
);

/** Online host whose setup hides agents or their state: what's missing, in consequences, with a Fix… link. */
function SetupGap({ hostId }: { hostId: string }) {
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  // Only `info` (not every 5 Hz patch of the host's state): this row re-renders when setup changes.
  const setup = useCore((s) => s.hosts[hostId]?.state.info.setup);
  const dismissed = useDismissedGaps((s) => s.hostIds.includes(hostId));
  const dismiss = useDismissedGaps((s) => s.dismiss);
  if (!online || !setup || dismissed) return null;
  // Bridge first: the TeleFlock extension serves sessions natively; collab sharing is only the fallback.
  const gap =
    !setup.globalBridge && !setup.globalSharing
      ? "omp sessions you start by hand won't show up until the TeleFlock extension is on for every session"
      : !setup.herdrIntegration
        ? "agents' working / waiting / done states stay unknown until herdr's omp integration is installed"
        : null;
  if (!gap) return null;
  return (
    <motion.div layout layoutDependency={gap} {...rise} role="status" className={cn(row, "bg-accent/6")}>
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

/** Exploring the simulated flock: say so, and lead to a real host (or out of the demo). */
function DemoNotice() {
  const demoIds = useHosts((s) => s.profiles.filter((p) => p.kind === "demo").map((p) => p.id).join("\n"));
  const onlyDemo = useHosts((s) => s.profiles.every((p) => p.kind === "demo"));
  const dismissed = useDismissedGaps((s) => s.hostIds.includes("demo"));
  const dismiss = useDismissedGaps((s) => s.dismiss);
  if (!demoIds || dismissed) return null;
  // `?demo` in a browser is all demo (nothing to leave); the app's "Try the demo" host can be removed.
  const leave = core.backend !== "demo";
  return (
    <motion.div layout layoutDependency={leave} {...rise} role="status" className={cn(row, "bg-accent/6")}>
      <FlaskConical className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">Demo flock</b> · simulated agents, nothing here is real{onlyDemo ? ". Add your herdr host to see your own." : ""}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="primary" onClick={() => useUi.getState().openDialog({ kind: "hostEditor" })}>
          Add your host
        </Button>
        {leave && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void Promise.all(demoIds.split("\n").map((hostId) => core.app("hosts.remove", { hostId }))).then(
                () => toast({ title: "Left the demo" }),
                () => toast({ title: "Couldn't remove the demo host", status: "error" }),
              )
            }
          >
            Leave demo
          </Button>
        )}
        <IconButton label="Hide the demo notice" size="sm" onClick={() => dismiss("demo")}>
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

/** Classes of the notice box: one box however many rows, gone when empty. */
const box = "divide-y divide-line overflow-hidden rounded-lg bg-white/[0.02] shadow-[inset_0_0_0_1px_var(--color-line-2)] empty:hidden";

/** The demo notice, hosts without an account to run agents with, and the setup-gap rows for the
 * hosts in view (board, phone Flock): dismissible. */
export function SetupGaps({ boxed = true }: { boxed?: boolean }) {
  const shown = useShownHosts();
  const rows = (
    <AnimatePresence initial={false}>
      <DemoNotice key="demo" />
      {shown.map((id) => (
        <LinkAccountNudge key={`accounts:${id}`} hostId={id} />
      ))}
      {shown.map((id) => (
        <SetupGap key={id} hostId={id} />
      ))}
    </AnimatePresence>
  );
  return boxed ? <div className={box}>{rows}</div> : rows;
}

/**
 * The board's notice box above the lanes: one row per disconnected host in view (cards below are
 * cached, desaturated and read-only), then the demo notice and setup gaps. One box, however many
 * rows; it disappears when there's nothing to say.
 */
export function StaleHosts() {
  const shown = useShownHosts();
  return (
    <div className={box}>
      <AnimatePresence initial={false}>
        {shown.map((id) => (
          <StaleHost key={id} hostId={id} />
        ))}
      </AnimatePresence>
      <SetupGaps boxed={false} />
    </div>
  );
}
