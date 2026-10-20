import { createStore } from "zustand/vanilla";
import { type CoreState, initialCoreState } from "./state";

/**
 * The single data store. Written only by the per-frame flush (one `setState` per frame) and by
 * a few local UI actions (filter, notification read state). Read it through the hooks.
 */
export const coreStore = createStore<CoreState>(() => initialCoreState("demo"));
