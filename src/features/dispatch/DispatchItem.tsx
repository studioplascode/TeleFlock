import { motion } from "motion/react";
import { Check, GitBranch, ImageOff, Play, RotateCcw, Server, ShieldCheck, SquareTerminal, X } from "lucide-react";
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type AgentView, agentKey, navigate, useAgent, useCore, useResuming } from "@/core";
import { type DraftVideo, useVideoUploads } from "@/core/draftVideos";
import type { Column } from "@/core/gen";
import { AgentGlyph, Elapsed, Lightbox, LightboxTrigger, Shimmer, StatusPill, type Status, cn, formatAge, spring, useNow } from "@/design";
import { canReview, openAgent, openTerminal, resumeParked } from "@/features/board/agentActions";
import { LANE_BY_COLUMN } from "@/features/board/lanes";
import { AgentOrb, LiveLine, QuietChip, useQuiet } from "@/features/board/LiveBits";
import { QuickAnswer } from "@/features/board/QuickAnswer";
import { ACTIONS, agentStateWord, isFresh } from "@/features/shell/vocab";
import { AiMark } from "@/features/workspace/shared/ai";
import { tildify } from "@/features/workspace/shared/paths";
import { VideoChips } from "@/features/session/composer/VideoChips";
import { useEntryImages } from "./images";
import { type DispatchEntry, type DispatchVideo, entryHost, isInFlight, useDispatch } from "./store";
import { APPEAR_GRACE_MS, START_TIMEOUT_MS } from "./thread";

/** Thread-wide handlers and facts the items need (kept out of props so items stay memoised). */
export interface ThreadContext {
  /** The thread's store key; each entry's host comes from it or the entry (`entryHost`). */
  threadKey: string;
  /** An Auto thread: entries show which host they went to and why. */
  auto: boolean;
  /** Home folder per host (paths are shown with `~`). */
  homes: Readonly<Record<string, string | undefined>>;
  /** Host state is live (not a cached snapshot), per host. */
  online: Readonly<Record<string, boolean>>;
  hostName(hostId: string): string;
  mobile: boolean;
  retry(id: string, trust: boolean): void;
  dismiss(id: string): void;
}

export const ThreadCtx = createContext<ThreadContext | null>(null);

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Launch steps after the request leaves the composer. */
type Step = "naming" | "uploading" | "queued" | "creating" | "starting";

const STEP_LABEL: Record<Step, string> = { naming: "Naming the branch", uploading: "Uploading videos", queued: "Queued", creating: "Creating worktree", starting: "Starting agent" };
const SEGMENTS = [
  { step: "creating", label: "Creating worktree" },
  { step: "starting", label: "Starting agent" },
  { step: "running", label: "Running" },
] as const;
const STEP_INDEX: Record<Step, number> = { naming: -1, uploading: -1, queued: -1, creating: 0, starting: 1 };

/** What the reply card shows, derived from the entry, whether its request is in flight, and host state. */
type Shown =
  | { k: "step"; step: Step }
  | { k: "live"; agent: AgentView }
  | { k: "failed" }
  /** No answer from herdr: the app reloaded mid-request, or the request timed out / lost the connection. */
  | { k: "unconfirmed"; reason: "reload" | "lost" }
  | { k: "gone" };

function shownOf(entry: DispatchEntry, agent: AgentView | undefined, now: number): Shown {
  const inFlight = isInFlight(entry.id);
  // `naming` shows as such even after a reload: the view resumes it under the fallback name.
  if (entry.phase === "naming") return { k: "step", step: "naming" };
  if (inFlight && (entry.phase === "uploading" || entry.phase === "queued" || entry.phase === "creating")) return { k: "step", step: entry.phase };
  if (entry.phase === "failed") return { k: "failed" };
  const since = entry.startedAt ?? entry.createdAt;
  if (agent) {
    // herdr started omp; the prompt is submitted once omp is ready (first turn not begun yet).
    const waiting = agent.turns === 0 && agent.state === "idle" && now - since < START_TIMEOUT_MS;
    return waiting ? { k: "step", step: "starting" } : { k: "live", agent };
  }
  if (entry.phase === "started") return now - since < APPEAR_GRACE_MS ? { k: "step", step: "starting" } : { k: "gone" };
  return { k: "unconfirmed", reason: entry.phase === "unknown" ? "lost" : "reload" };
}

