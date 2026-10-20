import { Bell, BellOff, CheckCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
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
  useNow,
} from "@/design";
import { core, type HostNotification, navigate, useHosts, useNotifications } from "@/core";
import type { Notification, NotifyAction, NotifyKind } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";

export const KIND_STATUS: Record<NotifyKind, Status> = {
  needs: "needs-you",
  finished: "review",
  error: "error",
  quiet: "idle",
  info: "done",
};

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

function Item({ n, unread, index, onOpen }: { n: HostNotification; unread: boolean; index: number; onOpen: () => void }) {
  const now = useNow(15_000);
  const { profiles } = useHosts();
  const host = profiles.find((p) => p.id === n.hostId);
  const [busy, setBusy] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const answerable = n.actions.filter((a) => a.answer);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      transition={{ ...spring.smooth, delay: Math.min(index, 8) * 0.03 }}
      className={cn("relative rounded-lg p-3 transition-colors", unread ? "bg-accent/8" : "hover:bg-white/[0.03]", n.kind === "needs" && unread && "bg-sun-2/8 shadow-[inset_0_0_0_1px_rgb(255_61_119/0.25)]")}
    >
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 rounded-sm text-left focus-ring">
        <StatusOrb status={KIND_STATUS[n.kind]} size={9} className="mt-1.5" label={n.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-bold text-ink">{n.title}</span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-mute-2">{formatAge(now - n.at)}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-mute">{n.body}</p>
          {host && <div className="mt-1 text-2xs font-semibold text-mute-2">{host.name}</div>}
        </div>
        {unread && <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-hi shadow-[0_0_8px_rgb(163_92_240/0.9)]" aria-label="Unread" />}
      </button>
      {answerable.length > 0 && n.requestId && (
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
                  runAnswer(n, a).then(() => {
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
      )}
    </motion.li>
  );
}

/** The list of notifications (newest first) with read/clear controls. Used by the bell and on mobile. */
export function NotificationList({ onNavigate, className, title = true }: { onNavigate?: () => void; className?: string; title?: boolean }) {
  const { items, unread, markRead, clear } = useNotifications();
  const sorted = [...items].sort((a, b) => b.at - a.at);
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 px-1 pb-2">
        {title && <h2 className="font-display text-lg font-bold">Notifications</h2>}
        {unread > 0 && <span className="rounded-full bg-accent/18 px-2 text-2xs font-extrabold text-accent-ink">{unread} new</span>}
        <div className="ml-auto flex gap-0.5">
          <IconButton label="Mark all read" size="sm" disabled={unread === 0} onClick={markRead}>
            <CheckCheck />
          </IconButton>
          <IconButton label="Clear all" size="sm" disabled={items.length === 0} onClick={clear}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-mute">
          <BellOff className="size-6 text-mute-2" />
          All quiet. Agents will ping you here.
        </div>
      ) : (
        <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
          <AnimatePresence initial={false}>
            {sorted.map((n, i) => (
              <Item
                key={`${n.hostId}:${n.id}`}
                n={n}
                index={i}
                unread={!n.read}
                onOpen={() => {
                  navigate({ name: "agent", hostId: n.hostId, agentId: n.agentId });
                  onNavigate?.();
                }}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

/** Title-bar bell: unread badge that pops in, panel with every notification and inline answers. */
export function NotificationBell() {
  const { unread, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(0);
  const [prev, setPrev] = useState(unread);
  if (unread !== prev) {
    setPrev(unread);
    if (unread > prev) setRing((r) => r + 1);
  }
  // Viewing the panel for a moment marks everything read.
  useEffect(() => {
    if (!open || unread === 0) return;
    const id = window.setTimeout(markRead, 1800);
    return () => window.clearTimeout(id);
  }, [open, unread, markRead]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label={unread ? `Notifications (${unread} unread)` : "Notifications"} size="md" badge={unread > 0 ? (unread > 99 ? "99+" : unread) : undefined}>
          <motion.span key={ring} className="grid place-items-center" animate={ring ? { rotate: [0, -18, 15, -10, 6, 0] } : undefined} transition={{ duration: 0.7 }}>
            <Bell />
          </motion.span>
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[min(560px,80dvh)] w-[400px] flex-col p-3">
        <NotificationList onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
