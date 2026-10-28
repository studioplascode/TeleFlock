import { ArrowUp, ChevronRight, MoreVertical, PanelBottomOpen } from "lucide-react";
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { agentKey as makeKey, navigate, parseAgentKey, useAgent, useColumnKeys, useInbox } from "@/core";
import { AgentGlyph, BottomSheet, cn, IconButton, Skeleton, spring, StatusOrb, StatusPill, useActivity, useCalmMotion, useIdleReady } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { haptic } from "@/features/shell/haptics";
import { useFirstUse } from "@/features/shell/hints";
import { agentStateWord, NEEDS_WORD } from "@/features/shell/vocab";
import { agentStatus, useBeat } from "../api";
import { ActionsMenu, FastToggle, GoalChip, ModelThinkingChip, PlanToggle } from "../header/Controls";
import { InspectorTabs } from "../inspector/Inspector";
import { SessionPane } from "../SessionPane";
import { useSessionUi } from "../state";

const SWIPE_PX = 90;
const SWIPE_VELOCITY = 520;
/** Holding the pager dots this long opens the list of the pager's agents. */
const LONG_PRESS_MS = 450;

/** Route slide-in (spring.sheet) and sheet rise: heavy subtrees mount after these. */
const SLIDE_MS = 420;

/** Pager order: needs-you first (oldest first), then running; the open agent always included. */
function usePagerKeys(current: string): string[] {
  const needs = useInbox();
  const running = useColumnKeys("running");
  const keys: string[] = [];
  for (const k of [...needs, ...running]) if (!keys.includes(k)) keys.push(k);
  if (!keys.includes(current)) keys.unshift(current);
  return keys;
}

function openKey(k: string) {
  const { hostId, agentId } = parseAgentKey(k);
  navigate({ name: "agent", hostId, agentId }, { replace: true });
}

function Peek({ agentKey, side }: { agentKey: string | undefined; side: "left" | "right" }) {
  const agent = useAgent(agentKey ?? "");
  if (!agent) return null;
  const status = agentStatus(agent);
  return (
    <div
      data-status={status}
      className={cn(
        "pointer-events-none absolute top-1/2 z-0 flex w-[120px] -translate-y-1/2 flex-col items-center gap-2 rounded-[22px] glass px-3 py-4 text-center",
        side === "left" ? "right-full mr-3" : "left-full ml-3",
      )}
      aria-hidden
    >
      <AgentGlyph name={agent.name} size={40} status={status} />
      <div className="w-full truncate font-display text-sm font-bold text-ink">{agent.name}</div>
      <StatusPill status={status} size="sm">
        {agentStateWord(agent)}
      </StatusPill>
      {agent.live.line && <div className="line-clamp-2 text-[10.5px] text-mute">{agent.live.line}</div>}
    </div>
  );
}

/** First-use caption under the dots (first 3 session opens with a pager); still under reduced motion. */
function SwipeHint({ doneRef }: { doneRef: RefObject<(() => void) | null> }) {
  const { show, done } = useFirstUse("session.pagerSwipe");
  const calm = useCalmMotion();
  useEffect(() => {
    doneRef.current = done;
  });
  if (!show) return null;
  return (
    <span className="flex items-center gap-1 rounded-full bg-[rgb(12_12_18/0.72)] px-2 py-0.5 text-2xs font-semibold text-mute shadow-hairline">
      swipe for next agent
      <motion.span className="grid" animate={calm ? undefined : { x: [0, 5, 0] }} transition={{ duration: 0.9, repeat: 3, ease: "easeInOut" }}>
        <ChevronRight className="size-3" />
      </motion.span>
    </span>
  );
}

/**
 * Page indicator. Over a transcript it floats in the top fade so it costs no row (only the dots
 * take taps); `inline` gives it its own row where content starts at the very top (terminal view).
 * Every dot is a 24 px target; holding the dots opens the list of the pager's agents.
 */
