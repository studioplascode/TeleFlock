import { ChevronLeft } from "lucide-react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect } from "react";
import { spring } from "@/design";
import { haptic } from "./haptics";
import { goBack } from "./MobileHeader";

const EDGE = 22;
const TRIGGER = 84;

/**
 * Android-style edge swipe: drag from the left edge and a glowing back bubble follows your thumb;
 * release past the threshold to go back. Disabled on root tabs.
 */
export function EdgeSwipeBack({ enabled }: { enabled: boolean }) {
  const dx = useMotionValue(0);
  const y = useMotionValue(0);
  const x = useTransform(dx, [0, TRIGGER, 200], [-44, 10, 22]);
  const scale = useTransform(dx, [0, TRIGGER], [0.4, 1]);
  const opacity = useTransform(dx, [0, 20, TRIGGER], [0, 0.7, 1]);
  const glow = useTransform(dx, [TRIGGER - 1, TRIGGER], ["0 0 0 0 rgb(163 92 240 / 0)", "0 0 28px 4px rgb(163 92 240 / 0.7)"]);

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let tracking = false;
    let armed = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1 || t.clientX > EDGE) return;
      start = { x: t.clientX, y: t.clientY };
      tracking = false;
      armed = false;
      y.set(t.clientY);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const mx = t.clientX - start.x;
      const my = Math.abs(t.clientY - start.y);
      if (!tracking) {
        if (my > 24 && my > mx) {
          start = null;
          return;
        }
        if (mx < 10) return;
        tracking = true;
      }
      dx.set(Math.max(0, mx));
      y.set(t.clientY);
      if (!armed && mx >= TRIGGER) {
        armed = true;
        haptic("tick");
      } else if (armed && mx < TRIGGER) armed = false;
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (tracking && armed) goBack();
      animate(dx, 0, spring.snappy);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, dx, y]);

  if (!enabled) return null;
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-drag grid size-11 -translate-y-1/2 place-items-center rounded-full bg-omp text-white"
      style={{ x, y, scale, opacity, boxShadow: glow }}
    >
      <ChevronLeft className="size-5" />
    </motion.div>
  );
}
