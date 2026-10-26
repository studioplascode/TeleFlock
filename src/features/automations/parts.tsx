import { ArrowUpCircle, CircleAlert, CircleCheck, Globe2, Server } from "lucide-react";
import { navigate, useHostState } from "@/core";
import type { AutomationRun, AutomationScheduler } from "@/core/gen";
import { Button, Chip, EmptyState, Tile, cn } from "@/design";
import { CopyCommand } from "@/features/hosts/CopyCommand";
import { RUN_STATUS, TRIGGER_LABEL, formatWhen } from "./format";

/**
 * What keeps this host's automations running: systemd timer active, lingering missing, timer
 * failed, or daemon-only. `systemd` without `persistent` and without a note means nothing is
 * enabled yet, so hostd has not installed the timer (it does on the first enabled automation).
 */
export function SchedulerBanner({ scheduler, className }: { scheduler: AutomationScheduler; className?: string }) {
  const systemd = scheduler.kind === "systemd";
  const idle = systemd && !scheduler.persistent && !scheduler.note;
  const ok = systemd && (scheduler.persistent || idle);
  const command = scheduler.note?.match(/loginctl enable-linger(?: [\w.@-]+)?/)?.[0];
  const title = ok
    ? "Runs even when no app is connected"
    : command
      ? "Stops when you log out of this host"
      : systemd
        ? "The systemd timer is not active"
        : "Runs only while tf-hostd is running";
  const body = idle
    ? "When you enable an automation, a systemd timer keeps tf-hostd running across reboots and crashes, so every schedule fires on time."
    : ok
      ? "A systemd timer keeps tf-hostd running across reboots and crashes, so every schedule fires on time."
      : command
        ? "Without lingering, your user's services end with your last login session and don't start at boot."
        : systemd
          ? "Schedules fire while tf-hostd runs; after a reboot they wait until an app connects."
          : "tf-hostd starts when a TeleFlock app connects; schedules that come due while it's down are missed (or caught up, if the automation asks).";
  return (
    <Tile
      data-status={ok ? "done" : "needs-you"}
      className={cn("flex items-start gap-3 p-4 max-md:p-3.5", ok ? "shadow-[inset_0_0_0_1px_rgb(var(--st-rgb)/0.22)]" : "shadow-[inset_0_0_0_1px_rgb(var(--st-rgb)/0.35)]", className)}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md st-soft max-md:size-8 [&_svg]:size-4">{ok ? <CircleCheck /> : <CircleAlert />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <span className="ml-auto inline-flex items-center gap-1 text-2xs font-semibold text-mute" title="Schedules use the host's local time">
            <Globe2 className="size-3" />
            Host time · <span className="font-mono text-ink-2">{scheduler.timezone}</span>
          </span>
        </div>
        <p className="text-xs text-mute">{body}</p>
        {scheduler.note && <p className="text-xs text-ink-2">{scheduler.note}</p>}
        {command && <CopyCommand command={command} className="mt-0.5 self-start" />}
      </div>
    </Tile>
  );
}

/** Status chip of one run; opens the run's agent while it's still on the host. */
export function RunChip({ hostId, run, className }: { hostId: string; run: AutomationRun; className?: string }) {
  const live = useHostState(hostId)?.agents.some((a) => a.id === run.agentId) ?? false;
  const meta = RUN_STATUS[run.status];
  const title = [`${meta.label} · ${TRIGGER_LABEL[run.trigger]} · ${formatWhen(run.at)}`, run.error, run.agentId && !live ? "The agent has since closed" : null].filter(Boolean).join("\n");
  const chip = (
    <Chip tone={meta.tone} className={cn("max-w-full", className)}>
      <span className="truncate">{meta.label}</span>
    </Chip>
  );
  if (!run.agentId || !live) return <span title={title}>{chip}</span>;
  return (
    <button
      type="button"
      title={`${title}\nOpen the agent`}
      className="rounded-full pressable focus-ring hover:brightness-125"
      onClick={() => navigate({ name: "agent", hostId, agentId: run.agentId as string })}
    >
      {chip}
    </button>
  );
}

/** The host's tf-hostd answers `unknown_method`: it predates automations. */
export function OutdatedHost({ hostName }: { hostName: string }) {
  return (
    <EmptyState
      icon={<ArrowUpCircle />}
      title={`Update TeleFlock on ${hostName}`}
      description={
        <>
          The tf-hostd running on this host predates automations. TeleFlock installs its own tf-hostd when it connects, so update this app and reconnect the
          host; it updates by itself.
        </>
      }
      action={
        <Button variant="secondary" icon={<Server />} onClick={() => navigate({ name: "hosts" })}>
          Hosts
        </Button>
      }
      className="mt-6"
    />
  );
}
