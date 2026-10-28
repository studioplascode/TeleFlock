import * as RadixToast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { useIsMobile } from "../lib/hooks";
import { cn } from "../lib/cn";
import { StatusOrb } from "../motion/StatusOrb";
import type { Status } from "../tokens";

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  /** Status tint + orb. needs-you toasts get the sunset glow and stay until dismissed. */
  status?: Status;
  /** One action button, e.g. { label: "Open", onClick }. */
  action?: { label: string; onClick: () => void };
  /** ms; default 5000, needs-you default Infinity. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  open: boolean;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  remove: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id, open: true }] }));
    return id;
  },
  // closed toasts leave the list once their close animation has played, so a phone's queue moves on
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, open: false } : t)) }));
    setTimeout(() => useToastStore.getState().remove(id), 400);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Show a toast from anywhere (no hook needed). Returns its id for `dismissToast`. */
export function toast(input: ToastInput): number {
  return useToastStore.getState().push(input);
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismiss(id);
}

/** Desktop stack: `right-5`, 380 px wide (the viewport's classes below). */
const DESKTOP_EDGE = 20;
const DESKTOP_WIDTH = 380;

/**
 * The stack sits just above the highest `[data-toast-anchor]` element along the bottom edge that it would
 * otherwise cover. Phones: any anchor in the lower half (tab bar, Flock "+" button, a session's composer
 * dock, Dispatch's composer). Desktop: only anchors under the stack's column (a session's composer and
 * its open question, Dispatch's composer), so the stack stays down in the corner everywhere else; one
 * that starts in the top 30% (a very tall question) is left alone rather than pushing the stack off
 * screen. Re-measured when a toast shows, when an anchor resizes (a composer growing with its text),
 * on resize and on navigation.
 */
function useBottomAnchor(active: boolean, toasts: readonly unknown[], mobile: boolean): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const right = vw - DESKTOP_EDGE;
      const left = right - Math.min(DESKTOP_WIDTH, vw - 2 * DESKTOP_EDGE);
      let top: number | null = null;
      for (const el of document.querySelectorAll<HTMLElement>("[data-toast-anchor]")) {
        resized.observe(el);
        const r = el.getBoundingClientRect();
        // only visible anchors low on the screen count (desktop: only under the stack)
        if (r.height <= 0 || r.top <= vh * (mobile ? 0.5 : 0.3) || (!mobile && (r.right <= left || r.left >= right))) continue;
        top = Math.min(top ?? r.top, r.top);
      }
      setBottom(top === null ? null : vh - top + (mobile ? 8 : 12));
    };
    const resized = new ResizeObserver(() => measure());
    measure();
    // a route change swaps the anchors once the new screen has slid in
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(measure, 380);
    };
    window.addEventListener("resize", measure);
    window.addEventListener("hashchange", later);
    window.addEventListener(ANCHORS_CHANGED, measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      resized.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("hashchange", later);
      window.removeEventListener(ANCHORS_CHANGED, measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [active, toasts, mobile]);
  return active ? bottom : null;
}

const ANCHORS_CHANGED = "tf:toast-anchors";

/**
 * A `[data-toast-anchor]` element appeared, moved into place or went away without a resize or a route
 * change (an ask card landing over the composer): toasts on screen re-measure where they sit.
 */
export function toastAnchorsChanged(): void {
  window.dispatchEvent(new Event(ANCHORS_CHANGED));
}

