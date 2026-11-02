import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { deviceStorage } from "@/core/deviceStorage";

export type MdMode = "diff" | "rendered";

interface MdModeState {
  mode: MdMode;
  setMode(mode: MdMode): void;
}

/** Review's Markdown view (`Diff | Rendered`), one choice for every Markdown file, remembered on this device. */
export const useMdMode = create<MdModeState>()(
  persist((set) => ({ mode: "diff", setMode: (mode) => set({ mode }) }), { name: "tf.review.markdown", storage: createJSONStorage(() => deviceStorage), partialize: ({ mode }) => ({ mode }) }),
);
