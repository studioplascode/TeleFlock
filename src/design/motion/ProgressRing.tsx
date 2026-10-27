import { motion } from "motion/react";
import { useId } from "react";
import { cn } from "../lib/cn";
import { STATUS, type Status } from "../tokens";
import { spring } from "./springs";

export interface ProgressRingProps {
  done: number;
  total: number;
  status?: Status;
  /** Outer size in px (default 40). */
  size?: number;
  /** Stroke width in px (default 4). */
  stroke?: number;
  /** Centre label; defaults to "done/total". Pass null to hide. */
  label?: React.ReactNode | null;
  /** Accessible name; defaults to "done of total todos". */
  ariaLabel?: string;
  className?: string;
}

/**
 * Todo progress ring. While running, a comet orbits the ring so you can see the agent working. The
 * arc's glow (`.tf-ring__arc`, a drop-shadow filter) is Lively only: a filtered arc repaints its
 * whole layer while it moves.
 */
export function ProgressRing({ done, total, status = "running", size = 40, stroke = 4, label, ariaLabel, className }: ProgressRingProps) {
  const gid = `tf-ring-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const meta = STATUS[status];
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const text = label === undefined ? `${done}/${total}` : label;
  return (
    <span
      data-status={status}
      className={cn("tf-ring", className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={ariaLabel ?? `${done} of ${total} todos`}
    >
      {status === "running" && <span className="tf-ring__comet tf-loop" />}
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={meta.c1} />
            <stop offset="1" stopColor={meta.c2} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth={stroke} />
        <motion.circle
          className="tf-ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - frac) }}
          transition={spring.gentle}
        />
      </svg>
      {text !== null && (
        <span className="relative font-extrabold tabular" style={{ fontSize: Math.max(9, size * 0.25), letterSpacing: "-0.02em" }}>
          {text}
        </span>
      )}
    </span>
  );
}
