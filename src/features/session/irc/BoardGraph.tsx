import { ChevronLeft, ChevronRight, ExternalLink, ListFilter, Pause, Play, SkipBack, SlidersHorizontal, User, Workflow, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "@/core";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Select,
  Spinner,
  type Status,
  StatusOrb,
  Switch,
  Tooltip,
  useNow,
} from "@/design";
import { COLUMN_STATUS } from "@/features/shell/status";
import { formatClock } from "../resume/words";
import { useSessionUi } from "../state";
import { SUB_LABEL, SUB_STATUS } from "../subagents/Subagents";
import { AgentAvatar } from "./AgentAvatar";
import { type GraphPrefs, setGraphPrefs, useBoardUi } from "./boardUi";
import { type BoardMessage, type ChatAgent, previewText, recipientsText, roleText, USER } from "./chat";
import {
  activeAt,
  buildGraph,
  type ChatGraph,
  countNear,
  edgeKey,
  type GraphEdge,
  type GraphNode,
  keepNodes,
  type LayoutItem,
  layoutGraph,
  type Pacing,
  pickHub,
  presentAt,
  type SpawnEdge,
  statusAt,
  stepDelay,
  summarize,
  summaryText,
  trackAt,
  trackPositions,
  type TreeAgent,
} from "./graph";

const SPEEDS = [0.5, 1, 2, 4, 8];
const PACINGS: { value: Pacing; label: string }[] = [
  { value: "even", label: "Even pacing" },
  { value: "real", label: "Real-time pacing" },
];
/** A pill's padding, status dot, gap and border around its name. */
const PILL_PAD = 40;
/** Longest name a pill shows before it is cut. */
const LABEL_MAX = 150;
/** Posts listed when an edge is picked. */
const EDGE_LIST = 3;

type Selection = { kind: "node"; id: string } | { kind: "edge"; key: string } | null;

interface Pill {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An edge as drawn: the curve between two pills (clear of both), its arrowhead and where its count goes. */
interface EdgeShape {
  d: string;
  arrow: string;
  label: { x: number; y: number };
}

/** Width of an edge carrying `n` messages: grows with the count, slower as it climbs, capped. */
function edgeWidth(n: number): number {
  return Math.min(8, 1.4 + 1.6 * Math.log2(n));
}

/**
 * The curve from pill `a` to pill `b`: a quadratic bowed to the left of its direction, so A → B and
 * B → A bow apart; `bend` scales the bow (an @all leg runs outside a direct edge the same way). It
 * leaves `a` and stops short of `b` for the arrowhead. None when the pills overlap.
 */
function edgeShape(a: Pill, b: Pill, width: number, bend: number): EdgeShape | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return undefined;
  const off = Math.min(46, Math.max(14, len * 0.16)) * bend;
  const cx = (a.x + b.x) / 2 + (dy / len) * off;
  const cy = (a.y + b.y) / 2 - (dx / len) * off;
  const at = (t: number) => {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
  };
  const inside = (t: number, p: Pill, margin: number) => {
    const q = at(t);
    return Math.abs(q.x - p.x) <= p.w / 2 + margin && Math.abs(q.y - p.y) <= p.h / 2 + margin;
  };
  if (inside(0.5, a, 2) || inside(0.5, b, 4)) return undefined;
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid, a, 2)) lo = mid;
    else hi = mid;
  }
  const t0 = hi;
  lo = 0.5;
  hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid, b, 4)) hi = mid;
    else lo = mid;
  }
  const t1 = lo;
  const tip = at(t1);
  const tx = 2 * (1 - t1) * (cx - a.x) + 2 * t1 * (b.x - cx);
  const ty = 2 * (1 - t1) * (cy - a.y) + 2 * t1 * (b.y - cy);
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const head = 6 + width * 1.15;
  const half = 3.2 + width * 0.85;
  // The stroke ends under the arrowhead, so its width never shows past the head's sides.
  lo = t0;
  hi = t1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const q = at(mid);
    if (Math.hypot(q.x - tip.x, q.y - tip.y) > head * 0.6) lo = mid;
    else hi = mid;
  }
  const t2 = lo;
  const s = at(t0);
  const e = at(t2);
  const k0 = (1 - t0) * (1 - t2);
  const k1 = (1 - t0) * t2 + t0 * (1 - t2);
  const k2 = t0 * t2;
  const qx = k0 * a.x + k1 * cx + k2 * b.x;
  const qy = k0 * a.y + k1 * cy + k2 * b.y;
  const bx = tip.x - ux * head;
  const by = tip.y - uy * head;
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    d: t2 > t0 ? `M${r(s.x)},${r(s.y)} Q${r(qx)},${r(qy)} ${r(e.x)},${r(e.y)}` : "",
    arrow: `M${r(tip.x)},${r(tip.y)} L${r(bx - uy * half)},${r(by + ux * half)} L${r(bx + uy * half)},${r(by - ux * half)} Z`,
    label: at((t0 + t1) / 2),
  };
}

