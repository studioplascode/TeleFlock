import { ChevronDown, MoreHorizontal, Pencil, Plus, PowerOff, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  fadeRise,
  formatElapsed,
  IconButton,
  PageHeader,
  Sparkline,
  spring,
  StatusOrb,
  Tile,
  toast,
  useIsMobile,
} from "@/design";
import { core, navigate, useAgentKeys, useHosts, useHostState, useUi } from "@/core";
import type { ConnStatus, HostProfile } from "@/core/gen";
import { errorMessage } from "@/features/shell/errors";
import { useHealthHistory } from "@/features/shell/healthHistory";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { connSummary, PHASE_LABEL, PHASE_STATUS } from "@/features/shell/status";
import { ConnStatusCard, disconnect } from "./ConnStatusCard";
import { hostAccent, KIND_META, profileAddress } from "./kinds";
import { SetupChecklist } from "./SetupChecklist";
import { setupFromHash, useSetupFocus } from "./setupFocus";
import { ToolUpdatesRow } from "./ToolUpdates";

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)}`;
}

function Health({ hostId }: { hostId: string }) {
  const { health, cpu, mem } = useHealthHistory(hostId);
  if (!health) return null;
  const memPct = health.memTotal ? (health.memUsed / health.memTotal) * 100 : 0;
  const diskPct = health.diskTotal ? (1 - health.diskFree / health.diskTotal) * 100 : 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div className="min-w-0 rounded-md well p-2.5">
        <div className="kicker">CPU</div>
        <div className="font-display text-lg font-bold tabular">{Math.round(health.cpuPct)}%</div>
        <Sparkline values={cpu.length > 1 ? cpu : [health.cpuPct, health.cpuPct]} height={22} status="running" aria-label="CPU history" />
      </div>
      <div className="min-w-0 rounded-md well p-2.5">
        <div className="kicker">Memory</div>
        <div className="font-display text-lg font-bold whitespace-nowrap tabular">
          {gb(health.memUsed)}
          <span className="text-xs text-mute">/{gb(health.memTotal)} GB</span>
        </div>
        <Sparkline values={mem.length > 1 ? mem : [memPct, memPct]} height={22} status="review" aria-label="Memory history" />
      </div>
      <div className="col-span-2 min-w-0 rounded-md well p-2.5 sm:col-span-1">
        <div className="kicker">Disk · load</div>
        <div className="font-display text-lg font-bold tabular">
          {gb(health.diskFree)}
          <span className="text-xs text-mute"> GB free</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
          <motion.div className="h-full rounded-full bg-done" initial={{ width: 0 }} animate={{ width: `${diskPct}%` }} transition={spring.gentle} />
        </div>
        <div className="mt-1 font-mono text-2xs text-mute-2" title="Load average over the last minute, against the number of CPU cores">
          load {health.load1.toFixed(2)}
          {health.cores > 0 && <> / {health.cores} cores</>} · up {formatElapsed(health.uptimeS * 1000)}
        </div>
      </div>
    </div>
  );
}

function Counts({ hostId }: { hostId: string }) {
  const running = useAgentKeys({ hostId, column: "running" }).length;
  const needs = useAgentKeys({ hostId, column: "needs" }).length;
  const review = useAgentKeys({ hostId, column: "review" }).length;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone="running">{running} running</Badge>
      {needs > 0 && <Badge tone="needs-you">{needs} need you</Badge>}
      <Badge tone="review">{review} to review</Badge>
    </div>
  );
}

function Versions({ hostId }: { hostId: string }) {
  const info = useHostState(hostId)?.info;
  if (!info) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-mute-2">
      <span>{info.hostname}</span>
      <span>
        {info.os}/{info.arch}
      </span>
      {info.herdr && <span className={info.herdr.ok ? undefined : "text-warn"}>herdr {info.herdr.version}</span>}
      {info.omp && <span className={info.omp.ok ? undefined : "text-warn"}>omp {info.omp.version}</span>}
      <span>hostd {info.hostdVersion}</span>
      <span>session {info.herdrSession}</span>
    </div>
  );
}

/** "2 recommended · 1 optional": setup items left, in accent (warn when one is an error), never needs-you. */
function SetupBadge({ issues }: { issues: readonly { recommended: boolean; severity: string }[] }) {
  if (issues.length === 0) return <Badge tone="done">All set</Badge>;
  const recommended = issues.filter((i) => i.recommended).length;
  const optional = issues.length - recommended;
  const warn = issues.some((i) => i.severity === "error");
  const parts = [recommended > 0 && `${recommended} recommended`, optional > 0 && `${optional} optional`].filter(Boolean);
  return (
    <Badge tone="accent" className={cn(warn && "bg-warn/16 text-warn")}>
      {parts.join(" · ")}
    </Badge>
  );
}

function HostCard({ profile, status, index }: { profile: HostProfile; status: ConnStatus | undefined; index: number }) {
  const { openDialog } = useUi();
  const [setupOpen, setSetupOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const phase = status?.phase ?? "idle";
  const online = phase === "online";
  const active = phase !== "idle" && phase !== "offline" && phase !== "error";
  const issues = useHostState(profile.id)?.info.setup.issues;
  const issueCount = issues?.length ?? 0;
  const known = issues !== undefined;
  const pending = useSetupFocus((s) => s.pending[profile.id] === true);
  const seen = useSetupFocus((s) => s.seen[profile.id] === true);
  // Host setup opens by itself the first time a host shows up with open items, right after Add host,
  // and for `#/hosts?setup=<id>` (the board strip's Fix…); afterwards it stays as the user leaves it.
  useEffect(() => {
    if (!online || !known) return;
    const focus = useSetupFocus.getState();
    if (pending) {
      setSetupOpen(true);
      focus.consume(profile.id);
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    } else if (!seen && issueCount > 0) setSetupOpen(true);
    if (!seen) focus.markSeen(profile.id);
  }, [online, known, pending, seen, issueCount, profile.id]);
  const Kind = KIND_META[profile.kind].icon;
  return (
    <motion.div ref={ref} {...fadeRise} transition={{ ...spring.smooth, delay: index * 0.05 }} layout className="min-w-0 scroll-mt-4">
      <Tile className="flex flex-col gap-4 p-5 max-md:gap-3 max-md:p-3.5">
        <div className="flex items-start gap-3">
          <span
            className="relative grid size-11 shrink-0 place-items-center rounded-lg text-white shadow-d1 max-md:size-10 [&_svg]:size-5"
            style={{ background: `linear-gradient(135deg, ${hostAccent(profile.color)}, rgb(255 255 255 / 0.08))` }}
          >
            <Kind />
            <StatusOrb status={PHASE_STATUS[phase]} size={10} className="absolute -right-1 -bottom-1 rounded-full ring-3 ring-tile-2" label={PHASE_LABEL[phase]} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="max-w-full min-w-0 truncate font-display text-xl font-bold max-md:text-lg">{profile.name}</h3>
              <Badge>{KIND_META[profile.kind].short}</Badge>
              {profile.autoConnect && <Badge tone="accent">Auto</Badge>}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-mute">
              <span className="max-w-full min-w-0 truncate font-mono">{profileAddress(profile)}</span>
              <span aria-hidden>·</span>
              <span className={cn("font-semibold", online ? "text-done" : phase === "error" ? "text-error" : phase === "authRequired" || phase === "hostKey" ? "text-sun-2" : "text-mute")}>{connSummary(status)}</span>
            </div>
          </div>
          {active && (
            <Button size="sm" variant="ghost" icon={<PowerOff />} onClick={() => disconnect(profile.id)} aria-label={`Disconnect ${profile.name}`}>
              <span className="hidden sm:inline">Disconnect</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`More for ${profile.name}`} size="sm">
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={<Pencil />} onSelect={() => openDialog({ kind: "hostEditor", hostId: profile.id })}>
                Edit & test
              </DropdownMenuItem>
              {online && (
                <DropdownMenuItem icon={<ShieldCheck />} onSelect={() => setSetupOpen(true)}>
                  Host setup
                </DropdownMenuItem>
              )}
              {online && (
                <DropdownMenuItem icon={<SlidersHorizontal />} onSelect={() => navigate({ name: "omp", hostId: profile.id })}>
                  omp settings
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                icon={<Trash2 />}
                onSelect={() =>
                  core.app("hosts.remove", { hostId: profile.id }).then(
                    () => toast({ title: `Removed ${profile.name}` }),
                    (err: unknown) => toast({ title: `Couldn't remove: ${errorMessage(err)}`, status: "error" }),
                  )
                }
              >
                Remove host
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ConnStatusCard hostId={profile.id} status={status} />

        {online && (
          <>
            <Counts hostId={profile.id} />
            <Health hostId={profile.id} />
            <Versions hostId={profile.id} />
            <ToolUpdatesRow hostId={profile.id} />
            <div className="border-t border-line pt-3 max-md:pt-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm text-left text-sm font-bold text-ink-2 focus-ring max-md:min-h-10"
                aria-expanded={setupOpen}
                onClick={() => setSetupOpen((o) => !o)}
              >
                <ShieldCheck className="size-4 text-accent-hi" />
                Host setup
                <SetupBadge issues={issues ?? []} />
                <ChevronDown className={cn("ml-auto size-4 text-mute transition-transform", setupOpen && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {setupOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
                    <div className="pt-3">
                      <SetupChecklist hostId={profile.id} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </Tile>
    </motion.div>
  );
}

/** Hosts manager: every saved host with its live connection state, health, setup and actions. */
export function HostsView() {
  const { profiles, status } = useHosts();
  const { openDialog } = useUi();
  const mobile = useIsMobile();
  // `#/hosts?setup=<hostId>` (board strip "Fix…"): queue that host's setup to open, then drop the
  // query so the same link works again next time.
  useEffect(() => {
    const take = () => {
      const id = setupFromHash(window.location.hash);
      if (!id) return;
      useSetupFocus.getState().request(id);
      window.history.replaceState(window.history.state, "", "#/hosts");
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);
  const add = (
    <Button variant="primary" size={mobile ? "sm" : "md"} icon={<Plus />} onClick={() => openDialog({ kind: "hostEditor" })}>
      Add host
    </Button>
  );
  const online = profiles.filter((p) => status[p.id]?.phase === "online").length;
  return (
    <div className={cn("flex min-h-full flex-col", !mobile && "@container")}>
      {mobile && <MobileHeader title="Hosts" subtitle={`${profiles.length} saved`} back actions={add} />}
      <div className={cn("mx-auto grid w-full flex-1 content-start", mobile ? "gap-3 px-3 pt-1 pb-5" : "max-w-[1200px] gap-4 px-8 pt-7 pb-10 @[64rem]:grid-cols-2")}>
        {!mobile && (
          <PageHeader
            className="col-span-full mb-1"
            kicker="Connections"
            title="Hosts"
            meta={
              profiles.length > 0 && (
                <>
                  <StatusOrb status={online > 0 ? "done" : "idle"} size={7} label={null} />
                  {online}/{profiles.length} online
                </>
              )
            }
            description="Your herdr hosts. Tailscale SSH everywhere; local and WSL on this PC."
            actions={add}
          />
        )}
        {profiles.map((p, i) => (
          <HostCard key={p.id} profile={p} status={status[p.id]} index={i} />
        ))}
        {profiles.length === 0 && (
          <EmptyState
            className="col-span-full"
            icon={<Plus />}
            title="No hosts yet"
            description="Add the machine where herdr runs, or try the built-in demo."
            action={add}
          />
        )}
      </div>
    </div>
  );
}
