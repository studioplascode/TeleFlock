import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./Button";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

/** Blurred scrim used by Dialog, BottomSheet and the command palette. */
export const overlayClass = "tf-fade fixed inset-0 z-overlay bg-[rgb(8_8_12/0.55)] backdrop-blur-md";

export interface DialogContentProps extends Omit<RadixDialog.DialogContentProps, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Icon tile left of the title (gradient square). */
  icon?: ReactNode;
  /** Footer row (buttons, right-aligned). */
  footer?: ReactNode;
  /** Hide the close (X) button. */
  hideClose?: boolean;
  /** Max width in px (default 560). */
  width?: number;
}

/**
 * Centered modal over a blurred backdrop. Title/description are wired for screen readers.
 * Initial focus goes to the first `[data-autofocus]` element inside (design `Input`/`Textarea`
 * set it from `autoFocus`), with its text selected; otherwise to the first tabbable control.
 */
export function DialogContent({ title, description, icon, footer, hideClose, width = 560, className, children, style, onOpenAutoFocus, ...rest }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={overlayClass} />
      <RadixDialog.Content
        className={cn(
          "tf-dialog fixed top-1/2 left-1/2 z-modal flex max-h-[calc(100dvh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-sheet bg-[linear-gradient(180deg,#1f1f2b,#17171f)] p-6 shadow-[var(--shadow-d3),0_0_0_1px_rgb(255_255_255/0.08)] outline-none",
          className,
        )}
        style={{ maxWidth: width, ...style }}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented || !(e.currentTarget instanceof HTMLElement)) return;
          const target = e.currentTarget.querySelector<HTMLElement>("[data-autofocus]");
          if (!target) return;
          e.preventDefault();
          target.focus();
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
        }}
        {...rest}
      >
        <div className="flex items-start gap-3.5">
          {icon && (
            <div className="grid size-[42px] shrink-0 place-items-center rounded-md bg-omp text-white shadow-glow-accent [&_svg]:size-5">{icon}</div>
          )}
          <div className="min-w-0 flex-1">
            <RadixDialog.Title className="font-display text-2xl font-bold">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-0.5 text-sm text-mute">{description}</RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RadixDialog.Description>
            )}
          </div>
          {!hideClose && (
            <RadixDialog.Close asChild>
              <IconButton label="Close" size="sm" className="-mt-0.5 -mr-1">
                <X />
              </IconButton>
            </RadixDialog.Close>
          )}
        </div>
        <div className="mt-5 min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-4">{footer}</div>}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
