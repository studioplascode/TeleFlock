import { CornerDownRight, ListPlus, Pencil, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { QueueInfo } from "@/core/gen";
import { cn, IconButton, spring, toast } from "@/design";
import { hostCall } from "../api";
import { useQueueChips, usePendingQueue } from "./queue";

/**
 * The "Queued" strip above the composer: the host's queue plus this client's just-sent messages
 * (`useQueueChips`). omp pulls back only its last queued message (the last steer, else the last
 * follow-up, as its Alt+Up does), so the edit and remove controls sit on that chip alone.
 */
export function QueueStrip({
  hostId,
  agentId,
  agentKey,
  queue,
  working,
  canPull,
  busy,
  run,
  onCopy,
  onPulled,
}: {
  hostId: string;
  agentId: string;
  agentKey: string;
  queue: QueueInfo | undefined;
  working: boolean;
  /** The session's bridge can pull a queued message back (`agent.dequeue`). */
  canPull: boolean;
  /** The composer is sending: the controls wait. */
  busy: boolean;
  /** Runs the host call as part of the composer's pending work. */
  run: <T>(p: Promise<T>) => Promise<T>;
  /** A chip was clicked: its text goes into the composer. */
  onCopy(text: string): void;
  /** The message was pulled back to be edited. */
  onPulled(text: string): void;
}) {
  const queued = useQueueChips(agentKey, queue, working);
  const lastSteer = queued.findLastIndex((q) => q.kind === "steer");
  const popIdx = !canPull ? -1 : lastSteer >= 0 ? lastSteer : queued.length - 1;
  const pull = async (edit: boolean) => {
    const r = await run(hostCall(hostId, "agent.dequeue", { agentId }, { failure: "Couldn't pull the message back" }));
    if (!r.ok) return;
    const t = r.value.text;
    if (!t) {
      // omp had nothing left to pull back: what showed as queued reached the agent already.
      usePendingQueue.getState().settle(agentKey);
      toast({ title: "Already delivered", description: "It reached the agent before it could be pulled back.", status: "idle" });
      return;
    }
    usePendingQueue.getState().forget(agentKey, t);
    if (edit) onPulled(t);
    else toast({ title: "Removed from the queue", description: t.length > 80 ? `${t.slice(0, 80)}…` : t, status: "done", duration: 2600 });
  };
  return (
    <AnimatePresence initial={false}>
      {queued.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-2 flex flex-wrap items-center gap-1.5 overflow-hidden px-1"
          aria-label="Queued messages"
        >
          <span className="mr-0.5 text-[10px] font-extrabold tracking-[0.1em] text-mute-2 uppercase">Queued · {queued.length}</span>
          <AnimatePresence initial={false} mode="popLayout">
            {queued.map((q, i) => {
              const excerpt = q.text.length > 40 ? `${q.text.slice(0, 40)}…` : q.text;
              return (
                <motion.span
                  layout
                  key={q.id}
                  initial={{ opacity: 0, scale: 0.8, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0, transition: spring.bouncy }}
                  exit={{ opacity: 0, scale: 0.85, y: -10, transition: { duration: 0.22 } }}
                  className="flex max-w-full min-w-0 items-center gap-0.5"
                >
                  <button
                    type="button"
                    title={`${q.sending ? "Sending… " : ""}${q.kind === "steer" ? "Steering: lands mid-turn" : "Follow-up: runs after this turn"}\n${q.text}\nClick to copy into the composer${popIdx >= 0 && i !== popIdx ? "\nOnly the last queued message can be pulled back" : ""}`}
                    onClick={() => onCopy(q.text)}
                    data-pending={q.pending || undefined}
                    className={cn(
                      "focus-ring flex max-w-[300px] min-w-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11.5px] font-semibold shadow-hairline",
                      q.kind === "steer" ? "bg-accent/14 text-accent-ink" : "bg-ink/5 text-ink-2",
                      q.sending && "opacity-70",
                      i === popIdx && "shadow-[inset_0_0_0_1px_var(--color-accent)]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-extrabold tracking-wider uppercase",
                        q.kind === "steer" ? "bg-accent/25 text-accent-hi" : "bg-ink/8 text-mute",
                      )}
                    >
                      {q.kind === "steer" ? <CornerDownRight className="size-2.5" /> : <ListPlus className="size-2.5" />}
                      {q.kind === "steer" ? "steer" : "follow-up"}
                    </span>
                    <span className="truncate">{q.text}</span>
                    <span className="tf-loop size-1.5 shrink-0 animate-breathe rounded-full bg-current opacity-70" aria-hidden />
                  </button>
                  {i === popIdx && (
                    <>
                      <IconButton label={`Pull “${excerpt}” back into the composer to edit it`} size="sm" disabled={busy} onClick={() => void pull(true)}>
                        <Pencil />
                      </IconButton>
                      <IconButton label={`Remove “${excerpt}” from the queue`} size="sm" disabled={busy} onClick={() => void pull(false)}>
                        <X />
                      </IconButton>
                    </>
                  )}
                </motion.span>
              );
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
