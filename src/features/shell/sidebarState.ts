import { create } from "zustand";
import { useUi } from "@/core";

/**
 * Below this width the desktop sidebar rests as an icon rail and expands as an overlay ("peek"),
 * so the board keeps four usable lanes on small laptops and snapped windows.
 */
export const SIDEBAR_RAIL_QUERY = "(max-width: 1279px)";

export const useSidebarPeek = create<{ open: boolean; set(open: boolean): void }>((set) => ({
  open: false,
  set: (open) => set({ open }),
}));

/** Ctrl+B / the collapse button: peek the overlay in rail mode, else flip the saved preference. */
export function toggleSidebar(): void {
  if (window.matchMedia(SIDEBAR_RAIL_QUERY).matches) {
    const peek = useSidebarPeek.getState();
    peek.set(!peek.open);
  } else {
    useUi.getState().toggleSidebar();
  }
}
