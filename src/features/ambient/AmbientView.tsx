import { Bell, BellOff, BellRing, Expand, Orbit, Play, Shrink, Sun, SunDim, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { navigate, selectAgentKeys, useCore } from "@/core";
import { Button, cn, EmptyState, IconButton, Popover, PopoverContent, PopoverTrigger, Switch, Tooltip, useIsMobile, useNow } from "@/design";
import { isTyping } from "@/features/inbox/AnswerParts";
import { STATE_WORD, VIEWS } from "@/features/shell/vocab";
import { AmbientOrb } from "./AmbientOrb";
import { CHIME_KINDS, type ChimeKind, playChime, unlockChimes } from "./chimes";
import { fitOrbs } from "./layout";
import { useAmbientPrefs } from "./prefs";
import { fullscreenSupported, toggleFullscreen, useFullscreen, useWakeLock, wakeLockSupported } from "./screen";
import { useAmbientChimes } from "./useAmbientChimes";

const CHIME_LABEL: Record<ChimeKind, { label: string; hint: string }> = {
  needs: { label: STATE_WORD.needs, hint: "A question, approval or plan to review" },
  review: { label: "Finished", hint: "A turn ended: ready to review" },
  running: { label: "Back to work", hint: "Started or resumed after your answer" },
  done: { label: "Marked done", hint: "Moved to Done (here or anywhere)" },
};

function ChimeMenu() {
  const chime = useAmbientPrefs((s) => s.chime);
  const chimeOn = useAmbientPrefs((s) => s.chimeOn);
  const prefs = useAmbientPrefs.getState;
  const Icon = chime ? BellRing : BellOff;
  return (
    <Popover>
      <Tooltip content={chime ? "Chimes on" : "Chimes off"}>
        <PopoverTrigger asChild>
          <IconButton label="Chimes" aria-pressed={chime}>
            <Icon className={cn(chime && "text-accent-hi")} />
          </IconButton>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(340px,calc(100vw-24px))]">
        <label className="flex cursor-pointer items-center gap-3 pb-2">
          <Bell className="size-4 text-mute" aria-hidden />
          <span className="flex-1 font-bold text-ink">Chime when an agent changes state</span>
          <Switch
            checked={chime}
            label="Chimes"
            onCheckedChange={(on) => {
              prefs().setChime(on);
              // this click is the gesture that lets the page play sound later
              if (on) {
                unlockChimes();
                playChime("needs");
              }
            }}
          />
        </label>
        <ul className={cn("flex flex-col gap-0.5 border-t border-line pt-2", !chime && "opacity-50")}>
          {CHIME_KINDS.map((kind) => (
            <li key={kind} className="flex items-center gap-2">
              <IconButton
                label={`Play the ${CHIME_LABEL[kind].label} chime`}
                size="sm"
                onClick={() => {
                  unlockChimes();
                  playChime(kind);
                }}
              >
                <Play />
              </IconButton>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-ink-2">{CHIME_LABEL[kind].label}</span>
                <span className="block text-2xs text-mute-2">{CHIME_LABEL[kind].hint}</span>
              </span>
              <Switch checked={chimeOn[kind]} disabled={!chime} label={`Chime: ${CHIME_LABEL[kind].label}`} onCheckedChange={(on) => prefs().setChimeOn(kind, on)} />
            </li>
          ))}
        </ul>
        <p className="mt-2.5 border-t border-line pt-2 text-2xs leading-relaxed text-mute-2">
          One chime at a time: changes close together share one, an agent repeating itself stays quiet for 30 s. Muted agents and quiet hours stay silent;
          notification sounds (Settings) are separate.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function Clock({ className }: { className?: string }) {
  const now = useNow(15_000);
  return (
    <time className={cn("font-display font-bold text-ink-2 tabular", className)} dateTime={new Date(now).toISOString()}>
      {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** "2 need you · 5 running · 3 to review" in the states' colours. */
function Summary({ mobile }: { mobile: boolean }) {
  const counts = useCore((s) => {
    const c = { needs: 0, running: 0, review: 0 };
    for (const a of Object.values(s.agents)) if (a.column !== "done") c[a.column] += 1;
    return c;
  }, shallow);
  const parts = [
    { status: "needs-you", n: counts.needs, word: "need you" },
    { status: "running", n: counts.running, word: "running" },
    { status: "review", n: counts.review, word: "to review" },
  ].filter((p) => p.n > 0);
  if (parts.length === 0) return <span className="text-sm font-bold text-mute">All quiet</span>;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 font-bold", mobile ? "text-sm" : "text-base")}>
      {parts.map((p) => (
        <span key={p.status} data-status={p.status} className="whitespace-nowrap">
          <span className="st-text tabular">{p.n}</span> <span className="text-mute">{p.word}</span>
        </span>
      ))}
    </span>
  );
}

function AmbientBar({ mobile }: { mobile: boolean }) {
  const keepAwake = useAmbientPrefs((s) => s.keepAwake);
  const showDone = useAmbientPrefs((s) => s.showDone);
  const awake = useWakeLock(keepAwake);
  const full = useFullscreen();
  return (
    <div className={cn("flex shrink-0 items-center gap-2", mobile ? "px-3 pt-2 pb-1" : "px-5 pt-3 pb-2")}>
      <Orbit className="size-4 shrink-0 text-accent-hi" aria-hidden />
      <h1 className="sr-only">{VIEWS.ambient.label}</h1>
      <Summary mobile={mobile} />
      <Clock className={cn("ml-auto shrink-0", mobile ? "text-lg" : "text-2xl")} />
      {/* the controls stay quiet until you reach for them */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
        <ChimeMenu />
        {wakeLockSupported && (
          <Tooltip content={keepAwake ? (awake ? "Keeping the screen on" : "Keep the screen on (when shown)") : "Let the screen sleep"}>
            <IconButton label="Keep the screen on" aria-pressed={keepAwake} onClick={() => useAmbientPrefs.getState().setKeepAwake(!keepAwake)}>
              {keepAwake ? <Sun className="text-accent-hi" /> : <SunDim />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip content={showDone ? "Hide done agents" : "Show done agents"}>
          <IconButton label="Show done agents" aria-pressed={showDone} onClick={() => useAmbientPrefs.getState().setShowDone(!showDone)}>
            <span className={cn("grid size-4 place-items-center rounded-full border-2", showDone ? "border-done bg-done/40" : "border-mute")} aria-hidden />
          </IconButton>
        </Tooltip>
        {fullscreenSupported && (
          <Tooltip content={full ? "Leave full screen" : "Full screen"}>
            <IconButton label="Full screen" aria-pressed={full} onClick={toggleFullscreen}>
              {full ? <Shrink /> : <Expand />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip content="Leave ambient mode" shortcut="Esc">
          <IconButton label="Leave ambient mode" onClick={() => navigate({ name: "board" })}>
            <X />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  );
}

/** Size of the orb field, kept current by a ResizeObserver. */
function useFieldSize(): [RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * Ambient mode (`#/ambient`): one orb per agent for an old tablet or a second screen, in a stable
 * order (host, workspace, name) so each agent stays where you last saw it. Needs-you orbs glow and
 * a tap answers them (the answer HUD); any other orb opens its session. Optional chimes per state
 * change, a screen wake lock and browser full screen. The shell hides the sidebar, split and
 * bottom nav here (`isBare`).
 */
export function AmbientView() {
  const mobile = useIsMobile();
  const showDone = useAmbientPrefs((s) => s.showDone);
  const keys = useCore((s) => selectAgentKeys(s).filter((k) => showDone || s.agents[k]?.column !== "done"), shallow);
  const [field, size] = useFieldSize();
  const grid = fitOrbs(keys.length, size.w, size.h, mobile ? 64 : 76);
  useAmbientChimes();

  // Esc leaves ambient mode (overlays and fields keep their own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]')) return;
      navigate({ name: "board" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AmbientBar mobile={mobile} />
      <div ref={field} className={cn("min-h-0 flex-1", mobile ? "px-2 pb-2" : "px-6 pb-6")}>
        {keys.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Orbit />}
            title="No agents to watch"
            description={showDone ? "Start one and it shows up here as an orb." : "Nothing is running, waiting or ready for review."}
            action={<Button onClick={() => navigate({ name: "dispatch" })}>{VIEWS.dispatch.label}</Button>}
          />
        ) : (
          size.w > 0 && (
            <ul
              className="grid h-full w-full"
              style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}
              aria-label="Agents"
            >
              {keys.map((k) => (
                <li key={k} className="grid min-h-0 min-w-0 place-items-center">
                  <AmbientOrb agentKey={k} size={grid.orb} />
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