/** Who runs under whom: the straight line from a parent's pill to its child's, clear of both (none when they overlap). */
function spawnLine(a: Pill, b: Pill): string | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Where the segment leaves a pill (a few pixels off it), as a share of its length.
  const exit = (p: Pill) => Math.min(dx === 0 ? Number.POSITIVE_INFINITY : (p.w / 2 + 3) / Math.abs(dx), dy === 0 ? Number.POSITIVE_INFINITY : (p.h / 2 + 3) / Math.abs(dy));
  const t0 = exit(a);
  const t1 = 1 - exit(b);
  if (!(t0 < t1)) return undefined;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M${r(a.x + dx * t0)},${r(a.y + dy * t0)} L${r(a.x + dx * t1)},${r(a.y + dy * t1)}`;
}

let measure: CanvasRenderingContext2D | null | undefined;

/** A name's width in the pills' font (a canvas measures it; an estimate without one). */
function textWidth(text: string, font: string): number {
  if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * 7.2;
  measure.font = font;
  return measure.measureText(text).width;
}

/** An element's inner size, kept current. */
function useBoxSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

interface GraphProps {
  agentKey: string;
  mobile: boolean;
  messages: readonly BoardMessage[];
  /** The whole log's graph with the session's tree (the Members tab counts from it too). */
  full: ChatGraph;
  /** The session's agent tree (`sessionTree`): its agents are on the graph whether they posted or not. */
  tree: readonly TreeAgent[];
  agentOf: (id: string) => ChatAgent;
  byId: ReadonlyMap<string, BoardMessage>;
  /** The board, filtered to one agent or the messages between two. */
  onShowMessages: (agents: string[]) => void;
  /** The board, at one message. */
  onShowMessage: (id: string) => void;
}

/**
 * The message board's Graph tab (architecture §6.17): the session's orchestration as a graph. Its
 * agents as pills (the main agent and its subagents at any depth, silent ones too, and anyone else
 * who posted or was addressed), who runs under whom as thin lines, who wrote to whom as curved
 * arrows (width and label: how many posts), broadcasts as an `@all N` badge on the sender and, with
 * Expand @all, dashed legs to the agents they listed; an agent that posted with no mention has a
 * dotted border, a silent one no fill, a finished one is dimmed and struck through (Hide inactive
 * leaves it out). A timeline replays the log: the graph as of the post at the playhead (who had
 * been spawned and was still running then included), play at even or real-time pacing and a speed,
 * step one post either way, Live follows new posts. Picking an agent or an edge highlights it; its
 * card lists its posts and takes the board to them.
 */
export function BoardGraph({ loading, ...props }: GraphProps & { loading: boolean }) {
  if (loading) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <Spinner size={18} label="Loading messages" />
      </div>
    );
  }
  if (props.messages.length === 0 && props.tree.length === 0) {
    return <EmptyState className="mt-10" compact icon={<Workflow />} title="No agents yet" description="The session's subagents and who writes to whom show up here once it spawns a subagent or its agents message each other." />;
  }
  // Mounted with its canvas: it measures the canvas and its font when it mounts.
  return <GraphView {...props} />;
}

function GraphView({ agentKey, mobile, messages, full, tree, agentOf, byId, onShowMessages, onShowMessage }: GraphProps) {
  const prefs = useBoardUi((s) => s.graph);
  const column = useAgent(agentKey)?.column;
  const now = useNow(60_000);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const size = useBoxSize(canvasRef);
  // The playhead: how many posts the graph shows; null follows the log (Live).
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [font, setFont] = useState<{ family: string; loaded: boolean }>();

  const total = messages.length;
  const live = pinned === null || pinned >= total;
  const k = live ? total : pinned;
  const seek = (n: number) => setPinned(n >= total ? null : Math.max(0, n));
  const ats = useMemo(() => messages.map((m) => m.at), [messages]);
  const positions = useMemo(() => trackPositions(ats, prefs.pacing), [ats, prefs.pacing]);
  // Who had been spawned and was running is told as of the post at the playhead (the start: just
  // before the first post); Live, as of now.
  const t = live ? Number.POSITIVE_INFINITY : k > 0 ? (ats[k - 1] as number) : (ats[0] as number) - 1;
  const shown = useMemo(() => (live ? full : buildGraph(messages.slice(0, k), tree)), [live, full, messages, k, tree]);
  const active = (id: string) => !prefs.hideInactive || activeAt(agentOf(id), t);
  // An agent of the tree spawned after the playhead isn't there yet; one that posted or was addressed by then is.
  const graph = keepNodes(shown, (n) => presentAt(n, agentOf(n.id), t) && active(n.id));
  const drawn = graph.edges.filter((e) => !e.viaAll || prefs.expandAll);
  const latest = k > 0 ? messages[k - 1] : undefined;

  // The places: every agent of the tree and the whole log the switches keep (agents yet to be
  // spawned or to post wait in theirs, so scrubbing moves no one).
  const placedKey = full.nodes
    .filter((n) => active(n.id))
    .map((n) => n.id)
    .join("\n");
  const pillH = mobile ? 32 : 28;
  // `font` changes once the web fonts loaded: the names are measured again.
  const layout = useMemo(() => {
    const on = new Set(placedKey ? placedKey.split("\n") : []);
    const placed = keepNodes(full, (n) => on.has(n.id));
    const hub = pickHub(placed);
    const parentOf = new Map(placed.spawns.map((s) => [s.child, s.parent]));
    // Siblings in the tree's order, then everyone else as they came; You last.
    const items: LayoutItem[] = [...placed.nodes]
      .sort((a, b) => Number(a.id === USER) - Number(b.id === USER))
      .map((n) => {
        const label = agentOf(n.id).label;
        const w = font ? textWidth(label, `800 12px ${font.family}`) : label.length * 7.2;
        return { id: n.id, parent: parentOf.get(n.id), w: Math.ceil(Math.min(LABEL_MAX, w)) + PILL_PAD, h: pillH };
      });
    const pills = new Map(items.map((it) => [it.id, it]));
    const placedAt = hub && size.w > 0 ? layoutGraph(items, hub, size.w, size.h) : { pos: new Map<string, { x: number; y: number }>(), height: size.h };
    return { hub, pills, ...placedAt };
  }, [placedKey, full, agentOf, font, pillH, size.w, size.h]);
  const hub = layout.hub;

  const pillOf = (id: string): Pill | undefined => {
    const p = layout.pos.get(id);
    const it = layout.pills.get(id);
    return p && it ? { x: p.x, y: p.y, w: it.w, h: it.h } : undefined;
  };

  // The canvas's font, measured once it is on screen and again once the web fonts loaded.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const family = getComputedStyle(el).fontFamily;
    setFont({ family, loaded: false });
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFont({ family, loaded: true }));
    return () => {
      alive = false;
    };
  }, []);

  // Playback: the next message after its pause; at the end the graph is live again.
  useEffect(() => {
    if (!playing) return;
    if (live) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setPinned(k + 1 >= total ? null : k + 1), stepDelay(positions, k, prefs.speed));
    return () => window.clearTimeout(timer);
  }, [playing, live, k, total, positions, prefs.speed]);

  // Esc drops the pick before it closes the full-screen board (window capture runs ahead of the dialog's).
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setSel(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel]);

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const selNode = sel?.kind === "node" && nodeIds.has(sel.id) ? sel.id : undefined;
  const selEdge = sel?.kind === "edge" ? drawn.find((e) => edgeKey(e) === sel.key) : undefined;
  const picked = selNode !== undefined || selEdge !== undefined;
  const lit = (e: GraphEdge) => (selNode !== undefined ? e.from === selNode || e.to === selNode : e === selEdge);
  const kin = (s: SpawnEdge) => selNode !== undefined && (s.parent === selNode || s.child === selNode);
  const near = new Set<string>();
  for (const e of drawn) if (lit(e)) near.add(e.from).add(e.to);
  for (const s of graph.spawns) if (kin(s)) near.add(s.parent).add(s.child);
  if (selNode) near.add(selNode);
  const order = [...drawn].sort((a, b) => Number(lit(a)) - Number(lit(b)) || Number(b.viaAll) - Number(a.viaAll));
  // Nothing posted yet: the tree alone, nothing to replay.
  const none = total === 0;
  const play = () => {
    if (playing) return setPlaying(false);
    if (live) setPinned(0);
    setPlaying(true);
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 flex-col gap-1.5 border-b border-line", mobile ? "px-2.5 py-2" : "px-3 py-2")}>
        <div className="flex min-w-0 items-center gap-0.5">
          <IconButton label="To the start" size={mobile ? "md" : "sm"} disabled={k === 0} onClick={() => seek(0)}>
            <SkipBack />
          </IconButton>
          <IconButton label="Previous post" size={mobile ? "md" : "sm"} disabled={k === 0} onClick={() => seek(k - 1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label={playing ? "Pause" : live ? "Play from the start" : "Play"} size={mobile ? "md" : "sm"} variant="secondary" disabled={none} onClick={play}>
            {playing ? <Pause /> : <Play />}
          </IconButton>
          <IconButton label="Next post" size={mobile ? "md" : "sm"} disabled={live} onClick={() => seek(k + 1)}>
            <ChevronRight />
          </IconButton>
          <Scrubber
            positions={positions}
            k={k}
            onSeek={(n) => {
              setPlaying(false);
              seek(n);
            }}
          />
          <Tooltip content={live ? "Following new posts" : "Back to the latest post"}>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setPinned(null);
              }}
              aria-pressed={live}
              className={cn("focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-bold touch-hit", live ? "text-done" : "text-mute hover:text-ink")}
            >
              <span className={cn("size-2 rounded-full", live ? "bg-done shadow-[0_0_8px_color-mix(in_srgb,var(--color-done)_70%,transparent)]" : "shadow-[inset_0_0_0_1.5px_var(--color-mute-2)]")} aria-hidden />
              Live
            </button>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
          <span className="min-w-0 flex-auto truncate text-[11.5px] font-semibold text-mute tabular" role="status">
            {summaryText(summarize(ats, k))}
          </span>
          {mobile ? <OptionsMenu prefs={prefs} /> : <OptionsRow prefs={prefs} />}
        </div>
        {latest && (
          <button
            type="button"
            onClick={() => onShowMessage(latest.id)}
            title="Show it on the board"
            className="focus-ring flex min-w-0 items-baseline gap-1.5 rounded-[6px] px-1 text-left text-[11.5px] text-mute hover:text-ink-2"
          >
            <span className="shrink-0 font-semibold text-mute-2 tabular">{formatClock(latest.at, now)}</span>
            <b className="max-w-[30%] shrink-0 truncate font-extrabold text-ink-2">{agentOf(latest.from).label}</b>
            <span className="shrink-0 text-mute-2">→</span>
            <b className="max-w-[30%] shrink-0 truncate font-bold text-ink-2">{recipientsText(latest.to, latest.broadcast, agentOf) || "no one"}</b>
            <span className="min-w-0 truncate">{previewText(latest.text) || "(empty)"}</span>
          </button>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={canvasRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [background-image:radial-gradient(color-mix(in_srgb,var(--color-ink)_8%,transparent)_1px,transparent_1px)] [background-size:20px_20px]"
          onClick={() => setSel(null)}
        >
          <div className="relative" style={{ width: size.w, height: layout.height }}>
            <svg width={size.w} height={layout.height} className="pointer-events-none absolute inset-0" aria-hidden>
              {graph.spawns.map((s) => {
                const a = pillOf(s.parent);
                const b = pillOf(s.child);
                const d = a && b ? spawnLine(a, b) : undefined;
                if (!d) return null;
                return <path key={`${s.parent}\n${s.child}`} d={d} fill="none" strokeWidth={1.25} className={cn("animate-[tf-fade-in_240ms_ease-out] stroke-ink/25 transition-opacity", picked && !kin(s) && "opacity-30")} />;
              })}
              {order.map((e) => {
                const a = pillOf(e.from);
                const b = pillOf(e.to);
                const n = e.ids.length;
                const width = edgeWidth(n);
                const shape = a && b ? edgeShape(a, b, width, e.viaAll ? 1.75 : 1) : undefined;
                if (!shape) return null;
                const key = edgeKey(e);
                const on = lit(e);
                const fresh = !picked && latest !== undefined && e.ids[n - 1] === latest.id;
                const tone = on || fresh ? "accent" : e.viaAll ? "via" : "plain";
                const pick = (ev: { stopPropagation(): void }) => {
                  ev.stopPropagation();
                  setSel(selEdge === e ? null : { kind: "edge", key });
                };
                return (
                  <g key={key} className={cn("animate-[tf-fade-in_240ms_ease-out] transition-opacity", picked && !on && "opacity-20")}>
                    <path d={shape.d} fill="none" strokeWidth={14} stroke="transparent" className="cursor-pointer [pointer-events:stroke]" onClick={pick} />
                    <path
                      d={shape.d}
                      fill="none"
                      strokeWidth={width}
                      strokeLinecap="round"
                      strokeDasharray={e.viaAll ? "5 4" : undefined}
                      className={cn("transition-[stroke-width]", tone === "accent" ? "stroke-accent-hi" : tone === "via" ? "stroke-mute-2" : "stroke-mute/75")}
                    />
                    <path d={shape.arrow} className={cn(tone === "accent" ? "fill-accent-hi" : tone === "via" ? "fill-mute-2" : "fill-mute/75")} />
                    {n > 1 && (
                      <g className="pointer-events-auto cursor-pointer" onClick={pick}>
                        <rect x={shape.label.x - 5 - String(n).length * 3.2} y={shape.label.y - 8} width={10 + String(n).length * 6.4} height={16} rx={8} strokeWidth={1} className={cn("fill-tile-2", on || fresh ? "stroke-accent/60" : "stroke-line-3")} />
                        <text x={shape.label.x} y={shape.label.y} textAnchor="middle" dominantBaseline="central" className={cn("text-[10px] font-extrabold tabular", on || fresh ? "fill-accent-ink" : "fill-ink-2")}>
                          {n}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((n) => {
              const p = pillOf(n.id);
              if (!p) return null;
              const who = agentOf(n.id);
              const status = who.sub ? statusAt(who.sub, t) : undefined;
              const inactive = !activeAt(who, t);
              const silent = n.sent + n.got === 0;
              const isHub = n.id === hub;
              const on = selNode === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel(on ? null : { kind: "node", id: n.id });
                  }}
                  aria-pressed={on}
                  aria-label={`${who.label}${status ? `, ${SUB_LABEL[status]}` : ""}: ${silent ? "silent" : `posted ${n.sent}, addressed in ${n.got}${n.broadcasts ? `, ${n.broadcasts} to @all` : ""}`}`}
                  title={who.id === who.label ? undefined : who.id}
                  className={cn(
                    "focus-ring absolute flex animate-[tf-fade-in_240ms_ease-out] items-center gap-1.5 rounded-full border-[1.5px] px-2.5 text-left text-[12px] font-extrabold text-ink shadow-d1 transition-[opacity,box-shadow] touch-hit",
                    // Silent: no fill, so an agent that never posted nor was addressed reads apart from one that did.
                    silent ? "bg-transparent text-mute shadow-none" : isHub ? "bg-tile-4" : "bg-tile-3",
                    n.unaddressed ? "border-dotted border-mute" : inactive ? "border-dashed border-line-3" : isHub ? "border-accent/55" : "border-line-3",
                    inactive && "opacity-55",
                    picked && !near.has(n.id) && "opacity-25",
                    on && "shadow-[0_0_0_2px_var(--color-accent),var(--shadow-d1)]",
                  )}
                  style={{ left: p.x - p.w / 2, top: p.y - p.h / 2, width: p.w, height: p.h }}
                >
                  <NodeDot who={who} status={status ? SUB_STATUS[status] : who.kind === "main" ? (column ? COLUMN_STATUS[column] : "idle") : "idle"} />
                  <span className={cn("min-w-0 truncate", inactive && "line-through decoration-[1.5px]")}>{who.label}</span>
                  {n.broadcasts > 0 && (
                    <span className="pointer-events-none absolute -top-2.5 -right-2 rounded-full bg-tile-2 px-1.5 py-px text-[9.5px] leading-[1.35] font-extrabold whitespace-nowrap text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]">
                      @all {n.broadcasts}
                    </span>
                  )}
                </button>
              );
            })}
            {graph.nodes.length === 0 &&
              (k === 0 ? (
                <p className="absolute inset-x-4 top-1/3 text-center text-xs font-semibold text-mute">The start, before the first post: play or step forward to replay the posts.</p>
              ) : (
                <div className="absolute inset-x-4 top-1/3 flex flex-col items-center gap-2 text-center text-xs font-semibold text-mute">
                  Every agent here had finished by then.
                  <Button size="sm" onClick={() => setGraphPrefs({ hideInactive: false })}>
                    Show finished agents
                  </Button>
                </div>
              ))}
          </div>
        </div>
        {(selNode || selEdge) && (
          <div className={cn("absolute bottom-2 glass-blur rounded-[16px] p-3", mobile ? "inset-x-2" : "left-3 w-[min(380px,calc(100%-24px))]")}>
            {selNode && (
              <NodeCard
                agentKey={agentKey}
                who={agentOf(selNode)}
                node={graph.nodes.find((n) => n.id === selNode)}
                t={t}
                live={live}
                onShow={() => onShowMessages([selNode])}
                onClose={() => setSel(null)}
              />
            )}
            {selEdge && <EdgeCard edge={selEdge} agentOf={agentOf} byId={byId} now={now} onShowAll={() => onShowMessages([selEdge.from, selEdge.to])} onShowMessage={onShowMessage} onClose={() => setSel(null)} />}
          </div>
        )}
      </div>
      <Legend mobile={mobile} />
    </div>
  );
}

/** A pill's mark: You, else the agent's status (a subagent's as of the playhead, the main agent's now). */
function NodeDot({ who, status }: { who: ChatAgent; status: Status }) {
  if (who.kind === "user") return <User className="size-3 shrink-0 text-accent-hi" aria-hidden />;
  return <StatusOrb status={status} activity={status === "running" ? "busy" : "silent"} size={7} label={null} />;
}

/**
 * The timeline's track: a mark per post (by order, or by time at real-time pacing), the part
 * played filled, the playhead. Dragging, a tap or the keys move it to the nearest post. Without
 * posts there is nothing to move to: it stays disabled.
 */
function Scrubber({ positions, k, onSeek }: { positions: readonly number[]; k: number; onSeek: (n: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const x = trackAt(positions, k);
  const n = positions.length;
  const off = n === 0;
  const seekAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (r && r.width > 0) onSeek(countNear(positions, (clientX - r.left) / r.width));
  };
  const onKey = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.round(n / 10));
    const keys: Record<string, number> = { ArrowLeft: k - 1, ArrowDown: k - 1, ArrowRight: k + 1, ArrowUp: k + 1, PageDown: k - page, PageUp: k + page, Home: 0, End: n };
    const to = keys[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(n, to)));
  };
  const ticks = positions.map((p) => `M${Math.round(p * 1000)} 0V10`).join("");
  return (
    <div
      role="slider"
      tabIndex={off ? -1 : 0}
      aria-label="Timeline"
      aria-disabled={off || undefined}
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={k}
      aria-valuetext={`${k} of ${n} posts`}
      onPointerDown={(e) => {
        if (off) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e.clientX);
      }}
      onKeyDown={off ? undefined : onKey}
      className={cn("focus-ring relative mx-1.5 h-8 min-w-0 flex-1 touch-none rounded-full px-2 select-none", off ? "opacity-40" : "cursor-pointer")}
    >
      <div ref={trackRef} className="relative h-full">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink/10" />
        <div className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${x * 100}%` }} />
        {n <= 600 && (
          <svg viewBox="0 0 1000 10" preserveAspectRatio="none" className="absolute inset-x-0 top-1/2 h-2.5 w-full -translate-y-1/2 overflow-visible" aria-hidden>
            <path d={ticks} strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-ink/30" />
          </svg>
        )}
        {!off && <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.45),0_0_0_2.5px_var(--color-accent)]" style={{ left: `${x * 100}%` }} />}
      </div>
    </div>
  );
}