function statusOf(shown: Shown, entry: DispatchEntry): Status {
  switch (shown.k) {
    case "failed":
      return "error";
    case "unconfirmed":
      return "idle";
    case "step":
      return "running";
    case "live":
      return isFresh(shown.agent) ? "idle" : LANE_BY_COLUMN[shown.agent.column].status;
    case "gone":
      return entry.last?.column === "done" || entry.last?.column === "review" ? "done" : "idle";
  }
}

function optionsSummary(e: DispatchEntry): string {
  const o = e.options;
  return [o.model === "default" ? null : (o.model.split("/").pop() ?? o.model), o.thinking === "default" ? null : o.thinking, o.plan && "plan"].filter(Boolean).join(" · ");
}

/**
 * One dispatch: the message (images, videos, text) as a user bubble, then the agent's live reply card.
 * `index` (its place in the thread) is what moves it: it measures its layout only when that changes.
 */
export const DispatchItem = memo(function DispatchItem({ entry, agentId, index }: { entry: DispatchEntry; agentId?: string; index: number }) {
  const ctx = useContext(ThreadCtx);
  if (!ctx) return null;
  const today = new Date(entry.createdAt).toDateString() === new Date().toDateString();
  return (
    <motion.li layout="position" layoutDependency={index} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring.smooth} className="flex flex-col gap-2.5">
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2 pr-1 text-[11px] font-bold text-mute-2">
          <span>You</span>
          <span className="font-semibold tabular">{(today ? timeFmt : dayFmt).format(entry.createdAt)}</span>
        </div>
        {!!entry.images && <EntryImages id={entry.id} count={entry.images} mobile={ctx.mobile} />}
        {!!entry.videos?.length && <EntryVideos videos={entry.videos} mobile={ctx.mobile} />}
        {entry.prompt.trim() && (
          <div
            className={cn(
              "max-w-[min(720px,88%)] rounded-[20px] rounded-tr-[8px] bg-tile-4 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.06),var(--shadow-d1)] whitespace-pre-wrap [overflow-wrap:anywhere]",
              ctx.mobile ? "px-3.5 py-2 text-[14px] leading-[1.5]" : "px-4 py-2.5 text-[13.5px] leading-[1.55]",
            )}
          >
            {entry.prompt}
          </div>
        )}
      </div>
      <Reply entry={entry} agentId={agentId} ctx={ctx} />
    </motion.li>
  );
});

/** A parked agent behind the entry (its pane closed when marked done): by id, else by omp session. */
function parkedKeyOf(agents: Record<string, AgentView>, hostId: string, entry: DispatchEntry): string | undefined {
  const byId = entry.agentId ? agents[agentKey(hostId, entry.agentId)] : undefined;
  if (byId?.parked) return byId.key;
  if (!entry.sessionId) return undefined;
  return Object.values(agents).find((a) => a.hostId === hostId && a.parked && a.omp?.sessionId === entry.sessionId)?.key;
}

