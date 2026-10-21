import type { ReactNode } from "react";
import { BottomSheet, Dialog, DialogContent, cn, useIsMobile } from "@/design";

export interface ResponsiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  /** Desktop max width in px. */
  width?: number;
  /** Mobile sheet max height (CSS length). */
  maxHeight?: string;
  /**
   * Fixed height instead of hugging the content: the desktop dialog stays put while steps/states swap
   * (no re-centering jumps), and on phones the sheet is full height so the footer action sits in the
   * thumb zone. `dvh` follows the on-screen keyboard (`interactive-widget=resizes-content`).
   */
  tall?: boolean;
  className?: string;
  children: ReactNode;
}

/** Desktop: centered Dialog. Phone: drag-to-dismiss BottomSheet. Same content, same a11y wiring. */
export function ResponsiveDialog({ open, onOpenChange, title, description, icon, footer, width, maxHeight, tall, className, children }: ResponsiveDialogProps) {
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title={title} description={description} footer={footer} maxHeight={maxHeight} className={cn(tall && "h-[94dvh]", className)}>
        {children}
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        icon={icon}
        footer={footer}
        width={width}
        className={cn(tall && "h-[min(800px,calc(100dvh-48px))]", className)}
        onEscapeKeyDown={(e) => {
          // Esc in a filter box that has text clears it (the field's own handler) instead of closing
          const t = e.target;
          if (t instanceof HTMLInputElement && t.value && "escClears" in t.dataset) e.preventDefault();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
