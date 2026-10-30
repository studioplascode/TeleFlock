import { Check, GitPullRequestArrow, TriangleAlert, Wand2, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { agentKey, navigate, useAgent, useHostState, useSuccessor } from "@/core";
import type { Agent, PrInfo, Workspace } from "@/core/gen";
import { Button, Elapsed, IconButton, Shimmer, Spinner, Tooltip, cn, useNow } from "@/design";
import {
  dismissFix,
  type FixPhase,
  type FixRun,
  fixActive,
  fixBlocker,
  fixKey,
  fixOffer,
  fixPhase,
  noteWorking,
  rebaseOnto,
  startFix,
  useFixRuns,
  worktreeAgent,
} from "./fix";

type Tone = "work" | "ok" | "warn" | "error";

const TONE: Record<Tone, string> = {
  work: "bg-accent/[0.08] shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]",
  ok: "bg-done/10 text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.25)]",
  warn: "bg-warn/10 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]",
  error: "bg-error/10 text-[#ffb1c1] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)]",
};

/** What a phase says, and in which tone. */
function describePhase(run: FixRun, phase: FixPhase, pr: PrInfo, onto: string): { text: string; tone: Tone } {
  const name = run.agentName;
  const green = run.kind === "green";
  const failed = pr.checks?.failed ?? 0;
  switch (phase) {
    case "resuming":
      return { text: `Resuming ${name}…`, tone: "work" };
    case "sending":
      return { text: green ? `Sending /green to ${name}…` : `Asking ${name} to rebase onto ${onto}…`, tone: "work" };
    case "starting":
      return { text: `${name} is starting…`, tone: "work" };
    case "working":
      return { text: green ? `${name} is making it green` : `${name} is rebasing onto ${onto}`, tone: "work" };
    case "needsYou":
      return { text: `${name} is asking you something`, tone: "warn" };
    case "checksRunning":
      return { text: `${name} pushed a fix · checks running`, tone: "work" };
    case "recheck":
      return { text: "Rebased · GitHub is checking the merge again", tone: "work" };
    case "done":
      return { text: green ? "All checks pass" : `Up to date with ${onto} · no conflicts`, tone: "ok" };
    case "stopped":
      return {
        text: green ? `${name} stopped with ${failed} check${failed === 1 ? "" : "s"} still failing` : `${name} stopped, and GitHub still can't merge it`,
        tone: "warn",
      };
    case "failed":
      return { text: run.error ?? `Couldn't ask ${name}`, tone: "error" };
  }
}

function FixProgress({ hostId, run, phase, pr, onto, onDismiss }: { hostId: string; run: FixRun; phase: FixPhase; pr: PrInfo; onto: string; onDismiss: () => void }) {
  const agent = useAgent(run.agentKey);
  const { text, tone } = describePhase(run, phase, pr, onto);
  const busy = fixActive(phase) && phase !== "needsYou";
  const watch = agent && (phase === "starting" || phase === "working" || phase === "needsYou" || phase === "checksRunning" || phase === "stopped");
  return (
    <div role="status" aria-live="polite" data-fix-phase={phase} className={cn("flex items-center gap-2 rounded-md py-1.5 pr-1.5 pl-2.5 text-xs", TONE[tone])}>
      <span className="grid size-4 shrink-0 place-items-center">
        {busy ? <Spinner size={13} label="Working" /> : tone === "ok" ? <Check className="size-3.5" strokeWidth={3} /> : <TriangleAlert className={cn("size-3.5", tone === "warn" && "text-warn")} />}
      </span>
      <span className="min-w-0 flex-1">
        {busy ? <Shimmer className="block truncate font-semibold">{text}</Shimmer> : <span className="block font-semibold wrap-break-word">{text}</span>}
        {phase === "working" && agent?.live.line && <span className="block truncate text-2xs text-mute">{agent.live.line}</span>}
      </span>
      {busy && <Elapsed since={run.at} className="shrink-0 font-mono text-2xs text-mute" />}
      {watch && (
        <Button size="sm" variant={phase === "needsYou" ? "sunset" : "ghost"} className="h-7 shrink-0" onClick={() => navigate({ name: "agent", hostId, agentId: agent.id })}>
          {phase === "needsYou" ? "Answer" : "Watch"}
        </Button>
      )}
      {!busy && phase !== "needsYou" && (
        <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
          <X />
        </IconButton>
      )}
    </div>
  );
}

/** A button whose tooltip still shows while it is disabled (it explains why). */
function Offer({ tip, disabled, children }: { tip: ReactNode; disabled: boolean; children: ReactNode }) {
  return (
    <Tooltip content={tip}>
      <span tabIndex={disabled ? 0 : -1} className="inline-flex rounded-sm focus-ring">
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * Pull request stage: "Make it green" while checks fail, "Rebase onto origin/<base> and resolve"
 * while GitHub reports conflicts or the branch behind its base, then the request's progress. The
 * worktree's agent does the work (`fix.ts`); a parked one is resumed first.
 */
export function FixActions({ hostId, cwd, workspace, pr, defaultBranch }: { hostId: string; cwd: string; workspace: Workspace; pr: PrInfo; defaultBranch?: string }) {
  const key = fixKey(hostId, cwd);
  const run = useFixRuns((s) => s.runs[key]);
  const host = useHostState(hostId);
  const moved = useSuccessor(run?.agentKey ?? "");
  const runAgent = useAgent(moved ?? run?.agentKey ?? "");
  const now = useNow(run?.step === "sent" ? 5_000 : null);
  const phase = run ? fixPhase(run, runAgent, pr, now) : undefined;
  useEffect(() => {
    if (phase === "working") noteWorking(key);
  }, [phase, key]);
  const offer = fixOffer(pr);
  if (!run && !offer.green && !offer.rebase) return null;

  const onto = rebaseOnto(pr, defaultBranch);
  const agent: Agent | undefined = worktreeAgent(host?.agents ?? [], workspace);
  const ask = (kind: "green" | "rebase") => {
    if (!agent) return;
    void startFix(hostId, cwd, kind, { ...agent, hostId, key: agentKey(hostId, agent.id) }, offer.rebase ? { onto, why: offer.rebase } : undefined);
  };
  const resumes = agent?.parked ? ` ${agent.name} is resumed first.` : "";
  const greenBlock = fixBlocker(agent, "green");
  const rebaseBlock = fixBlocker(agent, "rebase");
  return (
    <div className="flex flex-col gap-2">
      {run && phase && <FixProgress hostId={hostId} run={{ ...run, agentKey: moved ?? run.agentKey }} phase={phase} pr={pr} onto={run.onto ?? onto} onDismiss={() => dismissFix(key)} />}
      {!fixActive(phase) && (offer.green || offer.rebase) && (
        <div className="flex flex-wrap items-center gap-2">
          {offer.green && (
            <Offer
              disabled={!!greenBlock}
              tip={greenBlock ?? `${agent?.name} runs omp's /green: it watches the CI runs of HEAD, reads the failing logs, fixes, pushes and repeats until every check passes.${resumes}`}
            >
              <Button size="sm" variant="primary" icon={<Wand2 />} disabled={!!greenBlock} onClick={() => ask("green")}>
                Make it green
              </Button>
            </Offer>
          )}
          {offer.rebase && (
            <Offer
              disabled={!!rebaseBlock}
              tip={
                rebaseBlock ??
                `${offer.rebase === "conflicts" ? "GitHub reports conflicts" : `The branch is behind ${onto}`}: ${agent?.name} rebases onto ${onto}, resolves the conflicts, runs the tests and force-pushes (with lease).${resumes}`
              }
            >
              <Button size="sm" variant={offer.green ? "secondary" : "primary"} icon={<GitPullRequestArrow />} disabled={!!rebaseBlock} onClick={() => ask("rebase")}>
                Rebase onto {onto} and resolve
              </Button>
            </Offer>
          )}
        </div>
      )}
    </div>
  );
}