/** The images sent with a task (from IndexedDB): thumbnails that open the lightbox. */
function EntryImages({ id, count, mobile }: { id: string; count: number; mobile: boolean }) {
  const images = useEntryImages(id, count);
  const [viewing, setViewing] = useState<number | null>(null);
  const size = mobile ? "size-16" : "size-20";
  if (images === null) {
    return (
      <span className="flex items-center gap-1.5 pr-1 text-2xs font-semibold text-mute-2">
        <ImageOff className="size-3.5" /> {count === 1 ? "1 image" : `${count} images`} (not on this device)
      </span>
    );
  }
  return (
    <div className="flex max-w-[min(720px,88%)] flex-wrap justify-end gap-1.5" aria-label={count === 1 ? "1 image" : `${count} images`}>
      {images
        ? images.map((img, i) => (
            <LightboxTrigger key={i} label={`View image ${i + 1}`} onClick={() => setViewing(i)}>
              <img src={img.preview} alt={`image ${i + 1}`} className={cn(size, "rounded-[14px] object-cover shadow-[inset_0_1px_0_rgb(255_255_255/0.06),var(--shadow-d1)]")} />
            </LightboxTrigger>
          ))
        : Array.from({ length: count }, (_, i) => <span key={i} className={cn(size, "animate-pulse rounded-[14px] bg-tile-4")} />)}
      {images && <Lightbox images={images.map((img, i) => ({ src: img.preview, alt: `image ${i + 1}` }))} index={viewing !== null && viewing < images.length ? viewing : null} onIndexChange={setViewing} />}
    </div>
  );
}

/** The uploads of `videos` still running in this page. */
function useEntryUploads(videos: readonly DispatchVideo[]): DraftVideo[] {
  const ids = useMemo(() => videos.flatMap((v) => (v.upload && !v.path ? [v.upload] : [])), [videos]);
  return useVideoUploads(ids);
}

/** The videos sent with a task, as chips: their upload's progress while it runs, else uploaded (or not). */
function EntryVideos({ videos, mobile }: { videos: readonly DispatchVideo[]; mobile: boolean }) {
  const live = useEntryUploads(videos);
  const shown = videos.map(
    (v, i): DraftVideo =>
      live.find((u) => u.id === v.upload) ?? {
        id: v.upload ?? `sent-${i}`,
        name: v.name,
        size: v.size,
        mime: "",
        hostId: null,
        phase: v.path ? "done" : "failed",
        sent: v.path ? v.size : 0,
        ...(v.path ? { path: v.path } : { error: "Not uploaded" }),
      },
  );
  return <VideoChips videos={shown} mobile={mobile} className="max-w-[min(720px,88%)] justify-end" />;
}

