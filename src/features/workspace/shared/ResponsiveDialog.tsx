import type { ReactNode } from "react";
import { BottomSheet, Dialog, DialogContent, useIsMobile } from "@/design";

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
  className?: string;
  children: ReactNode;
}

/** Desktop: centered Dialog. Phone: drag-to-dismiss BottomSheet. Same content, same a11y wiring. */
export function ResponsiveDialog({ open, onOpenChange, title, description, icon, footer, width, maxHeight, className, children }: ResponsiveDialogProps) {
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title={title} description={description} footer={footer} maxHeight={maxHeight} className={className}>
        {children}
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} icon={icon} footer={footer} width={width} className={className}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
