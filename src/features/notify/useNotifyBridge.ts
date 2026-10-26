import { useEffect, useRef } from "react";
import { dismissToast, toast, useIsMobile } from "@/design";
import { agentKey, core, getRoute, isMuted, markAgentNotificationsRead, navigate, onAgentMoved, onAgentsPruned, onAppEvent, parseAgentKey, type PrunedGone, useRoute, useSettings, useUi } from "@/core";
import { pruneAgents } from "@/features/dispatch/store";
import { haptic } from "@/features/shell/haptics";
import { useLastTerminal } from "@/features/terminal/lastTerminal";
import { inQuietHours, playChime } from "./chime";
import { KIND_STATUS, runAnswer } from "./NotificationCenter";

/** Needs-you toasts linger longer than the 5s default, but not forever: the inbox and bell keep them. */
const NEEDS_TOAST_MS = 12_000;

/**
 * Open toasts by `${hostId}/${notificationId}`, with their agent key (one toast per agent, like the
 * OS) and whether they ask about a pending request (those stay until it is resolved, like the OS).
 */
const openToasts = new Map<string, { agent: string; toast: number; needs: boolean }>();

/** The app is in front: looking at an agent here means its notifications were seen. */
function inFront(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * An agent whose omp session was deleted vanishes from the GUI. The core drops its notifications,
 * drafts, mute, route, split and selection; this drops its toasts, its Dispatch entries and the
 * Terminal tab's memory of it.
 */
function forgetPruned(gone: PrunedGone[]): void {
  const keys = new Set(gone.flatMap((g) => g.keys));
  for (const [id, t] of openToasts) {
    if (!keys.has(t.agent)) continue;
    dismissToast(t.toast);
    openToasts.delete(id);
  }
  const byHost = new Map<string, { ids: string[]; sessions: string[] }>();
  for (const g of gone) {
    const host = byHost.get(g.hostId) ?? { ids: [], sessions: [] };
    host.ids.push(...g.keys.map((k) => parseAgentKey(k).agentId));
    if (g.sessionId) host.sessions.push(g.sessionId);
    byHost.set(g.hostId, host);
  }
  for (const [hostId, h] of byHost) pruneAgents(hostId, h.ids, h.sessions);
  const { last, lastSession } = useLastTerminal.getState();
  const lastGone = last?.agentId !== undefined && keys.has(agentKey(last.hostId, last.agentId));
  const sessionGone = lastSession !== null && keys.has(agentKey(lastSession.hostId, lastSession.agentId));
  if (lastGone || sessionGone) useLastTerminal.setState({ ...(lastGone ? { last: null } : {}), ...(sessionGone ? { lastSession: null } : {}) });
}

/** A parked agent resumed under a new id: the Terminal tab's memory follows it. */
function followMoved(from: string, to: string): void {
  const { last, lastSession } = useLastTerminal.getState();
  const { agentId } = parseAgentKey(to);
  if (last?.agentId !== undefined && agentKey(last.hostId, last.agentId) === from) useLastTerminal.setState({ last: { hostId: last.hostId, agentId } });
  if (lastSession && agentKey(lastSession.hostId, lastSession.agentId) === from) useLastTerminal.setState({ lastSession: { hostId: lastSession.hostId, agentId } });
}

/**
 * Bridges core events into the UI (mount once):
 * - `notify` → an in-app toast (needs-you toasts offer the first answer inline), a haptic and,
 *   where the OS doesn't play one, a chime; muted agents get none of these (the bell still lists
 *   them). A newer notification of the same agent replaces its toast. On phones, needs-you toasts
 *   stay quiet while a session is open (its "Next waiting" chip shows them);
 * - `notifyDone` (the request was handled anywhere, or the notification was read on another
 *   surface) → its toast disappears (needs-you toasts only once resolved); the store marks the list
 *   item read / resolved;
 * - viewing an agent's session (app in front) marks its notifications read everywhere;
 * - `openAgent` (tray, OS notification click, deep link) → navigate to the agent.
 */
export function useNotifyBridge(): void {
  const setAnswerNext = useUi((s) => s.setAnswerNext);
  const route = useRoute();
  const isMobile = useIsMobile();
  const mobile = useRef(isMobile);
  mobile.current = isMobile;
  const viewHost = route.name === "agent" ? route.hostId : undefined;
  const viewAgent = route.name === "agent" ? route.agentId : undefined;

  useEffect(() => {
    if (viewHost === undefined || viewAgent === undefined) return;
    const read = () => {
      if (inFront()) markAgentNotificationsRead(viewHost, viewAgent);
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [viewHost, viewAgent]);

  // Opening a session on a phone hands the waiting asks to its "Next waiting" chip.
  const inSession = viewAgent !== undefined;
  useEffect(() => {
    if (!isMobile || !inSession) return;
    for (const [id, t] of openToasts) {
      if (!t.needs) continue;
      dismissToast(t.toast);
      openToasts.delete(id);
    }
  }, [isMobile, inSession]);

  useEffect(() => onAgentsPruned(forgetPruned), []);
  useEffect(() => onAgentMoved(followMoved), []);

  useEffect(
    () =>
      onAppEvent((e) => {
        if (e.type === "openAgent") {
          navigate({ name: "agent", hostId: e.hostId, agentId: e.agentId });
          return;
        }
        if (e.type === "notifyDone") {
          for (const id of e.ids) {
            const open = openToasts.get(`${e.hostId}/${id}`);
            if (!open || (open.needs && !e.resolved)) continue;
            dismissToast(open.toast);
            openToasts.delete(`${e.hostId}/${id}`);
          }
          return;
        }
        if (e.type !== "notify") return;
        const n = { ...e.notification, hostId: e.hostId };
        const key = agentKey(n.hostId, n.agentId);
        const open = () => navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
        const first = n.actions.find((a) => a.answer);
        for (const [id, t] of openToasts) {
          if (t.agent !== key) continue;
          dismissToast(t.toast);
          openToasts.delete(id);
        }
        if (isMuted(key)) return;
        if (n.kind === "needs") haptic("warning");
        else if (n.kind === "finished") haptic("success");
        const s = useSettings.getState();
        // Inside Tauri the OS notification plays the system sound; elsewhere TeleFlock chimes itself.
        if (core.backend !== "tauri" && s.notifySound && !inQuietHours(s)) playChime(n.kind);
        // Already looking at this agent: its session shows the ask or result in place, and a banner
        // would only cover the header.
        const route = getRoute();
        if (route.name === "agent" && route.hostId === n.hostId && route.agentId === n.agentId) {
          if (inFront()) markAgentNotificationsRead(n.hostId, n.agentId);
          return;
        }
        // In a phone session the "Next waiting" chip above the composer carries other agents' asks;
        // a banner on top would only stack over it (the haptic and chime above still fire).
        if (n.kind === "needs" && mobile.current && route.name === "agent") return;
        const id = toast({
          title: n.title,
          description: n.body,
          status: KIND_STATUS[n.kind],
          duration: n.kind === "needs" ? NEEDS_TOAST_MS : undefined,
          action:
            n.kind === "needs" && first && n.requestId
              ? { label: first.label, onClick: () => void runAnswer(n, first) }
              : n.kind === "needs"
                ? { label: "Answer", onClick: () => setAnswerNext(true) }
                : { label: "Open", onClick: open },
        });
        openToasts.set(`${n.hostId}/${n.id}`, { agent: key, toast: id, needs: n.kind === "needs" });
      }),
    [setAnswerNext],
  );
}
