import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { create } from "zustand";
import { haptic } from "@/features/shell/haptics";
import { AnimatePresence, cn, spring } from "@/design";
import { useBoard } from "./boardStore";

export interface SwipeAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Tailwind classes for the revealed button. */
  tone: string;
  run(): void;
}

/** Only one row is swiped open at a time. */
const useOpenRow = create<{ open: string | null; set(open: string | null): void }>()((set) => ({
  open: null,
  set: (open) => set({ open }),
}));

const ACTION_W = 76;
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

/**
 * Thumb-first row: swipe left to reveal actions (Answer · Terminal · Archive), tap to open.
 * Long-press enters multi-select (the board's selection bar takes over); while selecting, taps
 * toggle rows and swipes are off.
 */
export function SwipeRow({
  id,
  actions,
  onOpen,
  children,
  className,
}: {
  id: string;
  actions: SwipeAction[];
  onOpen(): void;
  children: ReactNode;
  className?: string;
}) {
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const open = useOpenRow((s) => s.open === id);
  const setOpen = useOpenRow((s) => s.set);
  const selecting = useBoard((s) => s.picked.length > 0);
  const picked = useBoard((s) => s.picked.includes(id));
  const width = actions.length * ACTION_W;
  const reveal = useTransform(x, [-width, -24, 0], [1, 0.4, 0]);

  useEffect(() => {
    void animate(x, open && !selecting ? -width : 0, spring.snappy);
  }, [open, selecting, width, x]);

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
  };

  return (
    <div
      className={cn("relative rounded-xl", className)}
      data-swipe-row={id}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        cancelPress();
        const p = { x: e.clientX, y: e.clientY, fired: false, timer: 0 };
        p.timer = window.setTimeout(() => {
          p.fired = true;
          haptic("heavy");
          setOpen(null);
          useBoard.getState().togglePick(id);
        }, LONG_PRESS_MS);
        press.current = p;
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
    >
      <div className="absolute inset-0 overflow-hidden rounded-xl">
        <motion.div style={{ opacity: reveal }} className="absolute inset-y-0 right-0 flex" aria-hidden={!open}>
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              tabIndex={open ? 0 : -1}
              onClick={() => {
                setOpen(null);
                haptic("select");
                a.run();
              }}
              className={cn("flex flex-col items-center justify-center gap-1 text-2xs font-bold pressable", a.tone)}
              style={{ width: ACTION_W }}
            >
              <span className="[&>svg]:size-5">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </motion.div>
      </div>
      <motion.div
        drag={selecting ? false : "x"}
        dragDirectionLock
        dragConstraints={{ left: -width, right: 0 }}
        dragElastic={{ left: 0.15, right: 0.05 }}
        dragMomentum={false}
        style={{ x, touchAction: "pan-y" }}
        animate={{ scale: picked ? 0.97 : 1 }}
        transition={spring.snappy}
        onDragStart={() => {
          dragged.current = true;
          cancelPress();
        }}
        onDragEnd={(_, info) => {
          const shouldOpen = x.get() < -width / 2.6 || info.velocity.x < -400;
          if (shouldOpen && !open) haptic("tick");
          setOpen(shouldOpen ? id : null);
          void animate(x, shouldOpen ? -width : 0, spring.snappy);
        }}
        onPointerDownCapture={() => {
          dragged.current = false;
        }}
        onClick={() => {
          // a swipe or a long-press ends with a click on the row; neither should open the session
          if (dragged.current || press.current?.fired) {
            dragged.current = false;
            if (press.current) press.current.fired = false;
            return;
          }
          if (selecting) {
            haptic("select");
            useBoard.getState().togglePick(id);
          } else if (open) setOpen(null);
          else onOpen();
        }}
        className={cn("relative cursor-pointer rounded-xl", picked && "shadow-[0_0_0_2px_var(--color-accent),0_0_24px_-4px_rgb(163_92_240/0.6)]")}
      >
        {children}
        <AnimatePresence>
          {selecting && (
            <motion.span
              aria-hidden
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={spring.bouncy}
              className={cn(
                "absolute -top-1.5 -left-1.5 z-raised grid size-6 place-items-center rounded-full",
                picked ? "bg-accent text-white shadow-glow-accent" : "bg-tile-5/80 shadow-[inset_0_0_0_1.5px_var(--color-line-3)]",
              )}
            >
              {picked && (
                <svg viewBox="0 0 12 12" className="size-3.5">
                  <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