/** A task's videos on their way to the host: one bar for all of them. */
function Uploading({ videos }: { videos: readonly DispatchVideo[] }) {
  const live = useEntryUploads(videos);
  const total = live.reduce((n, v) => n + v.size, 0);
  const pct = total ? Math.floor((live.reduce((n, v) => n + v.sent, 0) / total) * 100) : 0;
  return (
    <div className="mt-2 flex items-center gap-3" role="status">
      <Shimmer className="text-xs font-semibold">
        {live.length > 1 ? `Uploading ${live.length} videos` : "Uploading the video"} · {pct}%
      </Shimmer>
      <span className="relative ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <span className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function Reply({ entry, agentId, ctx }: { entry: DispatchEntry; agentId?: string; ctx: ThreadContext }) {
  const hostId = entryHost(ctx.threadKey, entry);
  const online = ctx.online[hostId] === true;
  const key = agentId ? agentKey(hostId, agentId) : undefined;
  const agent = useAgent(key ?? "");
  const parkedKey = useCore((s) => (agent ? undefined : parkedKeyOf(s.agents, hostId, entry)));
  const launching = entry.phase !== "failed" && (!agent || (agent.turns === 0 && agent.state === "idle"));
  const now = useNow(launching ? 1000 : 60_000);

  // Remember the agent's lane so the entry still reads right once the agent is gone, and its omp
  // session to find it again once it resumes under a new id (or is pruned).
  const column = agent?.column;
  const title = agent?.title;
  const turns = agent?.turns;
  const sessionId = agent?.omp?.sessionId;
  const last = entry.last;
  useEffect(() => {
    if (!column || title === undefined || turns === undefined) return;
    if (last && last.column === column && last.title === title && last.turns === turns && (!sessionId || entry.sessionId === sessionId)) return;
    useDispatch.getState().patch(ctx.threadKey, entry.id, { last: { column, title, turns, at: Date.now() }, ...(sessionId ? { sessionId } : {}) });
  }, [column, title, turns, sessionId, last, entry.id, entry.sessionId, ctx.threadKey]);

  const shown = shownOf(entry, agent, now);
  const status = statusOf(shown, entry);
  const live = shown.k === "live" ? shown.agent : undefined;
  const bad = shown.k === "failed";
  const summary = optionsSummary(entry);

  return (
    <div className={cn("flex items-start", ctx.mobile ? "gap-2" : "gap-3")}>
      <AgentGlyph
        name={agent?.name ?? entry.name}
        size={ctx.mobile ? 26 : 30}
        status={live && (live.column === "running" || live.column === "needs") ? status : undefined}
        className="mt-0.5"
      />
      <div
        data-status={status}
        className={cn(
          "relative min-w-0 flex-1 rounded-[18px] rounded-tl-[8px] transition-[background-color,box-shadow] duration-500",
          ctx.mobile ? "p-2.5" : "p-3",
          bad
            ? "bg-error/8 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)]"
            : shown.k === "unconfirmed"
              ? "bg-warn/8 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]"
              : live?.column === "needs"
                ? "st-border-grad bg-white/[0.035]"
                : "bg-white/[0.035] shadow-hairline",
          shown.k === "gone" && "opacity-75",
        )}
      >
        <header className="flex min-w-0 items-center gap-2">
          {live && key && <AgentOrb agentKey={key} status={status} tool={live.live.tool} size={8} />}
          {entry.phase === "naming" ? (
            <Shimmer className="min-w-0 truncate text-[13px] font-extrabold">Naming…</Shimmer>
          ) : (
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-[13px] font-extrabold text-ink">{agent?.name ?? entry.name}</span>
              {entry.aiNamed && (agent?.name ?? entry.name) === entry.name && <AiMark />}
            </span>
          )}
          <Badge shown={shown} entry={entry} status={status} online={online} mobile={ctx.mobile} />
          <span className="ml-auto shrink-0 text-2xs font-bold text-mute tabular">
            {live?.column === "running" ? (
              <Elapsed since={live.omp?.turnStartedAt ?? live.stateSince} />
            ) : live?.column === "needs" && live.needs ? (
              <span className="text-[#ffb08a]">
                waiting <Elapsed since={live.needs.since} />
              </span>
            ) : live ? (
              formatAge(now - live.stateSince)
            ) : null}
          </span>
        </header>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-2xs text-mute-2">
          <GitBranch className="size-3 shrink-0" />
          <span className="min-w-0 truncate" title={entry.path ? tildify(entry.path, ctx.homes[hostId]) : undefined}>
            {entry.phase === "naming" ? "dispatch/…" : entry.branch}
            {(entry.base ?? entry.baseLabel) && <span className="opacity-70"> ← {entry.base ?? entry.baseLabel}</span>}
          </span>
          {summary && <span className="shrink-0 font-sans font-semibold max-sm:hidden">· sent with: {summary}</span>}
        </div>
        {ctx.auto && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs font-semibold text-mute-2" title={entry.placed}>
            <Server className="size-3 shrink-0" />
            <span className="shrink-0 text-mute">on {ctx.hostName(hostId)}</span>
            {entry.placed && <span className="min-w-0 truncate">· {entry.placed}</span>}
          </div>
        )}
        <Body shown={shown} entry={entry} agentKey={key} parkedKey={parkedKey} ctx={ctx} online={online} />
      </div>
    </div>
  );
}

const LAST_LABEL: Record<Column, string> = { running: "Closed", needs: "Closed", review: "Finished · closed", done: "Done · closed" };

