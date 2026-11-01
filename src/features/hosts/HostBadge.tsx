import { Pencil, Server } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { navigate, useCore, useHosts, useUi } from "@/core";
import { Button, cn, Popover, PopoverContent, PopoverTrigger, StatusOrb } from "@/design";
import { connSummary, PHASE_LABEL, PHASE_STATUS } from "@/features/shell/status";
import { hostAccent, KIND_META, kindBadge, profileAddress } from "./kinds";

const OS_NAME: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/** Delay before a hovering mouse opens the details, and before leaving closes them (so the pointer can cross into them). */
const OPEN_MS = 280;
const CLOSE_MS = 140;

/** Whether the app has more than one host: a lone host is the whole app, so rows don't repeat its name (the board's rule). */
export function useMultiHost(): boolean {
  return useHosts((s) => s.profiles.length > 1);
}

/**
 * A host's name inside text cut to one row (a phone toast, the pager list, "Next:"): at most 40% of
 * the row, with its own ellipsis, so a long user-chosen name never pushes the rest out.
 */
export function HostName({ name }: { name: string }) {
  return <span className="inline-block max-w-[40%] truncate align-bottom">{name}</span>;
}

/**
 * Which host an agent or session is on: the host's identity swatch and name as a compact chip,
 * with its details (connection kind and address, hostname and OS, connection state) one hover or
 * tap away, and a way into the host. With a single host it renders nothing, like the board's cards.
 * The chip shrinks and truncates its name (cap it with `className`), so a long label never pushes
 * out what sits beside it.
 */
export function HostBadge({ hostId, className }: { hostId: string; className?: string }) {
  const multi = useMultiHost();
  const profile = useHosts((s) => s.profiles.find((p) => p.id === hostId));
  const status = useHosts((s) => s.status[hostId]);
  const info = useCore((s) => s.hosts[hostId]?.state.info);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // How the details opened. A hovering mouse leaves focus where it is (a composer keeps it), and a
  // click on the chip then keeps them open rather than closing what the hover showed. Enter / Space
  // (a click without a pointer, `detail` 0) moves focus into them, so their buttons are reachable.
  const via = useRef<"hover" | "pointer" | "key">("pointer");
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!multi) return null;

  const name = profile?.name ?? hostId;
  const phase = status?.phase ?? "idle";
  const online = phase === "online";
  const later = (to: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(to), ms);
  };
  // Only a mouse hovers; touch and keyboard use the click that Radix toggles.
  const hover = (to: boolean, ms: number) => (e: { pointerType: string }) => {
    if (e.pointerType === "mouse") later(to, ms);
  };
  const detail = (label: string, value: ReactNode) => (
    <div className="flex items-baseline gap-3">
      <dt className="w-16 shrink-0 text-2xs font-bold text-mute">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-ink-2">{value}</dd>
    </div>
  );
  const kind = profile ? (profile.kind === "tailscaleSsh" ? kindBadge(profile) : KIND_META[profile.kind].short) : undefined;
  const os = info ? [OS_NAME[info.os] ?? info.os, info.arch].filter(Boolean).join(" · ") : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        window.clearTimeout(timer.current);
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Host ${name}, ${PHASE_LABEL[phase].toLowerCase()}. Show details`}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse" && !open) via.current = "hover";
            hover(true, OPEN_MS)(e);
          }}
          onPointerLeave={hover(false, CLOSE_MS)}
          onClick={(e) => {
            // Runs before Radix's toggle, which a prevented click skips.
            if (open && via.current === "hover" && e.detail > 0) e.preventDefault();
            via.current = e.detail === 0 ? "key" : "pointer";
          }}
          className={cn(
            "focus-ring relative inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-xs bg-ink/6 py-px pr-1.5 pl-1 text-2xs font-bold text-ink-2 hover:bg-ink/10",
            // a 24 px tap target around the 18 px chip, without growing the header
            "before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-['']",
            className,
          )}
        >
          <span className="h-2.5 w-1 shrink-0 rounded-full" style={{ background: hostAccent(profile?.color) }} aria-hidden />
          <span className="truncate">{name}</span>
          {!online && <StatusOrb status={PHASE_STATUS[phase]} size={6} label={null} />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-1.5rem)]"
        onOpenAutoFocus={(e) => {
          if (via.current !== "key") e.preventDefault();
        }}
        onPointerEnter={hover(true, 0)}
        onPointerLeave={hover(false, CLOSE_MS)}
      >
        <div className="flex items-center gap-2">
          <span className="h-4 w-1.5 shrink-0 rounded-full" style={{ background: hostAccent(profile?.color) }} aria-hidden />
          <span className="min-w-0 flex-1 break-words font-display text-md font-bold text-ink">{name}</span>
          {kind && <span className="shrink-0 rounded-xs bg-ink/6 px-1.5 py-px text-2xs font-bold text-mute">{kind}</span>}
        </div>
        <dl className="mt-2.5 flex flex-col gap-1.5">
          {detail(
            "State",
            <span className="inline-flex items-center gap-1.5">
              <StatusOrb status={PHASE_STATUS[phase]} size={7} label={null} />
              {PHASE_LABEL[phase]}
              {online && status?.latencyMs !== undefined && <span className="font-mono text-mute">· {connSummary(status)}</span>}
            </span>,
          )}
          {profile && detail("Address", <span className="font-mono">{profileAddress(profile)}</span>)}
          {info?.hostname && detail("Hostname", <span className="font-mono">{info.hostname}</span>)}
          {os && detail("System", os)}
        </dl>
        <div className="mt-3 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<Server />}
            onClick={() => {
              setOpen(false);
              navigate({ name: "hosts" });
            }}
          >
            Open hosts
          </Button>
          {profile && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil />}
              onClick={() => {
                setOpen(false);
                useUi.getState().openDialog({ kind: "hostEditor", hostId });
              }}
            >
              Edit
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