const speedOptions = SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }));

/** Desktop: the switches and pickers in a row (they wrap under the summary in a narrow panel). */
function OptionsRow({ prefs }: { prefs: GraphPrefs }) {
  const toggle = (label: string, checked: boolean, change: (on: boolean) => void) => (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-bold text-ink-2">
      <Switch checked={checked} onCheckedChange={change} />
      {label}
    </label>
  );
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5">
      {toggle("Hide inactive", prefs.hideInactive, (hideInactive) => setGraphPrefs({ hideInactive }))}
      {toggle("Expand @all", prefs.expandAll, (expandAll) => setGraphPrefs({ expandAll }))}
      <Select value={prefs.pacing} onValueChange={(v) => setGraphPrefs({ pacing: v as Pacing })} options={PACINGS} aria-label="Pacing" className="h-8 min-w-0 gap-1.5 rounded-full px-3 text-xs" />
      <Select value={String(prefs.speed)} onValueChange={(v) => setGraphPrefs({ speed: Number(v) })} options={speedOptions} aria-label="Speed" className="h-8 min-w-0 gap-1.5 rounded-full px-3 text-xs" />
    </div>
  );
}

/** Phones: the same choices in one menu. */
function OptionsMenu({ prefs }: { prefs: GraphPrefs }) {
  const keepOpen = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" icon={<SlidersHorizontal />} className="h-8 shrink-0 rounded-full px-2.5">
          {PACINGS.find((p) => p.value === prefs.pacing)?.label.replace(" pacing", "")} · {prefs.speed}×
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuCheckboxItem checked={prefs.hideInactive} onSelect={keepOpen} onCheckedChange={(hideInactive) => setGraphPrefs({ hideInactive })}>
          Hide inactive
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.expandAll} onSelect={keepOpen} onCheckedChange={(expandAll) => setGraphPrefs({ expandAll })}>
          Expand @all
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Pacing</DropdownMenuLabel>
        {PACINGS.map((p) => (
          <DropdownMenuCheckboxItem key={p.value} checked={prefs.pacing === p.value} onSelect={keepOpen} onCheckedChange={() => setGraphPrefs({ pacing: p.value })}>
            {p.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Speed</DropdownMenuLabel>
        <div className="flex gap-1 px-1.5 pb-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setGraphPrefs({ speed: s })}
              aria-pressed={prefs.speed === s}
              className={cn("focus-ring h-8 flex-1 rounded-sm text-xs font-bold tabular", prefs.speed === s ? "bg-tile-4 text-ink shadow-d1" : "text-mute hover:text-ink")}
            >
              {s}×
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A picked agent: where it sits, its status then, what it posted and was addressed in up to the playhead, the way to its posts. */
function NodeCard({ agentKey, who, node, t, live, onShow, onClose }: { agentKey: string; who: ChatAgent; node?: GraphNode; t: number; live: boolean; onShow: () => void; onClose: () => void }) {
  const sub = who.sub;
  const status = sub && statusAt(sub, t);
  const silent = node !== undefined && node.sent + node.got === 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentAvatar who={who} size={30} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <b className="truncate text-[13px] font-extrabold text-ink">{who.label}</b>
          <span className="truncate text-[11px] font-semibold text-mute-2">
            {status ? `${SUB_LABEL[status]}${live ? "" : " then"} · ` : ""}
            {roleText(who)}
          </span>
        </span>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {node && (
        <p className="text-[11.5px] font-semibold text-mute tabular">
          {silent ? (
            "Silent: it hasn't posted nor been addressed"
          ) : (
            <>
              Posted <b className="text-ink-2">{node.sent}</b> · addressed in <b className="text-ink-2">{node.got}</b>
              {node.broadcasts > 0 && (
                <>
                  {" "}
                  · <b className="text-ink-2">{node.broadcasts}</b> to @all
                </>
              )}
              {node.unaddressed && " · one with no mention"}
            </>
          )}
          {!live && (silent ? " by then" : " (up to here)")}
        </p>
      )}
      {(!silent || sub) && (
        <div className="flex flex-wrap gap-1.5">
          {!silent && (
            <Button size="sm" icon={<ListFilter />} onClick={onShow}>
              Show {who.kind === "user" ? "your" : "its"} posts on the board
            </Button>
          )}
          {sub && (
            <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => useSessionUi.getState().openSubagent(agentKey, sub.id)}>
              Open {who.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A picked edge: who wrote to whom and how often, its newest posts (each opens the board there), all of them on the board. */
function EdgeCard({
  edge,
  agentOf,
  byId,
  now,
  onShowAll,
  onShowMessage,
  onClose,
}: {
  edge: GraphEdge;
  agentOf: (id: string) => ChatAgent;
  byId: ReadonlyMap<string, BoardMessage>;
  now: number;
  onShowAll: () => void;
  onShowMessage: (id: string) => void;
  onClose: () => void;
}) {
  const n = edge.ids.length;
  const newest = edge.ids
    .slice(-EDGE_LIST)
    .reverse()
    .flatMap((id) => byId.get(id) ?? []);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <b className="min-w-0 truncate font-extrabold text-ink">{agentOf(edge.from).label}</b>
        <span className="shrink-0 text-mute-2">→</span>
        <b className="min-w-0 truncate font-extrabold text-ink">{agentOf(edge.to).label}</b>
        <span className="shrink-0 text-[11.5px] font-semibold text-mute tabular">
          · {n} {edge.viaAll ? "@all " : ""}post{n === 1 ? "" : "s"}
        </span>
        <IconButton label="Close" size="sm" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="flex flex-col">
        {newest.map((m) => (
          <button key={m.id} type="button" onClick={() => onShowMessage(m.id)} title="Show it on the board" className="focus-ring flex min-w-0 items-baseline gap-2 rounded-[8px] px-1.5 py-1 text-left text-[11.5px] hover:bg-ink/[0.05]">
            <span className="shrink-0 font-semibold text-mute-2 tabular">{formatClock(m.at, now)}</span>
            <span className={cn("min-w-0 truncate", m.progress ? "text-mute italic" : "text-ink-2")}>{previewText(m.text) || "(empty)"}</span>
          </button>
        ))}
      </div>
      <Button size="sm" icon={<ListFilter />} className="self-start" onClick={onShowAll}>
        Show their posts on the board
      </Button>
    </div>
  );
}

/** What the marks mean. */
function Legend({ mobile }: { mobile: boolean }) {
  const item = (mark: ReactNode, text: string) => (
    <span className="flex shrink-0 items-center gap-1.5">
      {mark}
      {text}
    </span>
  );
  const arrow = (dashed: boolean) => (
    <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden>
      <path d="M1 5H16" strokeWidth={dashed ? 1.6 : 2} strokeDasharray={dashed ? "3.5 2.5" : undefined} className={dashed ? "stroke-mute-2" : "stroke-mute"} />
      <path d="M15 1.2L22 5L15 8.8Z" className={dashed ? "fill-mute-2" : "fill-mute"} />
    </svg>
  );
  const pill = (cls: string, text?: string) => <span className={cn("grid h-3.5 min-w-6 place-items-center rounded-full border-[1.5px] bg-tile-3 px-1 text-[8.5px] leading-none font-extrabold", cls)}>{text}</span>;
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line text-[11px] font-semibold text-mute", mobile ? "px-3 py-2 text-[10.5px]" : "px-4 py-2")}>
      {item(arrow(false), "@mention, width = count")}
      {item(arrow(true), "via @all")}
      {item(
        <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden>
          <path d="M1 5H23" strokeWidth={1.25} className="stroke-ink/40" />
        </svg>,
        "spawned (runs under)",
      )}
      {item(pill("border-dotted border-mute"), "posted with no mention")}
      {item(pill("border-line-3 bg-transparent"), "silent: never posted or addressed")}
      {item(pill("border-dashed border-line-3 text-ink line-through opacity-55", "ab"), "finished")}
      {item(<span className="rounded-full bg-tile-2 px-1.5 py-px text-[9.5px] font-extrabold text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]">@all 2</span>, "= @all posts, drawn by Expand @all")}
    </div>
  );
}