function Badge({ shown, entry, status, online, mobile }: { shown: Shown; entry: DispatchEntry; status: Status; online: boolean; mobile: boolean }) {
  switch (shown.k) {
    case "failed":
      return <StatusPill status="error" size="sm">Failed</StatusPill>;
    case "unconfirmed":
      return <span className="shrink-0 rounded-full bg-warn/14 px-2 py-0.5 font-display text-[9.5px] font-bold tracking-[0.1em] text-warn uppercase">Unconfirmed</span>;
    case "gone":
      return (
        <StatusPill status={status} size="sm">
          {!online ? "Host offline" : entry.last ? LAST_LABEL[entry.last.column] : "Closed"}
        </StatusPill>
      );
    case "step":
      return null;
    case "live": {
      const a = shown.agent;
      if (a.column === "needs" || a.column === "review") return <StatusPill status={a.column === "needs" ? "needs-you" : status} size="sm">{agentStateWord(a)}</StatusPill>;
      if (a.column === "done") return <StatusPill status="done" size="sm">{agentStateWord(a)}</StatusPill>;
      // Phones: the orb and live line already say "running"; the name gets the room.
      return mobile ? null : <StatusPill status={status} size="sm" />;
    }
  }
}

const action = "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-2xs font-bold pressable focus-ring [&_svg]:size-3.5 disabled:pointer-events-none disabled:opacity-45";
const primary = `${action} bg-accent text-white shadow-glow-accent hover:bg-accent-hi`;
const secondary = `${action} bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-tile-5`;
const ghost = `${action} text-mute hover:bg-white/6 hover:text-ink`;

