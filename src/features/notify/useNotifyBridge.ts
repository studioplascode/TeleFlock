import { useEffect } from "react";
import { dismissToast, toast } from "@/design";
import { agentKey, core, getRoute, isMuted, markAgentNotificationsRead, navigate, onAppEvent, useRoute, useSettings, useUi } from "@/core";
import { haptic } from "@/features/shell/haptics";
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
 * Bridges core events into the UI (mount once):
 * - `notify` → an in-app toast (needs-you toasts offer the first answer inline), a haptic and,
 *   where the OS doesn't play one, a chime; muted agents get none of these (the bell still lists
 *   them). A newer notification of the same agent replaces its toast;
 * - `notifyDone` (the request was handled anywhere, or the notification was read on another
 *   surface) → its toast disappears (needs-you toasts only once resolved); the store marks the list
 *   item read / resolved;
 * - viewing an agent's session (app in front) marks its notifications read everywhere;
 * - `openAgent` (tray, OS notification click, deep link) → navigate to the agent.
 */
export function useNotifyBridge(): void {
  const setAnswerNext = useUi((s) => s.setAnswerNext);
  const route = useRoute();
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
