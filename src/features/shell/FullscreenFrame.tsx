import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton, Tooltip } from "@/design";

export interface FullscreenFrameProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the overlay. */
  label: string;
  /** Title row: leading glyph, title and controls before Close. Without `title` there is no row:
   *  the body brings its own chrome (and its own way to close). */
  icon?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  /** Esc closes it (default). Pass false when Esc belongs to the content (a page in the browser). */
  closeOnEscape?: boolean;
  /** Full-bleed: a bounded flex column that fills the rest of the screen (no padding, no scroller). */
  children: ReactNode;
}

/**
 * Something shown over the whole app (a document or the browser "full screen"; on phones the sheet
 * every artifact opens in): a modal overlay with focus kept inside, the safe areas left free, and
 * Esc or the Android back button closing it (unless `closeOnEscape` is false).
 */
export function FullscreenFrame({ open, onClose, label, icon, title, actions, closeOnEscape = true, children }: FullscreenFrameProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (!closeOnEscape) e.preventDefault();
          }}
          onOpenAutoFocus={(e) => {
            // The frame itself, not its first control: Close (or the first action) would open its tooltip on top of
            // the body (on a phone it stays until the next tap) and show a focus ring nobody asked for.
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
          }}
          className="fixed inset-0 z-modal flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none"
        >
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          {title !== undefined && (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-chrome/60 px-3 max-md:h-12 max-md:px-2">
              {icon}
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink-2">{title}</span>
              {actions}
              <Tooltip content="Close" shortcut={closeOnEscape ? "Esc" : undefined}>
                <IconButton label="Close" size="md" onClick={onClose}>
                  <X />
                </IconButton>
              </Tooltip>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
