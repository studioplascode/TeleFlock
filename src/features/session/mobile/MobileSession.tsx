import { MoreVertical, PanelBottomOpen } from "lucide-react";
import { animate, motion, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { useEffect, useRef } from "react";
import { agentKey as makeKey, navigate, parseAgentKey, useAgent, useColumnKeys, useInbox, useSession } from "@/core";
import { AgentGlyph, BottomSheet, cn, IconButton, Skeleton, StatusOrb, StatusPill, useActivity, useCalmMotion, useIdleReady } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { haptic } from "@/features/shell/haptics";
import { agentStatus, useBeat } from "../api";
import { ActionsMenu, FastToggle, GoalChip, ModelPicker, PlanToggle, ThinkingPicker } from "../header/Controls";
import { InspectorTabs } from "../inspector/Inspector";
import { SessionPane } from "../SessionPane";
import { useSessionUi } from "../state";

const SWIPE_PX = 90;
const SWIPE_VELOCITY = 520;

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
      <StatusPill status={status} size="sm" />
      {agent.live.line && <div className="line-clamp-2 text-[10.5px] text-mute">{agent.live.line}</div>}
    </div>
  );
}

/**
 * Page indicator. Over a transcript it floats in the top fade so it costs no row (only the dots
 * take taps); `inline` gives it its own row where content starts at the very top (terminal view).
 */
function PagerDots({ keys, current, inline = false }: { keys: string[]; current: string; inline?: boolean }) {
  if (keys.length < 2) return null;
  return (
    <div className={cn("pointer-events-none flex justify-center", inline ? "shrink-0 pb-1.5" : "absolute inset-x-0 top-0 z-raised")}>
      <div
        className={cn("mt-0.5 flex items-center gap-1.5 rounded-full px-2 py-1", !inline && "bg-[rgb(12_12_18/0.72)] shadow-hairline backdrop-blur-md")}
        role="tablist"
        aria-label="Agents"
      >
        {keys.slice(0, 12).map((k) => (
          <Dot key={k} k={k} on={k === current} />
        ))}
      </div>
    </div>
  );
}

function Dot({ k, on }: { k: string; on: boolean }) {
  const agent = useAgent(k);
  const status = agentStatus(agent);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      aria-label={agent?.name ?? k}
      onClick={() => {
        const { hostId, agentId } = parseAgentKey(k);
        navigate({ name: "agent", hostId, agentId }, { replace: true });
      }}
      data-status={status}
      className={cn(
        "pointer-events-auto h-1.5 rounded-full transition-all duration-300",
        on ? "w-5 st-fill" : "w-1.5 bg-white/20",
        !on && status === "needs-you" && "st-fill opacity-70",
      )}
    />
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
  const { meta } = useSession(key);
  const keys = usePagerKeys(key);
  const idx = keys.indexOf(key);
  const prev = idx > 0 ? keys[idx - 1] : undefined;
  const next = idx < keys.length - 1 ? keys[idx + 1] : undefined;
  const sheet = useSessionUi((s) => s.sheet[key] === true);
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
      const { hostId: h, agentId: a } = parseAgentKey(target);
      navigate({ name: "agent", hostId: h, agentId: a }, { replace: true });
      x.set(dir * w * 0.35);
      void animate(x, 0, { type: "spring", bounce: 0.12, visualDuration: 0.35 });
    });
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -SWIPE_PX || info.velocity.x < -SWIPE_VELOCITY) go(next, 1);
    else if (info.offset.x > SWIPE_PX || info.velocity.x > SWIPE_VELOCITY) go(prev, -1);
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
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-2 pr-8 pb-1.5 no-scrollbar [mask-image:linear-gradient(90deg,#000_calc(100%-40px),transparent)]">
          <ModelPicker agentKey={key} mobile />
          <ThinkingPicker agentKey={key} mobile />
          <PlanToggle agentKey={key} />
          <FastToggle agentKey={key} />
          <GoalChip agentKey={key} compact={!meta?.goal} />
        </div>
      )}
      {terminal && <PagerDots keys={keys} current={key} inline />}
      <div
        ref={(el) => {
          if (el) width.current = el.clientWidth;
        }}
        className="relative min-h-0 flex-1 overflow-x-clip"
      >
        {!terminal && <PagerDots keys={keys} current={key} />}
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
          <SessionPane key={key} agentKey={key} header={false} mobile ready={ready} />
        </motion.div>
      </div>
      {omp && (
        <BottomSheet open={sheet} onOpenChange={(o) => useSessionUi.getState().setSheet(key, o)} title={agent?.name ?? "Session"} description="Context, todos, subagents, agent chat, files, tree and btw">
          <InspectorBody agentKey={key} />
        </BottomSheet>
      )}
    </div>
  );
}
