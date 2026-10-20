import { useEffect } from "react";
import { dismissToast, toast } from "@/design";
import { agentKey, navigate, onAppEvent, useInbox, useUi } from "@/core";
import { haptic } from "@/features/shell/haptics";
import { KIND_STATUS, runAnswer } from "./NotificationCenter";

/** Needs-you toasts linger longer than the 5s default, but not forever: the inbox and bell keep them. */
const NEEDS_TOAST_MS = 12_000;

/** Open needs-you toasts by agent key, so answering elsewhere (or a newer ask) retires them. */
const needsToasts = new Map<string, number>();

/**
 * Bridges core events into the UI (mount once):
 * - `notify` → an in-app toast (needs-you toasts offer the first answer inline) plus a haptic;
 *   a needs-you toast disappears as soon as that agent no longer needs you;
 * - `openAgent` (tray, OS notification click, deep link) → navigate to the agent.
 */
export function useNotifyBridge(): void {
  const setAnswerNext = useUi((s) => s.setAnswerNext);
  const inbox = useInbox();

  useEffect(() => {
    const waiting = new Set(inbox);
    for (const [key, id] of needsToasts) {
      if (waiting.has(key)) continue;
      dismissToast(id);
      needsToasts.delete(key);
    }
  }, [inbox]);

  useEffect(
    () =>
      onAppEvent((e) => {
        if (e.type === "openAgent") {
          navigate({ name: "agent", hostId: e.hostId, agentId: e.agentId });
          return;
        }
        if (e.type !== "notify") return;
        const n = { ...e.notification, hostId: e.hostId };
        const key = agentKey(n.hostId, n.agentId);
        const open = () => navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
        const first = n.actions.find((a) => a.answer);
        const prev = needsToasts.get(key);
        if (prev !== undefined) {
          dismissToast(prev);
          needsToasts.delete(key);
        }
        if (n.kind === "needs") haptic("warning");
        else if (n.kind === "finished") haptic("success");
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
        if (n.kind === "needs") needsToasts.set(key, id);
      }),
    [setAnswerNext],
  );
}
