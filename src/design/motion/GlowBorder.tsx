import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import type { Status } from "../tokens";

export interface GlowBorderProps extends HTMLAttributes<HTMLDivElement> {
  status: Status;
  /** Animate the border (default true). When false, children render inside a plain wrapper. */
  active?: boolean;
  /** Border width in px (default 1.5). */
  width?: number;
  /** Corner radius in px (default 22 = kanban card). */
  radius?: number;
  /** Seconds per revolution (default 3.6; needs-you uses 2.4). */
  speed?: number;
  /** Soft outer bloom that rotates with the border (default true for needs-you). */
  bloom?: boolean;
}

/**
 * Rotating conic-gradient border for running / needs-you surfaces. The gradient is a rotating
 * square behind a masked ring, so the loop is a pure transform (GPU), not a repaint.
 */
export function GlowBorder({ status, active = true, width = 1.5, radius = 22, speed, bloom, className, style, children, ...rest }: GlowBorderProps) {
  const loud = status === "needs-you";
  const showBloom = active && (bloom ?? loud);
  const vars = {
    "--gb-width": `${width}px`,
    "--gb-radius": `${radius}px`,
    "--gb-speed": `${speed ?? (loud ? 2.4 : 3.6)}s`,
    borderRadius: radius,
    ...style,
  } as CSSProperties;
  return (
    <div data-status={status} className={cn("tf-glow-border", className)} style={vars} {...rest}>
      {showBloom && <span className="tf-glow-border__bloom tf-loop" aria-hidden />}
      {children}
      {active && <span className="tf-glow-border__ring tf-loop" aria-hidden />}
    </div>
  );
}
