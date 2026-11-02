import { markAgentNotificationsRead, navigate } from "@/core";
import type { HostPage, Notification } from "@/core/gen";
import { focusDecisions } from "@/features/autoAnswer/reviewFocus";
import { useIdleShellsPrefs } from "@/features/cleanup/idleShellsStore";

/** Action ids that name a host's page (tf_proto `HostPage::action_id`). */
const PAGES: Record<string, HostPage | undefined> = { "open:idleShells": "idleShells", "open:decisions": "decisions" };

/** The host's page a notification opens instead of an agent: its first action without an answer that names one (tf_proto `HostPage::of`). */
export function notificationPage(n: Pick<Notification, "actions">): HostPage | undefined {
  for (const a of n.actions) {
    const page = a.answer ? undefined : PAGES[a.id];
    if (page) return page;
  }
  return undefined;
}

/**
 * Opens a host's page (`AppEvent` `openPage`): idle shells → the host's Cleanup page, scrolled to
 * its Idle shells section; decisions → the Inbox, at the decision whose notification was opened
 * (`notificationId`), else at "Decided for you".
 */
export function openHostPage(hostId: string, page: HostPage, notificationId?: string): void {
  switch (page) {
    case "idleShells":
      useIdleShellsPrefs.getState().setFocus(hostId);
      navigate({ name: "cleanup", hostId });
      return;
    case "decisions":
      focusDecisions(hostId, notificationId);
      navigate({ name: "inbox" });
      return;
  }
}

/**
 * Opening a notification: the page it names, else its agent. One of the host's own (no agent: idle shells it closed)
 * is read now, here and on every device: no session view reads it, as an agent's view reads the agent's. The wire
 * reads per agent, so the host's other own notices go with it. (An OS notification's click reads it in the app core.)
 */
export function openNotification(n: Pick<Notification, "id" | "actions" | "agentId"> & { hostId: string }): void {
  if (!n.agentId) markAgentNotificationsRead(n.hostId, "");
  const page = notificationPage(n);
  if (page) openHostPage(n.hostId, page, n.id);
  else navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
}
