import { FlaskConical, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { core, navigate, useCore, useHostIds, useHostStale, useHosts, useUi } from "@/core";
import { Button, IconButton, StatusOrb, cn, formatAge, toast, useNow } from "@/design";
import { LinkAccountNudge } from "@/features/accounts/LinkAccountNudge";
import { LowDiskNotice } from "@/features/cleanup/LowDiskNotice";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { HerdrNotice } from "@/features/hosts/HerdrNotice";
import { setupHash } from "@/features/hosts/setupFocus";
import { PHASE_TEXT, phaseBusy } from "@/features/shell/status";
import { Term } from "@/features/shell/Term";
import { connWords } from "./FlockActions";
import { NoticeLine, NoticeTray, noticeBox, noticeRank, noticeRise as rise, noticeRow as row, useNoticeView } from "./notice";
import { boardSetupGap, type SetupGap as Gap } from "./setupGap";

/** A host that isn't online: its cards below are its cached snapshot, read-only until it reconnects. */
function StaleHost({ hostId, order }: { hostId: string; order: number }) {
  const stale = useHostStale(hostId);
  const st = useHosts((s) => s.status[hostId]);
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const now = useNow(1000);
  const view = useNoticeView(`stale:${hostId}`, stale && st ? noticeRank("stale", order) : null);
  if (!view || !st) return null;
  const retryIn = st.nextRetryAt ? Math.max(0, Math.ceil((st.nextRetryAt - now) / 1000)) : null;
  const action = connAction(st, hostId);
  const orb = <StatusOrb status={st.phase === "authRequired" || st.phase === "hostKey" || st.phase === "error" ? "error" : "idle"} size={8} label={null} className="shrink-0" />;
  const act = action && (
    <Button size="sm" variant="secondary" className="shrink-0" onClick={action.run}>
      {action.label}
    </Button>
  );
  if (view === "line")
    return (
      <NoticeLine icon={orb} action={act} className="bg-warn/8">
        <b className="text-ink">{name}</b> <span className={cn(phaseBusy(st.phase) && "tf-shimmer-text")}>{connWords(st, now)}</span>
        {st.error && <span className="text-[#ff9fb2]"> · {st.error.message}</span>}
      </NoticeLine>
    );
  return (
    // Re-renders every second (countdown, age): measure layout only when the row can change size,
    // or every tick re-measures every card on the board (motion measures the whole layout tree).
    <motion.div layout layoutDependency={`${st.phase}/${st.error ? 1 : 0}`} {...rise} role="status" className={cn(row, "bg-warn/8")}>
      {orb}
      {/* The text wraps inside its own column; the action stays pinned on the right (no extra row on phones). */}
      <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn("text-mute", phaseBusy(st.phase) && "tf-shimmer-text")}>
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
        {act}
      </span>
    </motion.div>
  );
}

/** Notices the user hid (per host for setup gaps, `demo` for the demo notice; the Hosts view keeps showing gaps). */
const useDismissedGaps = create<{ hostIds: string[]; dismiss(hostId: string): void }>()(
  persist((set) => ({ hostIds: [], dismiss: (hostId) => set((s) => ({ hostIds: [...s.hostIds, hostId] })) }), { name: "tf.board.setupGaps" }),
);

/** What a setup gap hides, as consequences: the full row and the folded tray's line. */
const GAP_TEXT: Record<Gap, { row: ReactNode; line: string }> = {
  sessions: {
    row: (
      <>
        omp sessions you start by hand won't show up until the <Term id="bridge">TeleFlock bridge</Term>, an omp extension, is on for every session
      </>
    ),
    line: "sessions you start by hand stay hidden",
  },
  states: {
    row: "agents' working / waiting / done states stay unknown until herdr's omp integration is installed",
    line: "agent states stay unknown",
  },
};

