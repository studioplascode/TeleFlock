import { Bot, Check, ChevronDown, FolderOpen, GitBranchPlus, GitFork, History, Plus, Send, Server } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { navigate, useHostIds, useHosts, useUi } from "@/core";
import type { ConnPhase, ConnStatus } from "@/core/gen";
import { cn, formatAge, spring, StatusOrb, useCalmMotion } from "@/design";
import { openNewAgent } from "@/features/workspace/NewAgentDialog";
import { haptic } from "@/features/shell/haptics";
import { closeSheet, openSheet } from "@/features/shell/sheets";
import { connSummary, hostsHealth, PHASE_LABEL, PHASE_STATUS } from "@/features/shell/status";
import { ACTIONS } from "@/features/shell/vocab";
import { useBoard } from "./boardStore";

/**
 * A host that is not online, in a few words for one-line strips (Flock, More):
 * "offline · 3h ago", "reconnecting in 12s", "sign-in required".
 */
export function connWords(status: ConnStatus | undefined, now: number): string {
  if (!status) return PHASE_LABEL.idle.toLowerCase();
  if (status.phase === "reconnecting" && status.nextRetryAt) return `reconnecting in ${Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000))}s`;
  const word = PHASE_LABEL[status.phase].toLowerCase();
  return status.lastOnlineAt && status.phase !== "online" ? `${word} · ${formatAge(now - status.lastOnlineAt)}` : word;
}

/** Big-tap sheet row: icon tile, label, hint, optional trailing mark. */
function SheetRow({ icon, label, hint, trailing, selected, onClick }: { icon: ReactNode; label: string; hint?: string; trailing?: ReactNode; selected?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        "flex min-h-13 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left pressable focus-ring",
        selected ? "bg-accent/12 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.035]",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white/[0.06] text-accent-hi [&_svg]:size-4.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-md font-bold text-ink">{label}</span>
        {/* hints are one-line descriptions; two lines on a narrow phone rather than cut off */}
        {hint && <span className="line-clamp-2 block text-xs text-mute">{hint}</span>}
      </span>
      {trailing}
    </button>
  );
}

function CreateActions() {
  const { openDialog } = useUi();
  const ids = useHostIds();
  const filter = useHosts((s) => s.filter);
  // The filtered host, else the first online one.
  const host = useHosts((s) => (filter !== "all" ? filter : (ids.find((id) => s.status[id]?.phase === "online") ?? ids[0])));
  const act = (run: (hostId: string | undefined) => void) => () => {
    haptic("select");
    closeSheet();
    run(host);
  };
  const row = (id: "newWorktree" | "newAgent" | "fanOut" | "openFolder" | "pastSessions", icon: ReactNode, run: (hostId: string | undefined) => void) => (
    <SheetRow icon={icon} label={ACTIONS[id].label} hint={ACTIONS[id].description} onClick={act(run)} />
  );
  return (
    <div className="flex flex-col gap-1">
      <SheetRow
        icon={<Send />}
        label={ACTIONS.newTask.label}
        hint={ACTIONS.newTask.description}
        onClick={() => {
          haptic("select");
          closeSheet();
          navigate({ name: "dispatch" });
        }}
      />
      {row("newWorktree", <GitBranchPlus />, (hostId) => openDialog({ kind: "newWorktree", hostId }))}
      {row("newAgent", <Bot />, (hostId) => openDialog({ kind: "newAgent", hostId }))}
      {row("fanOut", <GitFork />, (hostId) => openDialog({ kind: "fanOut", hostId }))}
      {row("openFolder", <FolderOpen />, (hostId) => openNewAgent({ hostId, openFolder: true }))}
      {row("pastSessions", <History />, (hostId) => openDialog({ kind: "pastSessions", hostId }))}
    </div>
  );
}

/**
 * Flock "+" button: floats above the bottom nav in the thumb zone and opens the create sheet.
 * Steps aside while a multi-select bar or the soft keyboard owns the bottom of the screen.
 */
