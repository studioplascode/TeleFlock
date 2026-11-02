import { core, getAgentViews, getHostStates, parseAgentKey } from "@/core";
import { CHATS_NEED_UPDATE, chatsUnsupported } from "@/core/chats";
import type { ChatDeletion } from "@/core/gen";
import { toast } from "@/design";
import { haptic } from "@/features/shell/haptics";
import { describeError } from "@/features/workspace/shared/errors";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { type DeleteSummary, deleteSummary, folderDelete, keptFolder } from "./model";

/** A chat to delete: by its agent (live, in Done or ended), or by a folder no card uses (Cleanup). */
export type ChatTarget = { agentId: string } | { folder: string };

/** Deletes asked for and not settled yet (host + agent id or folder): a second click opens no second dialog. */
const pending = new Set<string>();

/** What the confirm says about the card: its pane closes too, only the card goes, or there is no card. */
type CardFate = "pane" | "card" | null;

function DeleteBody({ s, card }: { s: DeleteSummary; card: CardFate }) {
  const count = s.kept.length + s.more;
  return (
    <div className="flex flex-col gap-2.5">
      {card && (
        <p>
          {card === "pane" ? "Its pane closes and its card leaves the board." : "Its card leaves the board."}
          {s.working && <span className="mt-1 block font-semibold text-warn">It is working: deleting stops it.</span>}
        </p>
      )}
      {s.folderGoes ? (
        <p>
          Its folder <span className="font-mono break-all">{s.folder}</span> is removed: nothing but omp's own files is in it.
        </p>
      ) : s.sharedWith ? (
        <p>
          Its folder <span className="font-mono break-all">{s.folder}</span> stays: “{s.sharedWith}” works in it too.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p>
            Its folder <span className="font-mono break-all">{s.folder}</span> stays: it holds {count === 1 ? "something" : `${count} things`} you or the agent made.
          </p>
          <ul aria-label="Kept in the folder" className="max-h-40 overflow-auto rounded-md well px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-ink-2">
            {s.kept.map((name) => (
              <li key={name} className="truncate" title={name}>
                {name}
              </li>
            ))}
            {s.more > 0 && <li className="font-sans text-mute">and {s.more} more</li>}
          </ul>
        </div>
      )}
      <p className="text-xs text-mute">The conversation stays in omp's history: Past sessions can still open it.</p>
    </div>
  );
}

function failed(title: string, e: unknown): void {
  haptic("warning");
  if (chatsUnsupported(e)) {
    toast({ title: CHATS_NEED_UPDATE.title, description: CHATS_NEED_UPDATE.hint, status: "error" });
    return;
  }
  const d = describeError(e);
  toast({ title, description: d.hint ? `${d.title} — ${d.hint}` : d.title, status: "error" });
}

/**
 * Delete a chat: `chat.delete` as a dry run, a confirm that says what goes and what stays (the pane, the
 * card, the folder or what keeps it, the conversation in Past sessions), then the delete and a toast.
 * A folder without a card that holds files someone made has nothing to delete: that toasts instead; so does
 * one an agent works in again (its chat resumed after the list was read), which a folder's confirm can't warn of.
 * Resolves to what the host did; null when cancelled, refused or failed (failures toast). Never rejects.
 */
export async function deleteChat(hostId: string, target: ChatTarget, name?: string): Promise<ChatDeletion | null> {
  const id = `${hostId}\u0000${"agentId" in target ? target.agentId : target.folder}`;
  if (pending.has(id)) return null;
  pending.add(id);
  const label = name ? `“${name}”` : "this chat";
  try {
    const host = core.host(hostId);
    let preview: ChatDeletion;
    try {
      preview = await host.call("chat.delete", { ...target, dryRun: true });
    } catch (e) {
      failed(`Couldn't delete ${label}`, e);
      return null;
    }
    const home = getHostStates()[hostId]?.info.home;
    const s = deleteSummary(preview, home);
    let card: CardFate = null;
    if ("agentId" in target) {
      const agent = getAgentViews().find((a) => a.hostId === hostId && a.id === target.agentId);
      card = agent && !agent.parked ? "pane" : "card";
    } else if (folderDelete(s) === "inUse") {
      toast({ title: `Not deleted: ${label} is working`, description: "Its chat was resumed after this list was read. Delete it again: the confirm then says that deleting stops it.", status: "idle" });
      return null;
    } else if (folderDelete(s) === "nothing") {
      toast({ title: "Nothing to delete", description: `${s.folder} holds files you or the agent made; TeleFlock leaves it alone.` });
      return null;
    }
    const ok = await confirmAction({ title: `Delete chat ${label}?`, body: <DeleteBody s={s} card={card} />, confirmLabel: "Delete chat", danger: true });
    if (!ok) return null;
    try {
      const done = await host.call("chat.delete", target);
      haptic("success");
      const kept = keptFolder(done, home);
      toast({ title: "Chat deleted", description: kept ? `Folder kept: ${kept}` : undefined, duration: kept ? 8000 : 3000 });
      return done;
    } catch (e) {
      failed(`Couldn't delete ${label}`, e);
      return null;
    }
  } finally {
    pending.delete(id);
  }
}

/** "Delete chat…" for an agent on the board (card menus, the session's actions menu). */
export function deleteChatAgent(key: string): Promise<ChatDeletion | null> {
  const { hostId, agentId } = parseAgentKey(key);
  const agent = getAgentViews().find((a) => a.key === key);
  return deleteChat(hostId, { agentId }, agent ? agent.title || agent.name : undefined);
}
