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

const WIDTH_KEY = "tf.sidebarWidth";
/**
 * From this width on, the launcher row shows every label next to its icon (wrapping onto a second
 * or third row as needed), so a new user reads each start action at the default width.
 */
export const SIDEBAR_LABELS_W = 240;
export const SIDEBAR_DEFAULT_W = 264;
export const SIDEBAR_MIN_W = 220;
export const SIDEBAR_MAX_W = 420;

function readWidth(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(WIDTH_KEY));
    return v >= SIDEBAR_MIN_W && v <= SIDEBAR_MAX_W ? v : SIDEBAR_DEFAULT_W;
  } catch {
    return SIDEBAR_DEFAULT_W;
  }
}

/** The expanded sidebar's width (drag its right edge; double-click resets). Saved per device. */
export const useSidebarWidth = create<{ width: number; set(width: number): void }>((set) => ({
  width: readWidth(),
  set: (w) => {
    const width = Math.round(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, w)));
    try {
      globalThis.localStorage?.setItem(WIDTH_KEY, String(width));
    } catch {
      /* storage unavailable */
    }
    set({ width });
  },
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
