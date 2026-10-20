import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, type PanInfo, useDragControls, useMotionValue, useTransform } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { spring, tween } from "../motion/springs";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Sticky footer (primary action). */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Max height as CSS length (default 88dvh). */
  maxHeight?: string;
}

const DISMISS_OFFSET = 110;
const DISMISS_VELOCITY = 550;

/**
 * Mobile bottom sheet: springs up, drag the handle/header down to dismiss (velocity- or
 * distance-based), scrim fades with the drag. Built on Radix Dialog for focus trap + a11y.
 */
export function BottomSheet({ open, onOpenChange, title, description, footer, children, className, maxHeight = "88dvh" }: BottomSheetProps) {
  const controls = useDragControls();
  const y = useMotionValue(0);
  const scrim = useTransform(y, [0, 400], [1, 0]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onOpenChange(false);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-overlay bg-[rgb(8_8_12/0.6)] backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.base}
                style={{ opacity: scrim }}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild forceMount>
              <motion.div
                className={cn(
                  "fixed inset-x-0 bottom-0 z-modal mx-auto flex w-full max-w-[640px] flex-col rounded-t-sheet bg-[linear-gradient(180deg,#21212d,#16161e)] shadow-[0_-24px_60px_rgb(0_0_0/0.65),inset_0_1px_0_rgb(255_255_255/0.09)] outline-none",
                  className,
                )}
                style={{ y, maxHeight }}
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={spring.sheet}
                drag="y"
                dragListener={false}
                dragControls={controls}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0.04, bottom: 0.9 }}
                onDragEnd={onDragEnd}
              >
                <div
                  className="shrink-0 cursor-grab touch-none px-5 pt-2.5 pb-3 active:cursor-grabbing"
                  onPointerDown={(e) => controls.start(e)}
                >
                  <div className="mx-auto mb-3 h-1 w-[42px] rounded-full bg-white/25" aria-hidden />
                  <RadixDialog.Title className="font-display text-2xl font-bold tracking-[-0.03em]">{title}</RadixDialog.Title>
                  {description ? (
                    <RadixDialog.Description className="mt-0.5 text-sm text-mute">{description}</RadixDialog.Description>
                  ) : (
                    <RadixDialog.Description className="sr-only">{typeof title === "string" ? title : "Sheet"}</RadixDialog.Description>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
                {footer && <div className="shrink-0 border-t border-line px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]">{footer}</div>}
                {!footer && <div className="h-[max(12px,env(safe-area-inset-bottom))] shrink-0" />}
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