function Body({ shown, entry, agentKey: key, parkedKey, ctx, online }: { shown: Shown; entry: DispatchEntry; agentKey?: string; parkedKey?: string; ctx: ThreadContext; online: boolean }) {
  const agent = shown.k === "live" ? shown.agent : undefined;
  const quiet = useQuiet(agent?.column === "running" && online, agent?.live.lastEventAt);

  if (shown.k === "unconfirmed") {
    return (
      <>
        <p className="mt-2 text-xs font-semibold text-warn [overflow-wrap:anywhere]">
          {shown.reason === "reload" ? "The app reloaded before herdr answered." : (entry.error?.title ?? "Lost contact with the host.")}
        </p>
        <p className="mt-0.5 text-2xs text-mute [overflow-wrap:anywhere]">
          The host may still be creating the worktree and agent; this card picks the agent up as soon as it appears. Check & retry looks for them before creating
          anything new.
        </p>
        <Actions>
          <button type="button" className={primary} onClick={() => ctx.retry(entry.id, false)} disabled={!online}>
            <RotateCcw /> Check & retry
          </button>
          <button type="button" className={ghost} onClick={() => ctx.dismiss(entry.id)}>
            <X /> Dismiss
          </button>
        </Actions>
      </>
    );
  }

  if (shown.k === "failed") {
    const untrusted = entry.error?.kind === "untrusted";
    return (
      <>
        <p className="mt-2 text-xs font-semibold text-error [overflow-wrap:anywhere]">{entry.error?.title}</p>
        <p className="mt-0.5 text-2xs text-mute [overflow-wrap:anywhere]">
          {untrusted ? "git refuses this repository (“dubious ownership”). Trusting it passes -c safe.directory to herdr's git commands only." : entry.error?.hint}
        </p>
        <Actions>
          {untrusted && (
            <button type="button" className={primary} onClick={() => ctx.retry(entry.id, true)} disabled={!online}>
              <ShieldCheck /> Trust repository & retry
            </button>
          )}
          <button type="button" className={untrusted ? secondary : primary} onClick={() => ctx.retry(entry.id, false)} disabled={!online}>
            <RotateCcw /> Retry
          </button>
          <button type="button" className={ghost} onClick={() => ctx.dismiss(entry.id)}>
            <X /> Dismiss
          </button>
        </Actions>
      </>
    );
  }

  if (shown.k === "step") return shown.step === "uploading" ? <Uploading videos={entry.videos ?? []} /> : <Progress step={shown.step} />;

  if (shown.k === "gone" && parkedKey && online) return <Parked parkedKey={parkedKey} />;

  if (shown.k === "gone" || !agent || !key) {
    return (
      <p className="mt-2 text-xs text-mute">
        {!online
          ? "The host is offline; this is the last state seen."
          : entry.last && entry.last.title && !entry.prompt.startsWith(entry.last.title)
            ? `“${entry.last.title}” — the agent has been closed since.`
            : "The agent has been closed since."}
      </p>
    );
  }

  const buttons = (
    <>
      <button type="button" className={secondary} onClick={() => openAgent(key)} title={ACTIONS.openSession.description}>
        {ACTIONS.openSession.label}
      </button>
      <button type="button" className={ghost} onClick={() => openTerminal(key, ctx.mobile)} title={ACTIONS.terminal.description}>
        <SquareTerminal /> {ACTIONS.terminal.label}
      </button>
      {canReview(agent) && (
        <button
          type="button"
          className={ghost}
          title={ACTIONS.review.description}
          onClick={() => navigate({ name: "review", hostId: agent.hostId, workspaceId: agent.workspaceId })}
        >
          {ACTIONS.review.label}
        </button>
      )}
    </>
  );

  if (agent.column === "needs" && agent.needs) {
    const n = agent.needs;
    return (
      <>
        <p className="mt-2 text-sm leading-snug font-bold text-ink">“{n.question || n.title}”</p>
        {n.detail && <p className="mt-1 line-clamp-3 text-xs text-mute">{n.detail}</p>}
        {n.command && !n.question.includes(n.command) && (
          <pre className="mt-2 max-h-24 overflow-auto rounded-sm well px-2.5 py-1.5 font-mono text-2xs whitespace-pre-wrap text-ink-2">{n.command}</pre>
        )}
        <QuickAnswer agentKey={key} className="mt-2.5" max={ctx.mobile ? 4 : 6} mobile={ctx.mobile} chat={false} />
        <Actions>{buttons}</Actions>
      </>
    );
  }

  return (
    <>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <LiveLine live={agent.live} running={agent.column === "running" && online} turnStartedAt={agent.omp?.turnStartedAt ?? agent.stateSince} className="min-w-0 flex-1" />
        {quiet && <QuietChip since={agent.live.lastEventAt ?? 0} />}
      </div>
      <Actions>
        {buttons}
        {agent.column === "done" && (
          <span className="ml-auto inline-flex items-center gap-1 text-2xs font-bold text-done">
            <Check className="size-3.5" /> {agentStateWord(agent)}
          </span>
        )}
      </Actions>
    </>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 flex flex-wrap items-center gap-1.5">{children}</div>;
}

/** The agent was marked done and its pane closed: it resumes (omp --resume) when needed. */
function Parked({ parkedKey }: { parkedKey: string }) {
  const resuming = useResuming(parkedKey);
  return (
    <>
      <p className="mt-2 text-xs text-mute">Its pane closed when it was marked done. Resume picks the session up in a new pane.</p>
      <Actions>
        <button type="button" className={secondary} onClick={() => void resumeParked(parkedKey)} disabled={resuming}>
          <Play /> {resuming ? "Resuming…" : ACTIONS.resume.label}
        </button>
        <button type="button" className={ghost} onClick={() => openAgent(parkedKey)} title={ACTIONS.openSession.description}>
          {ACTIONS.openSession.label}
        </button>
      </Actions>
    </>
  );
}

/** Queued → Creating worktree → Starting agent → Running, as three filling segments. */
function Progress({ step }: { step: Step }) {
  const at = STEP_INDEX[step];
  return (
    <div className="mt-2 flex items-center gap-3" role="status">
      <Shimmer className="text-xs font-semibold">{STEP_LABEL[step]}…</Shimmer>
      <span className="ml-auto flex gap-1" aria-hidden>
        {SEGMENTS.map((s, i) => (
          <span key={s.step} title={s.label} className="relative h-1.5 w-6 overflow-hidden rounded-full bg-white/10">
            {i < at && <span className="absolute inset-0 bg-accent" />}
            {i === at && <span className="tf-loop absolute inset-0 animate-pulse bg-omp" />}
          </span>
        ))}
      </span>
    </div>
  );
}
