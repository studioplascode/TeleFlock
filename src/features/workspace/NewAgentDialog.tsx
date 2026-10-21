import { AnimatePresence, motion } from "motion/react";
import { Bot, Columns2, FolderOpen, FolderPlus, Layers, PanelTop, Rows2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { core, useHostIds, useHostState, useHosts, useSettings, useUi } from "@/core";
import type { Split, Started, StartTarget, Workspace } from "@/core/gen";
import { Button, Chip, EmptyState, Field, IconButton, Input, Kbd, SegmentedControl, StatusOrb, type Status, Switch, cn, spring, toast, useIsMobile } from "@/design";
import { FolderBrowser, type FolderPick } from "../worktree/FolderBrowser";
import { AgentFields, type AgentDraft, agentNameError, initialAgentDraft, toAgentSpec, uniqueAgentName } from "./shared/AgentFields";
import { CommandPreview, type PreviewLine } from "./shared/CommandPreview";
import { agentLaunchLines, herdrArgv } from "./shared/commands";
import { describeError } from "./shared/errors";
import { LaunchSuccess, WorkingPanel } from "./shared/LaunchProgress";
import { OpsOverlayHost } from "./shared/overlays";
import { agentNameFromBranch, basename, shellQuote, tildify } from "./shared/paths";
import { ResponsiveDialog } from "./shared/ResponsiveDialog";
import { useDialogSession } from "./shared/useDialogSession";

export type NewAgentMode = "workspace" | "folder";

/**
 * Extra intent for the next `newAgent` dialog open (the ui dialog payload only carries host and
 * workspace). `openFolder: true` = the "Open folder" action: a workspace without an agent.
 */
let pendingIntent: { mode: NewAgentMode; openFolder: boolean } | null = null;

/** Open the New agent dialog; `openFolder` starts in folder mode with the agent switched off. */
export function openNewAgent(opts: { hostId?: string; workspaceId?: string; mode?: NewAgentMode; openFolder?: boolean } = {}) {
  pendingIntent = { mode: opts.openFolder ? "folder" : (opts.mode ?? "workspace"), openFolder: !!opts.openFolder };
  useUi.getState().openDialog({ kind: "newAgent", hostId: opts.hostId, workspaceId: opts.workspaceId });
}

/** Mounted once by the shell. Also hosts the confirm/rename overlays used by `workspaceActions`. */
export function NewAgentDialog() {
  const { open, payload, gen, close } = useDialogSession("newAgent");
  return (
    <>
      {payload && <NewAgentBody key={gen} open={open} initialHostId={payload.hostId} initialWorkspaceId={payload.workspaceId} onClose={close} />}
      <OpsOverlayHost />
    </>
  );
}

const ROLLUP_STATUS: Record<Workspace["rollup"], Status> = { working: "running", blocked: "needs-you", idle: "review", done: "review", unknown: "idle" };

type Submit = { phase: "idle" } | { phase: "working"; since: number } | { phase: "failed"; title: string; hint?: string } | { phase: "done"; started: Started };

function NewAgentBody({ open, initialHostId, initialWorkspaceId, onClose }: { open: boolean; initialHostId?: string; initialWorkspaceId?: string; onClose: () => void }) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const profiles = useHosts((s) => s.profiles);
  const openDialog = useUi((s) => s.openDialog);
  const settings = useSettings();
  // Read in the initializer (pure), cleared after commit so StrictMode's double init sees the same value.
  const [intent] = useState(() => pendingIntent);
  useEffect(() => {
    pendingIntent = null;
  }, []);
  const [hostId, setHostId] = useState<string | undefined>(initialHostId ?? hostIds[0]);
  const host = useHostState(hostId ?? "");
  const home = host?.info.home;
  const [mode, setMode] = useState<NewAgentMode>(intent?.mode ?? "workspace");
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(initialWorkspaceId);
  const [split, setSplit] = useState<Split>("right");
  const [folder, setFolder] = useState<FolderPick | null>(null);
  const [label, setLabel] = useState("");
  const [agent, setAgent] = useState<AgentDraft>(() => ({ ...initialAgentDraft(settings), start: !intent?.openFolder }));
  const [submit, setSubmit] = useState<Submit>({ phase: "idle" });

  useEffect(() => {
    if (!hostId && hostIds[0]) setHostId(hostIds[0]);
  }, [hostId, hostIds]);

  const workspaces = useMemo(() => [...(host?.workspaces ?? [])].sort((a, b) => a.order - b.order), [host?.workspaces]);
  const ws = workspaces.find((w) => w.id === workspaceId);
  useEffect(() => {
    if (mode === "workspace" && !workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [mode, workspaceId, workspaces]);

  const takenNames = host?.agents.map((a) => a.name) ?? [];
  // a worktree is named after its branch; a primary checkout after its workspace (not "main")
  const derived = uniqueAgentName(
    mode === "workspace" ? agentNameFromBranch(ws?.worktree?.branch ?? ws?.label ?? "") : agentNameFromBranch(folder ? basename(folder.path) : ""),
    takenNames,
  );
  const name = agent.name.trim() || derived;
  const startAgent = mode === "workspace" || agent.start;
  const target: StartTarget | null =
    mode === "workspace" ? (workspaceId ? { kind: "workspace", workspaceId, split } : null) : folder ? { kind: "cwd", cwd: folder.path, label: label.trim() || null } : null;
  const valid = !!hostId && !!target && (!startAgent || !agentNameError(name, takenNames));
  const busy = submit.phase === "working" || submit.phase === "done";

  const run = async () => {
    if (!valid || !hostId || !target || busy) return;
    setSubmit({ phase: "working", since: Date.now() });
    try {
      if (!startAgent && target.kind === "cwd") {
        const ref = await core.host(hostId).call("workspace.create", { cwd: target.cwd, label: target.label ?? undefined });
        onClose();
        toast({
          title: `Opened ${basename(target.cwd)}`,
          description: tildify(target.cwd, home),
          status: "review",
          action: { label: "Start an agent", onClick: () => openNewAgent({ hostId, workspaceId: ref.workspaceId }) },
        });
        return;
      }
      const started = await core.host(hostId).call("agent.start", { target, spec: toAgentSpec({ ...agent, name }) });
      setSubmit({ phase: "done", started });
    } catch (e) {
      const d = describeError(e);
      setSubmit({ phase: "failed", ...d });
    }
  };

  const session = host?.info.herdrSession;
  const spec = toAgentSpec({ ...agent, name });
  const activePane = ws?.tabs.flatMap((t) => t.panes).find((p) => p.focused)?.id ?? ws?.tabs[0]?.panes[0]?.id ?? "<pane>";
  const preview: PreviewLine[] = !target
    ? []
    : target.kind === "workspace"
      ? [
          split === "tab"
            ? { argv: herdrArgv(session, "tab", "create", "--workspace", target.workspaceId, "--no-focus") }
            : { argv: herdrArgv(session, "pane", "split", activePane, "--direction", split) },
          ...agentLaunchLines(session, spec, "<new pane>", { name }),
        ]
      : target.kind === "cwd"
        ? [
            { argv: herdrArgv(session, "workspace", "create", "--cwd", shellQuote(tildify(target.cwd, home)), target.label ? "--label" : undefined, target.label ? shellQuote(target.label) : undefined, "--no-focus") },
            ...(startAgent ? agentLaunchLines(session, spec, "<root pane>", { name }) : []),
          ]
        : [];

  const primaryLabel = submit.phase === "failed" ? "Try again" : !target ? (mode === "workspace" ? "Pick a workspace" : "Pick a folder") : startAgent ? "Start agent" : "Open folder";
  const footer =
    submit.phase === "done" ? undefined : (
      <div className="flex w-full items-center gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {!mobile && <span className="flex-1" />}
        {!mobile && valid && (
          <span className="flex items-center gap-1 text-2xs text-mute-2" aria-hidden>
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
          </span>
        )}
        <Button
          variant="primary"
          icon={startAgent ? <Sparkles /> : <FolderOpen />}
          onClick={() => void run()}
          disabled={!valid}
          loading={submit.phase === "working"}
          className={mobile ? "flex-1" : undefined}
        >
          {primaryLabel}
        </Button>
      </div>
    );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={intent?.openFolder && !agent.start ? "Open folder" : "New agent"}
      description={mode === "workspace" ? "Start omp next to your existing work" : "Open any folder on the host as a workspace"}
      icon={<Bot />}
      width={720}
      maxHeight="94dvh"
      tall
      footer={footer}
    >
      <div
        className="flex min-h-full flex-col gap-4"
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && valid) {
            e.preventDefault();
            e.stopPropagation();
            void run();
          }
        }}
      >
        {hostIds.length === 0 ? (
          <EmptyState compact icon={<TriangleAlert />} title="No host connected" action={<Button onClick={() => openDialog({ kind: "hostEditor" })}>Add a host</Button>} />
        ) : submit.phase === "done" && hostId ? (
          <LaunchSuccess hostId={hostId} started={submit.started} title={(n) => (n ? `${n} is starting` : "Starting agent…")} subtitle={ws ? ws.label : folder ? tildify(folder.path, home) : undefined} onClose={onClose} />
        ) : submit.phase === "working" ? (
          <WorkingPanel since={submit.since} label={startAgent ? `Starting ${name}` : "Opening folder"} detail={preview[0]?.argv.join(" ")} />
        ) : (
          <>
            {submit.phase === "failed" && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0, x: [0, -6, 5, -3, 0] }}
                transition={{ ...spring.smooth, x: { duration: 0.4 } }}
                className="flex gap-3 rounded-lg bg-error/10 p-3.5 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-error" />
                <div className="min-w-0 flex-1 text-xs">
                  <p className="text-sm font-bold">Couldn't {startAgent ? "start the agent" : "open the folder"}</p>
                  <p className="mt-0.5 font-mono whitespace-pre-wrap text-ink-2">{submit.title}</p>
                  {submit.hint && <p className="mt-1 text-mute">{submit.hint}</p>}
                  <p className="mt-1.5 text-mute-2">Adjust anything below, then try again.</p>
                </div>
                <IconButton label="Dismiss" size="sm" className="-mt-1 -mr-1" onClick={() => setSubmit({ phase: "idle" })}>
                  <X />
                </IconButton>
              </motion.div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "workspace", label: "In a workspace", icon: <Layers /> },
                  { value: "folder", label: "In a folder", icon: <FolderPlus /> },
                ]}
                aria-label="Where to start"
                fill={mobile}
              />
              {hostIds.length > 1 && (
                <SegmentedControl
                  size="sm"
                  value={hostId ?? ""}
                  onValueChange={(id) => {
                    setHostId(id);
                    setWorkspaceId(undefined);
                    setFolder(null);
                  }}
                  options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
                  aria-label="Host"
                  className="md:ml-auto"
                />
              )}
            </div>

            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={mode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring.smooth} className="flex flex-col gap-4">
                {mode === "workspace" && hostId ? (
                  <>
                    <div role="radiogroup" aria-label="Workspace" className="grid max-h-[232px] grid-cols-1 gap-1.5 overflow-y-auto overscroll-contain rounded-lg well p-1.5 md:grid-cols-2">
                      {workspaces.length === 0 && <p className="col-span-full px-3 py-6 text-center text-sm text-mute">No workspaces on this host yet — start in a folder instead.</p>}
                      {workspaces.map((w) => {
                        const on = w.id === workspaceId;
                        const agents = host?.agents.filter((a) => a.workspaceId === w.id).length ?? 0;
                        return (
                          <button
                            key={w.id}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => setWorkspaceId(w.id)}
                            className={cn(
                              "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors focus-ring pressable",
                              on ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "hover:bg-white/6",
                            )}
                          >
                            <StatusOrb status={ROLLUP_STATUS[w.rollup]} size={8} label={null} />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-sm font-bold">{w.label}</span>
                              <span className="truncate font-mono text-2xs text-mute-2">{w.worktree?.branch ?? w.repo?.branch ?? tildify(w.cwd, home)}</span>
                            </span>
                            {agents > 0 && <Chip className="h-5 px-2 text-2xs">{agents} agent{agents === 1 ? "" : "s"}</Chip>}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-2xs font-bold text-mute">Place it</span>
                      <SegmentedControl
                        size="sm"
                        value={split}
                        onValueChange={setSplit}
                        options={[
                          { value: "right", label: "Split right", icon: <Columns2 /> },
                          { value: "down", label: "Split down", icon: <Rows2 /> },
                          { value: "tab", label: "New tab", icon: <PanelTop /> },
                        ]}
                        aria-label="Pane placement"
                      />
                    </div>
                  </>
                ) : hostId ? (
                  <>
                    <FolderBrowser hostId={hostId} mode="folder" value={folder?.path} onSelect={setFolder} onConfirm={(p) => setFolder(p)} autoFocus={!mobile} />
                    <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-2">
                      <Field label="Workspace label" hint="optional">
                        {(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={folder ? basename(folder.path) : "folder name"} />}
                      </Field>
                      <label className="flex h-10 cursor-pointer items-center gap-3 rounded-md well px-3.5">
                        <Bot className="size-4 text-mute" />
                        <span className="flex-1 text-sm font-bold">Start an omp agent</span>
                        <Switch checked={agent.start} onCheckedChange={(v) => setAgent((a) => ({ ...a, start: v }))} label="Start an omp agent" />
                      </label>
                    </div>
                  </>
                ) : null}

                <AnimatePresence initial={false}>
                  {startAgent && hostId && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="overflow-hidden">
                      <AgentFields hostId={hostId} draft={agent} onChange={(p) => setAgent((a) => ({ ...a, ...p }))} derivedName={derived} takenNames={takenNames} />
                    </motion.div>
                  )}
                </AnimatePresence>

                {preview.length > 0 && <CommandPreview lines={preview} />}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
    </ResponsiveDialog>
  );
}
