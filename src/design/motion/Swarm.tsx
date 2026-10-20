import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Status } from "../tokens";
import { tween } from "./springs";

export interface SwarmProps {
  /** Number of live subagents. */
  count: number;
  status?: Status;
  /** Box size in px (default 44). Orbits sit just outside the centre content. */
  size?: number;
  /** Centre content, usually an AgentGlyph. */
  children?: ReactNode;
  /** Max dots drawn before collapsing into "+N" (default 8). */
  max?: number;
  className?: string;
}

/** Subagents as dots orbiting their parent: two counter-rotating rings, dots pop in/out. */
export function Swarm({ count, status = "running", size = 44, children, max = 8, className }: SwarmProps) {
  const shown = Math.min(count, max);
  const inner = Math.ceil(shown / 2);
  const rings = [
    { n: inner, r: size * 0.5 + 3, speed: 5.5, reverse: false, dot: 5 },
    { n: shown - inner, r: size * 0.5 + 9, speed: 8, reverse: true, dot: 4 },
  ];
  return (
    <span
      data-status={status}
      className={cn("tf-swarm", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${count} subagent${count === 1 ? "" : "s"}`}
    >
      {children}
      {rings.map((ring, ri) => (
        <span
          key={ri}
          className="tf-swarm__orbit tf-loop"
          style={{ "--orbit-speed": `${ring.speed}s`, animationDirection: ring.reverse ? "reverse" : "normal" } as CSSProperties}
          aria-hidden
        >
          <AnimatePresence>
            {Array.from({ length: ring.n }, (_, i) => (
              <motion.span
                key={i}
                className="tf-swarm__arm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.base}
                style={{ transform: `rotate(${(360 / ring.n) * i + ri * 30}deg) translateX(${ring.r}px)` }}
              >
                <span className="tf-swarm__dot" style={{ "--dot": `${ring.dot}px` } as CSSProperties} />
              </motion.span>
            ))}
          </AnimatePresence>
        </span>
      ))}
      {count > max && (
        <span className="absolute -right-2 -bottom-2 rounded-full bg-tile-4 px-1 text-[9px] font-extrabold text-ink shadow-d1">
          +{count - max}
        </span>
      )}
    </span>
  );
}
