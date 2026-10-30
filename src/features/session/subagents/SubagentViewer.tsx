import * as RadixDialog from "@radix-ui/react-dialog";
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, Lock, MessageSquareDashed, RefreshCw, RotateCcw, Skull, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { core, draftKey, drafts, parseAgentKey, useAgent, useDraft, useSession } from "@/core";
import type { Subagent } from "@/core/gen";
import {
  Button,
  cn,
  Elapsed,
  EmptyState,
  formatCompact,
  formatElapsed,
  formatUsd,
  IconButton,
  Kbd,
  Shimmer,
  Spinner,
  spring,
  StatusOrb,
  StatusPill,
  Textarea,
  Tooltip,
  tween,
  useIsMobile,
} from "@/design";
import { errorText, hostCall, usePending } from "../api";
import { SessionCtx } from "../context";
import { IrcSelfCtx } from "../irc/IrcBubble";
import { useSessionUi } from "../state";
import { ircThreadKey, isRailTool, ItemRow } from "../transcript/rows";
import { TRANSCRIPT_MAX_WIDTH, TranscriptLog } from "../transcript/Transcript";
import { SubagentMeters } from "./SubagentMeters";
import { mergeSnapshot, type Snapshot } from "./snapshot";
import { SUB_LABEL, SUB_STATUS } from "./Subagents";
import { SubagentRetry } from "../resume/SubagentRetry";

/** How often a running subagent's transcript is re-fetched while the viewer is open and visible. */
const POLL_MS = 2000;
/** How long the "Sent" confirmation stays in the composer. */
const SENT_MS = 2600;

/**
 * A subagent's live transcript, stats and controls: a full-height drawer on the right on desktop,
 * a full-screen sheet on phones. `[` / `]` step through the parent's subagents, Esc closes.
 *
 * Mount once per session (SessionPane does); open it with `useSessionUi().openSubagent(key, id)`
 * from anywhere (task cards, IRC bubbles, the inspector), so it outlives the virtualised row that
 * opened it. Opening another subagent while it is open switches it.
 */
