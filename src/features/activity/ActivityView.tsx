import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { type HostActivityEvent, type HostNotification, loadOlderActivity, navigate, useActivity, useCore, useHosts, useNotifications } from "@/core";
import type { ActivityKind, NotifyKind } from "@/core/gen";
import { AgentGlyph, Button, EmptyState, SegmentedControl, StatusOrb, type Status, cn, formatAge, spring, useIsMobile, useNow } from "@/design";
import { HostTag } from "@/features/board/AgentCard";
import { MobileHeader } from "@/features/shell/MobileHeader";

type Group = "all" | "finished" | "needs" | "problems" | "git" | "lifecycle";

const KIND_GROUP: Record<ActivityKind, Group> = {
  finished: "finished",
  asked: "needs",
  answered: "needs",
  approved: "needs",
  denied: "needs",
  error: "problems",
  toolError: "problems",
  committed: "git",
  started: "lifecycle",
  prompted: "lifecycle",
  archived: "lifecycle",
  unarchived: "lifecycle",
  stopped: "lifecycle",
  compacted: "lifecycle",
  modelChanged: "lifecycle",
};

const KIND_STATUS: Record<ActivityKind, Status> = {
  finished: "review",
  asked: "needs-you",
  answered: "running",
  approved: "running",
  denied: "error",
  error: "error",
  toolError: "error",
  committed: "done",
  started: "running",
  prompted: "running",
  archived: "done",
  unarchived: "review",
  stopped: "idle",
  compacted: "idle",
  modelChanged: "idle",
};

const KIND_LABEL: Record<ActivityKind, string> = {
  finished: "Finished",
  asked: "Asked",
  answered: "Answered",
  approved: "Approved",
  denied: "Denied",
  error: "Error",
  toolError: "Tool failed",
  committed: "Committed",
  started: "Started",
  prompted: "Prompted",
  archived: "Archived",
  unarchived: "Reopened",
  stopped: "Stopped",
  compacted: "Compacted",
  modelChanged: "Model changed",
};

const NOTIFY_STATUS: Record<NotifyKind, Status> = { needs: "needs-you", finished: "review", error: "error", quiet: "idle", info: "idle" };

const GROUPS = [
  { value: "all", label: "All" },
  { value: "finished", label: "Finished" },
  { value: "needs", label: "Asks" },
  { value: "problems", label: "Problems" },
  { value: "git", label: "Git" },
  { value: "lifecycle", label: "Lifecycle" },
] as const;

/** Timeline rows: host activity, plus live notifications that have no activity twin (quiet, info). */
type Row =
  | { type: "event"; id: string; at: number; ev: HostActivityEvent }
  | { type: "notice"; id: string; at: number; n: HostNotification };

function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function EventRow({ row, now }: { row: Row; now: number }) {
  const isEvent = row.type === "event";
  const hostId = isEvent ? row.ev.hostId : row.n.hostId;
  const agentId = isEvent ? row.ev.agentId : row.n.agentId;
  const name = isEvent ? row.ev.agentName : row.n.agentId;
  const status = isEvent ? KIND_STATUS[row.ev.kind] : NOTIFY_STATUS[row.n.kind];
  const label = isEvent ? KIND_LABEL[row.ev.kind] : row.n.kind === "quiet" ? "Quiet" : "Notice";
  const title = isEvent ? row.ev.title : row.n.title;
  const detail = isEvent ? row.ev.detail : row.n.body;
  const fresh = now - row.at < 8000;
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -14, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={spring.smooth}
      className="relative pl-9"
    >
      <span data-status={status} className="absolute top-3.5 left-[11px] z-10 grid size-3 place-items-center">
        <StatusOrb status={status} size={9} label={null} activity={fresh ? "busy" : "silent"} />
      </span>
      <button
        type="button"
        onClick={() => agentId && navigate({ name: "agent", hostId, agentId })}
        className={cn(
          "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-white/4 focus-ring",
          fresh && "bg-[rgb(var(--st-rgb)/0.06)]",
        )}
        data-status={status}
      >
        <AgentGlyph name={name} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="font-extrabold text-ink">{name}</span>
            <span data-status={status} className="rounded-full st-soft px-1.5 py-px text-[10px] font-bold uppercase">
              {label}
            </span>
            <HostTag hostId={hostId} />
            <span className="ml-auto font-mono text-2xs text-mute-2 tabular" title={new Date(row.at).toLocaleString()}>
              {now - row.at < 3_600_000 ? formatAge(now - row.at) : clock(row.at)}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-ink-2">{title}</p>
          {detail && <p className="mt-0.5 line-clamp-2 text-xs text-mute">{detail}</p>}
        </div>
      </button>
    </motion.li>
  );
}

