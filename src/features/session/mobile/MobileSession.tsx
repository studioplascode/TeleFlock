import { MoreVertical, PanelBottomOpen } from "lucide-react";
import { animate, motion, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { useEffect, useRef } from "react";
import { agentKey as makeKey, navigate, parseAgentKey, useAgent, useColumnKeys, useInbox, useSession } from "@/core";
import { AgentGlyph, BottomSheet, cn, IconButton, StatusOrb, StatusPill, useActivity } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { haptic } from "@/features/shell/haptics";
import { agentStatus, useBeat } from "../api";
import { ActionsMenu, FastToggle, GoalChip, ModelPicker, PlanToggle, ThinkingPicker } from "../header/Controls";
import { InspectorTabs } from "../inspector/Inspector";
import { SessionPane } from "../SessionPane";
import { useSessionUi } from "../state";

const SWIPE_PX = 90;
const SWIPE_VELOCITY = 520;

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

function PagerDots({ keys, current }: { keys: string[]; current: string }) {
  if (keys.length < 2) return null;
  return (
    <div className="flex items-center justify-center gap-1.5 py-1" role="tablist" aria-label="Agents">
      {keys.slice(0, 12).map((k) => (
        <Dot key={k} k={k} on={k === current} />
      ))}
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
      className={cn("h-1.5 rounded-full transition-all duration-300", on ? "w-5 st-fill" : "w-1.5 bg-white/20", !on && status === "needs-you" && "st-fill opacity-70")}
    />
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
  const controls = useDragControls();
  const width = useRef(0);

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
  return (
    <div className="flex h-full min-h-0 flex-col" data-status={status}>
      <MobileHeader
        back
        title={
          <span className="flex min-w-0 items-center gap-2">
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
      <PagerDots keys={keys} current={key} />
      {omp && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pr-8 pb-2 no-scrollbar [mask-image:linear-gradient(90deg,#000_calc(100%-40px),transparent)]">
          <ModelPicker agentKey={key} mobile />
          <ThinkingPicker agentKey={key} />
          <PlanToggle agentKey={key} />
          <FastToggle agentKey={key} />
          <GoalChip agentKey={key} compact={!meta?.goal} />
        </div>
      )}
      <div
        ref={(el) => {
          if (el) width.current = el.clientWidth;
        }}
        className="relative min-h-0 flex-1 overflow-x-clip"
      >
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
          className="relative flex h-full min-h-0 flex-col px-3 pb-2 touch-pan-y [&_*]:touch-pan-y [&_:is(pre,table,textarea,input,[data-no-swipe])]:touch-auto [&_:is(pre,table,[data-no-swipe])_*]:touch-auto"
          onPointerDown={(e) => {
            // Page from anywhere except text inputs, so typing and selecting never swipe.
            const t = e.target as HTMLElement;
            if (t.closest("textarea, input, [data-no-swipe], pre, table")) return;
            controls.start(e);
          }}
        >
          <Peek agentKey={prev} side="left" />
          <Peek agentKey={next} side="right" />
          <SessionPane key={key} agentKey={key} header={false} mobile />
        </motion.div>
      </div>
      {omp && (
        <BottomSheet open={sheet} onOpenChange={(o) => useSessionUi.getState().setSheet(key, o)} title={agent?.name ?? "Session"} description="Context, todos, subagents, files, tree and btw">
          <InspectorTabs agentKey={key} />
        </BottomSheet>
      )}
    </div>
  );
}