export function FlockFab() {
  const picking = useBoard((s) => s.picked.length > 0);
  const calm = useCalmMotion();
  return (
    <AnimatePresence initial={false}>
      {!picking && (
        <motion.button
          key="fab"
          type="button"
          aria-label="Create"
          aria-haspopup="dialog"
          data-toast-anchor
          onClick={() => {
            haptic("tick");
            openSheet({ title: "Create", description: "Start something on your flock", content: <CreateActions /> });
          }}
          initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={calm ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 24 }}
          transition={calm ? { duration: 0.12 } : spring.bouncy}
          className="fixed right-3.5 bottom-[calc(66px+env(safe-area-inset-bottom))] z-sticky grid size-13 place-items-center rounded-[18px] bg-accent text-white shadow-[0_14px_34px_-8px_rgb(163_92_240/0.7),inset_0_1px_0_rgb(255_255_255/0.25)] pressable focus-ring in-data-[kb=open]:hidden [&_svg]:size-6"
        >
          <Plus strokeWidth={2.4} />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function HostRow({ hostId, selected }: { hostId: string; selected: boolean }) {
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const status = useHosts((s) => s.status[hostId]);
  return (
    <SheetRow
      icon={<StatusOrb status={PHASE_STATUS[status?.phase ?? "idle"]} size={10} label={null} />}
      label={name}
      hint={connSummary(status)}
      selected={selected}
      trailing={selected ? <Check className="size-5 shrink-0 text-accent-hi" aria-hidden /> : undefined}
      onClick={() => {
        haptic("select");
        useHosts.getState().setFilter(hostId);
        closeSheet();
      }}
    />
  );
}

function HostFilterList() {
  const ids = useHostIds();
  const filter = useHosts((s) => s.filter);
  const online = useHosts((s) => ids.filter((id) => s.status[id]?.phase === "online").length);
  return (
    <div className="flex flex-col gap-1">
      <SheetRow
        icon={<Server />}
        label="All hosts"
        hint={`${online}/${ids.length} online`}
        selected={filter === "all"}
        trailing={filter === "all" ? <Check className="size-5 shrink-0 text-accent-hi" aria-hidden /> : undefined}
        onClick={() => {
          haptic("select");
          useHosts.getState().setFilter("all");
          closeSheet();
        }}
      />
      {ids.map((id) => (
        <HostRow key={id} hostId={id} selected={filter === id} />
      ))}
      <button
        type="button"
        className="mt-1 self-center rounded-full px-4 py-2.5 text-sm font-bold text-accent-hi pressable focus-ring"
        onClick={() => {
          closeSheet();
          navigate({ name: "hosts" });
        }}
      >
        Manage hosts
      </button>
    </div>
  );
}

/**
 * Flock header host chip. One host: its health, tapping opens Hosts. Several: the current filter
 * ("All hosts" or one host), tapping opens the host-filter sheet. The orb is honest, like the
 * desktop HostPill: the worst phase across the hosts in view, amber with "1/2 online" when a host
 * is down; never green over a dead host.
 */
export function HostChip() {
  const ids = useHostIds();
  const filter = useHosts((s) => s.filter);
  const hostId = filter !== "all" ? filter : ids[0];
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const status = useHosts((s) => (hostId ? s.status[hostId] : undefined));
  // joined so the selector stays primitive
  const packed = useHosts((s) => ids.map((id) => s.status[id]?.phase ?? "idle").join(","));
  if (!hostId) return null;
  const multi = ids.length > 1;
  const all = multi && filter === "all";
  const health = hostsHealth(packed.split(",") as ConnPhase[]);
  const phase = status?.phase ?? "idle";
  const orb = all ? health.orb : PHASE_STATUS[phase];
  const down = all ? health.online < health.total : phase !== "online";
  const bad = all ? health.orb === "error" || health.orb === "needs-you" || health.online === 0 : orb === "error" || orb === "needs-you";
  const detail = all ? (down ? `${health.online}/${health.total} online` : `${health.total}`) : connSummary(status);
  return (
    <button
      type="button"
      aria-haspopup={multi ? "dialog" : undefined}
      aria-label={multi ? `Host filter: ${all ? "all hosts" : name}, ${detail}` : `${name}, ${detail}, open hosts`}
      onClick={() => (multi ? openSheet({ title: "Hosts", description: "Show agents from", content: <HostFilterList /> }) : navigate({ name: "hosts" }))}
      className={cn(
        "flex min-h-9 items-center gap-1.5 rounded-full glass px-3 py-1.5 text-xs font-bold text-ink pressable focus-ring touch-hit",
        down && (bad ? "shadow-[inset_0_0_0_1px_rgb(255_77_94/0.45)]" : "shadow-[inset_0_0_0_1px_rgb(251_191_36/0.4)]"),
      )}
    >
      {all && health.degraded ? (
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn shadow-[0_0_6px_rgb(251_191_36/0.7)]" />
      ) : (
        <StatusOrb status={orb} size={7} label={null} />
      )}
      {all ? "All hosts" : name}
      <span className={cn("tabular", !down ? "text-mute" : bad ? "text-[#ff9fb2]" : "text-warn")}>{detail}</span>
      {multi && <ChevronDown className="size-3.5 text-mute" aria-hidden />}
    </button>
  );
}
