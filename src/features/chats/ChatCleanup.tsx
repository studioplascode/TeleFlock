import { FolderOpen, MessagesSquare, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agentKey, core, navigate, toApiError, useAgent, useCore, useHosts } from "@/core";
import { hostTakesChats, isChat } from "@/core/chats";
import type { ApiError, ChatFolder, ChatFolders } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, Chip, Skeleton, Tile, Tooltip, cn, formatAge, useNow } from "@/design";
import type { Status } from "@/design/tokens";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { deleteChat } from "./actions";
import { type ChatCardState, chatCardState, chatRowAction, chatsSection, keptOf } from "./model";

/** While the page is visible the list is asked for again this often (sizes grow while chats work). */
const POLL_MS = 120_000;
/** Kept names a row shows before "+N more" (the delete confirm lists them all). */
const ROW_KEPT = 3;

const CARD: Record<ChatCardState, { label: string; tone: "neutral" | Status; about: string }> = {
  running: { label: "Running", tone: "running", about: "Its agent is working" },
  needs: { label: "Needs you", tone: "needs-you", about: "Its agent waits for your answer" },
  idle: { label: "Idle", tone: "review", about: "Its agent finished its turn; the card is in Review" },
  done: { label: "Done", tone: "done", about: "Marked done; its card is in Done" },
  ended: { label: "Ended", tone: "idle", about: "Its omp ended without anyone closing it" },
  none: { label: "No card", tone: "neutral", about: "No card on the board uses this folder any more" },
};

interface ChatList {
  data?: ChatFolders;
  error?: ApiError;
  /** The host's daemon predates chats (`unknown_method`). */
  outdated: boolean;
  /** The host isn't online: asked once it is. */
  waiting: boolean;
  reload(): void;
}

/**
 * `chat.list` of one host: asked when the page shows it, whenever a chat starts or goes on that host
 * (its chat cards change), every 2 min while the page is visible, and after a delete.
 */
