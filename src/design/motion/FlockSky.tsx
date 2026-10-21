import { type CSSProperties, useId } from "react";
import { cn } from "../lib/cn";

interface Flock {
  /** Resting left edge (also where it sits under reduced motion). */
  x: string;
  top: string;
  /** Seconds per crossing; a negative delay starts it mid-flight. */
  dur: number;
  delay: number;
  /** Bird span in px. */
  size: number;
  /** [dx, dy] in bird spans, leader first. */
  birds: readonly [number, number][];
  opacity: number;
  rise: string;
}

/** A V: leader ahead, wings trailing back-left and back-right. */
const V: readonly [number, number][] = [
  [0, 0],
  [-1.25, -0.75],
  [-1.25, 0.75],
  [-2.5, -1.5],
  [-2.5, 1.5],
  [-3.75, -2.25],
  [-3.75, 2.25],
];

const FLOCKS: readonly Flock[] = [
  { x: "12vw", top: "16%", dur: 52, delay: -9, size: 24, birds: V, opacity: 0.6, rise: "-9vh" },
  { x: "58vw", top: "70%", dur: 64, delay: -38, size: 15, birds: V.slice(0, 5), opacity: 0.38, rise: "-14vh" },
  { x: "36vw", top: "36%", dur: 44, delay: -24, size: 10, birds: [[0, 0], [-1.6, 0.9], [-3, -0.4]], opacity: 0.3, rise: "-5vh" },
];

export interface FlockSkyProps {
  className?: string;
}

/**
 * Decorative background: little flocks of omp-gradient gulls gliding across, bobbing and flapping
 * out of sync. Transform-only CSS loops; under reduced motion the flocks hold their formation.
 */
export function FlockSky({ className }: FlockSkyProps) {
  const gid = `tf-sky-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className={cn("tf-sky", className)} aria-hidden>
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f053d0" />
            <stop offset="0.5" stopColor="#a15eef" />
            <stop offset="1" stopColor="#7fa2e7" />
          </linearGradient>
        </defs>
      </svg>
      {FLOCKS.map((f, fi) => (
        <span
          key={fi}
          className="tf-sky__flock"
          style={{ top: f.top, opacity: f.opacity, "--sky-x": f.x, "--sky-dur": `${f.dur}s`, "--sky-delay": `${f.delay}s`, "--sky-rise": f.rise } as CSSProperties}
        >
          {f.birds.map(([dx, dy], bi) => (
            <span
              key={bi}
              className="tf-sky__bird"
              style={
                {
                  left: dx * f.size,
                  top: dy * f.size,
                  "--bob-delay": `${-(bi * 0.37 + fi * 0.9)}s`,
                  "--bob-dur": `${3 + ((bi * 7) % 5) * 0.25}s`,
                  "--bob": `${-4 - (bi % 3) * 2}px`,
                  "--flap": `${1.1 + (bi % 4) * 0.12}s`,
                } as CSSProperties
              }
            >
              <svg width={f.size} height={f.size * 0.45} viewBox="32 8 17 7.6" fill="none">
                <path d="M33 13.2 C35.5 9.6 38 9.4 40.5 13.4 C43 9.4 45.5 9.6 48 13.2" stroke={`url(#${gid})`} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}
