import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, GitBranch, LayoutDashboard, Plus, RotateCcw, ShieldAlert, Sparkles, Split, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core, draftKey, navigate, suggestBranch, useAiNaming, useAiSuggestion, useDraft, useDraftState, useHostIds, useHostState, useHosts, useSettings } from "@/core";
import type { AgentSpec, AgentTemplate, Started, ThinkingLevel, WorktreeCreateParams } from "@/core/gen";
import { Button, Chip, Field, IconButton, Input, Select, type SelectOption, SegmentedControl, Shimmer, Switch, Textarea, cn, spring, useIsMobile } from "@/design";
import { useBoard } from "@/features/board/boardStore";
import { ACTIONS } from "@/features/shell/vocab";
import { AiMark } from "../workspace/shared/ai";
import { useModelCatalog } from "../workspace/shared/AgentFields";
import { CommandPreview, type PreviewLine } from "../workspace/shared/CommandPreview";
import { herdrArgv } from "../workspace/shared/commands";
import { classifyHerdrError, describeError } from "../workspace/shared/errors";
import { AGENT_NAME_MAX, basename, clipName, shellQuote, tildify } from "../workspace/shared/paths";
import { ResponsiveDialog } from "../workspace/shared/ResponsiveDialog";
import { templateSummary } from "../workspace/shared/templates";
import { slugFromPrompt, slugify } from "../workspace/shared/slug";
import { useDialogSession } from "../workspace/shared/useDialogSession";
import { useHostQuery } from "../workspace/shared/useHostQuery";
import { FolderBrowser, type FolderPick } from "./FolderBrowser";
import { StepRail } from "./StepRail";

/** Fan-out branches are `fanout/<slug>/<variant>`, so Review can find the siblings of any of them. */
export const FANOUT_PREFIX = "fanout/";

/** `fanout/<slug>/<variant>` → `{ slug, variant }`. */
export function parseFanOutBranch(branch: string | undefined): { slug: string; variant: string } | null {
  const m = branch?.match(/^fanout\/([^/]+)\/([^/]+)$/);
  return m?.[1] && m[2] ? { slug: m[1], variant: m[2] } : null;
}

const STEPS = ["Repository", "Task & variants", "Launch"] as const;
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 5;
/** Variant keys: short enough that `<slug>-<key>` keeps a useful slug within herdr's 32-char names. */
const MAX_KEY = 16;
const CUSTOM = "__custom";
const DEFAULT = "default";

interface Variant {
  id: number;
  key: string;
  keyTouched: boolean;
  templateId: string | null;
  model: string;
  thinking: ThinkingLevel | "default";
  plan: boolean;
}

function variantKeyFor(v: Pick<Variant, "templateId" | "model">, templates: readonly AgentTemplate[]): string {
  const t = templates.find((x) => x.id === v.templateId);
  if (t) return slugify(t.name.split(/\s+/)[0] ?? t.name, 12) || "variant";
  const model = v.model === DEFAULT ? "default" : (v.model.split("/").pop() ?? v.model);
  return slugify(model.split(/[-.:]/)[0] ?? model, 12) || "variant";
}

/** Unique keys: a repeated `opus` becomes `opus-2`. Typed keys win. */
function dedupeKeys(vs: Variant[], templates: readonly AgentTemplate[]): Variant[] {
  const used = new Set<string>();
  return vs.map((v) => {
    const base = v.keyTouched ? v.key : variantKeyFor(v, templates);
    let key = base;
    for (let i = 2; !v.keyTouched && used.has(key); i++) key = `${base}-${i}`;
    used.add(key);
    return { ...v, key };
  });
}

type RowPhase = "queued" | "creating" | "starting" | "running" | "failed";
interface Row {
  key: string;
  phase: RowPhase;
  started?: Started;
  path?: string;
  error?: { title: string; hint?: string; untrusted: boolean };
}

