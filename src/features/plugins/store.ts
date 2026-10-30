import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PluginsSection = "skills" | "plugins" | "more";

/** Device-local Skills & plugins page state: the host shown last, the project folder picked per host, the section. */
interface PluginsPrefs {
  hostId?: string;
  /** Host → project folder (absent: All projects). */
  folders: Record<string, string>;
  section: PluginsSection;
  setHost(hostId: string): void;
  setFolder(hostId: string, folder: string | undefined): void;
  /** Forgets `folder` as the host's pick (it is gone from the host); a different pick stays. */
  forgetFolder(hostId: string, folder: string): void;
  setSection(section: PluginsSection): void;
}

export const usePluginsPrefs = create<PluginsPrefs>()(
  persist(
    (set) => ({
      folders: {},
      section: "skills",
      setHost: (hostId) => set({ hostId }),
      setFolder: (hostId, folder) =>
        set((s) => {
          const { [hostId]: _old, ...rest } = s.folders;
          return { folders: folder ? { ...rest, [hostId]: folder } : rest };
        }),
      forgetFolder: (hostId, folder) =>
        set((s) => {
          if (s.folders[hostId] !== folder) return s;
          const { [hostId]: _gone, ...rest } = s.folders;
          return { folders: rest };
        }),
      setSection: (section) => set({ section }),
    }),
    { name: "tf.plugins", partialize: ({ hostId, folders, section }) => ({ hostId, folders, section }) },
  ),
);
