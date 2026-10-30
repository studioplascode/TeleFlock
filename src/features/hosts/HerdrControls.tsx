import { Power, RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { core, useCore } from "@/core";
import type { HerdrHealth } from "@/core/gen";
import { Button, cn, Dialog, DialogContent, Spinner, toast, useNow } from "@/design";
import { errorMessage } from "@/features/shell/errors";
import { forceRestartWarning, herdrDown, herdrHeadline, herdrStatus } from "./herdrHealth";

/** The host's herdr health (absent: an older host, or no herdr session). */
export function useHerdrHealth(hostId: string): HerdrHealth | undefined {
  return useCore((s) => s.hosts[hostId]?.state.info.herdrHealth);
}

/**
 * The host's herdr health while the host is online and its server is not up (down, starting, restarting,
 * not answering): what everything that shows agents, terminals or the composer of that host says instead
 * of Running. Undefined otherwise: an offline host shows its cached snapshot through the stale paths.
 */
export function useHerdrDown(hostId: string): HerdrHealth | undefined {
  return useCore((s) => {
    const h = s.hosts[hostId]?.state.info.herdrHealth;
    return herdrDown(h) && s.status[hostId]?.phase === "online" ? h : undefined;
  });
}

/** `useHerdrDown`'s state alone, for cards that only need to know (a primitive: info patches don't re-render them). */
export function useHerdrDownState(hostId: string): HerdrHealth["state"] | undefined {
  return useCore((s) => {
    const h = s.hosts[hostId]?.state.info.herdrHealth;
    return herdrDown(h) && s.status[hostId]?.phase === "online" ? h.state : undefined;
  });
}

/** Where running timers stop while herdr is down: when the outage began. */
export function useHerdrFreeze(hostId: string): number | undefined {
  return useCore((s) => {
    const h = s.hosts[hostId]?.state.info.herdrHealth;
    return herdrDown(h) && s.status[hostId]?.phase === "online" ? (h.downAt ?? h.since) : undefined;
  });
}

/** The host's display name. */
export function useHostName(hostId: string): string {
  return useCore((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
}

/** Calls `host.herdrRestart` and says so when it fails. Resolves true when hostd accepted it. */
export async function restartHerdr(hostId: string, force: boolean): Promise<boolean> {
  try {
    await core.host(hostId).call("host.herdrRestart", force ? { force: true } : {});
    return true;
  } catch (err) {
    toast({ title: "Couldn't restart herdr", description: errorMessage(err), status: "error" });
    return false;
  }
}

/** A short confirm for what ends running work. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirm}
            </Button>
          </>
        }
      >
        <p className="text-sm text-mute">{body}</p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Restart herdr": starts a stopped server at once (skipping the backoff). A server that still answers
 * slowly or not at all (`unresponsive`) is replaced only after a confirm that says every agent and
 * terminal of the session ends. Disabled while TeleFlock is already stopping or starting it.
 */
export function RestartHerdrButton({ hostId, health, size = "sm", variant = "secondary", className }: { hostId: string; health: HerdrHealth; size?: "sm" | "md"; variant?: "secondary" | "primary"; className?: string }) {
  const name = useHostName(hostId);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const force = health.state === "unresponsive";
  const busy = health.state === "starting" || health.state === "restarting";
  const run = async () => {
    setPending(true);
    try {
      await restartHerdr(hostId, force);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button size={size} variant={variant} className={cn("shrink-0", className)} icon={<RotateCw />} loading={pending || busy} disabled={busy} onClick={() => (force ? setConfirming(true) : void run())}>
        Restart herdr
      </Button>
      {force && (
        <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`Restart herdr on ${name}?`} body={forceRestartWarning(name)} confirm="Restart herdr" danger onConfirm={() => void run()} />
      )}
    </>
  );
}

/** The status line of a herdr that is not up: counts down while it has a clock in it. */
export function HerdrStatusText({ health, className }: { health: HerdrHealth; className?: string }) {
  const counting = health.state === "down" && health.retryAt !== undefined;
  const now = useNow(counting ? 1000 : 30_000);
  return <span className={className}>{herdrStatus(health, now)}</span>;
}

/** The host card's herdr line: "herdr 0.9.5 · up", or what is wrong with it and the way to restart it. */
export function HerdrHostRow({ hostId }: { hostId: string }) {
  const health = useHerdrHealth(hostId);
  if (!health) return null;
  const down = health.state !== "up";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" data-testid="herdr-health" data-state={health.state}>
      <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-2xs font-semibold", down ? "text-warn" : "text-ink-2")}>
        {health.state === "starting" || health.state === "restarting" || health.state === "updating" ? <Spinner size={12} label={health.state} /> : <Power className="size-3" aria-hidden />}
        herdr{health.version ? ` ${health.version}` : ""} · {health.state}
      </span>
      {down && (
        <>
          <span className="min-w-0 flex-[1_1_14rem] text-mute">
            <b className="text-ink">{herdrHeadline(health)}</b> · <HerdrStatusText health={health} />
          </span>
          {herdrDown(health) && <RestartHerdrButton hostId={hostId} health={health} />}
        </>
      )}
    </div>
  );
}
