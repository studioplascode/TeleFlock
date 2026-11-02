import { Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCore, useHosts } from "@/core";
import type { IdleShell } from "@/core/gen";
import { Button, Spinner, Switch, Tile, cn, useNow } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { closedText, idleText, ruleText, spanText } from "./idleShells";
import { ThresholdSelect, closeIdleShells, useIdleShellsSave } from "./idleShellControls";
import { useIdleShellsPrefs } from "./idleShellsStore";

/** One idle shell: where it is, how long it has been idle, what ran in it last, and its own Close. */
function ShellRow({ shell: s, home, now, busy, disabled, onClose }: { shell: IdleShell; home?: string; now: number; busy: boolean; disabled: boolean; onClose(): void }) {
  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5", busy && "opacity-50")}>
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Terminal className="size-3.5 shrink-0 text-mute" aria-hidden />
          <span className="min-w-0 truncate text-sm font-bold text-ink">{s.workspace}</span>
          <span className="shrink-0 rounded-full bg-ink/6 px-1.5 font-mono text-2xs font-semibold text-mute">{s.shell}</span>
        </span>
        {s.cwd && (
          <span className="min-w-0 truncate font-mono text-2xs text-mute-2" title={s.cwd}>
            {tildify(s.cwd, home)}
          </span>
        )}
      </div>
      <div className="flex w-72 min-w-0 shrink-0 flex-col gap-0.5 text-xs text-mute max-md:order-last max-md:w-full">
        <span>
          idle <b className="font-semibold text-ink-2">{idleText(now - s.idleSince)}</b>
          {s.closesWorkspace && " · closes its workspace"}
        </span>
        {s.lastCommand && (
          <span className="min-w-0 truncate" title={s.lastCommand}>
            last: <span className="font-mono text-ink-2">{s.lastCommand}</span>
          </span>
        )}
      </div>
      <Button size="sm" variant="secondary" icon={busy ? <Spinner /> : <X />} className="shrink-0" disabled={disabled || busy} onClick={onClose}>
        Close
      </Button>
    </li>
  );
}

const USER_SCROLL = ["wheel", "touchstart", "keydown"] as const;

/**
 * Scrolls the section to the top of the page and keeps it there for 2 s while sections above it still fill in
 * (worktrees, chats), until the user scrolls.
 */
function bringIntoView(el: HTMLElement | null): void {
  const page = el?.parentElement;
  if (!el || !page) return;
  const place = () => el.scrollIntoView({ block: "start" });
  const watch = new ResizeObserver(place);
  const stop = () => {
    watch.disconnect();
    for (const ev of USER_SCROLL) window.removeEventListener(ev, stop);
  };
  place();
  watch.observe(page);
  for (const ev of USER_SCROLL) window.addEventListener(ev, stop, { passive: true });
  setTimeout(stop, 2000);
}

/**
 * Cleanup page: one host's idle shells (`HostInfo.idleShells`), whether tf-hostd closes them by itself and
 * after how long, each with its own Close, and Close all. Nothing for a host before 0.9.0 (no `idleShells`).
 */
export function IdleShellsSection({ hostId }: { hostId: string }) {
  const idle = useCore((s) => s.hosts[hostId]?.state.info.idleShells);
  const home = useCore((s) => s.hosts[hostId]?.state.info.home);
  const online = useHosts((s) => s.status[hostId]?.phase === "online");
  const name = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const focus = useIdleShellsPrefs((s) => s.focus === hostId);
  const setFocus = useIdleShellsPrefs((s) => s.setFocus);
  const now = useNow(60_000);
  const { saving, save } = useIdleShellsSave(hostId);
  // `host\npane` of the shells being closed (the page can switch hosts meanwhile)
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const ref = useRef<HTMLElement>(null);
  const shown = idle !== undefined;
  // The board's Review: bring the section into view once it shows.
  useEffect(() => {
    if (!focus || !shown) return;
    setFocus(null);
    bringIntoView(ref.current);
  }, [focus, shown, setFocus]);
  if (!idle) return null;

  const shells = idle.shells;
  const n = shells.length;
  const busy = (s: IdleShell) => closing.has(`${hostId}\n${s.paneId}`);
  const close = async (some: readonly IdleShell[], ask: boolean) => {
    const keys = some.map((s) => `${hostId}\n${s.paneId}`);
    await closeIdleShells(hostId, name, some, { ask, home, onStart: () => setClosing((c) => new Set([...c, ...keys])) });
    setClosing((c) => new Set([...c].filter((k) => !keys.includes(k))));
  };

  return (
    <section ref={ref} aria-label="Idle shells" className="flex scroll-mt-4 flex-col gap-3 max-md:scroll-mt-16">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold">
          <Terminal className="size-4 text-mute" /> Idle shells
        </h2>
        {n > 0 && <span className="rounded-full bg-ink/6 px-1.5 text-2xs font-semibold text-mute tabular">{n}</span>}
        {n > 0 && (
          <Button size="sm" variant="danger" icon={<X />} className="ml-auto" disabled={!online || shells.some(busy)} onClick={() => void close(shells, true)}>
            Close all…
          </Button>
        )}
      </div>
      <Tile className="flex flex-col gap-3 p-4 max-md:p-3.5">
        <p className="text-xs text-mute">
          {ruleText(idle.minutes)}. {idle.auto ? "TeleFlock closes them by itself." : "TeleFlock leaves them open until you close them."}
        </p>
        {idle.notice && <p className="rounded-md bg-warn/8 px-3 py-2 text-xs font-semibold text-warn shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warn)_35%,transparent)]">{idle.notice}</p>}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2.5 text-sm font-semibold text-ink">
            <Switch checked={idle.auto} disabled={!online || saving} onCheckedChange={(auto) => save({ auto })} />
            Close idle shells automatically
          </label>
          <span className="flex items-center gap-2 text-xs text-mute">
            Idle after
            <ThresholdSelect minutes={idle.minutes} disabled={!online || saving} onChange={(minutes) => save({ minutes })} className="h-8 min-w-24 text-xs" />
          </span>
        </div>
        {n > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-md well">
            {shells.map((s) => (
              <ShellRow key={s.paneId} shell={s} home={home} now={now} busy={busy(s)} disabled={!online} onClose={() => void close([s], false)} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-2">
            No idle shells. Shells nobody uses {idle.auto ? "close by themselves" : "show up here"} after {spanText(idle.minutes)}.
          </p>
        )}
        {idle.lastClosed && <p className="border-t border-line pt-2 text-xs text-mute">{closedText(idle.lastClosed, now)}</p>}
      </Tile>
    </section>
  );
}
