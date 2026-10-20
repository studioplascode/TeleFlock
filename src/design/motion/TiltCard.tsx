import { type HTMLAttributes, type PointerEvent, useRef } from "react";
import { cn } from "../lib/cn";
import { useFinePointer } from "../lib/hooks";
import { useCalmMotion } from "./MotionProvider";

export interface TiltCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Max rotation in degrees (default 5). */
  maxTilt?: number;
  /** Disable tilt (e.g. while dragging). */
  disabled?: boolean;
}

/**
 * 3D tilt + specular highlight that follows the pointer. Only on fine pointers (mouse/trackpad)
 * and when motion isn't reduced. Writes CSS variables directly (no React re-render per move).
 */
export function TiltCard({ maxTilt = 5, disabled = false, className, children, onPointerMove, onPointerLeave, ...rest }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const fine = useFinePointer();
  const calm = useCalmMotion();
  const enabled = fine && !calm && !disabled;

  const handleMove = (e: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e);
    const el = ref.current;
    if (!enabled || !el || e.pointerType !== "mouse") return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const px = (clientX - r.left) / r.width;
      const py = (clientY - r.top) / r.height;
      el.style.setProperty("--rx", `${((0.5 - py) * maxTilt * 2).toFixed(2)}deg`);
      el.style.setProperty("--ry", `${((px - 0.5) * maxTilt * 2).toFixed(2)}deg`);
      el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
      el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
      el.dataset.tilting = "true";
    });
  };

  const handleLeave = (e: PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(e);
    const el = ref.current;
    cancelAnimationFrame(frame.current);
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    el.dataset.tilting = "false";
  };

  return (
    <div ref={ref} className={cn(enabled && "tf-tilt", "relative", className)} onPointerMove={handleMove} onPointerLeave={handleLeave} {...rest}>
      {children}
      {enabled && <span className="tf-tilt__spec" aria-hidden />}
    </div>
  );
}