/** Mounted once by the shell; renders while `useUi().dialog.kind === "fanOut"`. */
export function FanOutDialog() {
  const { open, payload, gen, close } = useDialogSession("fanOut");
  if (!payload) return null;
  return <FanOut key={gen} open={open} initialHostId={payload.hostId} initialCwd={payload.cwd} initialPrompt={payload.prompt} onClose={close} />;
}

function FanOut({ open, initialHostId, initialCwd, initialPrompt, onClose }: { open: boolean; initialHostId?: string; initialCwd?: string; initialPrompt?: string; onClose: () => void }) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const profiles = useHosts((s) => s.profiles);
  const templates = useSettings((s) => s.templates);
  const [hostId, setHostId] = useState<string | undefined>(initialHostId ?? hostIds[0]);
  const host = useHostState(hostId ?? "");
  const home = host?.info.home;
  const catalog = useModelCatalog(hostId);

  const [step, setStep] = useState(initialCwd ? 1 : 0);
  const [repo, setRepo] = useState<FolderPick | null>(initialCwd ? { path: initialCwd } : null);
  // task, name and variants persist per host + repository until every variant has launched
  const scope = [hostId ?? "", repo?.path ?? ""] as const;
  const [prompt, setPrompt, clearPrompt] = useDraft(draftKey("fanOut.prompt", ...scope));
  const [slug, setSlug, clearSlug] = useDraft(draftKey("fanOut.slug", ...scope));
  const slugTouched = slug !== "";
  const [base, setBase] = useState("");
  const [trust, setTrust] = useState(false);
  const [variants, setVariants, clearVariants] = useDraftState<Variant[]>(draftKey("fanOut.variants", ...scope), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [nextId, setNextId] = useState(1);
  /** The fan-out name at launch: the rows and the board filter keep it after the drafts clear. */
  const [launchedSlug, setLaunchedSlug] = useState("");

  // A task handed over by the caller (New worktree's "Try N approaches", Dispatch) replaces the stored
  // one, and follows the user (with their edits) to whichever repository they pick.
  const handed = useRef(initialPrompt ?? "");
  useEffect(() => {
    if (initialPrompt) setPrompt(handed.current);
  }, [hostId, repo?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hostId && hostIds[0]) setHostId(hostIds[0]);
  }, [hostId, hostIds]);

  // Seed 3 variants from the first templates, topped up with distinct catalog models (once a repo
  // is picked, so the seed lands in its draft; never after launch, when the drafts get cleared).
  const seeded = variants.length > 0;
  const canSeed = !!repo && rows === null;
  useEffect(() => {
    if (seeded || !canSeed || (!templates.length && !catalog)) return;
    const vs: Variant[] = templates.slice(0, 3).map((t, i) => ({ id: i + 1, key: "", keyTouched: false, templateId: t.id, model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan }));
    for (const m of catalog?.models ?? []) {
      if (vs.length >= 3) break;
      const id = `${m.provider}/${m.id}`;
      if (vs.some((v) => v.model === id)) continue;
      vs.push({ id: vs.length + 1, key: "", keyTouched: false, templateId: null, model: id, thinking: DEFAULT, plan: false });
    }
    while (vs.length < MIN_VARIANTS) vs.push({ id: vs.length + 1, key: "", keyTouched: false, templateId: null, model: DEFAULT, thinking: DEFAULT, plan: false });
    setVariants(dedupeKeys(vs, templates));
    setNextId(vs.length + 1);
  }, [seeded, canSeed, templates, catalog]);

  const branches = useHostQuery(hostId, "git.branches", repo ? { cwd: repo.path } : null);
  const baseRef = base || branches.data?.defaultBranch || "HEAD";
  const task = prompt.trim();
  // untouched name: the tiny model's slug for the task, else the task's own words
  const aiOn = useAiNaming(hostId);
  const aiKey = aiOn && hostId && !slugTouched && task ? `${hostId}\n${repo?.path ?? ""}\n${task}` : null;
  const aiSlugRaw = useAiSuggestion(hostId, aiKey, () => (hostId ? suggestBranch(hostId, task, { cwd: repo?.path }) : Promise.resolve(null)), { debounceMs: 700 });
  // whole words only: the tiny model's slug may be up to 40 chars, fan-out names stay ≤ 24
  const aiFull = aiKey && aiSlugRaw.value ? slugify(aiSlugRaw.value, 40) : "";
  const aiSlug = aiFull.length <= 24 ? aiFull : aiFull.slice(0, 25).replace(/-?[^-]*$/, "");
  const effSlug = slugTouched ? slugify(slug, 24) : aiSlug || slugFromPrompt(prompt);
  const takenNames = host?.agents.map((a) => a.name) ?? [];
  const existingBranches = new Set(branches.data?.branches.map((b) => b.name));
  const branchOf = (v: Variant) => `${FANOUT_PREFIX}${effSlug}/${v.key}`;
  // herdr agent names stay ≤ 32: the slug gives way (at a word boundary), the variant key never does
  const nameOf = (v: Variant) => `${clipName(effSlug, AGENT_NAME_MAX - 1 - v.key.length)}-${v.key}`;

  const variantErrors = variants.map((v) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v.key)) return "Lowercase letters, digits and - only";
    if (v.key.length > MAX_KEY) return `At most ${MAX_KEY} characters`;
    if (variants.filter((x) => x.key === v.key).length > 1) return "Two variants share this name";
    if (effSlug && existingBranches.has(branchOf(v))) return `${branchOf(v)} already exists`;
    if (effSlug && takenNames.includes(nameOf(v))) return `An agent named ${nameOf(v)} is running`;
    return null;
  });
  const setupValid = !!prompt.trim() && !!effSlug && variants.length >= MIN_VARIANTS && variantErrors.every((e) => !e);
  const valid = [!!repo && !!hostId, setupValid, setupValid];
  const maxReachable = valid[0] ? (valid[1] ? 2 : 1) : 0;
  const launched = rows !== null;

  const updateVariant = (id: number, patch: Partial<Variant>) => setVariants((vs) => dedupeKeys(vs.map((v) => (v.id === id ? { ...v, ...patch } : v)), templates));
  const addVariant = () => {
    const used = new Set(variants.map((v) => v.templateId));
    const t = templates.find((x) => !used.has(x.id));
    // restored variants may already use ids past the counter
    const id = Math.max(nextId, ...variants.map((x) => x.id + 1));
    const v: Variant = t
      ? { id, key: "", keyTouched: false, templateId: t.id, model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan }
      : { id, key: "", keyTouched: false, templateId: null, model: DEFAULT, thinking: DEFAULT, plan: false };
    setNextId(id + 1);
    setVariants((vs) => dedupeKeys([...vs, v], templates));
  };

  const specOf = (v: Variant): AgentSpec => {
    const t = templates.find((x) => x.id === v.templateId);
    const task = prompt.trim();
    return {
      kind: "omp",
      name: nameOf(v),
      model: v.model === DEFAULT ? undefined : v.model,
      thinking: v.thinking === DEFAULT ? undefined : v.thinking,
      plan: v.plan,
      // A template's own instructions frame the shared task.
      prompt: t?.prompt ? `${t.prompt.trim()}\n\n${task}` : task,
    };
  };
  const paramsOf = (v: Variant, trustRepo: boolean): WorktreeCreateParams | null =>
    repo
      ? {
          cwd: repo.path,
          branch: branchOf(v),
          base: baseRef !== "HEAD" ? baseRef : undefined,
          label: nameOf(v),
          existing: false,
          trust: trustRepo,
          agent: specOf(v),
        }
      : null;

  const setRow = (key: string, patch: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.key === key ? { ...r, ...patch } : r)) ?? rs);

  const createOne = async (v: Variant, trustRepo: boolean) => {
    const p = paramsOf(v, trustRepo);
    if (!p || !hostId) return;
    setRow(v.key, { phase: "creating", error: undefined });
    try {
      const created = await core.host(hostId).call("worktree.create", p);
      setRow(v.key, { phase: created.agent ? "starting" : "running", started: created.agent, path: created.path });
    } catch (e) {
      const f = classifyHerdrError(e);
      setRow(v.key, { phase: "failed", error: { ...describeError(e), untrusted: f.kind === "untrusted" } });
    }
  };

  const launch = () => {
    if (!setupValid || launched) return;
    setStep(2);
    setLaunchedSlug(effSlug);
    setRows(variants.map((v) => ({ key: v.key, phase: "queued" })));
    // Staggered so the rows visibly start one after another (and herdr isn't hit all at once).
    variants.forEach((v, i) => window.setTimeout(() => void createOne(v, trust), i * 180));
  };

  const retryFailed = (trustRepo: boolean) => {
    if (trustRepo) setTrust(true);
    variants.forEach((v) => rows?.find((r) => r.key === v.key)?.phase === "failed" && void createOne(v, trustRepo || trust));
  };

  // starting → running once the new agent shows up in host state.
  const agents = host?.agents;
  useEffect(() => {
    if (!rows || !agents) return;
    for (const r of rows) {
      if (r.phase !== "starting" || !r.started) continue;
      const started = r.started;
      if (agents.some((a) => (started.agentId && a.id === started.agentId) || a.paneId === started.paneId)) setRow(r.key, { phase: "running" });
    }
  }, [rows, agents]);

  const done = !!rows && rows.every((r) => r.phase === "running" || r.phase === "failed");
  const ok = rows?.filter((r) => r.phase === "running").length ?? 0;
  const failed = rows?.filter((r) => r.phase === "failed") ?? [];
  const openBoard = () => {
    useBoard.getState().setQ(launchedSlug);
    onClose();
    navigate({ name: "board" });
  };
  // All good: hold the finished state for a beat, then land on the board filtered to the siblings.
  // Keyed on the outcome only, so host-state patches arriving meanwhile don't restart the timer.
  const allRunning = done && failed.length === 0 && ok > 0;
  useEffect(() => {
    if (!allRunning) return;
    clearPrompt();
    clearSlug();
    clearVariants();
    const t = window.setTimeout(openBoard, 1400);
    return () => window.clearTimeout(t);
  }, [allRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = host?.info.herdrSession;
  const preview: PreviewLine[] = repo
    ? variants.map((v) => ({
        argv: herdrArgv(
          session,
          "worktree",
          "create",
          "--cwd",
          shellQuote(tildify(repo.path, home)),
          "--branch",
          shellQuote(branchOf(v)),
          baseRef !== "HEAD" && "--base",
          baseRef !== "HEAD" && shellQuote(baseRef),
          "--label",
          shellQuote(nameOf(v)),
          "--no-focus",
          trust && "--trust-repository",
        ),
        note: `${nameOf(v)} · ${v.model === DEFAULT ? "default model" : v.model}${v.thinking !== DEFAULT ? ` · ${v.thinking}` : ""}${v.plan ? " · plan" : ""}`,
      }))
    : [];

  const templateOptions: SelectOption[] = [
    ...templates.map((t) => ({ value: t.id, label: t.name, hint: templateSummary(t) })),
    { value: CUSTOM, label: "Custom model…", hint: "pick a model and thinking level" },
  ];
  const modelOptions: SelectOption[] = [
    { value: DEFAULT, label: "Host default", icon: <Sparkles /> },
    ...(catalog?.models ?? []).map((m) => ({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider })),
  ];
  const thinkingOptions: SelectOption[] = [{ value: DEFAULT, label: "Default" }, ...(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((l) => ({ value: l, label: l }))];
  const baseOptions: SelectOption[] = [
    ...(branches.data?.defaultBranch ? [{ value: branches.data.defaultBranch, label: branches.data.defaultBranch, hint: "default branch" }] : []),
    ...(branches.data?.branches ?? []).filter((b) => b.name !== branches.data?.defaultBranch && !/\/HEAD$/.test(b.name)).map((b) => ({ value: b.name, label: b.name, hint: b.remote ? "remote" : undefined })),
    { value: "HEAD", label: "HEAD" },
  ];

  const footer = (
    <div className="flex w-full items-center gap-2">
      {step > 0 && !launched && (
        <Button variant="ghost" icon={<ArrowLeft />} onClick={() => setStep(step - 1)}>
          Back
        </Button>
      )}
      {!mobile && <span className="flex-1" />}
      {!launched ? (
        step === 0 ? (
          <Button variant="primary" trailing={<ArrowRight />} disabled={!valid[0]} onClick={() => setStep(1)} className={mobile ? "flex-1" : undefined}>
            {repo ? `Continue with ${basename(repo.path)}` : "Continue"}
          </Button>
        ) : (
          <Button variant="primary" icon={<Split />} disabled={!setupValid} onClick={launch} className={mobile ? "flex-1" : undefined}>
            Launch {variants.length} agents
          </Button>
        )
      ) : done ? (
        <>
          {failed.length > 0 && (
            <Button icon={<RotateCcw />} onClick={() => retryFailed(false)}>
              Retry {failed.length} failed
            </Button>
          )}
          <Button variant="primary" icon={<LayoutDashboard />} disabled={ok === 0} onClick={openBoard} className={mobile ? "flex-1" : undefined}>
            {ok === 0 ? "Nothing launched" : `Open the ${ok} on the board`}
          </Button>
        </>
      ) : (
        <Shimmer className="text-xs font-semibold">Launching {rows?.length} agents…</Shimmer>
      )}
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && (!launched || done) && onClose()}
      title="Fan out"
      description={repo && step > 0 ? <span className="font-mono">{tildify(repo.path, home)}</span> : ACTIONS.fanOut.description}
      icon={<Split />}
      width={800}
      maxHeight="94dvh"
      footer={footer}
    >
      <div className="flex flex-col gap-5 md:min-h-[min(480px,calc(100dvh-264px))]">
        <StepRail steps={STEPS} current={step} reachable={launched ? step : maxReachable} onJump={(i) => !launched && setStep(i)} />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={spring.smooth} className="flex flex-col gap-4">
            {step === 0 && hostId && (
              <>
                {hostIds.length > 1 && (
                  <SegmentedControl
                    size="sm"
                    value={hostId}
                    onValueChange={(id) => {
                      setHostId(id);
                      setRepo(null);
                    }}
                    options={hostIds.map((id) => ({ value: id, label: profiles.find((p) => p.id === id)?.name ?? id }))}
                    aria-label="Host"
                  />
                )}
                <FolderBrowser
                  key={hostId}
                  hostId={hostId}
                  mode="repo"
                  value={repo?.path}
                  initialPath={initialCwd}
                  autoFocus={!mobile}
                  onSelect={setRepo}
                  onConfirm={(p) => {
                    setRepo(p);
                    setStep(1);
                  }}
                />
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Task" hint="sent to every variant">
                  {(id) => (
                    <Textarea
                      id={id}
                      autoFocus={!mobile}
                      value={prompt}
                      onChange={(e) => {
                        handed.current = e.target.value;
                        setPrompt(e.target.value);
                      }}
                      placeholder="What should the agents build? Each variant gets the same prompt."
                      className="min-h-[3lh]"
                      maxHeight={160}
                    />
                  )}
                </Field>
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <Field
                    label="Fan-out name"
                    hint={
                      slugTouched ? undefined : aiSlug ? (
                        <span className="flex items-center gap-1">
                          auto <AiMark />
                        </span>
                      ) : aiKey && aiSlugRaw.loading ? (
                        "naming…"
                      ) : (
                        "auto"
                      )
                    }
                    description={effSlug ? `Branches ${FANOUT_PREFIX}${effSlug}/<variant>` : undefined}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        value={slugTouched ? slug : effSlug}
                        placeholder="derived from the task"
                        trailing={!slugTouched && aiSlug ? <AiMark /> : undefined}
                        onChange={(e) => setSlug(e.target.value)}
                        className="font-mono text-xs"
                        spellCheck={false}
                        autoCapitalize="off"
                      />
                    )}
                  </Field>
                  <Field label="Base" hint="branch from">
                    {(id) => <Select id={id} value={baseRef} onValueChange={setBase} options={baseOptions} className="w-full" aria-label="Base ref" />}
                  </Field>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-2xs font-bold tracking-[0.02em] text-mute">Variants</span>
                  <Chip className="h-5 px-2 text-2xs">{variants.length}</Chip>
                  <Button size="sm" variant="ghost" icon={<Plus />} className="ml-auto" onClick={addVariant} disabled={variants.length >= MAX_VARIANTS}>
                    Add variant
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {variants.map((v, i) => {
                      const custom = v.templateId === null;
                      const err = variantErrors[i];
                      return (
                        <motion.div
                          key={v.id}
                          layout
                          initial={{ opacity: 0, y: 8, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.96 }}
                          transition={spring.smooth}
                          className={cn("rounded-lg bg-white/[0.035] p-3 shadow-hairline", err && "shadow-[inset_0_0_0_1px_rgb(255_77_94/0.45)]")}
                        >
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 md:grid-cols-[150px_minmax(0,1fr)_auto]">
                            <Input
                              value={v.key}
                              onChange={(e) => updateVariant(v.id, { key: slugify(e.target.value, 12), keyTouched: e.target.value !== "" })}
                              leading={<span className="font-mono text-2xs text-mute-2">{i + 1}</span>}
                              className="font-mono text-xs"
                              aria-label={`Variant ${i + 1} name`}
                              invalid={!!err}
                              spellCheck={false}
                            />
                            <IconButton label={`Remove variant ${v.key}`} size="sm" className="mt-1.5 md:order-3" onClick={() => setVariants((vs) => vs.filter((x) => x.id !== v.id))} disabled={variants.length <= MIN_VARIANTS}>
                              <Trash2 />
                            </IconButton>
                            <div className="col-span-2 flex flex-col gap-2 md:col-span-1">
                              <Select
                                value={v.templateId ?? CUSTOM}
                                onValueChange={(val) => {
                                  const t = templates.find((x) => x.id === val);
                                  updateVariant(v.id, t ? { templateId: t.id, model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan } : { templateId: null });
                                }}
                                options={templateOptions}
                                className="w-full"
                                aria-label={`Variant ${i + 1} template`}
                              />
                              {custom && (
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
                                  <Select value={v.model} onValueChange={(m) => updateVariant(v.id, { model: m })} options={modelOptions} className="w-full" aria-label={`Variant ${i + 1} model`} />
                                  <Select value={v.thinking} onValueChange={(t) => updateVariant(v.id, { thinking: t as Variant["thinking"] })} options={thinkingOptions} className="w-full min-w-0" aria-label={`Variant ${i + 1} thinking`} />
                                  <label className="flex h-10 items-center gap-2 text-xs font-semibold text-mute">
                                    <Switch checked={v.plan} onCheckedChange={(p) => updateVariant(v.id, { plan: p })} label={`Variant ${i + 1} plan mode`} />
                                    Plan
                                  </label>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="mt-1.5 flex items-center gap-2 font-mono text-2xs text-mute-2">
                            <GitBranch className="size-3" />
                            <span className="truncate">{effSlug ? branchOf(v) : "…"}</span>
                            {err && <span className="ml-auto shrink-0 font-sans font-semibold text-error">{err}</span>}
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
                {preview.length > 0 && <CommandPreview lines={preview} />}
              </>
            )}

            {step === 2 && rows && (
              <div className="flex flex-col gap-2" role="status" aria-live="polite">
                {rows.map((r, i) => (
                  <LaunchRow key={r.key} row={r} index={i} name={`${launchedSlug}-${r.key}`} home={home} />
                ))}
                {failed.some((r) => r.error?.untrusted) && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warn/8 p-3 text-xs shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]">
                    <ShieldAlert className="size-4 text-warn" />
                    <span className="min-w-0 flex-1">
                      git refuses this repository (“dubious ownership”). Trusting it passes <code className="font-mono">-c safe.directory</code> to herdr's git commands only.
                    </span>
                    <Button size="sm" variant="primary" onClick={() => retryFailed(true)}>
                      Trust & retry
                    </Button>
                  </div>
                )}
                <AnimatePresence>
                  {done && failed.length === 0 && (
                    <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring.bouncy} className="flex items-center justify-center gap-2 pt-2 text-sm font-bold text-done">
                      <Check className="size-4" /> All {ok} agents are running. Opening the board…
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </ResponsiveDialog>
  );
}

const PHASES: { phase: RowPhase; label: string; at: number }[] = [
  { phase: "queued", label: "Queued", at: 0.06 },
  { phase: "creating", label: "Creating worktree", at: 0.55 },
  { phase: "starting", label: "Starting agent", at: 0.85 },
  { phase: "running", label: "Running", at: 1 },
];

function LaunchRow({ row, index, name, home }: { row: Row; index: number; name: string; home?: string }) {
  const meta = PHASES.find((p) => p.phase === row.phase);
  const failed = row.phase === "failed";
  const live = row.phase === "creating" || row.phase === "starting";
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0, ...(failed ? { x: [0, -5, 4, -2, 0] } : {}) }}
      transition={{ ...spring.smooth, delay: index * 0.06 }}
      className={cn(
        "relative overflow-hidden rounded-lg p-3 transition-[background-color,box-shadow] duration-500",
        failed ? "bg-error/8 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]" : row.phase === "running" ? "bg-done/8 shadow-[inset_0_0_0_1px_rgb(163_230_53/0.35)]" : "bg-white/[0.035] shadow-hairline",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "relative grid size-8 shrink-0 place-items-center rounded-full text-xs font-extrabold",
            failed ? "bg-error/20 text-error" : row.phase === "running" ? "bg-done/20 text-done" : live ? "bg-omp text-white shadow-glow-accent" : "bg-tile-3 text-mute",
          )}
        >
          {failed ? <X className="size-4" /> : row.phase === "running" ? <Check className="size-4" strokeWidth={3} /> : index + 1}
          {live && <span className="tf-loop absolute -inset-1 animate-spin rounded-full [background:conic-gradient(from_0deg,transparent_0%,#f053d0_35%,#7fa2e7_60%,transparent_75%)] [mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-1.5px))]" aria-hidden />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm font-bold">{name}</span>
          {failed ? (
            <span className="truncate text-2xs text-error" title={row.error?.hint}>
              {row.error?.title}
            </span>
          ) : live ? (
            <Shimmer className="text-2xs font-semibold">{meta?.label}…</Shimmer>
          ) : (
            <span className="truncate text-2xs text-mute">{row.phase === "running" && row.path ? tildify(row.path, home) : meta?.label}</span>
          )}
        </span>
        <span className="hidden gap-1 sm:flex" aria-hidden>
          {PHASES.slice(1).map((p) => {
            const reached = !failed && (meta?.at ?? 0) >= p.at;
            return <span key={p.phase} title={p.label} className={cn("h-1.5 w-6 rounded-full transition-colors duration-500", reached ? (p.phase === "running" ? "bg-done" : "bg-accent") : "bg-white/10")} />;
          })}
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/5">
        <motion.div
          className={cn("h-full", failed ? "bg-error" : row.phase === "running" ? "bg-done" : "bg-omp")}
          initial={{ width: "0%" }}
          animate={{ width: `${(failed ? 1 : (meta?.at ?? 0)) * 100}%` }}
          transition={live ? { duration: row.phase === "creating" ? 2.4 : 1.6, ease: [0.2, 0.8, 0.2, 1] } : spring.smooth}
        />
      </div>
    </motion.div>
  );
}
