import { useEffect, useRef } from "react";
import { onFrame, useNow } from "../lib/clock";
import { cn } from "../lib/cn";
import { formatAge } from "../lib/format";
import { useInView } from "../lib/hooks";
import { STATUS, type Status } from "../tokens";
import { useCalmMotion } from "./MotionProvider";

export interface HeartbeatProps {
  /** Monotonic event counter: every increment draws one ECG spike. */
  beat: number;
  /** Time of the last event (ms epoch) for the age label. */
  lastEventAt?: number;
  status?: Status;
  /** Canvas height in px (default 28). Width fills the container. */
  height?: number;
  /** Show the "last event 4s ago" label (default true). */
  showAge?: boolean;
  /** After this much silence the age label turns amber (default 45s). */
  staleAfterMs?: number;
  /** Silence after which the trace has fully decayed to flat (default 20s). */
  flatAfterMs?: number;
  className?: string;
}

/** One P-QRS-T complex, one value per sample (2px). */
const SPIKE = [
  0.03, 0.08, 0.11, 0.08, 0.03, 0, 0, -0.1, 0.5, 1, 0.42, -0.32, -0.12, 0, 0.02, 0.06, 0.11, 0.16, 0.17, 0.14, 0.09, 0.04, 0,
];
const PX_PER_SAMPLE = 2;
const SAMPLE_MS = 34; // ~59px/s scroll

interface Trace {
  samples: Float32Array;
  head: number;
  pending: number[];
  acc: number;
  lastBeatAt: number;
  seed: number;
}

function noise(t: Trace): number {
  t.seed = (t.seed * 1664525 + 1013904223) >>> 0;
  return (t.seed / 4294967296 - 0.5) * 2;
}

function pushSample(t: Trace, now: number, flatAfterMs: number) {
  const energy = Math.exp((-(now - t.lastBeatAt) / flatAfterMs) * 4);
  const spike = t.pending.length ? (t.pending.shift() ?? 0) : 0;
  const v = spike + noise(t) * 0.035 * energy + Math.sin(now / 420) * 0.02 * energy;
  t.samples[t.head] = v;
  t.head = (t.head + 1) % t.samples.length;
}

function addSpike(t: Trace, amp: number) {
  // Cap the backlog (e.g. beats that arrived while the tab was hidden and rAF was paused).
  if (t.pending.length > SPIKE.length * 2) return;
  // A beat that lands while the previous one is still drawing is damped, so bursts read as a
  // rapid rhythm instead of a solid bar.
  const scale = t.pending.length > SPIKE.length / 2 ? amp * 0.55 : amp;
  for (let i = 0; i < SPIKE.length; i++) {
    const s = (SPIKE[i] ?? 0) * scale;
    if (i < t.pending.length) t.pending[i] = Math.max(-0.45, Math.min(1.05, (t.pending[i] ?? 0) + s));
    else t.pending.push(s);
  }
}

/**
 * "Is it still running?" — an ECG trace that spikes on every agent event and decays to a flat line
 * when the agent goes quiet, plus the age of the last event. Rendered on a canvas driven by the
 * shared rAF clock; it stops drawing when off-screen or fully flat.
 */
