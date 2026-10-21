import type { CSSProperties } from "react";
import { cn } from "../lib/cn";

/** Global mood of the app background. */
export type AmbientMood = "calm" | "running" | "attention" | "error";

/** Pick the ambient mood from board counts: needs-you beats error beats running. */
export function moodFor(counts: { needsYou: number; running: number; error?: number }): AmbientMood {
  if (counts.needsYou > 0) return "attention";
  if ((counts.error ?? 0) > 0) return "error";
  if (counts.running > 0) return "running";
  return "calm";
}

interface Blob {
  moods: readonly AmbientMood[];
  color: string;
  style: CSSProperties;
  drift: "a" | "b" | "c";
  seconds: number;
  opacity: number;
}

const BLOBS: readonly Blob[] = [
  // omp purple, top right — the resting glow
  { moods: ["calm", "running", "attention", "error"], color: "163 92 240", style: { right: "-28vmax", top: "-38vmax" }, drift: "a", seconds: 34, opacity: 0.16 },
  // blue, bottom left — joins while agents run
  { moods: ["running"], color: "79 139 255", style: { left: "-30vmax", bottom: "-42vmax" }, drift: "b", seconds: 41, opacity: 0.16 },
  // omp pink accent
  { moods: ["running", "calm"], color: "240 83 208", style: { left: "18vw", top: "-46vmax" }, drift: "c", seconds: 47, opacity: 0.07 },
  // sunset: something needs you
  { moods: ["attention"], color: "255 61 119", style: { left: "-22vmax", bottom: "-36vmax" }, drift: "b", seconds: 23, opacity: 0.26 },
  { moods: ["attention"], color: "255 122 24", style: { left: "20vw", bottom: "-52vmax" }, drift: "c", seconds: 29, opacity: 0.16 },
  // error
  { moods: ["error"], color: "255 77 94", style: { right: "-26vmax", bottom: "-44vmax" }, drift: "a", seconds: 31, opacity: 0.18 },
];

export interface AmbientGlowProps {
  mood: AmbientMood;
  /** 0..1 overall strength (default 1). */
  intensity?: number;
  className?: string;
}

/**
 * Fixed full-viewport background: noise plus slow drifting blooms that crossfade with the global
 * mood — a warm sunset bloom when anything needs you. Mount once, behind everything.
 */
export function AmbientGlow({ mood, intensity = 1, className }: AmbientGlowProps) {
  return (
    <div className={cn("tf-ambient", className)} data-mood={mood} aria-hidden>
      {BLOBS.map((b, i) => {
        const on = b.moods.includes(mood);
        return (
          <span
            key={i}
            className="tf-ambient__blob tf-loop"
            data-on={on}
            style={
              {
                ...b.style,
                "--blob-o": b.opacity * intensity,
                background: `radial-gradient(circle at center, rgb(${b.color} / 1) 0%, rgb(${b.color} / 0.35) 32%, rgb(${b.color} / 0) 68%)`,
                // Off blobs (opacity 0) hold still: no per-frame work for what nobody sees, and no
                // position jump when they fade back in.
                animation: `tf-drift-${b.drift} ${b.seconds}s ease-in-out infinite ${on ? "running" : "paused"}`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
