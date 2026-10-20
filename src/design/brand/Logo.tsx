import { useId } from "react";
import { cn } from "../lib/cn";

export interface LogoMarkProps {
  /** px (default 24). */
  size?: number;
  /** Gently flap the trailing flock (decorative; stops under reduced motion). */
  animated?: boolean;
  /** Draw in a single colour (currentColor) instead of the omp gradient. */
  mono?: boolean;
  className?: string;
  title?: string;
}

/**
 * TeleFlock mark: the omp π whose crossbar is a gliding gull, trailed by its flock.
 * Source of truth for the shapes: src/assets/logo/teleflock-mark.svg.
 */
export function LogoMark({ size = 24, animated = false, mono = false, className, title = "TeleFlock" }: LogoMarkProps) {
  const gid = `tf-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const stroke = mono ? "currentColor" : `url(#${gid})`;
  const flap = animated ? "tf-loop origin-center [transform-box:fill-box]" : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={cn("shrink-0", className)} role="img" aria-label={title}>
      {!mono && (
        <defs>
          <linearGradient id={gid} x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#f053d0" />
            <stop offset="0.5" stopColor="#a15eef" />
            <stop offset="1" stopColor="#7fa2e7" />
          </linearGradient>
        </defs>
      )}
      <g stroke={stroke} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 28 C13 20.5 19.5 19.5 25 23 L32 27.5 L39 23 C44.5 19.5 51 20.5 57 28" strokeWidth="6.2" />
        <path d="M24.5 25.5 V48" strokeWidth="6.2" />
        <path d="M39.5 25.5 V49 C39.5 53.5 42 56 47 55.5" strokeWidth="6.2" />
        <path
          d="M33 13.2 C35.5 9.6 38 9.4 40.5 13.4 C43 9.4 45.5 9.6 48 13.2"
          strokeWidth="3.4"
          opacity="0.9"
          className={flap}
          style={animated ? { animation: "tf-flap 1.4s ease-in-out infinite" } : undefined}
        />
        <path
          d="M47.5 6.4 C49.2 4 50.8 3.9 52.4 6.6 C54 3.9 55.6 4 57.2 6.4"
          strokeWidth="2.6"
          opacity="0.65"
          className={flap}
          style={animated ? { animation: "tf-flap 1.4s ease-in-out 0.35s infinite" } : undefined}
        />
      </g>
    </svg>
  );
}

export interface WordmarkProps {
  /** Mark size in px (default 22); text scales with it. */
  size?: number;
  animated?: boolean;
  className?: string;
}

/** Mark + "TeleFlock" in the display face. */
export function Wordmark({ size = 22, animated, className }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} animated={animated} title="" />
      <span className="font-display font-semibold tracking-[-0.01em] text-ink" style={{ fontSize: Math.round(size * 0.7) }}>
        TeleFlock
      </span>
    </span>
  );
}
