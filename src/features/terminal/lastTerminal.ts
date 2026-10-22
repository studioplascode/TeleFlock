import { create } from "zustand";
import { persist } from "zustand/middleware";
import { agentKey, getAgentViews, getWorkspacesSnapshot, type Route, routeToHash, useRoute } from "@/core";

/** A terminal target on one host: an agent's pane (preferred, survives pane restarts) or a bare pane. */
export interface TermSpot {
  hostId: string;
  agentId?: string;
  paneId?: string;
}

interface LastTerminalState {
  /** The terminal attached most recently (phone Terminal tab reopens it). */
  last: TermSpot | null;
  /** The agent whose session was viewed most recently (the tab's fallback). */
  lastSession: { hostId: string; agentId: string } | null;
  /** Route key the Terminal tab itself opened: that screen is the tab's root (no back chevron). */
  tabRoot: string | null;
  /** "New shell" picked in the phone chooser (not persisted): `#/terminal/<host>?shell=<nonce>` shows it. */
  shell: ShellRequest | null;
  remember(spot: TermSpot): void;
  rememberSession(hostId: string, agentId: string): void;
  setTabRoot(key: string | null): void;
  setShell(shell: ShellRequest | null): void;
}

/** A new shell to open on a host, in a workspace (or the host's home when it has none). */
export interface ShellRequest {
  hostId: string;
  workspaceId: string | null;
  cwd: string | null;
  nonce: number;
}

export const useLastTerminal = create<LastTerminalState>()(
  persist(
    (set) => ({
      last: null,
      lastSession: null,
      tabRoot: null,
      shell: null,
      remember: (spot) =>
        set((s) =>
          s.last?.hostId === spot.hostId && s.last.agentId === spot.agentId && s.last.paneId === spot.paneId ? s : { last: spot },
        ),
      rememberSession: (hostId, agentId) =>
        set((s) => (s.lastSession?.hostId === hostId && s.lastSession.agentId === agentId ? s : { lastSession: { hostId, agentId } })),
      setTabRoot: (tabRoot) => set((s) => (s.tabRoot === tabRoot ? s : { tabRoot })),
      setShell: (shell) => set({ shell }),
    }),
    { name: "tf.terminal.last", partialize: (s) => ({ last: s.last, lastSession: s.lastSession }) },
  ),
);

/** Identity of a terminal route (`host|agent|pane`), matching what TerminalView keys its selection on. */
export function terminalRouteKey(r: { hostId: string; agentId?: string; paneId?: string }): string {
  return `${r.hostId}|${r.paneId ?? ""}|${r.agentId ?? ""}`;
}

/** The phone chooser's "New shell": a pushed entry on the bare terminal route, so Back returns to the chooser. */
export function openNewShell(req: Omit<ShellRequest, "nonce">): void {
  const nonce = Date.now();
  useLastTerminal.getState().setShell({ ...req, nonce });
  window.location.hash = `${routeToHash({ name: "terminal", hostId: req.hostId })}?shell=${nonce}`;
}

/** The shell request the current hash asks for, if it is still known (a reload forgets it). */
export function useShellRequest(hostId: string): ShellRequest | null {
  useRoute(); // re-render on hash changes
  const shell = useLastTerminal((s) => s.shell);
  const nonce = /[?&]shell=(\d+)/.exec(window.location.hash)?.[1];
  return shell && nonce && shell.hostId === hostId && String(shell.nonce) === nonce ? shell : null;
}

/**
 * Where the phone Terminal tab goes: the last terminal used, else the agent of the last session
 * viewed, else null (the chooser). Stale memory (agent gone, pane closed on a host whose panes are
 * known) falls through to the next choice.
 */
export function terminalTabTarget(): Extract<Route, { name: "terminal" }> | null {
  const { last, lastSession } = useLastTerminal.getState();
  const agents = getAgentViews();
  const has = (hostId: string, agentId: string) => {
    const key = agentKey(hostId, agentId);
    return agents.some((a) => a.key === key);
  };
  if (last) {
    if (last.agentId && has(last.hostId, last.agentId)) return { name: "terminal", hostId: last.hostId, agentId: last.agentId };
    if (last.paneId) {
      const workspaces = getWorkspacesSnapshot().filter((w) => w.hostId === last.hostId);
      // no panes known for that host yet (still connecting): trust the memory, the view shows the connection state
      if (workspaces.length === 0 || workspaces.some(({ ws }) => ws.tabs.some((t) => t.panes.some((p) => p.id === last.paneId))))
        return { name: "terminal", hostId: last.hostId, paneId: last.paneId };
    }
  }
  if (lastSession && has(lastSession.hostId, lastSession.agentId)) return { name: "terminal", hostId: lastSession.hostId, agentId: lastSession.agentId };
  return null;
}
