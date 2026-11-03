import { agentKey, getTranscript, markAgentNotificationsRead, navigate } from "@/core";
import type { HostPage, Notification } from "@/core/gen";
import { MOBILE_MAX_WIDTH } from "@/design";
import { focusDecisions } from "@/features/autoAnswer/reviewFocus";
import { useIdleShellsPrefs } from "@/features/cleanup/idleShellsStore";
import type { DocRef } from "@/features/session/artifacts/load";
import { presentedDoc } from "@/features/session/artifacts/PresentedCard";
import { openDoc } from "@/features/session/artifacts/viewer";

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
 * The presented document a notification opens (tf_proto `Notification::presented`): the snapshot
 * (`presented/<slug>-v<n>.<ext>`) its first action without an answer names as `open:presented/…`.
 */
export function notificationDocument(n: Pick<Notification, "actions">): string | undefined {
  for (const a of n.actions) if (!a.answer && a.id.startsWith("open:presented/")) return a.id.slice("open:".length);
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
 * Opens an agent's session showing the document it presented (`AppEvent` `openPresented`): beside
 * the session on desktop, full screen on phones and in focus mode. The transcript's card of the
 * call says what the document is (title, kind) when the session is loaded; else the viewer reads
 * it from the listing.
 */
export function openPresented(hostId: string, agentId: string, name: string): void {
  const key = agentKey(hostId, agentId);
  const card = getTranscript(key).items.find((i) => i.kind === "tool" && i.artifact?.name === name);
  const doc: DocRef = card?.kind === "tool" && card.artifact ? presentedDoc(key, card.artifact) : { agentKey: key, kind: "local", name };
  navigate({ name: "agent", hostId, agentId });
  openDoc(doc, typeof window !== "undefined" && window.innerWidth <= MOBILE_MAX_WIDTH);
}

/**
 * Opening a notification: the page it names, the document it names in its agent's session, else its agent. One of
 * the host's own (no agent, such as "Closed 3 idle shells") is read now, here and on every device: no session view
 * reads it, as an agent's view reads the agent's. The wire reads per agent, so the host's other own notices go with
 * it. (An OS notification's click reads it in the app core.)
 */
export function openNotification(n: Pick<Notification, "id" | "actions" | "agentId"> & { hostId: string }): void {
  if (!n.agentId) markAgentNotificationsRead(n.hostId, "");
  const page = notificationPage(n);
  const doc = n.agentId ? notificationDocument(n) : undefined;
  if (page) openHostPage(n.hostId, page, n.id);
  else if (doc) openPresented(n.hostId, n.agentId, doc);
  else navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
}
