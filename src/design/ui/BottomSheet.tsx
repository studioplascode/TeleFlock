import * as RadixDialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, type PanInfo, useDragControls, useMotionValue, useTransform } from "motion/react";
import { type PointerEvent, type ReactNode, useRef } from "react";
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
  /**
   * Focus the first tabbable control on open (default true). Pass false when that control is a
   * text field, so opening the sheet doesn't pop the phone keyboard; focus stays on the sheet.
   */
  autoFocus?: boolean;
}

const DISMISS_OFFSET = 110;
const DISMISS_VELOCITY = 550;
/** Finger travel (px) before a press in the content is read as a scroll or a dismiss drag. */
const DRAG_SLOP = 6;

/** Whether every scroller from the touched element up to the sheet body sits at its top. */
function scrolledToTop(target: EventTarget | null, body: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollTop > 0) return false;
    if (el === body) return true;
  }
  return true;
}

/**
 * Mobile bottom sheet: springs up, drag down to dismiss (velocity- or distance-based) from the
 * handle/header or from anywhere in the content while it's scrolled to the top (otherwise the
 * content scrolls), scrim fades with the drag. Rides above the soft keyboard (`--kb-inset`).
 * Built on Radix Dialog for focus trap + a11y.
 */
export function BottomSheet({ open, onOpenChange, title, description, footer, children, className, maxHeight = "88dvh", autoFocus = true }: BottomSheetProps) {
  const controls = useDragControls();
  const y = useMotionValue(0);
  // Scrim follows a dismiss drag (px). While the sheet springs in/out `y` is a "%" string; the
  // overlay's own opacity animation covers that, so the drag factor stays at 1.
  const scrim = useTransform(y, (v: number | string) => (typeof v === "number" ? Math.min(1, Math.max(0, 1 - v / 400)) : 1));
  const press = useRef<{ id: number; x: number; y: number } | null>(null);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onOpenChange(false);
  };

  // Content drags: the first DRAG_SLOP px decide. Downward while every scroller under the finger is
  // at its top → the sheet follows the finger; anything else is left to native scrolling. At the top
  // the scrollers only allow native pans that scroll down (`pan-down`), so the browser doesn't claim
  // the downward swipe first (pointercancel).
  const onBodyPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    press.current = t.closest("input, textarea, select, [contenteditable=true], [data-no-sheet-drag]") ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onBodyPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    press.current = null;
    if (dy > Math.abs(dx) && scrolledToTop(e.target, e.currentTarget)) controls.start(e);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-overlay backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.base}
              >
                {/* Separate layer: an `opacity` MotionValue in `style` would fight the fade above. The blur
                    stays on the fading parent: WebView drops a child's backdrop-filter while the parent fades. */}
                <motion.div className="absolute inset-0 bg-[rgb(8_8_12/0.6)]" style={{ opacity: scrim }} />
              </motion.div>
            </RadixDialog.Overlay>
            <RadixDialog.Content
              asChild
              forceMount
              onOpenAutoFocus={(e) => {
                if (autoFocus) return;
                e.preventDefault();
                if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
              }}
            >
              <motion.div
                className={cn(
                  "fixed inset-x-0 bottom-[var(--kb-inset,0px)] z-modal mx-auto flex w-full max-w-[640px] flex-col rounded-t-sheet bg-[linear-gradient(180deg,#21212d,#16161e)] shadow-[0_-24px_60px_rgb(0_0_0/0.65),inset_0_1px_0_rgb(255_255_255/0.09)] outline-none",
                  className,
                )}
                style={{ y, maxHeight: `calc(${maxHeight} - var(--kb-inset, 0px))` }}
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
                  className="shrink-0 cursor-grab touch-none px-4 pt-2 pb-2.5 active:cursor-grabbing"
                  onPointerDown={(e) => controls.start(e)}
                >
                  <div className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-white/25" aria-hidden />
                  <RadixDialog.Title className="font-display text-xl font-bold tracking-[-0.025em]">{title}</RadixDialog.Title>
                  {description ? (
                    <RadixDialog.Description className="mt-0.5 text-xs text-mute">{description}</RadixDialog.Description>
                  ) : (
                    <RadixDialog.Description className="sr-only">{typeof title === "string" ? title : "Sheet"}</RadixDialog.Description>
                  )}
                </div>
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3 [touch-action:pan-down] [&_.overflow-y-auto]:[touch-action:pan-down]"
                  onPointerDown={onBodyPointerDown}
                  onPointerMove={onBodyPointerMove}
                  onPointerUp={() => (press.current = null)}
                  onPointerCancel={() => (press.current = null)}
                  onScrollCapture={(e) => {
                    const el = e.target as HTMLElement;
                    el.style.touchAction = el.scrollTop > 0 ? "pan-y" : "pan-down";
                  }}
                >
                  {children}
                </div>
                {footer && <div className="shrink-0 border-t border-line px-4 pt-2.5 pb-[max(14px,env(safe-area-inset-bottom))]">{footer}</div>}
                {!footer && <div className="h-[max(10px,env(safe-area-inset-bottom))] shrink-0" />}
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
