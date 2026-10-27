import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { type HostActivityEvent, type HostNotification, loadOlderActivity, navigate, type Route, useActivity, useCore, useHosts, useNotifications } from "@/core";
import type { ActivityKind, NotifyKind } from "@/core/gen";
import { AgentGlyph, Button, EmptyState, NumberTicker, PageHeader, SegmentedControl, Sparkline, StatusOrb, type Status, cn, formatAge, spring, useIsMobile, useNow } from "@/design";
import { HostTag } from "@/features/board/AgentCard";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { STATE_WORD, VIEWS } from "@/features/shell/vocab";

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
  archived: "Marked done",
  unarchived: "Reopened",
  stopped: "Turn stopped",
  compacted: "Compacted",
  modelChanged: "Model changed",
};

const NOTIFY_STATUS: Record<NotifyKind, Status> = { needs: "needs-you", finished: "review", error: "error", quiet: "idle", info: "idle" };

/** Filter chips, in the board's words: finished turns are what the Review lane holds, asks are Needs you. */
const GROUPS = [
  { value: "all", label: "All" },
  { value: "finished", label: "Finished" },
  { value: "needs", label: STATE_WORD.needs },
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

/** `index` (the row's place in its day) is what moves a row: it measures its layout only when that changes. */
function EventRow({ row, now, index }: { row: Row; now: number; index: number }) {
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
      layoutDependency={index}
      initial={{ opacity: 0, x: -14, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={spring.smooth}
      className="relative pl-9"
    >
      <span data-status={status} className="absolute top-3.5 left-[11px] z-raised grid size-3 place-items-center">
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

/** Today's tallies; Finished and Needs you also link to where those agents wait now (Review lane, Inbox). */
const PULSE: readonly { group: Group; label: string; status: Status; link?: { label: string; route: Route } }[] = [
  { group: "all", label: "Last hour", status: "running" },
  { group: "finished", label: "Finished today", status: "review", link: { label: VIEWS.board.label, route: { name: "board" } } },
  { group: "needs", label: `${STATE_WORD.needs} today`, status: "needs-you", link: { label: VIEWS.inbox.label, route: { name: "inbox" } } },
  { group: "problems", label: "Problems today", status: "error" },
];

const BUCKET_MS = 5 * 60_000;

/** Bento strip over the timeline: the last hour's pulse plus today's tallies; each tile filters. */
function ActivityPulse({ events, now, group, onPick, mobile }: { events: HostActivityEvent[]; now: number; group: Group; onPick: (g: Group) => void; mobile: boolean }) {
  const hourAgo = now - 12 * BUCKET_MS;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const buckets: number[] = Array.from({ length: 12 }, () => 0);
  const tally: Record<Group, number> = { all: 0, finished: 0, needs: 0, problems: 0, git: 0, lifecycle: 0 };
  for (const ev of events) {
    if (ev.at >= hourAgo) {
      tally.all++;
      const b = Math.min(11, Math.floor((ev.at - hourAgo) / BUCKET_MS));
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    if (ev.at >= midnight && ev.kind !== "answered" && ev.kind !== "approved" && ev.kind !== "denied") tally[KIND_GROUP[ev.kind]]++;
  }
  return (
    <div className={cn("grid", mobile ? "grid-cols-2 gap-2" : "grid-cols-4 gap-3")}>
      {PULSE.map((t, i) => {
        const on = group === t.group && t.group !== "all";
        const n = tally[t.group];
        return (
          <motion.div
            key={t.group}
            data-status={t.status}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...spring.smooth, delay: 0.06 + i * 0.05 }}
            className="relative"
          >
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on || t.group === "all" ? "all" : t.group)}
              className={cn(
                "card-surface group relative flex w-full flex-col overflow-hidden rounded-lg text-left pressable focus-ring lift",
                mobile ? "h-[88px] p-3" : "h-[104px] p-3.5",
                on && "shadow-[var(--shadow-d1),inset_0_0_0_1.5px_rgb(var(--st-rgb)/0.6),0_10px_30px_-12px_rgb(var(--st-rgb)/0.6)]",
              )}
            >
              <span className="flex items-center gap-1.5 pr-14 text-2xs font-bold text-mute">
                <StatusOrb status={n > 0 ? t.status : "idle"} size={6} label={null} activity={t.group === "all" && n > 0 ? "busy" : "silent"} />
                {t.label}
              </span>
              <NumberTicker value={n} className={cn("mt-1 font-display font-bold", mobile ? "text-2xl" : "text-3xl", n > 0 ? "text-ink" : "text-mute-2")} />
              {t.group === "all" ? (
                <Sparkline values={buckets} status="running" height={22} className="mt-auto" aria-label="Events per 5 minutes over the last hour" />
              ) : (
                <span className="mt-auto h-1 overflow-hidden rounded-full bg-white/6">
                  <motion.span
                    className="block h-full rounded-full st-bg"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, n * 10)}%` }}
                    transition={{ ...spring.gentle, delay: 0.15 + i * 0.05 }}
                  />
                </span>
              )}
            </button>
            {t.link && (
              <button
                type="button"
                onClick={() => t.link && navigate(t.link.route)}
                className="absolute top-2 right-2 flex h-6 items-center gap-0.5 rounded-sm px-1.5 text-2xs font-bold text-mute transition-colors focus-ring hover:bg-white/8 hover:text-ink"
              >
                {t.link.label}
                <ChevronRight className="size-3" />
              </button>
            )}
          </motion.div>
        );
      })}
    </div>
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

  // a promise chain, not try/finally: the React Compiler can't compile a component holding try without catch
  const loadOlder = () => {
    setLoading(true);
    return Promise.all(withMore.split("|").filter(Boolean).map((id) => loadOlderActivity(id))).finally(() => setLoading(false));
  };

  const content = (
    <>
      <ActivityPulse events={events} now={now} group={group} onPick={setGroup} mobile={mobile} />
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
            <h2 className="pointer-events-none sticky top-2 z-sticky mb-1 py-1 max-md:top-13 max-md:z-raised">
              <span className="inline-flex rounded-full glass px-2.5 py-1 font-display text-2xs font-bold tracking-[0.12em] text-ink-2 uppercase">{d.label}</span>
            </h2>
            <ol className="relative isolate flex flex-col before:absolute before:top-2 before:bottom-2 before:left-[16px] before:w-px before:bg-gradient-to-b before:from-line-3 before:to-transparent">
              <AnimatePresence initial={false}>
                {d.rows.map((r, i) => (
                  <EventRow key={r.id} row={r} now={now} index={i} />
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
        <MobileHeader title="Activity" subtitle="Every agent, one timeline" back />
        <div className="flex flex-col gap-3 px-3 pt-1 pb-5">{content}</div>
      </div>
    );
  return (
    <div className="mx-auto flex max-w-[920px] flex-col gap-4 px-8 pt-7 pb-12">
      <PageHeader
        kicker="Timeline"
        title="Activity"
        meta={
          <>
            <StatusOrb status="running" size={7} label={null} activity="steady" /> live · {rows.length} events
          </>
        }
        className="mb-1"
      />
      {content}
    </div>
  );
}