/**
 * Toast host; mount once (DesignProvider does). Desktop: bottom-right, above a `[data-toast-anchor]` under
 * the stack and floating bars that publish `--tf-toast-lift`; swipe right.
 * Phone: one compact banner in the thumb zone, just above the tab bar / bottom controls (one line,
 * action on the right), with a "+N" mark when more are waiting (they show as it goes); at the top
 * edge while a sheet is open (the sheet owns the bottom). Swipe down to dismiss.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const mobile = useIsMobile();
  const bottom = useBottomAnchor(toasts.length > 0, toasts, mobile);
  // Phones show one toast: the newest open one (else the one closing, so its exit plays); the rest wait.
  const shown = mobile ? (toasts.findLast((t) => t.open) ?? toasts.at(-1)) : undefined;
  const waiting = mobile ? toasts.filter((t) => t.open && t !== shown).length : 0;
  return (
    <RadixToast.Provider swipeDirection={mobile ? "down" : "right"} duration={5000}>
      {(mobile ? (shown ? [shown] : []) : toasts).map((t) => {
        const loud = t.status === "needs-you";
        const action = t.action && (
          <RadixToast.Action altText={t.action.label} asChild>
            <button
              type="button"
              onClick={t.action.onClick}
              className={cn(
                "relative inline-flex items-center font-extrabold pressable touch-hit focus-ring",
                mobile ? "h-9 max-w-[42%] shrink-0 truncate rounded-md px-3.5 text-[13px]" : "mt-2.5 h-8 rounded-sm px-3 text-xs",
                loud ? "bg-sun text-white" : "bg-tile-4 text-ink hover:bg-tile-5",
              )}
            >
              <span className="truncate">{t.action.label}</span>
            </button>
          </RadixToast.Action>
        );
        return (
          <RadixToast.Root
            key={t.id}
            open={t.open}
            duration={t.duration ?? (loud ? Number.POSITIVE_INFINITY : 5000)}
            onOpenChange={(o) => {
              if (!o) dismiss(t.id);
            }}
            data-status={t.status}
            className={cn(
              "tf-toast pointer-events-auto relative flex w-full gap-3 rounded-xl shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)]",
              // Phones: opaque instead of a backdrop blur (cheaper to composite over a live screen).
              mobile ? "items-center bg-[rgb(36_31_44/0.98)] py-2.5 pr-2.5 pl-3.5" : "items-start bg-[rgb(38_33_46/0.94)] p-3.5 pr-10 backdrop-blur-xl",
              loud && "shadow-[var(--shadow-d3),0_0_0_1px_rgb(255_61_119/0.4),0_16px_40px_-10px_rgb(255_61_119/0.5)]",
            )}
          >
            {t.status && <StatusOrb status={t.status} size={9} className={mobile ? undefined : "mt-1.5"} label={null} />}
            {waiting > 0 && (
              <span
                className="absolute -top-2 left-3 rounded-full bg-tile-5 px-1.5 py-px text-[10px] leading-none font-extrabold text-ink shadow-[0_0_0_1.5px_rgb(36_31_44)] tabular"
                aria-label={`${waiting} more`}
              >
                +{waiting}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <RadixToast.Title className={cn("font-extrabold text-ink", mobile ? "truncate text-[13.5px]" : "text-sm")}>{t.title}</RadixToast.Title>
              {t.description && <RadixToast.Description className={cn("mt-0.5 text-xs text-mute", mobile && "truncate")}>{t.description}</RadixToast.Description>}
              {!mobile && action}
            </div>
            {mobile && action}
            {(!mobile || !t.action) && (
              <RadixToast.Close
                aria-label="Dismiss"
                className={cn(
                  "grid place-items-center rounded-xs text-mute-2 hover:bg-white/8 hover:text-ink touch-hit focus-ring",
                  mobile ? "relative size-8 shrink-0" : "absolute top-2.5 right-2.5 size-6",
                )}
              >
                <X className="size-3.5" />
              </RadixToast.Close>
            )}
          </RadixToast.Root>
        );
      })}
      <RadixToast.Viewport
        style={bottom !== null ? ({ "--tf-toast-bottom": `${bottom}px` } as CSSProperties) : undefined}
        className={cn(
          "fixed z-toast flex flex-col gap-2 outline-none",
          // Phone: above the bottom controls (--tf-toast-bottom, measured from the screen top so it already clears the
          // safe area), else above the safe-area edge. While a sheet/dialog is open it owns the bottom, so the banner
          // moves to the safe-area top edge; z-toast keeps it above the sheet either way.
          // Desktop: above a composer under the stack (--tf-toast-bottom) or a floating bar along the bottom edge that
          // publishes --tf-toast-lift (board selection bar), whichever is higher.
          mobile
            ? "inset-x-2.5 bottom-[var(--tf-toast-bottom,calc(12px+env(safe-area-inset-bottom)))] transition-[bottom] duration-200 [body:has([role=dialog][data-state=open])_&]:top-[max(8px,env(safe-area-inset-top))] [body:has([role=dialog][data-state=open])_&]:bottom-auto"
            : "right-5 bottom-[max(calc(20px+var(--tf-toast-lift,0px)),var(--tf-toast-bottom,0px))] w-[380px] max-w-[calc(100vw-40px)] transition-[bottom] duration-300",
        )}
      />
    </RadixToast.Provider>
  );
}
