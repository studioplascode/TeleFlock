import type { ReactNode } from "react";
import { create } from "zustand";
import { BottomSheet, Dialog, DialogContent, useIsMobile } from "@/design";

export interface SheetSpec {
  title: ReactNode;
  description?: ReactNode;
  /** Body. Receives nothing; call `closeSheet()` to dismiss. */
  content: ReactNode;
  /** Sticky footer (primary action). */
  footer?: ReactNode;
}

interface SheetStore {
  sheet: SheetSpec | null;
  open: boolean;
}

const useSheetStore = create<SheetStore>()(() => ({ sheet: null, open: false }));

/** Show a responsive sheet: a draggable bottom sheet on phones, a centered dialog on desktop. */
export function openSheet(sheet: SheetSpec): void {
  useSheetStore.setState({ sheet, open: true });
}

export function closeSheet(): void {
  useSheetStore.setState({ open: false });
}

/** Mounted once by the shell. */
export function SheetHost() {
  const { sheet, open } = useSheetStore();
  const mobile = useIsMobile();
  if (!sheet) return null;
  const onOpenChange = (o: boolean) => {
    if (!o) closeSheet();
  };
  if (mobile) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title={sheet.title} description={sheet.description} footer={sheet.footer}>
        {sheet.content}
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={sheet.title} description={sheet.description} footer={sheet.footer}>
        {sheet.content}
      </DialogContent>
    </Dialog>
  );
}