/** Online host whose setup hides agents or their state: what's missing, in consequences, with a Fix… link. */
function SetupGap({ hostId, order }: { hostId: string; order: number }) {
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const kind = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.kind);
  // Only `info` (not every 5 Hz patch of the host's state): this row re-renders when setup changes.
  const setup = useCore((s) => s.hosts[hostId]?.state.info.setup);
  const dismissed = useDismissedGaps((s) => s.hostIds.includes(hostId));
  const dismiss = useDismissedGaps((s) => s.dismiss);
  const gap = online && !dismissed ? boardSetupGap(kind, setup) : null;
  const view = useNoticeView(`setup:${hostId}`, gap ? noticeRank("setup", order) : null);
  if (!view || !gap) return null;
  const orb = <StatusOrb status="idle" size={8} label={null} className="shrink-0" />;
  const fix = (
    <Button size="sm" variant="secondary" className="shrink-0" onClick={() => (window.location.hash = setupHash(hostId))}>
      Fix…
    </Button>
  );
  if (view === "line")
    return (
      <NoticeLine icon={orb} action={fix} className="bg-accent/6">
        <b className="text-ink">{name}</b> · {GAP_TEXT[gap].line}
      </NoticeLine>
    );
  return (
    <motion.div layout layoutDependency={gap} {...rise} role="status" className={cn(row, "bg-accent/6")}>
      {orb}
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">{name}</b> · {GAP_TEXT[gap].row}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {fix}
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
  const view = useNoticeView("demo", demoIds && !dismissed ? noticeRank("demo") : null);
  if (!view) return null;
  // `?demo` in a browser is all demo (nothing to leave); the app's "Try the demo" host can be removed.
  const leave = core.backend !== "demo";
  const icon = <FlaskConical className="size-3.5 shrink-0 text-accent-hi" aria-hidden />;
  const add = (
    <Button size="sm" variant="primary" className="shrink-0" onClick={() => useUi.getState().openDialog({ kind: "hostEditor" })}>
      Add your host
    </Button>
  );
  if (view === "line")
    return (
      <NoticeLine icon={icon} action={add} className="bg-accent/6">
        <b className="text-ink">Demo flock</b> · simulated agents
      </NoticeLine>
    );
  return (
    <motion.div layout layoutDependency={leave} {...rise} role="status" className={cn(row, "bg-accent/6")}>
      {icon}
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">Demo flock</b> · simulated agents, nothing here is real{onlyDemo ? ". Add your herdr host to see your own." : ""}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {add}
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

/**
 * Every notice for the hosts in view, most urgent first (`noticeRank`): hosts that aren't online (their
 * cards are cached, desaturated and read-only), hosts whose herdr server isn't up (agents ended or unseen),
 * hosts whose omp has no account to run agents with, setup gaps, then the demo. Dismissible ones stay hidden
 * per host (the Hosts view keeps showing them).
 */
function NoticeRows() {
  const shown = useShownHosts();
  return (
    <AnimatePresence initial={false}>
      {shown.map((id, i) => (
        <StaleHost key={`stale:${id}`} hostId={id} order={i} />
      ))}
      {shown.map((id, i) => (
        <HerdrNotice key={`herdr:${id}`} hostId={id} order={i} />
      ))}
      {shown.map((id, i) => (
        <LinkAccountNudge key={`accounts:${id}`} hostId={id} order={i} />
      ))}
      {shown.map((id, i) => (
        <LowDiskNotice key={`disk:${id}`} hostId={id} order={i} />
      ))}
      {shown.map((id, i) => (
        <SetupGap key={`setup:${id}`} hostId={id} order={i} />
      ))}
      <DemoNotice key="demo" />
    </AnimatePresence>
  );
}

/** The desktop board's notice box above the lanes: one row per notice, one box, gone when there's nothing to say. */
export function BoardNotices() {
  return (
    <div className={noticeBox}>
      <NoticeRows />
    </div>
  );
}

/** Phone Flock: the same notices folded into one line (the most urgent one, its action, "+N") until expanded. */
export function PhoneNotices() {
  return (
    <NoticeTray>
      <NoticeRows />
    </NoticeTray>
  );
}