/** Cross-agent timeline (spec §5 Activity): host activity + live notifications, newest first. */
export function ActivityView() {
  const filter = useHosts((s) => s.filter);
  const hostId = filter === "all" ? undefined : filter;
  const events = useActivity(hostId);
  const notes = useNotifications((v) => v.items);
  const withMore = useCore((s) =>
    Object.entries(s.activity)
      .filter(([id, a]) => a.hasMore && (!hostId || id === hostId))
      .map(([id]) => id)
      .join("|"),
  );
  const loaded = useCore((s) => Object.values(s.activity).some((a) => a.loaded));
  const [group, setGroup] = useState<Group>("all");
  const [loading, setLoading] = useState(false);
  const now = useNow(5000);
  const mobile = useIsMobile();

  const rows: Row[] = [];
  for (const ev of events) if (group === "all" || KIND_GROUP[ev.kind] === group) rows.push({ type: "event", id: `${ev.hostId}:${ev.id}`, at: ev.at, ev });
  if (group === "all" || group === "problems")
    for (const n of notes)
      if ((n.kind === "quiet" || n.kind === "info") && (!hostId || n.hostId === hostId) && (group === "all" || n.kind === "quiet"))
        rows.push({ type: "notice", id: `n:${n.hostId}:${n.id}`, at: n.at, n });
  rows.sort((a, b) => b.at - a.at);

  const days: { label: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.at, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.rows.push(r);
    else days.push({ label, rows: [r] });
  }

  const loadOlder = async () => {
    setLoading(true);
    try {
      await Promise.all(withMore.split("|").filter(Boolean).map((id) => loadOlderActivity(id)));
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <>
      <SegmentedControl<Group> size="sm" value={group} onValueChange={setGroup} options={GROUPS} className={cn(mobile && "w-full overflow-x-auto")} />
      {rows.length === 0 ? (
        <EmptyState
          title={loaded ? "Nothing here yet" : "Loading activity…"}
          description={loaded ? "Finished turns, questions, failures and commits from every agent show up here as they happen." : undefined}
          className="mt-10"
        />
      ) : (
        days.map((d) => (
          <section key={d.label} aria-label={d.label} className="[content-visibility:auto]">
            <h2 className="sticky top-0 z-20 -mx-1 mb-1 bg-bg/80 px-1 py-1.5 font-display text-xs font-bold tracking-[0.12em] text-mute uppercase backdrop-blur">
              {d.label}
            </h2>
            <ol className="relative flex flex-col before:absolute before:top-2 before:bottom-2 before:left-[16px] before:w-px before:bg-gradient-to-b before:from-line-3 before:to-transparent">
              <AnimatePresence initial={false}>
                {d.rows.map((r) => (
                  <EventRow key={r.id} row={r} now={now} />
                ))}
              </AnimatePresence>
            </ol>
          </section>
        ))
      )}
      {withMore && (
        <Button variant="secondary" size="sm" className="self-center" loading={loading} onClick={() => void loadOlder()}>
          Load older
        </Button>
      )}
    </>
  );

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Activity" subtitle="Every agent, one timeline" />
        <div className="flex flex-col gap-4 px-4 pt-2 pb-6">{content}</div>
      </div>
    );
  return (
    <div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <header className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-ink">Activity</h1>
          <span className="flex items-center gap-1.5 text-xs font-bold text-mute">
            <StatusOrb status="running" size={7} label={null} activity="steady" /> live
          </span>
          <span className="ml-auto text-xs font-semibold text-mute-2">{rows.length} events</span>
        </header>
        {content}
      </div>
    </div>
  );
}
