import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpFromLine,
  Check,
  CircleCheckBig,
  CircleDot,
  ExternalLink,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  type LucideIcon,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { agentKey, core, draftKey, drafts, navigate, openSession, suggestCommitMessage, suggestPullRequest, useAgent, useAiNaming, useCore, useDraft, useSession, useUi } from "@/core";
import type { Agent, ChangedFile, GitDiffResult, GitStatusResult, MergeMethod, PrInfo, PrStatusResult, Workspace } from "@/core/gen";
import { Badge, Button, Input, Kbd, SegmentedControl, Shimmer, Spinner, Switch, Textarea, Tooltip, cn, spring, toast } from "@/design";
import { archiveWithUndo, markDoneAndRemove } from "@/features/board/agentActions";
import { Term } from "@/features/shell/Term";
import { ACTIONS } from "@/features/shell/vocab";
import { removeWorktree } from "../workspace/workspaceActions";
import { AiMark, SuggestButton } from "../workspace/shared/ai";
import { describeError } from "../workspace/shared/errors";
import { type HostQuery, useHostQuery } from "../workspace/shared/useHostQuery";
import { fileList, patchExcerpt } from "./diff/excerpt";
import { prNext } from "./fix";
import { FixActions } from "./FixPanel";

const COMMIT_PROMPT = [
  "Write a git commit message for the current uncommitted changes in this worktree (look at `git status` and `git diff`).",
  "Reply with ONLY the message inside a single ```text fenced block: a conventional-commit subject line of at most 72 characters, a blank line, then a short body.",
  "Do not run git commit yourself.",
].join(" ");

/** Extract the commit message from the agent's reply: the first fenced block, else the whole text. */
function extractMessage(text: string): string {
  const fence = text.match(/```[\w-]*\n([\s\S]*?)```/);
  return (fence?.[1] ?? text).trim();
}

export const SHIP_STAGES: readonly { icon: LucideIcon; label: string }[] = [
  { icon: GitCommitHorizontal, label: "Commit" },
  { icon: ArrowUpFromLine, label: "Push" },
  { icon: GitPullRequest, label: "PR" },
  { icon: GitMerge, label: "Merge" },
  { icon: CircleCheckBig, label: "Done" },
];

export interface ShipState {
  /** Index into SHIP_STAGES of the first step not yet satisfied. */
  stage: number;
  dirty: boolean;
  unpushed: boolean;
  merged: boolean;
  /** Why the current step can't proceed here (e.g. no PR from the default branch). */
  blocked?: string;
  /** One-line "what's next" for compact surfaces (header button, mobile bar). */
  next: string;
}

/** Where a worktree is in commit → push → PR → merge → done. */
export function shipState(status: GitStatusResult, pr: PrInfo | undefined): ShipState {
  const dirty = status.files.length > 0;
  const unpushed = status.ahead > 0 || (!status.upstream && !!status.branch && status.branch !== status.defaultBranch);
  const merged = pr?.state === "MERGED";
  const onDefault = !!status.branch && status.branch === status.defaultBranch;
  // An open PR with new local commits still needs commit/push first.
  const stage = merged ? 4 : dirty ? 0 : unpushed ? 1 : !pr ? 2 : 3;
  const n = status.files.length;
  const blocked = stage === 2 && onDefault ? `On ${status.branch}: pull requests need a feature branch` : undefined;
  const next = [
    `Commit ${n} file${n === 1 ? "" : "s"}`,
    status.ahead > 0 ? `Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"}` : `Push ${status.branch ?? "branch"}`,
    blocked ? "Nothing to ship" : "Open PR",
    pr ? prNext(pr) : "Merge",
    `Merged · ${ACTIONS.markDone.label}`,
  ][stage] as string;
  return { stage, dirty, unpushed, merged, blocked, next };
}

/** PR status for a worktree, polled while it's open (checks and mergeability change server-side). */
export function usePrStatus(hostId: string, cwd: string | undefined): HostQuery<PrStatusResult> {
  const pr = useHostQuery(hostId, "gh.prStatus", cwd ? { cwd } : null);
  const info = pr.data?.pr;
  const pending = !!info && info.state === "OPEN" && ((info.checks?.pending ?? 0) > 0 || info.mergeable === undefined);
  const open = info?.state === "OPEN";
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(pr.reload, pending ? 4000 : 15000);
    return () => window.clearInterval(id);
  }, [open, pending, pr.reload]);
  return pr;
}

