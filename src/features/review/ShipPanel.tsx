import { AnimatePresence, motion } from "motion/react";
import { Archive, ArrowUpFromLine, Check, CircleDot, ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestArrow, Sparkles, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { agentKey, core, navigate, openSession, useAgent, useCore, useSession } from "@/core";
import type { Agent, GitStatusResult, MergeMethod, PrInfo, Workspace } from "@/core/gen";
import { Badge, Button, Input, SegmentedControl, Shimmer, Spinner, Switch, Textarea, cn, spring, toast } from "@/design";
import { removeWorktree } from "../workspace/workspaceActions";
import { describeError } from "../workspace/shared/errors";
import { useHostQuery } from "../workspace/shared/useHostQuery";

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

export interface ShipPanelProps {
  hostId: string;
  workspace: Workspace;
  cwd: string;
  status: GitStatusResult;
  agents: Agent[];
  /** Re-fetch git status + diff after a mutation. */
  onChanged: () => void;
}

/** Commit → push → PR → checks → merge → archive, as one pipeline whose current stage glows. */
export function ShipPanel({ hostId, workspace, cwd, status, agents, onChanged }: ShipPanelProps) {
  const pr = useHostQuery(hostId, "gh.prStatus", { cwd });
  const [lastCommit, setLastCommit] = useState<string>();
  const info = pr.data?.pr;
  const dirty = status.files.length > 0;
  const unpushed = status.ahead > 0 || (!status.upstream && !!status.branch && status.branch !== status.defaultBranch);
  const merged = info?.state === "MERGED";

  // Poll the PR while checks are pending or it's open (checks/mergeability change server-side).
  const pending = !!info && info.state === "OPEN" && ((info.checks?.pending ?? 0) > 0 || info.mergeable === undefined);
  useEffect(() => {
    if (!info || info.state !== "OPEN") return;
    const id = window.setInterval(pr.reload, pending ? 4000 : 15000);
    return () => window.clearInterval(id);
  }, [info, pending, pr.reload]);

  // Current stage = first step not yet satisfied (an open PR with new local commits still needs commit/push).
  const stage = merged ? 4 : dirty ? 0 : unpushed ? 1 : !info ? 2 : 3;
  const stages = [
    { icon: GitCommitHorizontal, label: "Commit" },
    { icon: ArrowUpFromLine, label: "Push" },
    { icon: GitPullRequest, label: "PR" },
    { icon: GitMerge, label: "Merge" },
    { icon: Archive, label: "Wrap up" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex items-center gap-1" aria-label="Ship progress">
        {stages.map((s, i) => (
          <li key={s.label} className="flex flex-1 items-center gap-1">
            <span
              className={cn(
                "relative grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-500 [&_svg]:size-3.5",
                i < stage && "bg-done/20 text-done",
                i === stage && "bg-omp text-white shadow-glow-accent",
                i > stage && "bg-tile-3 text-mute-2",
              )}
              title={s.label}
            >
              {i < stage ? <Check strokeWidth={3} /> : <s.icon />}
              {i === stage && !merged && <span className="tf-loop absolute -inset-1 animate-ping-soft rounded-full shadow-[0_0_0_2px_rgb(163_92_240/0.45)]" aria-hidden />}
            </span>
            {i < stages.length - 1 && (
              <span className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/8">
                <motion.span className="block h-full bg-done/70" initial={false} animate={{ width: i < stage ? "100%" : "0%" }} transition={spring.gentle} />
              </span>
            )}
          </li>
        ))}
      </ol>

      <CommitCard
        hostId={hostId}
        cwd={cwd}
        dirty={dirty}
        fileCount={status.files.length}
        agents={agents}
        onCommitted={(summary) => {
          setLastCommit(summary);
          onChanged();
        }}
        active={stage === 0}
      />
      <PushCard hostId={hostId} cwd={cwd} status={status} unpushed={unpushed} dirty={dirty} onPushed={() => (onChanged(), pr.reload())} active={stage === 1} />
      {info ? (
        <PrCard hostId={hostId} cwd={cwd} pr={info} loading={pr.loading} onMerged={() => (pr.reload(), onChanged())} active={stage === 3} />
      ) : (
        <CreatePrCard key={lastCommit} hostId={hostId} cwd={cwd} status={status} lastCommit={lastCommit} disabled={dirty || unpushed} error={pr.error?.message} onCreated={pr.reload} active={stage === 2} />
      )}
      <AnimatePresence>{merged && <WrapUpCard hostId={hostId} workspace={workspace} agents={agents} />}</AnimatePresence>
    </div>
  );
}

function Section({ icon, title, meta, active, done, children }: { icon: ReactNode; title: string; meta?: ReactNode; active: boolean; done?: boolean; children?: ReactNode }) {
  return (
    <motion.section
      layout
      transition={spring.smooth}
      className={cn(
        "rounded-lg p-3.5 transition-[background-color,box-shadow] duration-500",
        active ? "bg-accent/[0.07] shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4),0_0_30px_-12px_rgb(163_92_240/0.6)]" : "bg-white/[0.03] shadow-hairline",
      )}
    >
      <header className="flex items-center gap-2">
        <span className={cn("grid size-6 place-items-center rounded-sm [&_svg]:size-3.5", done ? "bg-done/15 text-done" : active ? "bg-omp text-white" : "bg-tile-3 text-mute")}>{done ? <Check strokeWidth={3} /> : icon}</span>
        <h3 className="font-display text-sm font-bold">{title}</h3>
        <span className="ml-auto flex items-center gap-1.5 text-2xs text-mute">{meta}</span>
      </header>
      {children && <div className="mt-3">{children}</div>}
    </motion.section>
  );
}

function CommitCard({ hostId, cwd, dirty, fileCount, agents, onCommitted, active }: { hostId: string; cwd: string; dirty: boolean; fileCount: number; agents: Agent[]; onCommitted: (summary: string) => void; active: boolean }) {
  const [message, setMessage] = useState("");
  const [all, setAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ agentId: string; afterId: string | null } | null>(null);
  const omp = agents.find((a) => a.kind === "omp");

  const commit = async () => {
    setBusy(true);
    try {
      const r = await core.host(hostId).call("git.commit", { cwd, message: message.trim(), all });
      toast({ title: `Committed ${r.sha.slice(0, 7)}`, description: r.summary, status: "done", duration: 3500 });
      setMessage("");
      onCommitted(r.summary);
    } catch (e) {
      const d = describeError(e);
      toast({ title: "Commit failed", description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (!dirty) {
    return <Section icon={<GitCommitHorizontal />} title="Everything committed" active={false} done meta="working tree clean" />;
  }
  return (
    <Section icon={<GitCommitHorizontal />} title="Commit" active={active} meta={`${fileCount} file${fileCount === 1 ? "" : "s"} changed`}>
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
          <Button variant="primary" size="sm" icon={<GitCommitHorizontal />} onClick={() => void commit()} loading={busy} disabled={!message.trim() || !!asking}>
            Commit
          </Button>
        </div>
      </div>
    </Section>
  );
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
      Ask {agent.name} to write it
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
    return <Section icon={<ArrowUpFromLine />} title="Pushed" done active={false} meta={status.upstream ?? "up to date"} />;
  }
  return (
    <Section
      icon={<ArrowUpFromLine />}
      title="Push"
      active={active}
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

function CreatePrCard({ hostId, cwd, status, lastCommit, disabled, error, onCreated, active }: { hostId: string; cwd: string; status: GitStatusResult; lastCommit?: string; disabled: boolean; error?: string; onCreated: () => void; active: boolean }) {
  const humanBranch = (status.branch ?? "").replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ");
  const [title, setTitle] = useState(lastCommit ?? (humanBranch ? humanBranch[0]?.toUpperCase() + humanBranch.slice(1) : ""));
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const info = await core.host(hostId).call("gh.prCreate", { cwd, title: title.trim(), body, draft, base: status.defaultBranch });
      toast({ title: `Opened PR #${info.number}`, description: info.title, status: "review", action: { label: "Open on GitHub", onClick: () => void core.app("app.openExternal", { url: info.url }) } });
      onCreated();
    } catch (e) {
      const d = describeError(e);
      toast({ title: "Couldn't create the PR", description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section icon={<GitPullRequest />} title="Pull request" active={active} meta={status.defaultBranch ? `into ${status.defaultBranch}` : undefined}>
      {error ? (
        <p className="text-xs text-mute">{error}</p>
      ) : (
        <div className={cn("flex flex-col gap-2", disabled && "opacity-60")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PR title" aria-label="PR title" disabled={disabled} />
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changed and why (markdown)" maxHeight={160} className="min-h-[3lh] text-xs" aria-label="PR description" disabled={disabled} />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-mute">
              <Switch checked={draft} onCheckedChange={setDraft} label="Draft PR" disabled={disabled} />
              Draft
            </label>
            <span className="flex-1 text-right text-2xs text-mute-2">{disabled ? "Commit and push first" : ""}</span>
            <Button size="sm" variant={active ? "primary" : "secondary"} icon={<GitPullRequestArrow />} onClick={() => void create()} loading={busy} disabled={disabled || !title.trim()}>
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

function PrCard({ hostId, cwd, pr, loading, onMerged, active }: { hostId: string; cwd: string; pr: PrInfo; loading: boolean; onMerged: () => void; active: boolean }) {
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

function WrapUpCard({ hostId, workspace, agents }: { hostId: string; workspace: Workspace; agents: Agent[] }) {
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = agents.filter((a) => !a.archived);
  const archive = async () => {
    setBusy(true);
    try {
      await Promise.all(live.map((a) => core.host(hostId).call("agent.archive", { agentId: a.id, archived: true })));
      setArchived(true);
      toast({ title: live.length === 1 ? `Archived ${live[0]?.name}` : `Archived ${live.length} agents`, status: "done", duration: 3000 });
    } catch (e) {
      toast({ title: "Couldn't archive", description: describeError(e).title, status: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.section
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={spring.bouncy}
      className="relative overflow-hidden rounded-lg p-4 text-white shadow-glow-done [background:radial-gradient(120%_140%_at_100%_0%,rgb(163_230_53/0.35),transparent_60%),linear-gradient(135deg,#1f3a12,#14261a)]"
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
      <p className="mt-0.5 text-xs text-white/75">The PR is merged. Tidy up this worktree?</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {live.length > 0 && !archived && (
          <Button size="sm" variant="primary" icon={<Archive />} onClick={() => void archive()} loading={busy}>
            {live.length === 1 ? `Archive ${live[0]?.name}` : `Archive ${live.length} agents`}
          </Button>
        )}
        {archived && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-done">
            <Check className="size-3.5" /> Archived
          </span>
        )}
        {workspace.worktree && (
          <Button size="sm" variant="secondary" icon={<Trash2 />} onClick={() => void removeWorktree(hostId, workspace)}>
            Remove worktree
          </Button>
        )}
      </div>
    </motion.section>
  );
}