export function Heartbeat({
  beat,
  lastEventAt,
  status = "running",
  height = 28,
  showAge = true,
  staleAfterMs = 45_000,
  flatAfterMs = 20_000,
  className,
}: HeartbeatProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<Trace | null>(null);
  const wakeRef = useRef<() => void>(() => {});
  const prevBeatRef = useRef(beat);
  const inView = useInView(wrapRef);
  const calm = useCalmMotion();
  const now = useNow(1000);
  const meta = STATUS[status];

  // Size + draw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let dpr = 1;
    let unsub: (() => void) | null = null;

    const ensureTrace = (n: number) => {
      const prev = traceRef.current;
      if (prev && prev.samples.length === n) return prev;
      const samples = new Float32Array(n);
      if (prev) {
        // keep the most recent history when resizing
        const m = Math.min(n, prev.samples.length);
        for (let i = 0; i < m; i++) {
          samples[n - m + i] = prev.samples[(prev.head - m + i + prev.samples.length) % prev.samples.length] ?? 0;
        }
      }
      const t: Trace = prev
        ? { ...prev, samples, head: 0 }
        : { samples, head: 0, pending: [], acc: 0, lastBeatAt: -Infinity, seed: 0x9e3779b9 };
      traceRef.current = t;
      return t;
    };

    const draw = () => {
      const t = traceRef.current;
      if (!t || width === 0) return;
      const h = canvas.height;
      const w = canvas.width;
      ctx.clearRect(0, 0, w, h);
      const n = t.samples.length;
      const mid = h * 0.62;
      const amp = h * 0.5;
      const step = PX_PER_SAMPLE * dpr;
      const shift = calm ? 0 : (t.acc / SAMPLE_MS) * step;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `rgb(${meta.rgb} / 0)`);
      grad.addColorStop(0.35, `${meta.c1}88`);
      grad.addColorStop(1, meta.c2);

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = t.samples[(t.head + i) % n] ?? 0;
        const x = i * step - shift;
        const y = mid - v * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // glow pass
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 4 * dpr;
      ctx.stroke();
      // core pass
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();

      // head dot
      const last = t.samples[(t.head + n - 1) % n] ?? 0;
      const hx = (n - 1) * step - shift;
      const hy = mid - last * amp;
      const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 7 * dpr);
      glow.addColorStop(0, `${meta.c2}cc`);
      glow.addColorStop(1, `${meta.c2}00`);
      ctx.fillStyle = glow;
      ctx.fillRect(hx - 8 * dpr, hy - 8 * dpr, 16 * dpr, 16 * dpr);
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(hx, hy, 1.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    };

    const tick = (_t: number, dt: number) => {
      const t = traceRef.current;
      if (!t) return;
      const at = performance.now();
      t.acc += dt;
      while (t.acc >= SAMPLE_MS) {
        t.acc -= SAMPLE_MS;
        pushSample(t, at, flatAfterMs);
      }
      draw();
      const flat = t.pending.length === 0 && at - t.lastBeatAt > flatAfterMs && t.samples.every((v) => Math.abs(v) < 0.004);
      if (flat && unsub) {
        unsub();
        unsub = null;
      }
    };

    const wake = () => {
      if (calm || !inView) {
        draw();
        return;
      }
      if (!unsub) unsub = onFrame(tick);
    };
    wakeRef.current = wake;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(rect.width));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ensureTrace(Math.ceil(width / PX_PER_SAMPLE) + 2);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    wake();

    return () => {
      ro.disconnect();
      unsub?.();
      wakeRef.current = () => {};
    };
  }, [calm, inView, height, flatAfterMs, meta]);

  // Inject a spike per event.
  useEffect(() => {
    const prev = prevBeatRef.current;
    prevBeatRef.current = beat;
    if (beat === prev) return;
    const t = traceRef.current;
    if (!t) return;
    const spikes = Math.min(Math.max(beat - prev, 1), 3);
    for (let i = 0; i < spikes; i++) addSpike(t, 0.62 + ((t.seed >>> 8) % 38) / 100);
    t.lastBeatAt = performance.now();
    if (calm) {
      // no scrolling: flush the spike straight into the trace
      while (t.pending.length) pushSample(t, t.lastBeatAt, flatAfterMs);
    }
    wakeRef.current();
  }, [beat, calm, flatAfterMs]);

  const age = lastEventAt !== undefined ? now - lastEventAt : undefined;
  // staleness only means something for statuses that are supposed to be producing events
  const stale = STATUS[status].live && age !== undefined && age > staleAfterMs;

  return (
    <div data-status={status} className={cn("flex items-center gap-2 min-w-0", className)}>
      <div ref={wrapRef} className="relative min-w-0 flex-1" style={{ height }} aria-hidden>
        <canvas ref={canvasRef} className="absolute inset-0 block" />
      </div>
      {showAge && age !== undefined && (
        <span
          className={cn("shrink-0 font-mono text-2xs tabular transition-colors", stale ? "text-warn" : "text-mute")}
          title={stale ? "No events for a while" : "Last event"}
        >
          {formatAge(age)}
        </span>
      )}
    </div>
  );
}
