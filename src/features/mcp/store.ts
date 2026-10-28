import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Device-local MCP page state: the host shown last and the project folder picked per host. */
interface McpPrefs {
  hostId?: string;
  /** Host → project folder (absent: All projects). */
  folders: Record<string, string>;
  setHost(hostId: string): void;
  setFolder(hostId: string, folder: string | undefined): void;
  /** Forgets `folder` as the host's pick (it is gone from the host); a different pick stays. */
  forgetFolder(hostId: string, folder: string): void;
}

export const useMcpPrefs = create<McpPrefs>()(
  persist(
    (set) => ({
      folders: {},
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
    }),
    { name: "tf.mcp", partialize: ({ hostId, folders }) => ({ hostId, folders }) },
  ),
);
