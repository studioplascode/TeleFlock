import { ArrowRight, Shuffle } from "lucide-react";
import { useState } from "react";
import {
  type ActivityTier,
  AgentGlyph,
  Badge,
  Button,
  Card,
  CardFlight,
  Elapsed,
  GlowBorder,
  Heartbeat,
  LayoutGroup,
  NumberTicker,
  ProgressRing,
  STATUS,
  STATUSES,
  Shimmer,
  Skeleton,
  Sparkline,
  type Status,
  StatusOrb,
  StatusPill,
  StreamText,
  Swarm,
  Tile,
  TiltCard,
  cn,
  formatCompact,
  formatUsd,
  spring,
  useActivity,
} from "@/design";
import { motion } from "motion/react";
import { Demo, Section } from "./Showcase";
import { type SimStream, useSimStreamingText } from "./sim";

const MOUNTED_AT = Date.now();

export function BentoHero({ stream, tier }: { stream: SimStream; tier: ActivityTier }) {
  const { tier: measured } = useActivity(stream.beat);
  const typing = useSimStreamingText(tier !== "silent");
  const [answer, setAnswer] = useState("ntfy on your tailnet");
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[2.05fr_1fr_1fr_1.32fr]">
      <TiltCard className="rounded-tile">
        <Tile variant="sunset" className="flex h-full min-h-56 flex-col overflow-hidden p-5">
          <div className="pointer-events-none absolute -top-16 -right-16 size-60 rounded-full border-[38px] border-white/8" />
          <div className="relative flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgb(40_0_20/0.28)] py-1 pr-2.5 pl-2 font-display text-2xs font-bold tracking-[0.12em] uppercase">
              <span className="relative size-[7px] rounded-full bg-white">
                <span className="tf-loop absolute inset-0 animate-ping-soft rounded-full bg-white" />
              </span>
              Needs you · 1 of 2
            </span>
            <span className="ml-auto text-xs font-bold opacity-90">
              push · waiting <Elapsed since={MOUNTED_AT - 373_000} />
            </span>
          </div>
          <h3 className="relative mt-2.5 mb-1 max-w-md text-2xl leading-tight md:text-[24px]">How should notifications reach your phone?</h3>
          <p className="relative text-xs font-semibold opacity-85">
            teleflock / <code className="font-mono text-2xs">feat/android-push</code> · opus-5 · high
          </p>
          <div className="relative mt-auto grid grid-cols-2 gap-2 pt-4">
            {["ntfy on your tailnet", "Firebase Cloud Messaging", "UnifiedPush", "Other…"].map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setAnswer(o)}
                className={cn(
                  "truncate rounded-md px-2.5 py-2 text-left text-xs font-bold pressable lift focus-ring",
                  answer === o
                    ? "bg-white text-[#d21a5a] shadow-[0_8px_20px_-6px_rgb(80_0_30/0.5)]"
                    : "bg-[rgb(40_0_20/0.24)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] hover:bg-[rgb(40_0_20/0.36)]",
                )}
              >
                {o}
              </button>
            ))}
          </div>
        </Tile>
      </TiltCard>

      <TiltCard className="rounded-tile">
        <Tile className="flex h-full min-h-56 flex-col p-5">
          <span className="kicker">Today · 10 agents</span>
          <NumberTicker value={stream.cost} format={formatUsd} className="mt-3 font-display text-hero font-bold" />
          <span className="mt-1.5 text-sm font-semibold text-mute">
            <NumberTicker value={stream.tokens} format={formatCompact} className="font-bold text-ink" /> tokens
          </span>
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <div className="flex h-2 gap-[3px]">
              {(["running", "needs-you", "review", "done"] as const).map((s, i) => (
                <i key={s} data-status={s} className={cn("rounded-full st-bg", s === "running" && "live-gradient")} style={{ flex: [3, 2, 2, 3][i] }} />
              ))}
            </div>
            <div className="flex justify-between text-2xs font-semibold text-mute">
              <span><b className="mr-1 text-ink">3</b>run</span>
              <span><b className="mr-1 text-ink">2</b>you</span>
              <span><b className="mr-1 text-ink">2</b>rev</span>
              <span><b className="mr-1 text-ink">3</b>done</span>
            </div>
          </div>
        </Tile>
      </TiltCard>

      <TiltCard className="rounded-tile">
        <Tile className="flex h-full min-h-56 flex-col p-5">
          <div className="flex items-center justify-between">
            <span className="kicker">Activity</span>
            <span className="flex items-center gap-1.5 text-xs font-bold text-mute">
              <StatusOrb status="running" activity={measured} size={7} label={null} />
              {measured}
            </span>
          </div>
          <div className="mt-3 font-display text-hero font-bold tabular">
            {stream.beat}
            <span className="ml-1 text-md font-semibold text-mute">events</span>
          </div>
          <Sparkline values={stream.series} height={46} className="mt-auto" />
          <Heartbeat beat={stream.beat} lastEventAt={stream.lastEventAt} height={26} className="mt-2" />
        </Tile>
      </TiltCard>

      <TiltCard className="rounded-tile">
        <Tile variant="deep" className="flex h-full min-h-56 flex-col p-4">
          <div className="flex items-center gap-2 text-xs font-bold">
            <AgentGlyph name="kanban" size={20} />
            kanban <span className="font-mono text-2xs text-mute-2">w4:p1</span>
            <span className="ml-auto flex items-center gap-1.5 font-display text-[10px] tracking-[0.12em] text-mute uppercase">
              <StatusOrb status="needs-you" size={6} label={null} /> live
            </span>
          </div>
          <div className="mt-3 text-xs">
            <Shimmer>{typing.streaming ? "Streaming response…" : "Thinking…"}</Shimmer>
          </div>
          <p className="mt-1.5 line-clamp-6 text-sm leading-relaxed text-ink-2">
            <StreamText text={typing.text} streaming={typing.streaming} />
          </p>
        </Tile>
      </TiltCard>
    </div>
  );
}

