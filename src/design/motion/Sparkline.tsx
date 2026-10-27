import { useId } from "react";
import { cn } from "../lib/cn";
import { STATUS, type Status } from "../tokens";

export interface SparklineProps {
  values: readonly number[];
  status?: Status;
  /** Height in px (default 32); width fills the container. */
  height?: number;
  /** Gradient area under the line (default true). */
  fill?: boolean;
  /** Pulsing dot on the latest value (default true). */
  live?: boolean;
  className?: string;
  "aria-label"?: string;
}

const VB_W = 100;

/** Catmull-Rom → cubic Bézier smoothing through all points. */
function smoothPath(pts: readonly [number, number][]): string {
  if (pts.length === 0) return "";
  const first = pts[0] as [number, number];
  let d = `M${first[0].toFixed(2)},${first[1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i] ?? first;
    const p1 = pts[i] ?? first;
    const p2 = pts[i + 1] ?? p1;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/**
 * Smooth gradient sparkline. In Lively, with the window active, the path morphs between updates via
 * a CSS `d` transition (`.tf-spark-path`, motion.css; Chromium: WebView2 + Android WebView) so new
 * data glides in; otherwise it jumps (a `d` transition is main-thread SVG animation, 0.6 s per sample).
 */
export function Sparkline({ values, status = "running", height = 32, fill = true, live = true, className, ...rest }: SparklineProps) {
  const id = `tf-spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const meta = STATUS[status];
  const pad = 3;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1e-9);
  const span = max - min || 1;
  const n = Math.max(values.length, 2);
  const pts: [number, number][] = values.map((v, i) => [
    (i / (n - 1)) * VB_W,
    pad + (1 - (v - min) / span) * (height - pad * 2),
  ]);
  const line = smoothPath(pts);
  const area = pts.length ? `${line} L${VB_W},${height} L0,${height} Z` : "";
  const last = pts[pts.length - 1];
  return (
    <div className={cn("relative w-full", className)} style={{ height }} role="img" aria-label={rest["aria-label"] ?? "Activity sparkline"}>
      <svg viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`${id}-s`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={meta.c1} />
            <stop offset="1" stopColor={meta.c2} />
          </linearGradient>
          <linearGradient id={`${id}-f`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={meta.c2} stopOpacity="0.35" />
            <stop offset="1" stopColor={meta.c2} stopOpacity="0" />
          </linearGradient>
        </defs>
        {fill && <path className="tf-spark-path" style={{ d: `path("${area}")` }} fill={`url(#${id}-f)`} />}
        <path
          className="tf-spark-path"
          style={{ d: `path("${line}")` }}
          fill="none"
          stroke={`url(#${id}-s)`}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {live && last && (
        <span
          data-status={status}
          className="tf-orb absolute"
          style={{ left: `${last[0]}%`, top: last[1], translate: "-50% -50%", "--orb-size": "6px", "--tf-breath": "1.6s" } as React.CSSProperties}
          aria-hidden
        >
          <span className="tf-orb__halo tf-loop" />
          <span className="tf-orb__core tf-loop" style={{ background: "#fff" }} />
        </span>
      )}
    </div>
  );
}
