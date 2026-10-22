import { Bell, BellOff, Check, CheckCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  cn,
  formatAge,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  spring,
  type Status,
  StatusOrb,
  toast,
  Tooltip,
  useNow,
} from "@/design";
import { agentKey, core, type HostNotification, markNotificationRead, navigate, useHosts, useInbox, useNotifications } from "@/core";
import type { Notification, NotifyAction, NotifyKind } from "@/core/gen";
import { VIEWS } from "@/features/shell/vocab";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";

export const KIND_STATUS: Record<NotifyKind, Status> = {
  needs: "needs-you",
  finished: "review",
  error: "error",
  quiet: "idle",
  info: "done",
};

/** Updates shown before the list hands over to Activity ("N more in Activity →"). */
const UPDATES_LIMIT = 20;

/** Answer a pending request straight from a notification action. */
export function runAnswer(n: Notification & { hostId: string }, action: NotifyAction): Promise<void> {
  if (!action.answer || !n.requestId) {
    navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
    return Promise.resolve();
  }
  haptic("success");
  return core
    .host(n.hostId)
    .call("agent.answer", { agentId: n.agentId, requestId: n.requestId, answer: action.answer })
    .then(
      () => {
        toast({ title: `Answered “${action.label}”`, description: n.title, status: "done" });
      },
      (err: unknown) => {
        haptic("warning");
        toast({ title: `Couldn't answer: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
      },
    );
}

/**
 * Inbox "Updates": unread notifications, newest first (finished, errors, quiet, info, and any
 * needs-you ping whose agent no longer waits in "Needs you", which already shows the live ones).
 * `keep` holds ids that stay listed after they turn read (the bell, while it is open).
 */
export function useUpdates(keep?: ReadonlySet<string>): HostNotification[] {
  const items = useNotifications((s) => s.items);
  const waiting = useInbox();
  return useMemo(() => {
    const live = new Set(waiting);
    return items
      .filter((n) => (!n.read || keep?.has(`${n.hostId}:${n.id}`) === true) && !(n.kind === "needs" && !n.resolved && live.has(agentKey(n.hostId, n.agentId))))
      .sort((a, b) => b.at - a.at);
  }, [items, waiting, keep]);
}

function Item({ n, index, onOpen }: { n: HostNotification; index: number; onOpen: () => void }) {
  const now = useNow(15_000);
  const { profiles } = useHosts();
  const host = profiles.find((p) => p.id === n.hostId);
  const [busy, setBusy] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const answerable = n.actions.filter((a) => a.answer);
  const unread = !n.read;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      transition={{ ...spring.smooth, delay: Math.min(index, 8) * 0.03 }}
      className={cn(
        "group/item relative rounded-lg p-3 transition-colors",
        unread ? "bg-accent/8" : "hover:bg-white/[0.03]",
        n.kind === "needs" && unread && !n.resolved && "bg-sun-2/8 shadow-[inset_0_0_0_1px_rgb(255_61_119/0.25)]",
        n.resolved && "opacity-70",
      )}
    >
      <div className="flex items-start gap-1">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-ring">
          <StatusOrb status={n.resolved ? "done" : KIND_STATUS[n.kind]} size={9} className="mt-1.5" label={n.resolved ? "resolved" : n.kind} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-ink">{n.title}</span>
              <span className="ml-auto shrink-0 font-mono text-2xs text-mute-2">{formatAge(now - n.at)}</span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-mute">{n.body}</p>
            {host && <div className="mt-1 text-2xs font-semibold text-mute-2">{host.name}</div>}
          </div>
        </button>
        {unread ? (
          <IconButton label="Mark read" size="sm" className="-mt-1 -mr-1" onClick={() => markNotificationRead(n.hostId, n.id)}>
            <Check />
          </IconButton>
        ) : (
          <span className="size-8 shrink-0" aria-hidden />
        )}
      </div>
      {n.resolved ? (
        <div className="mt-2 pl-6">
          <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-xs font-bold text-done">
            ✓ {answered ? `Answered “${answered}”` : "Resolved"}
          </motion.span>
        </div>
      ) : (
        answerable.length > 0 &&
        n.requestId && (
          <div className="mt-2.5 flex flex-wrap gap-1.5 pl-6">
            {answered ? (
              <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-xs font-bold text-done">
                ✓ {answered}
              </motion.span>
            ) : (
              answerable.map((a, i) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant={i === 0 && n.kind === "needs" ? "sunset" : "secondary"}
                  loading={busy === a.id}
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(a.id);
                    void runAnswer(n, a).then(() => {
                      setBusy(null);
                      setAnswered(a.label);
                    });
                  }}
                >
                  {a.label}
                </Button>
              ))
            )}
          </div>
        )
      )}
    </motion.li>
  );
}

/** "Mark all read" and "Clear all" for the notification list. */
export function UpdatesActions({ className }: { className?: string }) {
  const { items, unread, markRead, clear } = useNotifications();
  return (
    <div className={cn("flex gap-0.5", className)}>
      <IconButton label="Mark all read" size="sm" disabled={unread === 0} onClick={markRead}>
        <CheckCheck />
      </IconButton>
      <IconButton label="Clear all" size="sm" disabled={items.length === 0} onClick={clear}>
        <Trash2 />
      </IconButton>
    </div>
  );
}

/**
 * The Updates list (Inbox and the bell): newest first, inline answers, mark read; after
 * `limit` items it hands over to Activity, which keeps the whole history.
 */
export function UpdatesList({ items, limit = UPDATES_LIMIT, onNavigate, className }: { items: readonly HostNotification[]; limit?: number; onNavigate?: () => void; className?: string }) {
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  if (items.length === 0) {
    return (
      <div className={cn("flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-mute", className)}>
        <BellOff className="size-6 text-mute-2" />
        <span>No unread updates. Finished turns, errors and quiet agents show up here.</span>
        <button
          type="button"
          onClick={() => {
            navigate({ name: "activity" });
            onNavigate?.();
          }}
          className="rounded-xs text-xs font-bold text-accent-ink hover:text-ink focus-ring"
        >
          Everything so far is in {VIEWS.activity.label} →
        </button>
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
        <AnimatePresence initial={false}>
          {shown.map((n, i) => (
            <Item
              key={`${n.hostId}:${n.id}`}
              n={n}
              index={i}
              onOpen={() => {
                navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
                onNavigate?.();
              }}
            />
          ))}
        </AnimatePresence>
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() => {
            navigate({ name: "activity" });
            onNavigate?.();
          }}
          className="mt-2 self-start rounded-xs px-1 text-xs font-bold text-accent-ink hover:text-ink focus-ring"
        >
          {more} more in {VIEWS.activity.label} →
        </button>
      )}
    </div>
  );
}

/** Updates with their header and an "Open Inbox" link: the bell's peek (and the phone's sheet). */
export function NotificationList({ onNavigate, className, title = true, keep }: { onNavigate?: () => void; className?: string; title?: boolean; keep?: ReadonlySet<string> }) {
  const updates = useUpdates(keep);
  const fresh = updates.filter((n) => !n.read).length;
  const waiting = useInbox().length;
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 px-1 pb-2">
        {title && <h2 className="font-display text-lg font-bold">Updates</h2>}
        {fresh > 0 && <span className="rounded-full bg-accent/18 px-2 text-2xs font-extrabold text-accent-ink">{fresh} new</span>}
        <UpdatesActions className="ml-auto" />
      </div>
      <UpdatesList items={updates} onNavigate={onNavigate} className="min-h-0" />
      <button
        type="button"
        onClick={() => {
          navigate({ name: "inbox" });
          onNavigate?.();
        }}
        className="mt-2 flex items-center gap-2 rounded-md border-t border-line px-1 pt-2.5 text-left text-xs font-bold text-ink-2 hover:text-ink focus-ring"
      >
        Open {VIEWS.inbox.label}
        {waiting > 0 && <span className="font-semibold text-[#ffb08a]">· {waiting} waiting</span>}
        <span className="ml-auto font-semibold text-mute-2">{VIEWS.inbox.shortcut}</span>
      </button>
    </div>
  );
}

/** Title-bar bell: neutral unread-updates badge, popover peeking at the Inbox's Updates. */
export function NotificationBell() {
  const { markRead } = useNotifications();
  const updates = useUpdates();
  const count = updates.length;
  const [open, setOpen] = useState(false);
  // Ids on screen when the popover opened stay listed while it is open, though they turn read.
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set());
  const [ring, setRing] = useState(0);
  const [prev, setPrev] = useState(count);
  if (count !== prev) {
    setPrev(count);
    if (count > prev) setRing((r) => r + 1);
  }
  const onOpenChange = (next: boolean) => {
    if (next) setKeep(new Set(updates.map((n) => `${n.hostId}:${n.id}`)));
    setOpen(next);
  };
  // Viewing the panel for a moment marks everything read.
  useEffect(() => {
    if (!open || count === 0) return;
    const id = window.setTimeout(markRead, 1800);
    return () => window.clearTimeout(id);
  }, [open, count, markRead]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip content="Notifications">
        <PopoverTrigger asChild>
          <IconButton label={count ? `Notifications (${count} unread)` : "Notifications"} title="" size="md">
            <motion.span key={ring} className="grid place-items-center" animate={ring ? { rotate: [0, -18, 15, -10, 6, 0] } : undefined} transition={{ duration: 0.7 }}>
              <Bell />
            </motion.span>
            {count > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-white/85 px-1 text-[10.5px] leading-none font-extrabold text-chrome shadow-[0_0_0_3px_var(--color-chrome)]"
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
          </IconButton>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="flex max-h-[min(560px,80dvh)] w-[400px] flex-col p-3">
        <NotificationList keep={keep} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