export function SubagentViewer({ agentKey }: { agentKey: string }) {
  const mobile = useIsMobile();
  const { meta } = useSession(agentKey);
  const open = useSessionUi((s) => s.subagent[agentKey]);
  const openId = open?.id ?? null;
  const all = meta?.subagents ?? [];
  // The parent's full list when it knows this subagent; else the opener's (e.g. a task card in an old transcript).
  const subs = openId != null && !all.some((s) => s.id === openId) && open?.subs ? open.subs : all;
  const index = openId == null ? -1 : subs.findIndex((s) => s.id === openId);
  const sub = subs[index];
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const prev = subs[index - 1];
  const next = subs[index + 1];
  const show = (id: string) => useSessionUi.getState().openSubagent(agentKey, id);

  // Leaving the session closes its viewer (coming back doesn't reopen it).
  useEffect(() => () => useSessionUi.getState().closeSubagent(agentKey), [agentKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target;
    if (e.defaultPrevented || (t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = e.key === "[" ? prev : e.key === "]" ? next : undefined;
    if (!to) return;
    e.preventDefault();
    show(to.id);
  };

  return (
    <RadixDialog.Root open={sub != null} onOpenChange={(o) => !o && useSessionUi.getState().closeSubagent(agentKey)}>
      <AnimatePresence>
        {sub && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-overlay bg-[rgb(8_8_12/0.55)] backdrop-blur-[3px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.base}
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content
              asChild
              forceMount
              // Focus the panel itself: the composer would pop the phone keyboard and swallow `[` / `]`.
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                panel.current?.focus({ preventScroll: true });
              }}
              // No Radix trigger to return to: give focus back to whatever opened the viewer (a subagent card).
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
                opener.current = null;
              }}
              // Esc in a composer holding a draft leaves the field instead of closing (and losing the draft).
              onEscapeKeyDown={(e) => {
                const el = document.activeElement;
                if (el instanceof HTMLTextAreaElement && el.value.trim()) {
                  e.preventDefault();
                  panel.current?.focus({ preventScroll: true });
                }
              }}
              onKeyDown={onKeyDown}
            >
              <motion.div
                ref={panel}
                tabIndex={-1}
                data-status={SUB_STATUS[sub.status]}
                className={cn(
                  "fixed z-modal flex flex-col overflow-hidden outline-none",
                  mobile
                    ? "inset-x-0 top-0 bottom-[var(--kb-inset,0px)] bg-[linear-gradient(180deg,#1d1d28,#141419)] pt-[env(safe-area-inset-top)]"
                    : "inset-y-3 right-3 w-[min(calc(100vw-24px),max(760px,60vw),1280px)] rounded-[28px] bg-[linear-gradient(180deg,#1f1f2b,#16161e)] shadow-[var(--shadow-d3),0_0_0_1px_rgb(255_255_255/0.08)]",
                )}
                initial={mobile ? { y: "100%" } : { x: "calc(100% + 24px)" }}
                animate={mobile ? { y: 0 } : { x: 0 }}
                exit={mobile ? { y: "100%" } : { x: "calc(100% + 24px)" }}
                transition={spring.sheet}
              >
                <SubagentPanel
                  key={sub.id}
                  agentKey={agentKey}
                  sub={sub}
                  mobile={mobile}
                  position={subs.length > 1 ? { index, count: subs.length } : null}
                  onPrev={prev ? () => show(prev.id) : undefined}
                  onNext={next ? () => show(next.id) : undefined}
                />
              </motion.div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

interface PanelProps {
  agentKey: string;
  sub: Subagent;
  mobile: boolean;
  position: { index: number; count: number } | null;
  onPrev?: () => void;
  onNext?: () => void;
}

function SubagentPanel({ agentKey, sub, mobile, position, onPrev, onNext }: PanelProps) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const running = sub.status === "running";
  const { snap, error, refresh } = useSubagentTranscript(hostId, agentId, sub.id, running);
  // Bumped on every sent message: the transcript jumps back to (and follows) the bottom.
  const [follow, setFollow] = useState(0);
  const [acting, runAct] = usePending();
  const blocked = !agent ? "The parent agent isn't available" : agent.omp && agent.omp.link !== "live" ? "Not connected to the parent session" : null;

  const act = async (action: "kill" | "revive") => {
    const res = await runAct(
      hostCall(hostId, "agent.subagent", { agentId, subagentId: sub.id, action }, { success: action === "kill" ? `Killed ${sub.name}` : `Revived ${sub.name}`, failure: action === "kill" ? `Couldn't kill ${sub.name}` : `Couldn't revive ${sub.name}` }),
    );
    if (res.ok) refresh();
  };

  return (
    <SessionCtx.Provider value={{ hostId, agentId, key: agentKey }}>
      <Header sub={sub} mobile={mobile} position={position} onPrev={onPrev} onNext={onNext} acting={acting} blocked={blocked} onAct={(a) => void act(a)} extra={<SubagentRetry agentKey={agentKey} sub={sub} blocked={blocked} onDone={refresh} />} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {error && snap && (
          <div role="status" className="absolute inset-x-0 top-2 z-raised mx-auto flex w-fit items-center gap-2 rounded-full glass-blur px-3 py-1.5 text-2xs font-semibold text-warn shadow-d2">
            <RefreshCw className="size-3" />
            Couldn't refresh: {error}
          </div>
        )}
        {error && !snap ? (
          <EmptyState
            className="my-auto"
            icon={<MessageSquareDashed />}
            title="Transcript unavailable"
            description={error}
            action={
              <Button size="sm" icon={<RefreshCw />} onClick={refresh}>
                Retry
              </Button>
            }
          />
        ) : (
          // IRC bubbles in this transcript are written from the subagent's side ("peer → <subagent>").
          <IrcSelfCtx.Provider value={sub.name}>
            <SubTranscript sub={sub} snap={snap} mobile={mobile} followSignal={follow} />
          </IrcSelfCtx.Provider>
        )}
      </div>
      <SteerComposer
        agentKey={agentKey}
        sub={sub}
        mobile={mobile}
        blocked={blocked}
        onSent={() => {
          setFollow((n) => n + 1);
          refresh();
        }}
      />
    </SessionCtx.Provider>
  );
}

// ------------------------------------------------------------------ header

interface HeaderProps {
  sub: Subagent;
  mobile: boolean;
  position: PanelProps["position"];
  onPrev?: () => void;
  onNext?: () => void;
  acting: boolean;
  blocked: string | null;
  onAct: (action: "kill" | "revive") => void;
  /** Extra actions before Kill / Revive (Retry of a failed or stopped subagent). */
  extra?: ReactNode;
}

function Header({ sub, mobile, position, onPrev, onNext, acting, blocked, onAct, extra }: HeaderProps) {
  const running = sub.status === "running";
  const status = SUB_STATUS[sub.status];
  const activity = running ? "busy" : "silent";
  const elapsed = sub.startedAt == null ? null : running ? <Elapsed since={sub.startedAt} /> : formatElapsed((sub.endedAt ?? sub.startedAt) - sub.startedAt);
  const action = running ? (
    <Button size="sm" variant="danger" icon={<Skull />} onClick={() => onAct("kill")} loading={acting} disabled={!!blocked} title={blocked ?? `Stop ${sub.name}`}>
      Kill
    </Button>
  ) : (
    <Button size="sm" icon={<RotateCcw />} onClick={() => onAct("revive")} loading={acting} disabled={!!blocked} title={blocked ?? `Restart ${sub.name}`}>
      Revive
    </Button>
  );
  const stats: { key: string; label: string; value: string }[] = [];
  if (sub.tokens != null) stats.push({ key: "tok", label: "tokens", value: formatCompact(sub.tokens) });
  if (sub.toolCount != null) stats.push({ key: "tools", label: sub.toolCount === 1 ? "tool call" : "tool calls", value: String(sub.toolCount) });
  if (sub.costUsd != null) stats.push({ key: "cost", label: "cost", value: formatUsd(sub.costUsd) });

  return (
    <header className={cn("relative shrink-0 border-b border-line", mobile ? "px-3 pt-1.5 pb-3" : "px-6 pt-5 pb-4")}>
      {running && <span className="tf-loop live-gradient absolute inset-x-0 top-0 h-[2px] opacity-80" aria-hidden />}
      <div className="flex min-w-0 items-center gap-2">
        {mobile && (
          <RadixDialog.Close asChild>
            <IconButton label="Close" size="md" className="-ml-1">
              <ChevronDown />
            </IconButton>
          </RadixDialog.Close>
        )}
        <StatusOrb status={status} activity={activity} size={10} label={null} className="shrink-0" />
        <RadixDialog.Title className={cn("min-w-0 truncate font-display font-bold tracking-[-0.02em] text-ink", mobile ? "text-[17px]" : "text-[21px]")}>{sub.name}</RadixDialog.Title>
        {/* Phones keep the title readable: the orb carries the status there. */}
        {!mobile && (
          <StatusPill status={status} activity={activity} size="sm">
            {SUB_LABEL[sub.status]}
          </StatusPill>
        )}
        {elapsed != null && <span className="shrink-0 text-xs font-bold text-mute tabular">{elapsed}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {position && (
            <span className="mr-1 flex items-center gap-0.5" role="group" aria-label="Subagents">
              <Tooltip content="Previous subagent" shortcut="[">
                <IconButton label="Previous subagent" size={mobile ? "md" : "sm"} onClick={onPrev} disabled={!onPrev}>
                  <ChevronLeft />
                </IconButton>
              </Tooltip>
              <span className="min-w-9 text-center text-2xs font-bold text-mute-2 tabular" aria-live="polite">
                {position.index + 1}/{position.count}
              </span>
              <Tooltip content="Next subagent" shortcut="]">
                <IconButton label="Next subagent" size={mobile ? "md" : "sm"} onClick={onNext} disabled={!onNext}>
                  <ChevronRight />
                </IconButton>
              </Tooltip>
            </span>
          )}
          {!mobile && extra}
          {!mobile && action}
          {!mobile && (
            <Tooltip content="Close" shortcut="Esc">
              <RadixDialog.Close asChild>
                <IconButton label="Close" size="sm" className="ml-1">
                  <X />
                </IconButton>
              </RadixDialog.Close>
            </Tooltip>
          )}
        </span>
      </div>
      <RadixDialog.Description className="sr-only">Transcript and controls of the subagent {sub.name}</RadixDialog.Description>
      {sub.description && <Description key={sub.description} text={sub.description} />}
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-mute", mobile ? "mt-2" : "mt-3")}>
        {sub.model && <span className="max-w-full truncate rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-ink-2 shadow-hairline">{sub.model}</span>}
        {stats.map((s) => (
          <span key={s.key} className="whitespace-nowrap">
            <b className="font-bold text-ink-2 tabular">{s.value}</b> {s.label}
          </span>
        ))}
        <SubagentMeters sub={sub} size="md" />
        {mobile && (
          <span className="ml-auto flex items-center gap-1.5">
            {extra}
            {action}
          </span>
        )}
      </div>
    </header>
  );
}

/** Task description: two lines, expandable when longer. */
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);
  return (
    <div className="mt-1.5 flex items-end gap-2">
      <p ref={ref} className={cn("min-w-0 flex-1 text-[13px] leading-[1.45] whitespace-pre-wrap text-ink-2", expanded ? "max-h-[30dvh] overflow-y-auto" : "line-clamp-2")}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="focus-ring shrink-0 rounded-xs text-2xs font-bold text-accent-hi hover:text-ink">
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ transcript

/** Fetches the transcript while mounted (= the viewer is open); polls while the subagent runs and the window is visible. */
function useSubagentTranscript(hostId: string, agentId: string, subagentId: string, running: boolean) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // `nonce` (from `refresh`) re-runs the fetch on demand.
  useEffect(() => {
    let alive = true;
    let inflight = false;
    const load = () => {
      if (inflight || document.visibilityState === "hidden") return;
      inflight = true;
      core
        .host(hostId)
        .call("session.subagentTranscript", { agentId, subagentId })
        .then((page) => {
          if (!alive) return;
          setSnap((prev) => mergeSnapshot(prev, page.items));
          setError(null);
        })
        .catch((e: unknown) => alive && setError(errorText(e).title))
        .finally(() => (inflight = false));
    };
    load();
    if (!running) return () => void (alive = false);
    const timer = window.setInterval(load, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hostId, agentId, subagentId, running, nonce]);

  return { snap, error, refresh };
}

const EMPTY_SNAPSHOT: Snapshot = { ids: [], byId: new Map() };

function SubTranscript({ sub, snap, mobile, followSignal }: { sub: Subagent; snap: Snapshot | null; mobile: boolean; followSignal: number }) {
  const running = sub.status === "running";
  const { ids, byId } = snap ?? EMPTY_SNAPSHOT;
  const items = useMemo(() => ids.map((id) => byId.get(id)), [ids, byId]);
  const last = byId.get(ids[ids.length - 1] ?? "");
  const lastLive = last != null && ((last.kind === "assistant" && last.streaming) || (last.kind === "thinking" && last.streaming) || (last.kind === "tool" && (last.status === "running" || last.status === "pending")));
  return (
    <TranscriptLog
      ids={ids}
      items={items}
      loading={snap == null}
      ariaLabel={`${sub.name} transcript`}
      followSignal={followSignal}
      padX={mobile ? 10 : 24}
      gutter={mobile ? 0 : 38}
      overscan={mobile ? 3 : 8}
      dense={mobile}
      renderRow={(id, prevId, nextId, rail) => {
        const item = byId.get(id);
        if (!item) return null;
        const prev = prevId == null ? undefined : byId.get(prevId);
        const next = nextId == null ? undefined : byId.get(nextId);
        const irc = ircThreadKey(item);
        return (
          <ItemRow
            item={item}
            rail={rail}
            up={rail && isRailTool(prev)}
            down={rail && isRailTool(next)}
            ircPrev={irc != null && ircThreadKey(prev) === irc}
            ircNext={irc != null && ircThreadKey(next) === irc}
          />
        );
      }}
      empty={
        <EmptyState
          className="mt-16"
          icon={<MessageSquareDashed />}
          title={running ? "Starting up" : "No transcript"}
          description={running ? `${sub.name} hasn't written anything yet; its messages and tool calls appear here as they happen.` : `${sub.name} didn't record any messages.`}
        />
      }
      footer={running && snap != null && !lastLive ? <WorkingFooter sub={sub} /> : null}
      jumpLabel={(unseen) => (
        <>
          {running && <StatusOrb status="running" activity="busy" size={7} label={null} />}
          {unseen > 0 ? `${unseen} new` : running ? "Streaming" : "Jump to latest"}
        </>
      )}
    />
  );
}

/** Heartbeat under the last row while the subagent works without visible output (same as the session's). */
function WorkingFooter({ sub }: { sub: Subagent }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex min-w-0 items-center gap-2.5 pt-3 pl-[var(--tf-gutter,38px)] text-xs font-semibold text-mute" aria-live="polite">
      <span data-status="running" className="relative grid size-5 shrink-0 place-items-center">
        <span className="tf-loop absolute inset-0 animate-breathe rounded-full bg-accent/25 [--tf-breath:2.8s]" />
        <StatusOrb status="running" activity="calm" size={8} label={null} />
      </span>
      <Shimmer className="min-w-0 truncate">{sub.line ? sub.line : "Working…"}</Shimmer>
      {sub.startedAt != null && <Elapsed since={sub.startedAt} className="shrink-0 text-mute-2 tabular" />}
    </motion.div>
  );
}

// ------------------------------------------------------------------ composer

function SteerComposer({ agentKey, sub, mobile, blocked, onSent }: { agentKey: string; sub: Subagent; mobile: boolean; blocked: string | null; onSent: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const key = draftKey("subagent.message", agentKey, sub.id);
  const [text, setText] = useDraft(key);
  const [sending, run] = usePending();
  const [sent, setSent] = useState(0);
  const running = sub.status === "running";
  const hasText = text.trim().length > 0;

  useEffect(() => {
    if (!sent) return;
    const t = window.setTimeout(() => setSent(0), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending || blocked) return;
    const res = await run(hostCall(hostId, "agent.subagent", { agentId, subagentId: sub.id, action: "chat", message }, { failure: `Couldn't message ${sub.name}` }));
    if (!res.ok) return;
    // Only what was sent: anything typed while sending stays in the draft.
    const cur = drafts.get(key);
    drafts.set(key, cur.startsWith(text) ? cur.slice(text.length).trimStart() : cur);
    setSent(Date.now());
    onSent();
  };

  const status = blocked ? (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold text-mute-2">
      <Lock className="size-3 shrink-0" />
      {blocked}
    </span>
  ) : sending ? (
    <Shimmer className="text-[11px] font-semibold text-mute">Sending to {sub.name}…</Shimmer>
  ) : sent ? (
    <motion.span initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} className="flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-done" role="status">
      <Check className="size-3.5 shrink-0" />
      {running ? `Steered ${sub.name}: lands mid-turn` : `Sent to ${sub.name}`}
    </motion.span>
  ) : mobile ? null : (
    <span className="flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold text-mute-2">
      <span className={cn("flex items-center gap-1", running && "text-accent-hi")}>
        <Kbd>Enter</Kbd>
        {running ? "steer" : "send"}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Shift</Kbd>
        <Kbd>Enter</Kbd>
        newline
      </span>
      <span className="hidden items-center gap-1 lg:flex">
        <Kbd>[</Kbd>
        <Kbd>]</Kbd>
        subagents
      </span>
    </span>
  );

  return (
    <div className={cn("shrink-0", mobile ? "px-2.5 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]" : "px-6 pt-2 pb-5 [@media(max-height:720px)]:pb-3")}>
      <div className="mx-auto w-full" style={{ maxWidth: TRANSCRIPT_MAX_WIDTH }}>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            // Desktop: Enter sends, Shift+Enter is a newline. Phone (like the session composer): Enter is a
            // newline and the button sends, or Ctrl/Meta+Enter from a hardware keyboard.
            if (mobile ? e.ctrlKey || e.metaKey : !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={blocked ? "Messaging is unavailable" : running ? `Steer ${sub.name}…` : `Message ${sub.name}…`}
          aria-label={running ? `Steer ${sub.name}` : `Message ${sub.name}`}
          disabled={!!blocked}
          enterKeyHint={mobile ? "enter" : undefined}
          maxHeight={mobile ? 140 : 220}
          boxClassName={cn("rounded-[22px] glass px-4 py-3", mobile ? "py-2 pr-2 pl-4 [&>div]:mt-1.5" : "[@media(max-height:720px)]:py-2", !!blocked && "opacity-80")}
          className={cn("text-[14px]", mobile && "min-h-[1lh] text-[15px]")}
          footer={
            <>
              {status}
              <span className="ml-auto flex shrink-0 items-center">
                <IconButton
                  label={`${running ? "Steer" : "Send"}${mobile ? "" : " (Enter)"}`}
                  size={mobile ? "lg" : "sm"}
                  variant="primary"
                  onClick={() => void send()}
                  disabled={!hasText || sending || !!blocked}
                >
                  {sending ? <Spinner size={14} /> : running ? <CornerDownRight /> : <ArrowUp />}
                </IconButton>
              </span>
            </>
          }
        />
      </div>
    </div>
  );
}
