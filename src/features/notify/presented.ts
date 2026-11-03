import { markNotificationsRead, parseAgentKey, useNotifications } from "@/core";
import type { Notification } from "@/core/gen";
import { presentedName } from "@/features/session/artifacts/kinds";

/**
 * The presented document a notification opens (tf_proto `Notification::presented`): the snapshot
 * (`presented/<slug>-v<n>.<ext>`) its first action without an answer names as `open:presented/…`.
 */
export function notificationDocument(n: Pick<Notification, "actions">): string | undefined {
  for (const a of n.actions) if (!a.answer && a.id.startsWith("open:presented/")) return a.id.slice("open:".length);
  return undefined;
}

/**
 * A presented document was opened (`name`, any version): its agent's notifications about that
 * document are read, here and on every other surface. Opening the session leaves them unread, as
 * the document may never have been looked at (one a subagent presented isn't in the transcript).
 */
export function readPresentedNotifications(agentKey: string, name: string): void {
  const slug = presentedName(name)?.slug;
  if (slug === undefined) return;
  const { hostId, agentId } = parseAgentKey(agentKey);
  const ids = useNotifications
    .getState()
    .items.filter((n) => !n.read && n.kind === "presented" && n.hostId === hostId && n.agentId === agentId && presentedName(notificationDocument(n) ?? "")?.slug === slug)
    .map((n) => n.id);
  markNotificationsRead(hostId, ids);
}
