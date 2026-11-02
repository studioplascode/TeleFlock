# features/chats: chats on the board, deleting them, their folders

A chat (architecture §3.31, `src/core/chats.ts`) is an omp agent started without a repository or a folder of the
user's: its host makes a folder for it (`<hostd home>/chats/<name>-<id>/`, empty, never a repository), opens it in
its herdr workspace for chats and marks the agent `Agent.chat`. Dispatch starts them ("No folder · chat",
features/dispatch). This folder holds what agent surfaces show for a chat instead of git, deleting a chat, and the
Cleanup page's Chats section.

## Files

```ts
// ChatTag.tsx — the "Chat" chip (MessagesSquare + "Chat", neutral; white on a dark tint on the sunset hero card),
// tooltip with the folder `~`-shortened. board/RepoTag renders it for `chat`; the desktop session header and the
// phone session's subtitle use it directly.
export function ChatTag(props: { hostId?: string; folder?: string; sunset?: boolean; className?: string }): JSX.Element;

// actions.tsx — Delete chat: dry run, confirm, delete, toast. Never rejects; null when cancelled, refused or failed.
export type ChatTarget = { agentId: string } | { folder: string };
export function deleteChat(hostId: string, target: ChatTarget, name?: string): Promise<ChatDeletion | null>;
export function deleteChatAgent(agentKey: string): Promise<ChatDeletion | null>; // card ⋯/right-click, phone rows, session ⋯

// ChatCleanup.tsx — the Cleanup page's Chats section (CleanupView mounts it between the repositories and omp storage)
export function ChatCleanup(props: { hostId: string; hostName: string; home?: string }): JSX.Element | null;

// model.ts — pure decisions (model.test.ts)
export function deleteSummary(d: ChatDeletion, home?: string): DeleteSummary; // folder (~), folderGoes, kept, more, sharedWith?, working
export function keptFolder(d, home?): string | null;      // the folder a finished delete left in place; null when it went
export function folderDelete(s): "confirm" | "nothing" | "inUse"; // a delete by folder after its dry run; inUse: an agent works there again
export function keptOf(f, max?): { names; more };         // kept names to show and how many more there are
export function chatRowAction(row): { kind: "agent"; agentId } | { kind: "folder"; folder } | { kind: "none" };
export function chatCardState(agent?): "running" | "needs" | "idle" | "done" | "ended" | "none";
export function inChatsDir(path?, chatsDir?): boolean;    // the host's chats folder or inside it (ReviewView's guard)
export function chatsSection(o: { hostTakes; anyHostTakes; outdated }): "list" | "update" | "hidden";
```

## Host methods

`chat.list` (Empty → ChatFolders) and `chat.delete` (ChatDeleteParams → ChatDeletion), types in `@/core/gen`
(`crates/tf-proto/src/chats.rs`). A daemon that predates chats has no `HostInfo.chats` and answers both with
`unknown_method`; `chatsUnsupported(e)` turns that into `CHATS_NEED_UPDATE`'s words.

## Behaviour

- **No git for a chat.** Board cards, phone rows and needs cards, the Inbox/HUD needs header and Wall tiles show the
  "Chat" chip where the repo or folder chip goes (`RepoTag chat`); the desktop session header and the phone
  session's subtitle show it where repo · branch go. No diff meter. `canReview` is false (Review cards, the card
  menu, phone rows, Dispatch replies), `agentWorktree` is null and `worktreePr` never asks gh (no "Mark done &
  remove worktree…", no "Delete worktree…"), `useCanMove` is false (no "Move to host…"; the session menu leaves it
  out). The inspector lists the session's changed files without Review links. ReviewView on a chat's workspace says
  there is nothing to review and makes no git or gh call. With no repository, chats are not in the repo filter;
  Repo grouping shows them in one Chats column after the repositories. Mark done, Reopen, Resume, Stop turn,
  Rename, Name it again and Terminal work as for any agent.
- **Delete chat…** (card ⋯ and right-click menu, phone row ⋯, the session's ⋯ dropdown and phone sheet, Cleanup):
  `chat.delete {…, dryRun: true}` first, then a danger confirm (`confirmAction`: a dialog on desktop, a bottom
  sheet on phones; the confirm button has focus, Esc cancels) that says what happens: the pane closes (a parked or
  ended card has none) and the card leaves the board; "It is working: deleting stops it" while a turn runs; the
  folder (`~`-shortened) is removed, or stays because it holds files you or the agent made (up to 20 names, then
  "and N more") or because another card works in it too (`sharedWith`: an agent started in the chat's folder, or a
  card of another herdr session on the host); the
  conversation stays in omp's history (Past sessions). Confirm runs `chat.delete` without
  `dryRun`; the toast says "Chat deleted", with "Folder kept: <folder>" when the folder stayed. The host decides
  again at delete time. The deleted chat is in `HostInfo.pruned`, so views on it go back to the board and what
  the app keeps about it (drafts, notifications, Dispatch entries) goes (`onAgentsPruned`). A second click while
  one delete is open does nothing.
- **Cleanup** (`ChatCleanup`, the page's host): `chat.list` when the page shows the host, whenever a chat
  starts or goes there, every 2 min while visible and after a delete (the host leaves out the chats of its other
  herdr sessions). Rows, newest first: the card's state (from
  the board: running, needs you, idle, done, ended, or no card), the title (opens the chat when it has a card), the
  folder name (full path in the tooltip), what keeps it (three names, then "+N more"), size and last change, and
  Delete through the same confirm: by agent when a card uses the folder, else by folder. A folder no card uses
  that holds files someone made has nothing TeleFlock may delete: the row says so and has no Delete. A delete by
  folder whose dry run says an agent works there (the chat was resumed after the list was read; the host would stop
  and delete it too, which the folder's confirm doesn't say) deletes nothing: a toast says so and the list is read
  again, so the row shows its card and Delete goes through the agent. A host whose
  daemon predates chats gets one line about updating it; no section at all while no known host starts chats.
