import { Check, ChevronDown, Pencil, Plug, PlugZap, Plus, Search, Server, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Heartbeat,
  Kbd,
  NumberTicker,
  popIn,
  StatusOrb,
  type Status,
  Tooltip,
} from "@/design";
import { navigate, useHosts, useUi } from "@/core";
import { connect, disconnect } from "@/features/hosts/ConnStatusCard";
import { useFlockCounts, useGlobalMood, useGlobalPulse } from "./liveness";
import { connSummary, PHASE_LABEL, PHASE_STATUS } from "./status";

/** Host switcher: the current host filter with its live orb + latency; menu to switch/connect/manage. */
export function HostPill() {
  const { profiles, status, filter, setFilter } = useHosts();
  const { openDialog } = useUi();
  const current = filter === "all" ? undefined : profiles.find((p) => p.id === filter);
  const online = profiles.filter((p) => status[p.id]?.phase === "online").length;
  // "All hosts": the worst phase wins the orb (auth > error > connecting > online).
  const phases = profiles.map((p) => status[p.id]?.phase ?? "idle");
  const orb: Status = current
    ? PHASE_STATUS[status[current.id]?.phase ?? "idle"]
    : phases.includes("authRequired")
      ? "needs-you"
      : phases.includes("error")
        ? "error"
        : phases.some((p) => p === "connecting" || p === "reconnecting" || p === "authenticating" || p === "deploying" || p === "starting")
          ? "running"
          : online > 0
            ? "done"
            : "idle";
  const label = current ? current.name : profiles.length === 1 ? (profiles[0]?.name ?? "No host") : "All hosts";
  const detail = current ? connSummary(status[current.id]) : profiles.length === 1 && profiles[0] ? connSummary(status[profiles[0].id]) : `${online}/${profiles.length} online`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-2 rounded-full bg-white/5 pr-2 pl-2.5 text-xs font-bold text-ink-2 shadow-hairline pressable focus-ring hover:bg-white/9 data-[state=open]:bg-white/10"
          aria-label={`Host: ${label}, ${detail}`}
        >
          <StatusOrb status={orb} size={8} label={null} />
          <span className="max-w-[140px] truncate">{label}</span>
          <span className="font-mono text-2xs font-semibold text-mute tabular">{detail}</span>
          <ChevronDown className="size-3.5 text-mute" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Hosts</DropdownMenuLabel>
        {profiles.length > 1 && (
          <DropdownMenuItem icon={filter === "all" ? <Check /> : <PlugZap />} onSelect={() => setFilter("all")}>
            All hosts <span className="text-2xs text-mute-2">{online} online</span>
          </DropdownMenuItem>
        )}
        {profiles.map((p) => {
          const s = status[p.id];
          const phase = s?.phase ?? "idle";
          return (
            <DropdownMenuItem
              key={p.id}
              icon={<StatusOrb status={PHASE_STATUS[phase]} size={9} label={null} />}
              onSelect={() => (phase === "online" ? setFilter(p.id) : void connect(p.id))}
            >
              <span className="flex w-full items-center gap-2">
                <span className="truncate">{p.name}</span>
                {filter === p.id && <Check className="!size-3.5 !text-accent" />}
                <span className={cn("ml-auto font-mono text-2xs", phase === "online" ? "text-mute" : phase === "authRequired" ? "text-sun-2" : "text-mute-2")}>
                  {phase === "online" ? connSummary(s) : PHASE_LABEL[phase]}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {current && (
          <>
            <DropdownMenuSeparator />
            {status[current.id]?.phase === "online" || status[current.id]?.phase === "reconnecting" ? (
              <DropdownMenuItem icon={<Unplug />} onSelect={() => void disconnect(current.id)}>
                Disconnect {current.name}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={<Plug />} onSelect={() => void connect(current.id)}>
                Connect {current.name}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem icon={<Pencil />} onSelect={() => openDialog({ kind: "hostEditor", hostId: current.id })}>
              Edit {current.name}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Plus />} onSelect={() => openDialog({ kind: "hostEditor" })}>
          Add host…
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Server />} shortcut="Ctrl 5" onSelect={() => navigate({ name: "hosts" })}>
          Manage hosts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Aggregated ECG of every agent: spikes on any pulse, flatlines when the whole flock is quiet. */
export function GlobalHeartbeat({ className }: { className?: string }) {
  const { beat, lastAt } = useGlobalPulse();
  const mood = useGlobalMood();
  const { running } = useFlockCounts();
  const status: Status = mood === "attention" ? "needs-you" : mood === "error" ? "error" : mood === "running" ? "running" : "idle";
  return (
    <Tooltip content={running ? `${running} agent${running === 1 ? "" : "s"} running` : "The flock is resting"}>
      <div className={cn("flex w-[150px] items-center", className)} role="img" aria-label={`Global heartbeat: ${running} running`}>
        <Heartbeat beat={beat} lastEventAt={lastAt} status={status} height={22} staleAfterMs={120_000} className="w-full" />
      </div>
    </Tooltip>
  );
}

/** The Ctrl+K search field (a button that opens the palette). */
export function SearchField() {
  const { setPalette } = useUi();
  return (
    <button
      type="button"
      onClick={() => setPalette(true)}
      className="group flex h-7 w-[260px] items-center gap-2 rounded-full bg-black/25 pr-1.5 pl-3 text-xs text-mute-2 shadow-[inset_0_0_0_1px_var(--color-line-2)] transition-[box-shadow,background-color] focus-ring hover:bg-black/35 hover:shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)] lg:w-[300px]"
      aria-label="Search and commands (Ctrl+K)"
    >
      <Search className="size-3.5 transition-colors group-hover:text-accent-hi" />
      <span className="flex-1 truncate text-left">Search agents, run a command</span>
      <span className="flex gap-0.5">
        <Kbd className="h-[18px]">Ctrl</Kbd>
        <Kbd className="h-[18px]">K</Kbd>
      </span>
    </button>
  );
}

/** Needs-you counter: sunset pill that pulses while anything waits on you; opens the inbox. */
export function NeedsCounter() {
  const { needs } = useFlockCounts();
  const { setAnswerNext } = useUi();
  return (
    <AnimatePresence initial={false}>
      {needs > 0 && (
        <motion.div {...popIn} key="needs">
          <Tooltip content="Open the inbox" shortcut="Ctrl J">
            <button
              type="button"
              onClick={() => navigate({ name: "inbox" })}
              onDoubleClick={() => setAnswerNext(true)}
              className="sun-pulse flex h-7 items-center gap-1.5 rounded-full bg-sun pr-3 pl-2 text-xs font-extrabold text-white pressable focus-ring"
              aria-label={`${needs} agent${needs === 1 ? "" : "s"} need you`}
            >
              <span className="relative grid size-4 place-items-center">
                <span className="tf-loop absolute inset-0 animate-ping rounded-full bg-white/60" />
                <span className="size-2 rounded-full bg-white" />
              </span>
              <NumberTicker value={needs} />
              <span>need{needs === 1 ? "s" : ""} you</span>
            </button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
