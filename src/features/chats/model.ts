import type { Agent, ChatDeletion, ChatFolder } from "@/core/gen";
import { tildify } from "@/features/workspace/shared/paths";

/*
 * Pure decisions behind deleting chats and listing their folders (model.test.ts). The host decides
 * what a delete removes (`chat.delete`, architecture §3.31); these only read its answers.
 */

/** What a chat folder holds beyond omp's own `.omp/`: the first names (`max` of them) and how many more. */
export function keptOf(f: Pick<ChatFolder, "kept" | "keptCount">, max = Number.POSITIVE_INFINITY): { names: readonly string[]; more: number } {
  const names = f.kept.slice(0, max);
  return { names, more: Math.max(f.keptCount, f.kept.length) - names.length };
}

/** What deleting a chat does, read from `chat.delete`'s dry run. */
export interface DeleteSummary {
  /** The chat's folder, `~`-shortened. */
  folder: string;
  /** The folder goes with the chat: nothing but omp's own `.omp/` is in it and no other card works there. */
  folderGoes: boolean;
  /** What keeps the folder: the names the host listed (at most 20) and how many more there are. */
  kept: readonly string[];
  more: number;
  /** Another card works in the same folder (its title): the folder stays with it. */
  sharedWith?: string;
  /** It is in the middle of a turn: deleting stops it. */
  working: boolean;
}

export function deleteSummary(d: ChatDeletion, home?: string): DeleteSummary {
  const { names, more } = keptOf(d);
  return {
    folder: tildify(d.folder, home),
    folderGoes: names.length === 0 && more === 0 && !d.sharedWith,
    kept: names,
    more,
    ...(d.sharedWith ? { sharedWith: d.sharedWith } : {}),
    working: d.working,
  };
}

/** The folder a finished delete left in place (`~`-shortened), or null when it went with the chat. */
export function keptFolder(d: Pick<ChatDeletion, "folder" | "removed">, home?: string): string | null {
  return d.removed ? null : tildify(d.folder, home);
}

/**
 * What a delete by folder (a Cleanup row no card used when the list was read) does after its dry run: `confirm`;
 * `nothing` while the folder holds files someone made (TeleFlock leaves it alone); `inUse` once an agent works in
 * it (its chat was resumed since): the host would stop and delete that agent too, which a folder's confirm doesn't
 * say, so nothing is deleted and the row is read again (it then deletes through the agent, whose confirm says so).
 */
export function folderDelete(s: Pick<DeleteSummary, "folderGoes" | "working">): "confirm" | "nothing" | "inUse" {
  if (s.working) return "inUse";
  return s.folderGoes ? "confirm" : "nothing";
}

/**
 * What a Cleanup row may delete: the chat through its agent (live, in Done or ended); a folder no card
 * uses any more while only omp's own files are in it; nothing when no card uses it and it holds files
 * someone made (TeleFlock removes only folders holding nothing of anyone's).
 */
export type ChatRowAction = { kind: "agent"; agentId: string } | { kind: "folder"; folder: string } | { kind: "none" };

export function chatRowAction(row: Pick<ChatFolder, "folder" | "agentId" | "kept" | "keptCount">): ChatRowAction {
  if (row.agentId) return { kind: "agent", agentId: row.agentId };
  const { names, more } = keptOf(row);
  return names.length === 0 && more === 0 ? { kind: "folder", folder: row.folder } : { kind: "none" };
}

/** Where a chat's card is on the board: `none` when no card uses its folder (or the app hasn't seen it). */
export type ChatCardState = "running" | "needs" | "idle" | "done" | "ended" | "none";

export function chatCardState(a: Pick<Agent, "column" | "parked"> | undefined): ChatCardState {
  if (!a) return "none";
  if (a.column === "done") return "done";
  if (a.column === "running") return "running";
  if (a.column === "needs") return "needs";
  // an ended card (its omp ended without anyone closing it) waits in Review until it is continued
  return a.parked?.ended ? "ended" : "idle";
}

/** `path` is the chats folder of its host (`HostInfo.chats`) or inside it. */
export function inChatsDir(path: string | undefined, chatsDir: string | undefined): boolean {
  if (!path || !chatsDir) return false;
  const root = chatsDir.replace(/[\\/]+$/, "");
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/**
 * The Cleanup page's Chats section for its host: the folders when the host starts chats, a one-line
 * "update the host" note when it doesn't (its daemon predates chats) while another host does, else
 * nothing (no host has chats: the page says nothing about them).
 */
export function chatsSection(o: { hostTakes: boolean; anyHostTakes: boolean; outdated: boolean }): "list" | "update" | "hidden" {
  if (o.hostTakes && !o.outdated) return "list";
  return o.hostTakes || o.anyHostTakes ? "update" : "hidden";
}