const STATUS_DEMO: Record<Status, { title: string; done: number; total: number; subs: number }> = {
  running: { title: "Drag-and-drop kanban board with column persistence", done: 4, total: 7, subs: 3 },
  "needs-you": { title: "Android push notifications when an agent gets blocked", done: 2, total: 5, subs: 0 },
  review: { title: "Auto-reconnect SSH and resume herdr attach", done: 6, total: 6, subs: 0 },
  done: { title: "README and architecture overview", done: 5, total: 5, subs: 0 },
  idle: { title: "Waiting for a prompt", done: 0, total: 0, subs: 0 },
  error: { title: "Cache bun install + turbo artifacts in CI", done: 3, total: 4, subs: 0 },
};

export function LivenessSection({ stream, tier }: { stream: SimStream; tier: ActivityTier }) {
  return (
    <Section
      id="liveness"
      kicker="05 · Liveness"
      title="Every status, alive"
      description="Running breathes in omp purple→blue and its border orbits; needs-you is the loudest thing on screen; review/done settle; idle rests. The heartbeat answers “is it still running?” at a glance."
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {STATUSES.map((s) => {
          const d = STATUS_DEMO[s];
          const live = s === "running" || s === "needs-you";
          const card = (
            <Card className={cn("flex h-full flex-col gap-3 rounded-xl p-4", s === "needs-you" && "st-border-grad")} data-status={s}>
              <div className="flex items-center gap-2">
                <StatusPill status={s} activity={tier} size="sm" />
                <span className="ml-auto text-xs font-bold text-mute">
                  {live ? <Elapsed since={MOUNTED_AT - (s === "running" ? 725_000 : 372_000)} /> : s === "done" ? "2h ago" : "—"}
                </span>
              </div>
              <div className="flex items-start gap-3">
                {s === "running" ? (
                  <Swarm count={d.subs} size={38}>
                    <AgentGlyph name="kanban" size={38} />
                  </Swarm>
                ) : (
                  <AgentGlyph name={STATUS[s].label} size={38} status={s} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-extrabold text-mute">{s === "running" ? "kanban · 3 subagents" : STATUS[s].label.toLowerCase()}</div>
                  <h4 className="line-clamp-2 font-sans text-sm leading-snug font-bold">{d.title}</h4>
                </div>
                {d.total > 0 && <ProgressRing done={d.done} total={d.total} status={s} size={38} />}
              </div>
              <Heartbeat
                beat={live ? stream.beat : 0}
                lastEventAt={live ? stream.lastEventAt : MOUNTED_AT - 3_600_000}
                status={s}
                height={24}
              />
            </Card>
          );
          return live ? (
            <GlowBorder key={s} status={s} radius={22} className="rounded-xl">
              {card}
            </GlowBorder>
          ) : (
            <div key={s}>{card}</div>
          );
        })}
      </div>
    </Section>
  );
}

const RATES: ActivityTier[] = ["silent", "calm", "steady", "busy", "frantic"];

export function MotionComponentsSection({ stream, tier }: { stream: SimStream; tier: ActivityTier }) {
  const typing = useSimStreamingText(tier !== "silent");
  const [ring, setRing] = useState(3);
  const [subs, setSubs] = useState(4);
  return (
    <Section id="motion" kicker="06 · Motion kit" title="Liveness components" description="All loops are transform/opacity on the compositor; one shared rAF loop and one shared 1s clock drive every canvas and timer. Reduced motion stops loops but keeps state visible.">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Demo label="StatusOrb · breath follows activity">
          {RATES.map((r) => (
            <span key={r} className="flex flex-col items-center gap-2">
              <StatusOrb status="running" activity={r} size={14} />
              <span className="font-mono text-[10px] text-mute-2">{r}</span>
            </span>
          ))}
          <span className="flex flex-col items-center gap-2">
            <StatusOrb status="needs-you" size={14} />
            <span className="font-mono text-[10px] text-mute-2">needs-you</span>
          </span>
        </Demo>
        <Demo label="ProgressRing · comet while running">
          <ProgressRing done={ring} total={7} size={52} />
          <ProgressRing done={2} total={5} status="needs-you" size={44} />
          <ProgressRing done={6} total={6} status="review" size={44} />
          <ProgressRing done={5} total={5} status="done" size={44} />
          <Button size="sm" onClick={() => setRing((v) => (v >= 7 ? 0 : v + 1))}>
            +1 todo
          </Button>
        </Demo>
        <Demo label="Heartbeat · spikes per event, decays when silent">
          <Heartbeat beat={stream.beat} lastEventAt={stream.lastEventAt} className="w-full" height={34} />
          <Heartbeat beat={0} lastEventAt={MOUNTED_AT - 95_000} status="idle" className="w-full" height={20} />
        </Demo>
        <Demo label="StreamText · token fade + caret, Shimmer">
          <div className="flex w-full flex-col gap-2">
            <Shimmer className="text-xs font-bold">Running bash · bun test src/board</Shimmer>
            <p className="line-clamp-3 min-h-[3lh] text-sm text-ink-2">
              <StreamText text={typing.text} streaming={typing.streaming} />
            </p>
          </div>
        </Demo>
        <Demo label="NumberTicker · rolling digits">
          <NumberTicker value={stream.cost} format={formatUsd} className="font-display text-3xl font-bold" />
          <NumberTicker value={stream.tokens} className="font-mono text-lg text-mute" />
        </Demo>
        <Demo label="Elapsed · shared 1s clock">
          <Elapsed since={MOUNTED_AT} className="font-display text-3xl font-bold" />
          <Elapsed since={MOUNTED_AT - 3_725_000} className="font-mono text-lg text-mute" />
        </Demo>
        <Demo label="Swarm · orbiting subagents">
          <Swarm count={subs} size={44}>
            <AgentGlyph name="pool" size={44} />
          </Swarm>
          <Swarm count={2} status="needs-you" size={30}>
            <AgentGlyph name="limits" size={30} />
          </Swarm>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setSubs((v) => Math.max(0, v - 1))}>
              −
            </Button>
            <Button size="sm" onClick={() => setSubs((v) => Math.min(12, v + 1))}>
              + subagent
            </Button>
          </div>
        </Demo>
        <Demo label="Sparkline · morphs on update">
          <Sparkline values={stream.series} height={44} />
          <Sparkline values={stream.series.map((v, i) => v + Math.sin(i))} status="review" height={28} fill={false} />
        </Demo>
        <Demo label="Skeleton">
          <div className="flex w-full items-center gap-3">
            <Skeleton className="size-10 rounded-md" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        </Demo>
        <Demo label="GlowBorder · running / needs-you">
          <GlowBorder status="running" radius={18} className="flex-1 rounded-lg">
            <div className="rounded-lg bg-tile-3 p-4 text-sm font-bold">Running</div>
          </GlowBorder>
          <GlowBorder status="needs-you" radius={18} className="flex-1 rounded-lg">
            <div className="rounded-lg bg-tile-3 p-4 text-sm font-bold">Needs you</div>
          </GlowBorder>
        </Demo>
        <Demo label="TiltCard · pointer tilt + specular">
          <TiltCard className="w-full rounded-xl">
            <Card className="p-5 text-sm font-bold">Hover me with a mouse</Card>
          </TiltCard>
        </Demo>
        <Demo label="pressable · springy press">
          <button type="button" className="pressable lift focus-ring rounded-md bg-tile-4 px-4 py-2.5 text-sm font-bold">
            .pressable
          </button>
          <motion.button type="button" whileTap={{ scale: 0.94 }} whileHover={{ y: -2 }} transition={spring.press} className="focus-ring rounded-md bg-omp px-4 py-2.5 text-sm font-bold text-white">
            pressMotion
          </motion.button>
        </Demo>
      </div>
    </Section>
  );
}

interface FlightCard {
  id: string;
  name: string;
  title: string;
  status: Status;
}

const LANES: Status[] = ["running", "needs-you", "review", "done"];
/** Click-to-advance cycle through the board lanes. */
const NEXT: Record<Status, Status> = { running: "needs-you", "needs-you": "review", review: "done", done: "running", idle: "running", error: "running" };

const INITIAL_CARDS: FlightCard[] = [
  { id: "a", name: "kanban", title: "Drag-and-drop board", status: "running" },
  { id: "b", name: "pool", title: "Postgres pooling", status: "running" },
  { id: "c", name: "push", title: "Android push", status: "needs-you" },
  { id: "d", name: "reconnect", title: "SSH auto-reconnect", status: "review" },
  { id: "e", name: "docs", title: "Architecture overview", status: "done" },
];

export function SharedLayoutSection() {
  const [cards, setCards] = useState(INITIAL_CARDS);
  const shuffle = () =>
    setCards((cs) => {
      const pick = cs[Math.floor(Math.random() * cs.length)];
      if (!pick) return cs;
      const lanes = LANES.filter((l) => l !== pick.status);
      const to = lanes[Math.floor(Math.random() * lanes.length)] ?? "running";
      return cs.map((c) => (c.id === pick.id ? { ...c, status: to } : c));
    });
  return (
    <Section id="flight" kicker="07 · Shared layout" title="Cards fly between lanes" description="Wrap each card in <CardFlight flightId> inside one <LayoutGroup>; a status change re-parents the card and it springs to its new lane. Click a card to advance it.">
      <div className="mb-3 flex gap-2">
        <Button size="sm" variant="primary" icon={<Shuffle />} onClick={shuffle}>
          Random move
        </Button>
      </div>
      <LayoutGroup>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {LANES.map((lane) => {
            const inLane = cards.filter((c) => c.status === lane);
            return (
              <div
                key={lane}
                data-status={lane}
                className={cn(
                  "flex min-h-48 flex-col gap-2 rounded-tile bg-white/[0.018] p-2.5 shadow-hairline",
                  lane === "needs-you" && "bg-[radial-gradient(120%_60%_at_50%_0%,rgb(255_61_119/0.09),transparent_70%)]",
                )}
              >
                <div className="flex items-center gap-2 px-1.5 py-1">
                  <StatusOrb status={lane} size={8} label={null} />
                  <h3 className="text-md font-semibold">{STATUS[lane].label}</h3>
                  <motion.span layout className={cn("grid h-5 min-w-[22px] place-items-center rounded-full px-1.5 text-[11px] font-extrabold", lane === "needs-you" ? "bg-sun text-white" : "bg-tile-3 text-mute")}>
                    {inLane.length}
                  </motion.span>
                </div>
                {inLane.map((c) => (
                  <CardFlight key={c.id} flightId={c.id}>
                    <button
                      type="button"
                      onClick={() => setCards((cs) => cs.map((x) => (x.id === c.id ? { ...x, status: NEXT[x.status] } : x)))}
                      data-status={c.status}
                      className={cn(
                        "card-surface flex w-full items-center gap-2.5 p-2.5 text-left pressable focus-ring",
                        c.status === "needs-you" && "st-border-grad shadow-[0_14px_34px_-14px_rgb(255_61_119/0.55)]",
                      )}
                    >
                      <AgentGlyph name={c.name} size={30} status={c.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-extrabold text-mute">{c.name}</span>
                        <span className="block truncate text-sm font-bold">{c.title}</span>
                      </span>
                      {c.status === "needs-you" ? <Badge tone="needs-you">ask</Badge> : <ArrowRight className="size-3.5 text-mute-2" />}
                    </button>
                  </CardFlight>
                ))}
              </div>
            );
          })}
        </div>
      </LayoutGroup>
    </Section>
  );
}
