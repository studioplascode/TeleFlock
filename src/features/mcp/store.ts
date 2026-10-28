import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Device-local MCP page state: the host shown last and the project folder picked per host. */
interface McpPrefs {
  hostId?: string;
  /** Host → project folder (absent: All projects). */
  folders: Record<string, string>;
  setHost(hostId: string): void;
  setFolder(hostId: string, folder: string | undefined): void;
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
    }),
    { name: "tf.mcp", partialize: ({ hostId, folders }) => ({ hostId, folders }) },
  ),
);