function PagerDots({ keys, current, inline = false, onList, hintDone }: { keys: string[]; current: string; inline?: boolean; onList: () => void; hintDone: RefObject<(() => void) | null> }) {
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  if (keys.length < 2) return null;
  const cancel = () => window.clearTimeout(timer.current);
  return (
    // Floating: the hint sits beside the dots (one row), so neither reaches the first message below.
    <div className={cn("pointer-events-none flex items-center", inline ? "shrink-0 flex-col pb-1.5" : "absolute inset-x-0 top-0 z-raised justify-center gap-1.5")}>
      <div
        className={cn("pointer-events-auto mt-0.5 flex items-center rounded-full px-1 select-none", !inline && "bg-[rgb(12_12_18/0.72)] shadow-hairline backdrop-blur-md")}
        role="tablist"
        aria-label="Agents (hold for the list)"
        onPointerDown={() => {
          held.current = false;
          cancel();
          timer.current = window.setTimeout(() => {
            held.current = true;
            haptic("select");
            onList();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClickCapture={(e) => {
          // The press that opened the list is not also a tap on a dot.
          if (!held.current) return;
          held.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {keys.slice(0, 12).map((k) => (
          <Dot key={k} k={k} on={k === current} />
        ))}
      </div>
      <SwipeHint doneRef={hintDone} />
    </div>
  );
}

function Dot({ k, on }: { k: string; on: boolean }) {
  const agent = useAgent(k);
  const status = agentStatus(agent);
  return (
    <button type="button" role="tab" aria-selected={on} aria-label={agent?.name ?? k} onClick={() => openKey(k)} className="grid h-6 min-w-6 place-items-center px-0.5 focus-ring">
      <span
        data-status={status}
        className={cn("h-1.5 rounded-full transition-all duration-300", on ? "w-5 st-fill" : "w-1.5 bg-white/20", !on && status === "needs-you" && "st-fill opacity-70")}
      />
    </button>
  );
}

/** One agent in the pager list sheet. */
function PagerRow({ k, current, onPick }: { k: string; current: boolean; onPick: () => void }) {
  const agent = useAgent(k);
  if (!agent) return null;
  const status = agentStatus(agent);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={current || undefined}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left pressable focus-ring",
        current ? "bg-accent/12 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.035]",
      )}
    >
      <AgentGlyph name={agent.name} size={32} status={status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-md font-bold text-ink">{agent.name}</span>
        <span className="block truncate text-xs text-mute">{agent.title || [agent.repo, agent.branch].filter(Boolean).join(" · ")}</span>
      </span>
      <StatusPill status={status} size="sm">
        {agentStateWord(agent)}
      </StatusPill>
    </button>
  );
}

/**
 * Docked above the composer while other agents need you: the oldest one and how many more wait.
 * Phone needs-you toasts stay quiet on session routes; this chip carries them, in thumb reach.
 */
function NextWaiting({ current, onGo }: { current: string; onGo: (k: string) => void }) {
  const others = useInbox().filter((k) => k !== current);
  const first = others[0];
  const agent = useAgent(first ?? "");
  return (
    <AnimatePresence initial={false}>
      {first && agent && (
        <motion.button
          key="next"
          type="button"
          data-status="needs-you"
          data-toast-anchor=""
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: spring.snappy }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
          onClick={() => onGo(first)}
          className="pressable focus-ring mx-auto flex min-h-11 w-full shrink-0 items-center gap-2 rounded-full st-soft st-ring px-4 text-left text-[13px] font-bold"
        >
          <ArrowUp className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Next: {agent.name}
            {agent.needs && <span className="font-semibold opacity-85"> · {NEEDS_WORD[agent.needs.kind]}</span>}
            {others.length > 1 && <span className="font-semibold opacity-70"> · {others.length - 1} more</span>}
          </span>
          <ChevronRight className="size-4 shrink-0" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** Inspector tabs mount once the sheet has risen; skeleton bars until then. */
function InspectorBody({ agentKey }: { agentKey: string }) {
  const ready = useIdleReady(useCalmMotion() ? 0 : SLIDE_MS);
  if (ready) return <InspectorTabs agentKey={agentKey} />;
  return (
    <div className="flex flex-col gap-3 pt-1" aria-busy>
      <Skeleton className="h-9 rounded-full" />
      <Skeleton className="h-24 rounded-[16px]" />
      <Skeleton className="h-16 rounded-[16px]" />
    </div>
  );
}

/** Phone session: top bar, horizontal pager between agents with neighbour peeks, inspector sheet. */
export function MobileSession({ hostId, agentId }: { hostId: string; agentId: string }) {
  const key = makeKey(hostId, agentId);
  const agent = useAgent(key);
  const keys = usePagerKeys(key);
  const idx = keys.indexOf(key);
  const prev = idx > 0 ? keys[idx - 1] : undefined;
  const next = idx < keys.length - 1 ? keys[idx + 1] : undefined;
  const sheet = useSessionUi((s) => s.sheet[key] === true);
  const [list, setList] = useState(false);
  const hintDone = useRef<(() => void) | null>(null);
  const beat = useBeat(key);
  const { tier } = useActivity(beat);
  const x = useMotionValue(0);
  const fade = useTransform(x, [-220, 0, 220], [0.55, 1, 0.55]);
  const width = useRef(0);
  // The transcript rows mount after the slide-in (time-sliced), so the push animation stays smooth.
  const ready = useIdleReady(useCalmMotion() ? 0 : SLIDE_MS);
  const controls = useDragControls();

  // New agent slid in: settle at the centre.
  useEffect(() => {
    x.set(0);
  }, [key, x]);

  const go = (target: string | undefined, dir: 1 | -1) => {
    if (!target) {
      void animate(x, 0, { type: "spring", bounce: 0.3, visualDuration: 0.35 });
      return;
    }
    haptic("select");
    const w = width.current || window.innerWidth;
    void animate(x, -dir * w, { type: "spring", bounce: 0, visualDuration: 0.22 }).then(() => {
      openKey(target);
      x.set(dir * w * 0.35);
      void animate(x, 0, { type: "spring", bounce: 0.12, visualDuration: 0.35 });
    });
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const forward = info.offset.x < -SWIPE_PX || info.velocity.x < -SWIPE_VELOCITY;
    const back = info.offset.x > SWIPE_PX || info.velocity.x > SWIPE_VELOCITY;
    if ((forward && next) || (back && prev)) hintDone.current?.();
    if (forward) go(next, 1);
    else if (back) go(prev, -1);
    else void animate(x, 0, { type: "spring", bounce: 0.3, visualDuration: 0.35 });
  };

  const status = agentStatus(agent);
  const omp = agent?.omp != null && agent.omp.link === "live";
  // Non-omp agents open straight onto a terminal: its first row would sit under floating dots.
  const terminal = agent != null && agent.omp == null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-status={status}>
      <MobileHeader
        back
        title={
          <span className="flex min-w-0 items-center gap-2 pl-1.5">
            <StatusOrb status={status} activity={tier} size={8} label={null} />
            <span data-morph="name" data-morph-key={key} className="truncate">
              {agent?.name ?? agentId}
            </span>
          </span>
        }
        subtitle={agent ? [agent.repo, agent.branch].filter(Boolean).join(" · ") || agent.title : undefined}
        actions={
          omp ? (
            <>
              <IconButton label="Inspector" size="lg" onClick={() => useSessionUi.getState().setSheet(key, true)}>
                <PanelBottomOpen />
              </IconButton>
              <ActionsMenu
                agentKey={key}
                trigger={
                  <IconButton label="Session actions" size="lg">
                    <MoreVertical />
                  </IconButton>
                }
              />
            </>
          ) : undefined
        }
      />
      {omp && (
        // scrolls sideways on narrow phones: the edge with more chips past it fades
        <div className="flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain px-2 pb-1.5 no-scrollbar scroll-fade-x">
          <ModelThinkingChip agentKey={key} />
          <PlanToggle agentKey={key} />
          <FastToggle agentKey={key} />
          <GoalChip agentKey={key} />
        </div>
      )}
      {terminal && <PagerDots keys={keys} current={key} inline onList={() => setList(true)} hintDone={hintDone} />}
      <div
        ref={(el) => {
          if (el) width.current = el.clientWidth;
        }}
        className="relative min-h-0 flex-1 overflow-x-clip"
      >
        {!terminal && <PagerDots keys={keys} current={key} onList={() => setList(true)} hintDone={hintDone} />}
        <motion.div
          drag="x"
          dragControls={controls}
          dragListener={false}
          dragDirectionLock
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={{ left: next ? 0.9 : 0.15, right: prev ? 0.9 : 0.15 }}
          onDragEnd={onDragEnd}
          style={{ x, opacity: fade }}
          // Horizontal pans belong to the pager. With `dragListener={false}` motion doesn't set
          // touch-action itself, and nested scrollers re-enable every pan, so the browser would
          // claim the swipe (pointercancel). Code blocks, tables and inputs keep native panning.
          className="relative flex h-full min-h-0 flex-col px-2 pb-1.5 touch-pan-y [&_*]:touch-pan-y [&_:is(pre,table,textarea,input,[data-no-swipe])]:touch-auto [&_:is(pre,table,[data-no-swipe])_*]:touch-auto"
          onPointerDown={(e) => {
            // Page from anywhere except text inputs, so typing and selecting never swipe.
            const t = e.target as HTMLElement;
            if (t.closest("textarea, input, [data-no-swipe], pre, table")) return;
            controls.start(e);
          }}
        >
          <Peek agentKey={prev} side="left" />
          <Peek agentKey={next} side="right" />
          <SessionPane key={key} agentKey={key} header={false} mobile ready={ready} dock={<NextWaiting current={key} onGo={(k) => go(k, keys.indexOf(k) < idx ? -1 : 1)} />} />
        </motion.div>
      </div>
      {omp && (
        <BottomSheet open={sheet} onOpenChange={(o) => useSessionUi.getState().setSheet(key, o)} title={agent?.name ?? "Session"} description="Context, todos, subagents, agent chat, files, tree and btw">
          <InspectorBody agentKey={key} />
        </BottomSheet>
      )}
      <BottomSheet open={list} onOpenChange={setList} title="Agents" description="Needs you first, then running. Swipe sideways to move between them.">
        <div className="flex flex-col gap-1">
          {keys.map((k) => (
            <PagerRow
              key={k}
              k={k}
              current={k === key}
              onPick={() => {
                setList(false);
                // A push, not the pager's replace: the sheet's back-button entry is still current
                // here, and replacing it would be undone when that entry is popped.
                if (k !== key) navigate({ name: "agent", ...parseAgentKey(k) });
              }}
            />
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}
