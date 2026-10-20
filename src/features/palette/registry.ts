import { type ReactNode, useEffect, useId } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A command contributed to the palette by any feature. */
export interface PaletteCommand {
  /** Stable id (also the recents key). */
  id: string;
  title: string;
  /** Group heading; defaults to "Actions". */
  group?: string;
  /** Extra search terms. */
  keywords?: string[];
  icon?: ReactNode;
  /** Shortcut hint, e.g. "Ctrl N". */
  shortcut?: string;
  /** Secondary text after the title. */
  hint?: string;
  run(): void | Promise<unknown>;
}

interface Contributed {
  sources: Record<string, PaletteCommand[]>;
  set(source: string, cmds: PaletteCommand[] | null): void;
}

/** Commands contributed by mounted features (keyed by contributor). */
export const useContributed = create<Contributed>()((set) => ({
  sources: {},
  set: (source, cmds) =>
    set((s) => {
      const sources = { ...s.sources };
      if (cmds) sources[source] = cmds;
      else delete sources[source];
      return { sources };
    }),
}));

/** Contribute contextual palette commands while the calling component is mounted. */
export function usePaletteCommands(commands: PaletteCommand[]): void {
  const source = useId();
  useEffect(() => {
    useContributed.getState().set(source, commands);
  }, [source, commands]);
  useEffect(() => () => useContributed.getState().set(source, null), [source]);
}

interface Recents {
  /** Most recent first. */
  ids: string[];
  push(id: string): void;
}

const MAX_RECENTS = 8;

/** Recently run palette entries (persisted). */
export const useRecents = create<Recents>()(
  persist(
    (set) => ({
      ids: [],
      push: (id) => set((s) => ({ ids: [id, ...s.ids.filter((x) => x !== id)].slice(0, MAX_RECENTS) })),
    }),
    { name: "tf.palette.recents" },
  ),
);
