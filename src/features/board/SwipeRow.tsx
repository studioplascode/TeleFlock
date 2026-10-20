import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { create } from "zustand";
import { haptic } from "@/features/shell/haptics";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger, cn, spring } from "@/design";

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

/**
 * Thumb-first row: swipe left to reveal actions (Answer · Terminal · Archive), long-press for the
 * same actions in a menu, tap to open.
 */
export function SwipeRow({
  id,
  actions,
  menuTitle,
  onOpen,
  children,
  className,
}: {
  id: string;
  actions: SwipeAction[];
  menuTitle: string;
  onOpen(): void;
  children: ReactNode;
  className?: string;
}) {
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const open = useOpenRow((s) => s.open === id);
  const setOpen = useOpenRow((s) => s.set);
  const width = actions.length * ACTION_W;
  const reveal = useTransform(x, [-width, -24, 0], [1, 0.4, 0]);

  useEffect(() => {
    void animate(x, open ? -width : 0, spring.snappy);
  }, [open, width, x]);

  return (
    <ContextMenu
      onOpenChange={(o) => {
        if (o) haptic("heavy");
      }}
    >
      <ContextMenuTrigger asChild>
        <div className={cn("relative overflow-hidden rounded-xl", className)} data-swipe-row={id}>
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
          <motion.div
            drag="x"
            dragDirectionLock
            dragConstraints={{ left: -width, right: 0 }}
            dragElastic={{ left: 0.15, right: 0.05 }}
            dragMomentum={false}
            style={{ x, touchAction: "pan-y" }}
            onDragEnd={(_, info) => {
              const shouldOpen = x.get() < -width / 2.6 || info.velocity.x < -400;
              if (shouldOpen && !open) haptic("tick");
              setOpen(shouldOpen ? id : null);
              if (!shouldOpen) void animate(x, 0, spring.snappy);
              else void animate(x, -width, spring.snappy);
            }}
            onDragStart={() => {
              dragged.current = true;
            }}
            onPointerDownCapture={() => {
              dragged.current = false;
            }}
            onClick={() => {
              // a swipe ends with a click on the row; it must not open the session
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              if (open) setOpen(null);
              else onOpen();
            }}
            className="relative"
          >
            {children}
          </motion.div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{menuTitle}</ContextMenuLabel>
        <ContextMenuItem onSelect={onOpen}>Open session</ContextMenuItem>
        <ContextMenuSeparator />
        {actions.map((a) => (
          <ContextMenuItem key={a.id} icon={a.icon} onSelect={a.run}>
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