export interface ShipPanelProps {
  hostId: string;
  workspace: Workspace;
  cwd: string;
  status: GitStatusResult;
  /** From `usePrStatus` (owned by the review view so collapsed surfaces stay current). */
  pr: HostQuery<PrStatusResult>;
  agents: Agent[];
  /** The loaded diff against the base (the AI drafts read a bounded excerpt of it). */
  diff?: GitDiffResult;
  /** Scroll to (and focus the field of) this stage; a new `nonce` re-applies it. */
  focus?: { stage: number; nonce: number };
  /** Re-fetch git status + diff after a mutation. */
  onChanged: () => void;
}

/** Commit → push → PR → checks → merge → done, as one pipeline whose current stage glows. */
export function ShipPanel({ hostId, workspace, cwd, status, pr, agents, diff, focus, onChanged }: ShipPanelProps) {
  const [lastCommit, setLastCommit] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const info = pr.data?.pr;
  const st = shipState(status, info);
  const { stage, dirty, unpushed, merged } = st;
  const prBlocked = dirty ? `Commit ${status.files.length === 1 ? "the change" : `${status.files.length} files`} first` : unpushed ? `Push ${status.branch ?? "the branch"} first` : st.blocked;

  useEffect(() => {
    if (!focus) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-ship-stage="${focus.stage}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.querySelector<HTMLElement>("textarea:not(:disabled), input:not(:disabled)")?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      <ShipStepper stage={stage} blocked={!!st.blocked} />
      <CommitCard
        hostId={hostId}
        cwd={cwd}
        dirty={dirty}
        files={status.files}
        patch={diff?.patch}
        agents={agents}
        onCommitted={(summary) => {
          setLastCommit(summary);
          onChanged();
        }}
        active={stage === 0}
      />
      <PushCard hostId={hostId} cwd={cwd} status={status} unpushed={unpushed} dirty={dirty} onPushed={() => (onChanged(), pr.reload())} active={stage === 1} />
      {info ? (
        <PrCard hostId={hostId} cwd={cwd} workspace={workspace} defaultBranch={status.defaultBranch} pr={info} loading={pr.loading} onMerged={() => (pr.reload(), onChanged())} active={stage === 3} />
      ) : st.blocked && !dirty && !unpushed ? (
        <DefaultBranchCard hostId={hostId} cwd={cwd} reason={st.blocked} />
      ) : (
        <CreatePrCard
          key={lastCommit}
          hostId={hostId}
          cwd={cwd}
          status={status}
          diff={diff}
          lastCommit={lastCommit}
          blockedReason={prBlocked}
          error={pr.error?.message}
          onCreated={pr.reload}
          active={stage === 2}
        />
      )}
      <DoneCard hostId={hostId} workspace={workspace} agents={agents} merged={merged} />
    </div>
  );
}

function StageNode({ index, stage, blocked, size = 28 }: { index: number; stage: number; blocked: boolean; size?: number }) {
  const s = SHIP_STAGES[index];
  if (!s) return null;
  const done = index < stage || (index === 4 && stage === 4);
  const current = index === stage && !done;
  return (
    <span
      className={cn(
        "relative z-raised grid shrink-0 place-items-center rounded-full transition-[background-color,color,box-shadow] duration-500 [&_svg]:size-3.5",
        done && "bg-[color-mix(in_oklab,var(--color-done)_22%,var(--color-tile-2))] text-done",
        current && !blocked && "bg-omp text-white shadow-glow-accent",
        current && blocked && "bg-[color-mix(in_oklab,var(--color-warn)_18%,var(--color-tile-2))] text-warn",
        index > stage && "bg-tile-3 text-mute-2",
      )}
      style={{ width: size, height: size }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={done ? "done" : "todo"} className="grid place-items-center" initial={{ scale: 0.3, opacity: 0, rotate: -30 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} exit={{ scale: 0.3, opacity: 0 }} transition={spring.bouncy}>
          {done ? <Check strokeWidth={3} /> : <s.icon />}
        </motion.span>
      </AnimatePresence>
      {current && !blocked && <span className="tf-loop absolute -inset-1 animate-ping-soft rounded-full shadow-[0_0_0_2px_rgb(163_92_240/0.45)]" aria-hidden />}
    </span>
  );
}

/** Horizontal pipeline with labels; connectors fill as stages complete. `dots` drops the labels. */
export function ShipStepper({ stage, blocked, dots = false }: { stage: number; blocked: boolean; dots?: boolean }) {
  return (
    <ol className="isolate grid grid-cols-5 pt-1.5" aria-label="Ship progress">
      {SHIP_STAGES.map((s, i) => {
        const done = i < stage || (i === 4 && stage === 4);
        return (
          <li
            key={s.label}
            className="relative flex flex-col items-center gap-1.5"
            aria-current={i === stage ? "step" : undefined}
            aria-label={`${s.label}: ${done ? "done" : i === stage ? (blocked ? "blocked" : "next") : "to do"}`}
          >
            {i > 0 && (
              <span className={cn("absolute right-1/2 h-0.5 w-full -translate-y-1/2 overflow-hidden rounded-full bg-white/8", dots ? "top-[11px]" : "top-[14px]")} aria-hidden>
                <motion.span className="block h-full bg-done/70" initial={false} animate={{ width: i <= stage ? "100%" : "0%" }} transition={spring.gentle} />
              </span>
            )}
            <StageNode index={i} stage={stage} blocked={blocked} size={dots ? 22 : 28} />
            {!dots && (
              <span className={cn("text-2xs font-semibold whitespace-nowrap transition-colors duration-500", done ? "text-done/80" : i === stage ? (blocked ? "text-warn" : "font-bold text-ink") : "text-mute-2")}>{s.label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Ship panel closed: every stage with its state on one line under the review title. A stage opens
 * the panel there.
 */
export function ShipStrip({ state, onOpen }: { state: ShipState; onOpen: (stage: number) => void }) {
  const blocked = !!state.blocked;
  return (
    <ol className="isolate flex min-w-0 items-center" aria-label="Ship progress">
      {SHIP_STAGES.map((s, i) => {
        const done = i < state.stage || (i === 4 && state.stage === 4);
        const current = i === state.stage && !done;
        return (
          <li key={s.label} className="flex min-w-0 items-center" aria-current={i === state.stage ? "step" : undefined}>
            {i > 0 && (
              <span className="mx-1 h-0.5 w-4 shrink overflow-hidden rounded-full bg-white/8 @3xl:w-7" aria-hidden>
                <motion.span className="block h-full bg-done/70" initial={false} animate={{ width: i <= state.stage ? "100%" : "0%" }} transition={spring.gentle} />
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpen(i)}
              title={`Open the ship panel at ${s.label}`}
              aria-label={`${s.label}: ${done ? "done" : current ? (blocked ? "blocked" : "next") : "to do"}. Open the ship panel there`}
              className="flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 transition-colors focus-ring hover:bg-white/[0.06]"
            >
              <StageNode index={i} stage={state.stage} blocked={blocked} size={22} />
              <span className={cn("text-2xs font-semibold whitespace-nowrap transition-colors duration-500", done ? "text-done/80" : current ? (blocked ? "text-warn" : "font-bold text-ink") : "text-mute-2")}>{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Section({ icon, title, meta, active, done, stage, children }: { icon: ReactNode; title: string; meta?: ReactNode; active: boolean; done?: boolean; stage: number; children?: ReactNode }) {
  return (
    <motion.section
      layout="position"
      transition={spring.smooth}
      data-ship-stage={stage}
      className={cn(
        "scroll-my-3 rounded-lg p-3.5 transition-[background-color,box-shadow] duration-500",
        active ? "bg-accent/[0.07] shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4),0_0_30px_-12px_rgb(163_92_240/0.6)]" : "bg-white/[0.03] shadow-hairline",
      )}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm [&_svg]:size-3.5", done ? "bg-done/15 text-done" : active ? "bg-omp text-white" : "bg-tile-3 text-mute")}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={done ? "done" : "todo"} className="grid place-items-center" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }} transition={spring.bouncy}>
              {done ? <Check strokeWidth={3} /> : icon}
            </motion.span>
          </AnimatePresence>
        </span>
        <h3 className="shrink-0 font-display text-sm font-bold">{title}</h3>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-2xs text-mute">{meta}</span>
      </header>
      {children && <div className="mt-3">{children}</div>}
    </motion.section>
  );
}

/** On the default branch with nothing local: there's no PR to open from here. */
function DefaultBranchCard({ hostId, cwd, reason }: { hostId: string; cwd: string; reason: string }) {
  const ui = useUi();
  return (
    <Section icon={<TriangleAlert />} title="Nothing to ship" active={false} stage={2}>
      <div className="flex flex-col gap-2.5">
        <p className="text-xs text-mute">{reason}. Start a worktree to ship changes through a pull request.</p>
        <Button size="sm" icon={<GitBranchPlus />} onClick={() => ui.openDialog({ kind: "newWorktree", hostId, cwd })} className="self-start">
          New worktree
        </Button>
      </div>
    </Section>
  );
}

function CommitCard({ hostId, cwd, dirty, files, patch, agents, onCommitted, active }: { hostId: string; cwd: string; dirty: boolean; files: ChangedFile[]; patch?: string; agents: Agent[]; onCommitted: (summary: string) => void; active: boolean }) {
  const msgKey = draftKey("review.commit", hostId, cwd);
  const [message, setMessage, clearMessage] = useDraft(msgKey);
  /** The message when ✨ was clicked: the draft only replaces it if the user hasn't typed since. */
  const writeFrom = useRef("");
  const [all, setAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ agentId: string; afterId: string | null } | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const ai = useAiNaming(hostId);
  const omp = agents.find((a) => a.kind === "omp");
  const fileCount = files.length;
  const aiMade = aiMessage !== null && message === aiMessage;

  /** Drafts the message from the uncommitted files and their part of the loaded diff; never commits. */
  const writeIt = async (): Promise<string | null> => {
    writeFrom.current = message;
    const excerpt = patch ? patchExcerpt(patch, undefined, new Set(files.map((f) => f.path))) : "";
    const hint = message.trim() && !aiMade ? message.trim() : undefined;
    const r = await suggestCommitMessage(hostId, { files: fileList(files), patch: excerpt || undefined, hint }, { cwd });
    if (!r) return null;
    const body = r.body?.trim();
    return body ? `${r.subject}\n\n${body}` : r.subject;
  };

  const commit = async () => {
    setBusy(true);
    try {
      const r = await core.host(hostId).call("git.commit", { cwd, message: message.trim(), all });
      toast({ title: `Committed ${r.sha.slice(0, 7)}`, description: r.summary, status: "done", duration: 3500 });
      clearMessage();
      onCommitted(r.summary);
    } catch (e) {
      const d = describeError(e);
      toast({ title: "Commit failed", description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!dirty) {
    return <Section icon={<GitCommitHorizontal />} title="Everything committed" active={false} done meta="working tree clean" stage={0} />;
  }
  return (
    <Section icon={<GitCommitHorizontal />} title="Commit" active={active} meta={`${fileCount} file${fileCount === 1 ? "" : "s"} changed`} stage={0}>
      <div className="flex flex-col gap-2.5">
        <div className="relative">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={"feat: describe the change\n\nWhy it was needed, in a sentence or two."}
            className="min-h-[4lh] font-mono text-xs"
            maxHeight={220}
            aria-label="Commit message"
            disabled={!!asking}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && message.trim()) {
                e.preventDefault();
                void commit();
              }
            }}
          />
          {asking && <AgentWriter hostId={hostId} agentId={asking.agentId} afterId={asking.afterId} onDone={(m) => (setMessage(m), setAsking(null))} onCancel={() => setAsking(null)} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-mute">
            <Switch checked={all} onCheckedChange={setAll} label="Stage all changes" />
            Stage all
          </label>
          <span className="flex-1" />
          {omp && (
            <AskAgentButton
              hostId={hostId}
              agent={omp}
              disabled={!!asking}
              onAsked={(afterId) => setAsking({ agentId: omp.id, afterId })}
            />
          )}
          {ai && (
            <SuggestButton
              run={writeIt}
              onValue={(v) => {
                if (drafts.get(msgKey) !== writeFrom.current) return;
                setMessage(v);
                setAiMessage(v);
              }}
              label="Write it"
              title="Draft the message with omp's tiny model (edit it before you commit)"
              disabled={!!asking}
              variant="secondary"
            />
          )}
          <Button variant="primary" size="sm" icon={<GitCommitHorizontal />} onClick={() => void commit()} loading={busy} disabled={!message.trim() || !!asking}>
            Commit
          </Button>
        </div>
        {!asking && (
          <p className="-mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-2xs text-mute-2">
            {aiMade && (
              <span className="mr-auto flex items-center gap-1 whitespace-nowrap">
                <AiMark /> Drafted by the <Term id="tinyModel">tiny model</Term>
              </span>
            )}
            {message.trim() ? (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd> to commit
              </span>
            ) : (
              `${orList(["Write a message", omp && `ask ${omp.name}`, ai && "let the tiny model write it"])} to commit`
            )}
          </p>
        )}
      </div>
    </Section>
  );
}

/** "a, b, or c" (falsy items dropped). */
function orList(items: readonly (string | false | undefined)[]): string {
  const xs = items.filter((x): x is string => !!x);
  return xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")}, or ${xs[xs.length - 1]}`;
}

/** Sends the commit-message prompt; reports the last transcript row at send time (replies come after it). */
function AskAgentButton({ hostId, agent, disabled, onAsked }: { hostId: string; agent: Agent; disabled: boolean; onAsked: (afterId: string | null) => void }) {
  const key = agentKey(hostId, agent.id);
  const session = useSession(key);
  const [busy, setBusy] = useState(false);
  useEffect(() => openSession(key), [key]);
  return (
    <Button
      size="sm"
      icon={<Sparkles />}
      loading={busy}
      disabled={disabled || agent.column === "running" || agent.column === "needs"}
      title={agent.column === "running" ? `${agent.name} is busy` : `Ask ${agent.name} to write the message`}
      onClick={async () => {
        setBusy(true);
        try {
          const afterId = session.itemIds[session.itemIds.length - 1] ?? null;
          await core.host(hostId).call("agent.prompt", { agentId: agent.id, text: COMMIT_PROMPT, images: [], delivery: "auto" });
          onAsked(afterId);
        } catch (e) {
          toast({ title: `Couldn't ask ${agent.name}`, description: describeError(e).title, status: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      {agent.column === "running" ? `${agent.name} is working…` : agent.column === "needs" ? `${agent.name} needs you` : `Ask ${agent.name} to write it`}
    </Button>
  );
}

/** Overlay on the message box while the agent writes; fills the box when its reply settles. */
function AgentWriter({ hostId, agentId, afterId, onDone, onCancel }: { hostId: string; agentId: string; afterId: string | null; onDone: (msg: string) => void; onCancel: () => void }) {
  const key = agentKey(hostId, agentId);
  const agent = useAgent(key);
  useEffect(() => openSession(key), [key]);
  // Latest assistant row after the prompt (a turn may end on a tool row, so don't just take the last row).
  const reply = useCore((s) => {
    const e = s.sessions[key];
    if (!e) return undefined;
    const start = afterId ? e.itemIds.indexOf(afterId) + 1 : 0;
    for (let i = e.itemIds.length - 1; i >= start; i--) {
      const it = e.items[e.itemIds[i] ?? ""];
      if (it?.kind === "assistant") return it;
    }
    return undefined;
  });
  const idle = agent?.column === "review" || agent?.column === "done";
  const finished = !!reply && !reply.streaming && idle;
  const doneRef = useRef(false);
  useEffect(() => {
    if (finished && reply && !doneRef.current) {
      doneRef.current = true;
      onDone(extractMessage(reply.text));
    }
  }, [finished, reply, onDone]);
  const asking = agent?.column === "needs";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col justify-between overflow-hidden rounded-md bg-bg-deep/92 p-3 shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.6)] backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <span className="tf-loop pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-gradient-pan bg-omp bg-[length:200%_100%]" aria-hidden />
      <pre className="min-h-0 overflow-hidden font-mono text-xs whitespace-pre-wrap text-ink-2">{reply ? extractMessage(reply.text) : ""}</pre>
      <div className="flex items-center gap-2">
        <Spinner size={13} />
        <Shimmer className="flex-1 truncate text-xs font-semibold">
          {asking ? `${agent?.name} is asking you something` : (agent?.live.line ?? (reply ? "Writing…" : `${agent?.name ?? "Agent"} is reading the diff…`))}
        </Shimmer>
        {asking && (
          <Button size="sm" variant="sunset" onClick={() => navigate({ name: "agent", hostId, agentId })}>
            Answer
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<X />} onClick={onCancel}>
          Stop waiting
        </Button>
      </div>
    </motion.div>
  );
}

function PushCard({ hostId, cwd, status, unpushed, dirty, onPushed, active }: { hostId: string; cwd: string; status: GitStatusResult; unpushed: boolean; dirty: boolean; onPushed: () => void; active: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const push = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await core.host(hostId).call("git.push", { cwd });
      if (out.code !== 0) setErr(out.stderr.trim() || out.stdout.trim() || `git push exited ${out.code}`);
      else {
        toast({ title: `Pushed ${status.branch ?? "branch"}`, description: status.upstream ?? "upstream set", status: "done", duration: 3000 });
        onPushed();
      }
    } catch (e) {
      setErr(describeError(e).title);
    } finally {
      setBusy(false);
    }
  };
  if (!unpushed) {
    return <Section icon={<ArrowUpFromLine />} title="Pushed" done active={false} meta={status.upstream ?? "up to date"} stage={1} />;
  }
  return (
    <Section
      icon={<ArrowUpFromLine />}
      title="Push"
      active={active}
      stage={1}
      meta={status.upstream ? `${status.ahead} ahead${status.behind ? ` · ${status.behind} behind` : ""} of ${status.upstream}` : "no upstream yet"}
    >
      <div className="flex flex-col gap-2">
        {err && <pre className="max-h-32 overflow-auto rounded-sm bg-error/10 p-2 font-mono text-2xs whitespace-pre-wrap text-[#ffb1c1]">{err}</pre>}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-mute">{dirty ? "Uncommitted changes stay local." : status.upstream ? "" : "Sets the upstream on first push."}</span>
          <Button size="sm" variant={active ? "primary" : "secondary"} icon={<ArrowUpFromLine />} onClick={() => void push()} loading={busy}>
            Push {status.branch}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function CreatePrCard({ hostId, cwd, status, diff, lastCommit, blockedReason, error, onCreated, active }: { hostId: string; cwd: string; status: GitStatusResult; diff?: GitDiffResult; lastCommit?: string; blockedReason?: string; error?: string; onCreated: () => void; active: boolean }) {
  const humanBranch = (status.branch ?? "").replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ");
  const branch = status.branch ?? "";
  const titleKey = draftKey("review.prTitle", hostId, cwd, branch);
  const bodyKey = draftKey("review.prBody", hostId, cwd, branch);
  const titleInitial = lastCommit ?? (humanBranch ? humanBranch[0]?.toUpperCase() + humanBranch.slice(1) : "");
  const [title, setTitle, clearTitle] = useDraft(titleKey, titleInitial);
  const [body, setBody, clearBody] = useDraft(bodyKey);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const ai = useAiNaming(hostId);
  const [aiPr, setAiPr] = useState<{ title: string; body: string } | null>(null);
  const aiMade = !!aiPr && (title === aiPr.title || body === aiPr.body);
  /** Fields when ✨ was clicked + the answer: each field is filled only if the user hasn't edited it since. */
  const pending = useRef<{ title: string; body: string; pr?: { title: string; body: string } }>(null);
  /** Drafts title + description from the branch's files, commits and a bounded diff excerpt; never creates the PR. */
  const writeIt = async (): Promise<string | null> => {
    const from = { title, body };
    pending.current = from;
    const r = await suggestPullRequest(
      hostId,
      { branch, base: status.defaultBranch ?? diff?.base ?? "", commits: lastCommit ? [lastCommit] : [], files: fileList(diff?.files ?? status.files), patch: diff ? patchExcerpt(diff.patch) || undefined : undefined },
      { cwd },
    );
    if (!r) return null;
    pending.current = { ...from, pr: r };
    return r.title;
  };
  const applyAi = () => {
    const p = pending.current;
    if (!p?.pr) return;
    const titleFree = drafts.get(titleKey, titleInitial) === p.title;
    const bodyFree = drafts.get(bodyKey) === p.body;
    if (titleFree) setTitle(p.pr.title);
    if (bodyFree) setBody(p.pr.body);
    if (titleFree || bodyFree) setAiPr(p.pr);
  };
  const create = async () => {
    setBusy(true);
    try {
      const info = await core.host(hostId).call("gh.prCreate", { cwd, title: title.trim(), body, draft, base: status.defaultBranch });
      toast({ title: `Opened PR #${info.number}`, description: info.title, status: "review", action: { label: "Open on GitHub", onClick: () => void core.app("app.openExternal", { url: info.url }) } });
      clearTitle();
      clearBody();
      onCreated();
    } catch (e) {
      const d = describeError(e);
      toast({ title: "Couldn't create the PR", description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };
  /** Ctrl+Enter creates the PR from either field (multi-field form send key). */
  const onSendKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && title.trim() && !busy) {
      e.preventDefault();
      void create();
    }
  };
  return (
    <Section icon={<GitPullRequest />} title="Pull request" active={active} meta={status.defaultBranch ? `into ${status.defaultBranch}` : undefined} stage={2}>
      {error ? (
        <p className="flex items-start gap-2 text-xs text-mute">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
          {error}
        </p>
      ) : blockedReason ? (
        <p className="text-xs text-mute">{blockedReason}, then open the pull request here.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onSendKey} placeholder="PR title" aria-label="PR title" />
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onSendKey} placeholder="What changed and why (markdown)" maxHeight={160} className="min-h-[3lh] text-xs" aria-label="PR description" />
          {(ai || aiMade) && (
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              {aiMade && (
                <span className="mr-auto flex items-center gap-1 text-2xs whitespace-nowrap text-mute-2">
                  <AiMark /> Drafted by the <Term id="tinyModel">tiny model</Term>
                </span>
              )}
              {ai && <SuggestButton run={writeIt} onValue={applyAi} label="Write title & description" title="Draft the title and description with omp's tiny model (edit them before you create the PR)" />}
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-mute">
              <Switch checked={draft} onCheckedChange={setDraft} label="Draft PR" />
              Draft
            </label>
            <span className="flex flex-1 items-center justify-end gap-1 text-2xs text-mute-2">
              {title.trim() ? (
                <>
                  <Kbd>Ctrl</Kbd>
                  <Kbd>Enter</Kbd>
                </>
              ) : (
                "Give it a title"
              )}
            </span>
            <Button size="sm" variant={active ? "primary" : "secondary"} icon={<GitPullRequestArrow />} onClick={() => void create()} loading={busy} disabled={!title.trim()}>
              Create PR
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function ChecksBar({ checks }: { checks: NonNullable<PrInfo["checks"]> }) {
  const total = checks.passed + checks.failed + checks.pending;
  if (total === 0) return <span className="text-2xs text-mute">No checks</span>;
  const seg = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-white/8" role="img" aria-label={`${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending`}>
        <motion.span className="h-full bg-done" initial={false} animate={{ width: seg(checks.passed) }} transition={spring.smooth} />
        <motion.span className="h-full bg-error" initial={false} animate={{ width: seg(checks.failed) }} transition={spring.smooth} />
        <motion.span className="tf-loop h-full animate-shimmer bg-[linear-gradient(90deg,#fbbf24,#fde68a,#fbbf24)] bg-[length:200%_100%]" initial={false} animate={{ width: seg(checks.pending) }} transition={spring.smooth} />
      </div>
      <div className="flex gap-3 text-2xs font-bold tabular">
        <span className="text-done">{checks.passed} passed</span>
        {checks.failed > 0 && <span className="text-error">{checks.failed} failed</span>}
        {checks.pending > 0 && (
          <span className="flex items-center gap-1 text-warn">
            <CircleDot className="tf-loop size-3 animate-breathe" />
            {checks.pending} running
          </span>
        )}
      </div>
    </div>
  );
}

function PrCard({ hostId, cwd, workspace, defaultBranch, pr, loading, onMerged, active }: { hostId: string; cwd: string; workspace: Workspace; defaultBranch?: string; pr: PrInfo; loading: boolean; onMerged: () => void; active: boolean }) {
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const merged = pr.state === "MERGED";
  const closed = pr.state === "CLOSED";
  const failing = (pr.checks?.failed ?? 0) > 0;
  const merge = async () => {
    setBusy(true);
    try {
      await core.host(hostId).call("gh.prMerge", { cwd, method, deleteBranch });
      toast({ title: `Merged #${pr.number}`, description: pr.title, status: "done" });
      onMerged();
    } catch (e) {
      const d = describeError(e);
      toast({ title: `Couldn't merge #${pr.number}`, description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      icon={<GitMerge />}
      title={`#${pr.number}`}
      active={active}
      done={merged}
      stage={3}
      meta={
        <>
          {loading && <Spinner size={11} label="Refreshing PR" />}
          <Badge tone={merged ? "done" : closed ? "error" : pr.draft ? "idle" : "review"}>{pr.draft && !merged ? "draft" : pr.state.toLowerCase()}</Badge>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <button type="button" onClick={() => void core.app("app.openExternal", { url: pr.url })} className="group flex items-start gap-2 rounded-xs text-left focus-ring">
          <span className="flex-1 text-sm font-semibold group-hover:underline">{pr.title}</span>
          <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-mute" />
        </button>
        {pr.checks && <ChecksBar checks={pr.checks} />}
        {!merged && !closed && <FixActions hostId={hostId} cwd={cwd} workspace={workspace} pr={pr} defaultBranch={defaultBranch} />}
        {!merged && !closed && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                value={method}
                onValueChange={setMethod}
                options={[
                  { value: "squash", label: "Squash" },
                  { value: "merge", label: "Merge" },
                  { value: "rebase", label: "Rebase" },
                ]}
                aria-label="Merge method"
              />
              <label className="flex items-center gap-2 text-xs font-semibold text-mute">
                <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} label="Delete branch after merge" />
                Delete branch
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-2xs text-mute-2">
                {pr.draft
                  ? "Draft — mark it ready for review on GitHub to merge"
                  : failing
                    ? "Checks are failing — merge anyway?"
                    : (pr.checks?.pending ?? 0) > 0
                      ? "Checks still running"
                      : pr.mergeable === false
                        ? "GitHub reports conflicts"
                        : "Ready to merge"}
              </span>
              <Button size="sm" variant={failing ? "danger" : "primary"} icon={<GitMerge />} onClick={() => void merge()} loading={busy} disabled={pr.mergeable === false || pr.draft}>
                {method === "squash" ? "Squash & merge" : method === "rebase" ? "Rebase & merge" : "Merge"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * Done: Mark done (Undo toast) or Mark done & remove worktree (asks first). Always offered, so a
 * branch that ships elsewhere can be finished too; once the PR is merged it's the glowing next step.
 */
function DoneCard({ hostId, workspace, agents, merged }: { hostId: string; workspace: Workspace; agents: Agent[]; merged: boolean }) {
  const [busy, setBusy] = useState<"done" | "remove" | null>(null);
  const live = agents.filter((a) => !a.archived);
  const keys = live.map((a) => agentKey(hostId, a.id));
  const first = agents[0];
  const removeKey = keys[0] ?? (first ? agentKey(hostId, first.id) : undefined);
  if (!merged && live.length === 0 && !workspace.worktree) return null;

  const run = async (kind: "done" | "remove") => {
    setBusy(kind);
    try {
      if (kind === "done") await archiveWithUndo(keys);
      else if (removeKey) await markDoneAndRemove(removeKey);
      else await removeWorktree(hostId, workspace);
    } finally {
      setBusy(null);
    }
  };
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {live.length > 0 ? (
        <Tooltip content={ACTIONS.markDone.description}>
          <Button size="sm" variant={merged ? "primary" : "secondary"} icon={<CircleCheckBig />} onClick={() => void run("done")} loading={busy === "done"} disabled={!!busy}>
            {live.length === 1 ? ACTIONS.markDone.label : `${ACTIONS.markDone.label} (${live.length} agents)`}
          </Button>
        </Tooltip>
      ) : (
        agents.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-done">
            <Check className="size-3.5" /> Marked done
          </span>
        )
      )}
      {workspace.worktree && (
        <Tooltip content={ACTIONS.markDoneRemove.description}>
          <Button size="sm" variant="secondary" icon={<Trash2 />} onClick={() => void run("remove")} loading={busy === "remove"} disabled={!!busy}>
            {ACTIONS.markDoneRemove.label}
          </Button>
        </Tooltip>
      )}
    </div>
  );

  if (!merged) {
    return (
      <Section icon={<CircleCheckBig />} title="Done" active={false} meta="when you're finished" stage={4}>
        {actions}
      </Section>
    );
  }
  return (
    <motion.section
      data-ship-stage={4}
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={spring.bouncy}
      className="relative scroll-my-3 overflow-hidden rounded-lg p-4 text-white shadow-glow-done [background:radial-gradient(120%_140%_at_100%_0%,rgb(163_230_53/0.35),transparent_60%),linear-gradient(135deg,#1f3a12,#14261a)]"
    >
      {Array.from({ length: 14 }, (_, i) => (
        <motion.span
          key={i}
          className="absolute size-1.5 rounded-full bg-done"
          style={{ left: `${8 + ((i * 53) % 84)}%`, top: "60%" }}
          initial={{ opacity: 1, y: 0 }}
          animate={{ opacity: 0, y: -60 - (i % 4) * 18 }}
          transition={{ duration: 1.2, delay: i * 0.04, ease: "easeOut" }}
          aria-hidden
        />
      ))}
      <p className="font-display text-lg font-bold">Shipped 🎉</p>
      <p className="mt-0.5 mb-3 text-xs text-white/75">The PR is merged. {live.length > 0 ? "Mark it done?" : "All done here."}</p>
      {actions}
    </motion.section>
  );
}
