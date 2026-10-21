import * as RadixToast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import type { ReactNode } from "react";
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
  dismiss: (id) => set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, open: false } : t)) })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Show a toast from anywhere (no hook needed). Returns its id for `dismissToast`. */
export function toast(input: ToastInput): number {
  return useToastStore.getState().push(input);
}

export function dismissToast(id: number): void {
  useToastStore.getState().dismiss(id);
}

/**
 * Toast host; mount once (DesignProvider does). Desktop: bottom-right (lifted by `--tf-toast-lift`), swipe right.
 * Phone: compact heads-up banners just below the screen header (one line, action on the right, at
 * most two stacked; one, at the top edge, while a sheet is open), swipe up to dismiss.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const remove = useToastStore((s) => s.remove);
  const mobile = useIsMobile();
  return (
    <RadixToast.Provider swipeDirection={mobile ? "up" : "right"} duration={5000}>
      {(mobile ? toasts.slice(-2) : toasts).map((t) => {
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
              if (!o) {
                dismiss(t.id);
                setTimeout(() => remove(t.id), 400);
              }
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
        className={cn(
          "fixed z-toast flex flex-col gap-2 outline-none",
          // --tf-toast-lift: floating bars along the bottom edge (board selection bar) raise the stack clear of them.
          // Phone: banners drop in below the 48px screen header. While a sheet/dialog is open its scrim already
          // covers that header, so the banner moves back up to the safe-area edge (clear of a tall sheet's top)
          // and only the newest one shows; z-toast keeps it above the sheet either way.
          mobile
            ? "inset-x-2.5 top-[calc(env(safe-area-inset-top)+52px)] transition-[top] duration-200 [body:has([role=dialog][data-state=open])_&]:top-[max(8px,env(safe-area-inset-top))] [body:has([role=dialog][data-state=open])_&>li:not(:last-child)]:hidden"
            : "right-5 bottom-[calc(20px+var(--tf-toast-lift,0px))] w-[380px] max-w-[calc(100vw-40px)] transition-[bottom] duration-300",
        )}
      />
    </RadixToast.Provider>
  );
}
