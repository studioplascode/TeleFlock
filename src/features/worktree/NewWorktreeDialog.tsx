import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Cpu, FolderGit2, GitBranch, GitBranchPlus, Pencil, ShieldAlert, Sparkles, Split, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { core, draftKey, navigate, suggestAgentName, suggestBranch, useAiNaming, useAiSuggestion, useDraftState, useHostIds, useHostState, useHosts, usePrefs, useSettings, useUi } from "@/core";
import type { WorktreeCreateParams, WorktreeCreated } from "@/core/gen";
import { Button, Chip, EmptyState, Input, Kbd, SegmentedControl, Shimmer, StatusOrb, cn, spring, toast, useIsMobile } from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { AiMark, within } from "../workspace/shared/ai";
import { AgentFields, agentNameError, autoAgentName, initialAgentDraft, toAgentSpec, useAgentDraft, useModelCatalog } from "../workspace/shared/AgentFields";
import { CommandPreview, type PreviewLine } from "../workspace/shared/CommandPreview";
import { agentLaunchLines, herdrArgv } from "../workspace/shared/commands";
import { type HerdrFailure, classifyHerdrError } from "../workspace/shared/errors";
import { LaunchSuccess, WorkingPanel } from "../workspace/shared/LaunchProgress";
import { agentNameFromBranch, basename, branchNameError, branchSlug, joinPath, shellQuote, tildify, uniqueAgentName } from "../workspace/shared/paths";
import { ResponsiveDialog } from "../workspace/shared/ResponsiveDialog";
import { useDialogSession } from "../workspace/shared/useDialogSession";
import { useHostQuery } from "../workspace/shared/useHostQuery";
import { autoBranchName } from "./autoName";
import { type BranchDraft, BranchStep } from "./BranchStep";
import { FolderBrowser, type FolderPick } from "./FolderBrowser";
import { StepRail } from "./StepRail";

const STEPS = ["Repository", "Branch", "Agent", "Create"] as const;

/** herdr's `[worktrees] directory` default (`docs/research/herdr.md` §8). */
const HERDR_WORKTREES_DIR = ".herdr/worktrees";

const NO_BRANCH: BranchDraft = { mode: "new", name: "", base: "", existing: "", customPath: false, path: "", label: "" };

/** Longest the Create step shows "Naming…" before the deterministic names take over. */
const NAMING_MS = 5000;
const NO_TASK = "Type a branch name: there's no task to name it from";
const MISSING_BRANCH = "Type a branch name";

/** Mounted once by the shell; renders while `useUi().dialog.kind === "newWorktree"`. */
export function NewWorktreeDialog() {
  const { open, payload, gen, close } = useDialogSession("newWorktree");
  if (!payload) return null;
  return <WorktreeWizard key={gen} open={open} initialHostId={payload.hostId} initialCwd={payload.cwd} onClose={close} />;
}

type Submit =
  | { phase: "idle" }
  | { phase: "working"; since: number }
  | { phase: "failed"; failure: HerdrFailure }
  | { phase: "done"; created: WorktreeCreated };

interface WizardProps {
  open: boolean;
  initialHostId?: string;
  initialCwd?: string;
  onClose: () => void;
}