function useChatFolders(hostId: string, enabled: boolean): ChatList {
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const chatIds = useCore((s) =>
    (s.hosts[hostId]?.state.agents ?? [])
      .filter(isChat)
      .map((a) => a.id)
      .join("\n"),
  );
  const [state, setState] = useState<{ hostId?: string; data?: ChatFolders; error?: ApiError }>({});
  const [ask, setAsk] = useState(0);

  useEffect(() => {
    if (!enabled || !online) return;
    let live = true;
    core
      .host(hostId)
      .call("chat.list", {})
      .then(
        (data) => live && setState({ hostId, data }),
        (e: unknown) => live && setState((s) => ({ hostId, data: s.hostId === hostId ? s.data : undefined, error: toApiError(e) })),
      );
    return () => {
      live = false;
    };
  }, [hostId, enabled, online, chatIds, ask]);

  const current = state.hostId === hostId;
  const outdated = current && state.error?.code === "unknown_method";
  useEffect(() => {
    if (!enabled || outdated) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setAsk((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, outdated]);

  const reload = useCallback(() => setAsk((n) => n + 1), []);
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, outdated, waiting: !online, reload };
}

/** One chat folder: its card's state, title, folder, what keeps it, size and age, and its Delete. */
function ChatRow({ hostId, row, home, now, removing, onDelete }: { hostId: string; row: ChatFolder; home?: string; now: number; removing: boolean; onDelete(): void }) {
  const key = row.agentId ? agentKey(hostId, row.agentId) : "";
  const agent = useAgent(key);
  const card = CARD[chatCardState(agent)];
  const action = chatRowAction(row);
  const kept = keptOf(row, ROW_KEPT);
  return (
    <li className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-md:px-3.5", removing && "opacity-50")}>
      <Tooltip content={card.about}>
        <span className="mt-0.5 flex w-[104px] shrink-0 max-md:w-auto">
          <Chip tone={card.tone} className="justify-center">
            {card.label}
          </Chip>
        </span>
      </Tooltip>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessagesSquare className="size-3.5 shrink-0 text-mute" aria-hidden />
          {agent ? (
            <button
              type="button"
              className="min-w-0 truncate rounded-sm text-left text-sm font-bold text-ink focus-ring hover:underline"
              title={`Open ${agent.name}`}
              onClick={() => navigate({ name: "agent", hostId, agentId: agent.id })}
            >
              {row.title}
            </button>
          ) : (
            <span className="min-w-0 truncate text-sm font-bold text-ink">{row.title}</span>
          )}
        </div>
        <span className="flex min-w-0 items-center gap-1 font-mono text-2xs text-mute-2" title={tildify(row.folder, home)}>
          <FolderOpen className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{basename(row.folder)}</span>
        </span>
        {kept.names.length > 0 && (
          <span className="min-w-0 truncate text-xs text-mute" title={row.kept.join("\n")}>
            Keeps <span className="font-mono text-ink-2">{kept.names.join(", ")}</span>
            {kept.more > 0 && ` +${kept.more} more`}
          </span>
        )}
        {action.kind === "none" && (
          <span className="text-xs text-mute-2">No card uses it, and it holds files you or the agent made: TeleFlock leaves it alone. Delete it yourself if you don't need them.</span>
        )}
      </div>
      <div className="flex w-[232px] shrink-0 items-center justify-end gap-3 max-md:w-full max-md:justify-between">
        <span className="flex min-w-0 flex-col items-end text-right text-xs text-mute max-md:items-start max-md:text-left">
          <span className="font-mono text-ink-2 tabular" title="Space it takes on disk">
            {formatBytes(row.bytes)}
          </span>
          {row.modifiedAt !== undefined && <span>modified {formatAge(now - row.modifiedAt)}</span>}
        </span>
        {action.kind !== "none" && (
          <Tooltip
            content={
              action.kind === "agent"
                ? "End the chat, forget its card and remove its folder unless it holds files you or the agent made (asks first)"
                : "Remove the folder: only omp's own files are in it (asks first)"
            }
          >
            <span>
              <Button size="sm" variant="danger" icon={<Trash2 />} disabled={removing} onClick={onDelete}>
                Delete
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * The Cleanup page's Chats section (`chat.list` of the page's host): every chat folder with its card's
 * state, size, age and what keeps it; Delete goes through the chat's own confirm (`deleteChat`). A host
 * whose daemon predates chats gets one line about updating it; the section is gone while no host has chats.
 */
export function ChatCleanup({ hostId, hostName, home }: { hostId: string; hostName: string; home?: string }) {
  const hostTakes = useCore((s) => hostTakesChats(s.hosts[hostId]?.state.info));
  const anyHostTakes = useCore((s) => Object.values(s.hosts).some((h) => hostTakesChats(h.state.info)));
  const q = useChatFolders(hostId, hostTakes);
  const now = useNow(60_000);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const section = chatsSection({ hostTakes, anyHostTakes, outdated: q.outdated });
  if (section === "hidden") return null;

  if (section === "update")
    return (
      <p className="flex items-start gap-2 px-1 text-xs text-mute">
        <MessagesSquare className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          <b className="text-ink-2">Chats:</b> {hostName}'s TeleFlock daemon predates chats, so its chat folders can't be listed here. Update it (Hosts → Update).
        </span>
      </p>
    );

  const remove = async (row: ChatFolder) => {
    const action = chatRowAction(row);
    if (action.kind === "none") return;
    setRemoving((s) => new Set([...s, row.folder]));
    const done = await deleteChat(hostId, action.kind === "agent" ? { agentId: action.agentId } : { folder: action.folder }, row.title);
    setRemoving((s) => new Set([...s].filter((f) => f !== row.folder)));
    // also when nothing was deleted: a folder refused as in use again then shows its card, and Delete goes through it
    if (done || action.kind === "folder") q.reload();
  };

  const chats = q.data?.chats ?? [];
  const bytes = chats.reduce((n, c) => n + c.bytes, 0);
  let body;
  if (!q.data && q.error)
    body = (
      <Tile className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-error/90 max-md:px-3.5">
        <span className="min-w-0 flex-1">{q.error.hint ? `${q.error.message} · ${q.error.hint}` : q.error.message}</span>
        <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={q.reload}>
          Retry
        </Button>
      </Tile>
    );
  else if (!q.data && q.waiting) body = <Tile className="px-4 py-3 text-xs text-mute max-md:px-3.5">{hostName}'s chat folders show here once it is connected.</Tile>;
  else if (!q.data) body = <Skeleton className="h-[72px] rounded-tile" />;
  else if (chats.length === 0) body = <Tile className="px-4 py-3 text-xs text-mute max-md:px-3.5">No chat folders on {hostName}.</Tile>;
  else
    body = (
      <Tile className="overflow-hidden p-0">
        <ol className="flex flex-col divide-y divide-line">
          {chats.map((row) => (
            <ChatRow key={row.folder} hostId={hostId} row={row} home={home} now={now} removing={removing.has(row.folder)} onDelete={() => void remove(row)} />
          ))}
        </ol>
      </Tile>
    );

  return (
    <section aria-label="Chats" className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
        <h2 className="flex items-center gap-2 self-center font-display text-lg font-bold">
          <MessagesSquare className="size-4 text-mute" aria-hidden /> Chats
        </h2>
        {q.data && <span className="min-w-0 truncate font-mono text-2xs text-mute-2">{tildify(q.data.dir, home)}</span>}
        {chats.length > 0 && (
          <span className="ml-auto text-2xs text-mute">
            {chats.length} folder{chats.length === 1 ? "" : "s"} · {formatBytes(bytes)}
          </span>
        )}
      </div>
      <p className="px-1 text-xs text-mute">
        Folders TeleFlock made for chats. Deleting a chat ends it and removes its folder unless it holds files you or the agent made; its conversation stays
        in Past sessions.
      </p>
      {body}
    </section>
  );
}