function WorktreeWizard({ open, initialHostId, initialCwd, onClose }: WizardProps) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const profiles = useHosts((s) => s.profiles);
  const statuses = useHosts((s) => s.status);
  const openDialog = useUi((s) => s.openDialog);
  const settings = useSettings();
  const [hostId, setHostId] = useState<string | undefined>(initialHostId ?? hostIds[0]);
  const host = useHostState(hostId ?? "");
  const home = host?.info.home;

  const [step, setStep] = useState(initialCwd ? 1 : 0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [repo, setRepo] = useState<FolderPick | null>(initialCwd ? { path: initialCwd } : null);
  // the branch and agent forms persist per host + repository until a worktree is created
  const [branch, setBranch, clearBranch] = useDraftState<BranchDraft>(draftKey("worktree.branch", hostId ?? "", repo?.path ?? ""), NO_BRANCH);
  const [agent, patchAgent, clearAgent] = useAgentDraft(draftKey("worktree.agent", hostId ?? "", repo?.path ?? ""), () => initialAgentDraft(settings));
  const [trust, setTrust] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });
  /** Why the wizard bounced back to the Branch step (shown under the name until it changes). */
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId && hostIds[0]) setHostId(hostIds[0]);
  }, [hostId, hostIds]);

  const branches = useHostQuery(hostId, "git.branches", repo ? { cwd: repo.path } : null);
  const catalog = useModelCatalog(hostId);

  // repo name: the primary worktree root's basename (herdr's repo_name)
  const repoRoot = repo?.path ?? "";
  const repoName = basename(host?.workspaces.find((w) => w.repo?.root === repoRoot)?.repo?.root ?? repoRoot);
  const takenNames = useMemo(() => host?.agents.map((a) => a.name) ?? [], [host?.agents]);
  // every name git already has, local or as a remote-tracking branch's local name
  const takenBranches = useMemo(
    () => new Set((branches.data?.branches ?? []).flatMap((b) => (b.remote ? [b.name, b.name.replace(/^[^/]+\//, "")] : [b.name]))),
    [branches.data],
  );

  // Auto naming: an empty new-branch name (switch on) and/or agent name come from the agent's task;
  // prefetched while the task is typed, resolved at the Create step (≤ NAMING_MS, then the fallback).
  // The switch follows Settings → AI naming, not the host's AI health: once chosen, a host that
  // can't do AI still gets a branch named from the task (deterministic `baseSlug`).
  const aiOn = useAiNaming(hostId);
  const autoOffered = usePrefs((s) => s.aiNaming);
  const autoName = autoOffered && branch.mode === "new" && branch.autoName !== false;
  const task = agent.start ? agent.prompt.trim() : "";
  const needBranch = autoName && !branch.name.trim();
  const needAgent = aiOn && agent.start && !agent.name.trim() && !!task;
  /** The auto-named branch as edited inline on the Create step (null = untouched; "" = cleared). */
  const [inlineBranch, setInlineBranch] = useState<string | null>(null);
  const taskKey = hostId && repo && task ? `${hostId}\n${repoRoot}\n${task}` : null;
  const branchAi = () => (hostId ? suggestBranch(hostId, task, { cwd: repoRoot }) : Promise.resolve(null));
  const agentAi = () => (hostId ? suggestAgentName(hostId, task, takenNames) : Promise.resolve(null));
  useAiSuggestion(hostId, needBranch ? taskKey : null, branchAi, { debounceMs: 800 });
  const agentPrefetch = useAiSuggestion(hostId, needAgent ? taskKey : null, agentAi, { debounceMs: 800 });
  const askBranch = aiOn && needBranch;
  const resolveKey = taskKey && (askBranch || needAgent) ? `${taskKey}\n${askBranch}\n${needAgent}` : null;
  const [named, setNamed] = useState<{ key: string; branch: string | null; agent: string | null } | null>(null);
  const fresh = named && named.key === resolveKey ? named : null;
  const naming = step === 3 && !!resolveKey && !fresh;
  useEffect(() => {
    if (!naming || !resolveKey) return;
    let live = true;
    void Promise.all([askBranch ? within(branchAi(), NAMING_MS) : null, needAgent ? within(agentAi(), NAMING_MS) : null]).then(([b, a]) => {
      if (live) setNamed({ key: resolveKey, branch: b, agent: a });
    });
    return () => {
      live = false;
    };
  }, [naming, resolveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // shown from the Create step on (earlier steps keep the "named from the task" placeholder)
  const autoBranch = needBranch && task && step === 3 ? autoBranchName(aiOn ? (fresh?.branch ?? null) : null, task, takenBranches) : null;

  const effectiveBranch = (branch.mode === "new" ? branch.name.trim() || (needBranch ? (inlineBranch ?? autoBranch?.name ?? "") : "") : branch.existing).trim();
  const defaultPath = home ? joinPath(home, HERDR_WORKTREES_DIR, repoName, branchSlug(effectiveBranch) || "") : `~/${HERDR_WORKTREES_DIR}/${repoName}/${branchSlug(effectiveBranch)}`;
  const derivedName = uniqueAgentName(agentNameFromBranch(effectiveBranch), takenNames);
  const agentSuggestion = needAgent ? (fresh ? fresh.agent : agentPrefetch.value) : null;
  const autoAgent = needAgent ? autoAgentName(agentSuggestion, derivedName, takenNames) : { name: derivedName, ai: false };
  const agentName = agent.name.trim() || autoAgent.name;

  const localBranch = branches.data?.branches.find((b) => !b.remote && b.name === effectiveBranch);
  const nameError =
    branch.mode === "new"
      ? (branchNameError(effectiveBranch) ?? (localBranch ? (localBranch.worktreePath ? "Already checked out in another worktree" : "A branch with this name exists") : null))
      : null;

  const valid = [
    !!repo && !!hostId,
    branch.mode === "new" ? needBranch || !nameError : !!branch.existing,
    !agent.start || !agentNameError(agentName, takenNames),
    true,
  ];
  const reachable = valid.findIndex((v) => !v);
  const maxReachable = reachable === -1 ? STEPS.length - 1 : reachable;
  const busy = submit.phase === "working" || submit.phase === "done";

  const goTo = (target: number) => {
    if (busy) return;
    // Past an invalid step: land on that step (it shows what's missing) instead of doing nothing.
    const i = Math.min(target, maxReachable);
    if (i === step && target > step) {
      if (step === 1) setBranchNotice(MISSING_BRANCH);
      return;
    }
    if (i === 1 && target > 1 && branch.mode === "new" && !needBranch) setBranchNotice(MISSING_BRANCH);
    // auto name without a task: nothing to name the branch from
    if (i === 3 && needBranch && !task) {
      setBranchNotice(NO_TASK);
      setDir(-1);
      setStep(1);
      return;
    }
    setDir(i > step ? 1 : -1);
    setStep(i);
    if (submit.phase === "failed") setSubmit({ phase: "idle" });
  };

  const next = () => (step < STEPS.length - 1 ? goTo(step + 1) : void create());

  // The Base select shows the default branch when untouched; send exactly what it shows.
  const baseRef = branch.base || branches.data?.defaultBranch || "HEAD";
  const params: WorktreeCreateParams | null =
    repo && effectiveBranch && !naming
      ? {
          cwd: repo.path,
          branch: effectiveBranch,
          base: branch.mode === "new" && baseRef !== "HEAD" ? baseRef : undefined,
          path: branch.customPath && branch.path.trim() ? branch.path.trim() : undefined,
          label: branch.label.trim() || undefined,
          existing: branch.mode === "existing",
          trust,
          agent: agent.start ? toAgentSpec({ ...agent, name: agentName }) : undefined,
        }
      : null;

  const create = async (override?: Partial<WorktreeCreateParams>) => {
    if (!params || !hostId || busy || nameError) return;
    const p = { ...params, ...override };
    setSubmit({ phase: "working", since: Date.now() });
    try {
      const created = await core.host(hostId).call("worktree.create", p);
      clearBranch();
      clearAgent();
      setSubmit({ phase: "done", created });
      if (!created.agent) {
        onClose();
        toast({
          title: `Worktree ${created.branch} is ready`,
          description: tildify(created.path, home),
          status: "review",
          action: { label: "Start an agent", onClick: () => openDialog({ kind: "newAgent", hostId, workspaceId: created.workspaceId }) },
        });
      }
    } catch (e) {
      setSubmit({ phase: "failed", failure: classifyHerdrError(e) });
    }
  };

  // Ctrl/⌘+Enter anywhere advances / creates (otherwise the folder browser uses it to pick + continue).
  // Window-level so it still works when the focused field unmounts between steps.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && valid[step]) {
        e.preventDefault();
        e.stopPropagation();
        next();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const session = host?.info.herdrSession;
  const preview: PreviewLine[] = params
    ? [
        {
          argv: herdrArgv(
            session,
            "worktree",
            "create",
            "--cwd",
            shellQuote(tildify(params.cwd, home)),
            "--branch",
            shellQuote(params.branch),
            params.base && "--base",
            params.base && shellQuote(params.base),
            params.path && "--path",
            params.path && shellQuote(params.path),
            params.label && "--label",
            params.label && shellQuote(params.label),
            "--no-focus",
            params.trust && "--trust-repository",
          ),
        },
        ...(params.agent ? agentLaunchLines(session, params.agent, "<new root pane>", { name: agentName }) : []),
      ]
    : [];

  const hostOptions = hostIds.map((id) => ({
    value: id,
    label: (
      <span className="flex items-center gap-1.5">
        <StatusOrb status={statuses[id]?.phase === "online" ? "done" : "idle"} size={6} label={null} />
        {profiles.find((p) => p.id === id)?.name ?? id}
      </span>
    ),
  }));

  const title = submit.phase === "done" && submit.created.agent ? "Worktree ready" : "New worktree";
  const footer =
    submit.phase === "done" ? undefined : (
      <div className="flex w-full items-center gap-2">
        {step > 0 && (
          <Button variant="ghost" icon={<ArrowLeft />} onClick={() => goTo(step - 1)} disabled={busy}>
            Back
          </Button>
        )}
        {!mobile && <span className="flex-1" />}
        {!mobile && (
          <span className="hidden items-center gap-1 text-2xs text-mute-2 md:flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
          </span>
        )}
        {step < STEPS.length - 1 ? (
          <Button variant="primary" trailing={<ArrowRight />} onClick={next} disabled={!valid[step]} className={mobile ? "flex-1" : undefined}>
            {step === 0 && repo ? `Continue with ${basename(repo.path)}` : "Continue"}
          </Button>
        ) : (
          <Button
            variant={submit.phase === "failed" && submit.failure.kind !== "other" ? "secondary" : "primary"}
            icon={<Sparkles />}
            onClick={() => void create()}
            loading={submit.phase === "working" || naming}
            disabled={!params || !!nameError}
            className={mobile ? "flex-1" : undefined}
          >
            {naming ? "Naming…" : submit.phase === "failed" ? "Try again" : agent.start ? "Create & start agent" : "Create worktree"}
          </Button>
        )}
      </div>
    );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      description={repo && step > 0 ? <span className="font-mono">{tildify(repo.path, home)}</span> : ACTIONS.newWorktree.description}
      icon={<GitBranchPlus />}
      width={760}
      maxHeight="94dvh"
      tall
      footer={footer}
    >
      <div className="flex min-h-full flex-col gap-5">
        {hostIds.length === 0 ? (
          <EmptyState
            compact
            icon={<TriangleAlert />}
            title="No host connected"
            description="Connect a host to create worktrees on it."
            action={<Button onClick={() => openDialog({ kind: "hostEditor" })}>Add a host</Button>}
          />
        ) : submit.phase === "done" && submit.created.agent && hostId ? (
          <LaunchSuccess
            hostId={hostId}
            started={submit.created.agent}
            title={(name) => (name ? `${name} is starting` : "Starting agent…")}
            subtitle={
              <>
                <span className="flex items-center justify-center gap-1.5 text-ink-2">
                  <GitBranch className="size-3.5 text-accent" />
                  {submit.created.branch}
                </span>
                <span className="block truncate">{tildify(submit.created.path, home)}</span>
              </>
            }
            onClose={onClose}
          />
        ) : (
          <>
            <StepRail steps={STEPS} current={step} reachable={maxReachable} onJump={goTo} />
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                variants={{
                  enter: (d: number) => ({ opacity: 0, x: 36 * d, filter: "blur(4px)" }),
                  center: { opacity: 1, x: 0, filter: "blur(0px)" },
                  exit: (d: number) => ({ opacity: 0, x: -36 * d, filter: "blur(4px)" }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={spring.smooth}
                className="flex flex-1 flex-col"
              >
                {step === 0 && hostId && (
                  <div className="flex flex-1 flex-col gap-3">
                    {hostIds.length > 1 && (
                      <div className="flex items-center gap-3">
                        <span className="text-2xs font-bold text-mute">Host</span>
                        <SegmentedControl
                          size="sm"
                          value={hostId}
                          onValueChange={(id) => {
                            setHostId(id);
                            setRepo(null);
                          }}
                          options={hostOptions}
                          aria-label="Host"
                        />
                      </div>
                    )}
                    <FolderBrowser
                      key={hostId}
                      className="flex-1"
                      hostId={hostId}
                      mode="repo"
                      value={repo?.path}
                      initialPath={initialCwd}
                      autoFocus={!mobile}
                      onSelect={setRepo}
                      onConfirm={(pick) => {
                        setRepo(pick);
                        setDir(1);
                        setStep(1);
                      }}
                    />
                    <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden text-xs text-mute" aria-live="polite">
                      <AnimatePresence mode="popLayout" initial={false}>
                        {repo ? (
                          <motion.span
                            key={repo.path}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={spring.smooth}
                            className="flex min-w-0 items-center gap-2"
                          >
                            <FolderGit2 className="size-3.5 shrink-0 text-accent" />
                            <span className="truncate font-mono text-ink-2">{tildify(repo.path, home)}</span>
                            {repo.git?.branch && <Chip icon={<GitBranch />}>{repo.git.branch}</Chip>}
                          </motion.span>
                        ) : (
                          <motion.span key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-mute-2">
                            <FolderGit2 className="size-3.5 shrink-0" />
                            Pick a repository: folders with the git icon
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
                {step === 1 && (
                  <BranchStep
                    branches={branches.data}
                    loading={branches.loading || branches.waiting}
                    error={branches.waiting ? undefined : branches.error?.message}
                    draft={branch}
                    onChange={(patch) => {
                      setBranchNotice(null);
                      setInlineBranch(null);
                      setBranch((b) => ({ ...b, ...patch }));
                    }}
                    filterKey={draftKey("worktree.branchFilter", hostId ?? "", repoRoot)}
                    branch={effectiveBranch}
                    defaultPath={defaultPath}
                    nameError={nameError}
                    home={home}
                    aiNaming={autoOffered}
                    notice={branchNotice}
                    onSubmit={() => valid[1] && next()}
                  />
                )}
                {step === 2 && hostId && (
                  <div className="flex flex-col gap-3">
                    <AgentFields
                      hostId={hostId}
                      toggleable
                      draft={agent}
                      onChange={patchAgent}
                      derivedName={needBranch && !effectiveBranch ? "named from the task" : derivedName}
                      suggestedName={autoAgent.ai ? autoAgent.name : null}
                      takenNames={takenNames}
                    />
                    <button
                      type="button"
                      onClick={() => openDialog({ kind: "fanOut", hostId, cwd: repo?.path, prompt: agent.prompt.trim() || undefined })}
                      className="group flex items-center gap-3 rounded-lg bg-white/[0.03] px-3.5 py-2.5 text-left shadow-hairline transition-colors focus-ring pressable hover:bg-accent/[0.08]"
                    >
                      <Split className="size-4 text-accent transition-transform duration-500 ease-spring group-hover:rotate-90" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-bold">Try N approaches</span>
                        <span className="text-2xs text-mute">
                          {ACTIONS.fanOut.label}: {ACTIONS.fanOut.description}
                        </span>
                      </span>
                      <ArrowRight className="size-4 text-mute-2 transition-transform group-hover:translate-x-0.5" />
                    </button>
                  </div>
                )}
                {step === 3 && (
                  <div className="flex flex-col gap-4">
                    <Summary
                      repo={tildify(repoRoot, home)}
                      branch={effectiveBranch}
                      mode={branch.mode}
                      base={branch.mode === "new" ? baseRef : undefined}
                      path={tildify(params?.path ?? defaultPath, home)}
                      agent={agent.start ? (naming && needAgent ? "Naming…" : agentName) : null}
                      agentAi={agent.start && !agent.name.trim() && autoAgent.ai}
                      model={agent.model === "default" ? "host default" : (catalog?.models.find((m) => `${m.provider}/${m.id}` === agent.model)?.label ?? agent.model)}
                      onEdit={goTo}
                      branchEdit={
                        needBranch ? (
                          naming && askBranch && inlineBranch === null ? (
                            <Shimmer className="flex h-8 items-center font-mono text-xs font-semibold">Naming…</Shimmer>
                          ) : (
                            <span className="flex flex-col gap-1">
                              <Input
                                value={inlineBranch ?? autoBranch?.name ?? ""}
                                onChange={(e) => setInlineBranch(e.target.value)}
                                aria-label="Branch name"
                                invalid={!!nameError}
                                trailing={inlineBranch === null && autoBranch?.ai ? <AiMark /> : undefined}
                                boxClassName="h-8 px-2"
                                className="font-mono text-xs font-semibold"
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                              />
                              {nameError && <span className="text-2xs font-semibold text-error">{nameError}</span>}
                            </span>
                          )
                        ) : undefined
                      }
                    />
                    {submit.phase === "working" ? (
                      <WorkingPanel
                        since={submit.since}
                        label={agent.start ? "Creating worktree & starting agent" : "Creating worktree"}
                        detail={`git worktree add ${tildify(params?.path ?? defaultPath, home)}`}
                      />
                    ) : (
                      <>
                        {submit.phase === "failed" && (
                          <FailureCallout
                            failure={submit.failure}
                            home={home}
                            branch={effectiveBranch}
                            onTrust={() => {
                              setTrust(true);
                              void create({ trust: true });
                            }}
                            onUseExisting={() => {
                              setBranch((b) => ({ ...b, mode: "existing", existing: effectiveBranch }));
                              void create({ existing: true, base: undefined });
                            }}
                            onNewName={() => {
                              setBranch((b) => ({ ...b, mode: "new", name: `${effectiveBranch}-2`, base: b.mode === "existing" ? b.existing : b.base }));
                              goTo(1);
                            }}
                            onOtherPath={() => {
                              setBranch((b) => ({ ...b, customPath: true, path: `${params?.path ?? defaultPath}-2` }));
                              goTo(1);
                            }}
                            onOpenCheckout={async (path) => {
                              if (!hostId) return;
                              const ws = host?.workspaces.find((w) => w.cwd === path || w.worktree?.path === path);
                              const agentHere = ws && host?.agents.find((a) => a.workspaceId === ws.id);
                              onClose();
                              if (agentHere) {
                                navigate({ name: "agent", hostId, agentId: agentHere.id });
                              } else if (ws) {
                                openDialog({ kind: "newAgent", hostId, workspaceId: ws.id });
                              } else {
                                try {
                                  const ref = await core.host(hostId).call("workspace.create", { cwd: path });
                                  toast({
                                    title: "Opened the existing checkout",
                                    description: tildify(path, home),
                                    status: "review",
                                    action: { label: "Start an agent", onClick: () => openDialog({ kind: "newAgent", hostId, workspaceId: ref.workspaceId }) },
                                  });
                                } catch (e) {
                                  toast({ title: "Couldn't open the checkout", description: classifyHerdrError(e).error.message, status: "error" });
                                }
                              }
                            }}
                            onPickRepo={() => goTo(0)}
                          />
                        )}
                        {submit.phase === "idle" && (
                          <ol className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2" aria-label="What happens">
                            {[
                              branch.mode === "new" ? `git creates ${effectiveBranch || "the new branch"} from ${baseRef}` : `git checks out ${effectiveBranch}`,
                              "herdr opens the checkout as a workspace",
                              ...(agent.start
                                ? [`omp starts as ${naming && needAgent ? "the named agent" : agentName}, shared with TeleFlock`, "You land in its session"]
                                : ["You can start an agent there any time"]),
                            ].map((text, i) => (
                              <motion.li
                                key={text}
                                initial={{ opacity: 0, x: -6 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ ...spring.smooth, delay: 0.12 + i * 0.05 }}
                                className="flex min-w-0 items-center gap-2.5 text-xs text-ink-2"
                              >
                                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/6 font-mono text-[10px] font-bold text-mute shadow-hairline">{i + 1}</span>
                                <span className="truncate">{text}</span>
                              </motion.li>
                            ))}
                          </ol>
                        )}
                        <CommandPreview lines={preview} />
                      </>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function Summary({
  repo,
  branch,
  mode,
  base,
  path,
  agent,
  agentAi,
  model,
  onEdit,
  branchEdit,
}: {
  repo: string;
  branch: string;
  mode: "new" | "existing";
  base?: string;
  path: string;
  agent: string | null;
  /** The agent name is the tiny model's (✨). */
  agentAi?: boolean;
  model: string;
  onEdit: (step: number) => void;
  /** Inline editor for an auto-named branch (replaces the jump-to-step row). */
  branchEdit?: ReactNode;
}) {
  const rows: { icon: typeof Cpu; k: string; v: string; step: number; ai?: boolean; edit?: ReactNode }[] = [
    { icon: FolderGit2, k: "Repository", v: repo, step: 0 },
    { icon: mode === "new" ? GitBranchPlus : GitBranch, k: mode === "new" ? `New branch from ${base}` : "Existing branch", v: branch, step: 1, edit: branchEdit },
    { icon: FolderGit2, k: "Checkout", v: path, step: 1 },
    { icon: Cpu, k: "Agent", v: agent ? `${agent} · ${model}` : "none", step: 2, ai: agentAi },
  ];
  const tile = (r: (typeof rows)[number]) => (
    <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgb(163_92_240/0.25)]">
      <r.icon className="size-4" />
    </span>
  );
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {rows.map((r, i) =>
        r.edit ? (
          <motion.div
            key={r.k}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.smooth, delay: i * 0.04 }}
            className="flex items-center gap-3 rounded-md bg-white/4 px-3 py-2 shadow-hairline"
          >
            {tile(r)}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-2xs font-bold text-mute-2">{r.k}</span>
              {r.edit}
            </span>
          </motion.div>
        ) : (
          <motion.button
            key={r.k}
            type="button"
            onClick={() => onEdit(r.step)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.smooth, delay: i * 0.04 }}
            title={r.v}
            aria-label={`${r.k}: ${r.v}. Edit`}
            className="group flex items-center gap-3 rounded-md bg-white/4 px-3 py-2.5 text-left shadow-hairline transition-colors focus-ring pressable hover:bg-white/7"
          >
            {tile(r)}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-2xs font-bold text-mute-2">{r.k}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs font-semibold text-ink">{r.v}</span>
                {r.ai && <AiMark />}
              </span>
            </span>
            <Pencil className="size-3.5 shrink-0 text-mute-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60" aria-hidden />
          </motion.button>
        ),
      )}
    </div>
  );
}

interface FailureCalloutProps {
  failure: HerdrFailure;
  home?: string;
  branch: string;
  onTrust: () => void;
  onUseExisting: () => void;
  onNewName: () => void;
  onOtherPath: () => void;
  onOpenCheckout: (path: string) => void;
  onPickRepo: () => void;
}

/** Actionable fixes for herdr's known worktree failures (`docs/research/herdr.md` §8). */
function FailureCallout({ failure, home, branch, onTrust, onUseExisting, onNewName, onOtherPath, onOpenCheckout, onPickRepo }: FailureCalloutProps) {
  let title: string;
  let body: ReactNode;
  let actions: ReactNode;
  let tone: "warn" | "error" = "warn";
  switch (failure.kind) {
    case "untrusted":
      title = "This repository is owned by another user";
      body = (
        <>
          git refuses to operate on it (“dubious ownership”). Trusting it makes herdr pass <code className="font-mono">-c safe.directory=&lt;repo&gt;</code> to
          its own git commands only. Your gitconfig is not changed.
        </>
      );
      actions = (
        <Button variant="primary" size="sm" icon={<ShieldAlert />} onClick={onTrust}>
          Trust this repository & create
        </Button>
      );
      break;
    case "branchInUse":
      title = `${failure.branch ?? branch} is already checked out`;
      body = failure.path ? (
        <>
          git allows a branch in one worktree at a time. It's checked out at <span className="font-mono">{tildify(failure.path, home)}</span>.
        </>
      ) : (
        "git allows a branch in one worktree at a time."
      );
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={onNewName}>
            Branch off it instead
          </Button>
          {failure.path && (
            <Button size="sm" onClick={() => onOpenCheckout(failure.path ?? "")}>
              Go to that checkout
            </Button>
          )}
        </>
      );
      break;
    case "branchExists":
      title = `A branch named ${failure.branch ?? branch} already exists`;
      body = "Check it out into the new worktree instead of creating it.";
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={onUseExisting}>
            Use existing branch
          </Button>
          <Button size="sm" onClick={onNewName}>
            Pick another name
          </Button>
        </>
      );
      break;
    case "pathExists":
      title = "The checkout path already exists";
      body = (
        <>
          <span className="font-mono">{tildify(failure.path ?? "", home)}</span> is already on disk — probably an earlier worktree for this branch.
        </>
      );
      actions = (
        <>
          <Button size="sm" variant="primary" onClick={onOtherPath}>
            Use another path
          </Button>
          {failure.path && (
            <Button size="sm" onClick={() => onOpenCheckout(failure.path ?? "")}>
              Open the existing checkout
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onUseExisting}>
            Use existing branch
          </Button>
        </>
      );
      break;
    case "notRepo":
      title = "That folder isn't inside a git repository";
      body = "Pick a repository root (folders with the git icon).";
      actions = (
        <Button size="sm" variant="primary" onClick={onPickRepo}>
          Choose another folder
        </Button>
      );
      break;
    default:
      tone = "error";
      title = "Couldn't create the worktree";
      body = (
        <>
          <span className="block font-mono text-2xs whitespace-pre-wrap">{failure.error.message}</span>
          {failure.error.hint && <span className="mt-1 block">{failure.error.hint}</span>}
        </>
      );
      actions = null;
  }
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, x: [0, -6, 5, -3, 0] }}
      transition={{ ...spring.smooth, x: { duration: 0.4 } }}
      className={cn(
        "flex gap-3 rounded-lg p-3.5",
        tone === "warn" ? "bg-warn/8 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]" : "bg-error/10 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]",
      )}
    >
      <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", tone === "warn" ? "text-warn" : "text-error")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm font-bold">{title}</p>
        <div className="text-xs leading-relaxed text-ink-2">{body}</div>
        {actions && <div className="mt-1 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </motion.div>
  );
}
