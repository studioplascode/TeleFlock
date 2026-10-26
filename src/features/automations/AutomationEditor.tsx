import { ArrowLeft, ClipboardList, Clock3, FolderGit2, FolderOpen, FolderSearch, GitBranchPlus, History, Power, Sparkles } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { core, toApiError, useHostState } from "@/core";
import type { Automation, AutomationDraft, ThinkingLevel } from "@/core/gen";
import { Button, Field, Input, SegmentedControl, Select, type SelectOption, Switch, Textarea, toast, useIsMobile } from "@/design";
import { useModelCatalog } from "@/features/workspace/shared/AgentFields";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { FolderBrowser, type FolderPick } from "@/features/worktree/FolderBrowser";
import { DEFAULT_SCHEDULE, type ScheduleDraft, cronToSchedule, scheduleToCron } from "./schedule";
import { ScheduleField } from "./ScheduleField";
import { useSchedulePreview } from "./useAutomations";

const DEFAULT = "default";
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface Form {
  name: string;
  cwd: string;
  worktree: boolean;
  prompt: string;
  model: string;
  thinking: ThinkingLevel | typeof DEFAULT;
  plan: boolean;
  catchUp: boolean;
  enabled: boolean;
  schedule: ScheduleDraft;
}

function initialForm(a: Automation | undefined): Form {
  if (!a) return { name: "", cwd: "", worktree: true, prompt: "", model: DEFAULT, thinking: DEFAULT, plan: false, catchUp: true, enabled: true, schedule: DEFAULT_SCHEDULE };
  return {
    name: a.name,
    cwd: a.cwd,
    worktree: a.worktree,
    prompt: a.prompt,
    model: a.model ?? DEFAULT,
    thinking: a.thinking ?? DEFAULT,
    plan: a.plan,
    catchUp: a.catchUp,
    enabled: a.enabled,
    schedule: cronToSchedule(a.schedule),
  };
}

type FieldKey = "name" | "cwd" | "prompt" | "schedule";

/** The field a save error is about (tf-hostd's `store::validate` messages), shown under it; else null. */
function errorField(message: string): FieldKey | null {
  if (/\bnames?\b/i.test(message)) return "name";
  if (/\bprompt\b/i.test(message)) return "prompt";
  if (/repository|folder|absolute path/i.test(message)) return "cwd";
  if (/schedule|never runs|minute|hour|day of|month|step|range/i.test(message)) return "schedule";
  return null;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="kicker">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({ icon, title, description, checked, onChange }: { icon: ReactNode; title: string; description: ReactNode; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md well px-3.5 py-3">
      <span className="text-mute [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-bold">{title}</span>
        <span className="text-2xs text-mute-2">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </label>
  );
}

export interface AutomationEditorProps {
  hostId: string;
  /** The automation to edit; absent: a new one. */
  automation?: Automation;
  /** Host time zone, for the preview. */
  timezone?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(a: Automation): void;
}

/** Create / edit an automation (dialog on desktop, full-height sheet on phones). Mount per opening. */
export function AutomationEditor({ hostId, automation, timezone, open, onOpenChange, onSaved }: AutomationEditorProps) {
  const mobile = useIsMobile();
  const home = useHostState(hostId)?.info.home;
  const [form, setForm] = useState<Form>(() => initialForm(automation));
  const [browsing, setBrowsing] = useState(false);
  const [pick, setPick] = useState<FolderPick | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field: FieldKey | null; message: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const patch = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };

  const cron = scheduleToCron(form.schedule);
  const preview = useSchedulePreview(hostId, cron, open);
  const scheduleProblem = preview.schedule === cron && !preview.loading && (preview.error ?? (preview.preview && !preview.preview.valid));

  const catalog = useModelCatalog(hostId);
  const defaultRole = catalog?.roles.find((r) => r.role === "default")?.model;
  const modelOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [{ value: DEFAULT, label: "Host default", hint: defaultRole ?? "omp's default role", icon: <Sparkles /> }];
    for (const m of catalog?.models ?? []) opts.push({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider });
    if (form.model !== DEFAULT && !opts.some((o) => o.value === form.model)) opts.push({ value: form.model, label: form.model, hint: "saved" });
    return opts;
  }, [catalog, defaultRole, form.model]);
  const levels = catalog?.models.find((m) => `${m.provider}/${m.id}` === form.model)?.thinking ?? [];
  const thinkingLevels = levels.length > 0 ? levels : LEVELS;
  const thinkingOptions: SelectOption[] = [{ value: DEFAULT, label: "Default" }, ...thinkingLevels.map((l) => ({ value: l, label: l[0]?.toUpperCase() + l.slice(1) }))];

  const missing = {
    name: touched && !form.name.trim() ? "Name the automation" : null,
    cwd: touched && !form.cwd.trim() ? (form.worktree ? "Pick a repository" : "Pick a folder") : null,
    prompt: touched && !form.prompt.trim() && !form.plan ? "Tell the agent what to do (or turn on plan mode)" : null,
  };
  const fieldError = (k: FieldKey) => (error?.field === k ? error.message : null) ?? (k === "schedule" ? null : missing[k]);

  const save = async () => {
    setTouched(true);
    if (!form.name.trim() || !form.cwd.trim() || (!form.prompt.trim() && !form.plan) || scheduleProblem) return;
    const draft: AutomationDraft = {
      id: automation?.id,
      name: form.name.trim(),
      enabled: form.enabled,
      schedule: cron,
      cwd: form.cwd.trim(),
      worktree: form.worktree,
      prompt: form.prompt.trim(),
      model: form.model === DEFAULT ? undefined : form.model,
      thinking: form.thinking === DEFAULT ? undefined : form.thinking,
      plan: form.plan,
      catchUp: form.catchUp,
    };
    setSaving(true);
    try {
      const saved = await core.host(hostId).call("automation.save", draft);
      toast({ title: automation ? `Saved “${saved.name}”` : `Created “${saved.name}”`, status: "done", duration: 2500 });
      onSaved(saved);
    } catch (e) {
      const err = toApiError(e);
      setError({ field: errorField(err.message), message: err.hint ? `${err.message} · ${err.hint}` : err.message });
    } finally {
      setSaving(false);
    }
  };

  const confirmPick = (p: FolderPick | null) => {
    if (!p) return;
    patch({ cwd: p.path });
    setBrowsing(false);
  };

  const footer = browsing ? (
    <div className="flex w-full items-center justify-end gap-2">
      <Button variant="ghost" icon={<ArrowLeft />} onClick={() => setBrowsing(false)}>
        Back
      </Button>
      <Button variant="primary" disabled={!pick} onClick={() => confirmPick(pick)} className={mobile ? "flex-1" : undefined}>
        {pick ? `Use ${basename(pick.path) || pick.path}` : form.worktree ? "Select a repository" : "Select a folder"}
      </Button>
    </div>
  ) : (
    <div className="flex w-full flex-col gap-2">
      {error && !error.field && <p className="text-xs font-semibold text-error">{error.message}</p>}
      <div className="flex w-full items-center justify-end gap-2">
        {!mobile && (
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        )}
        <Button variant="primary" loading={saving} onClick={() => void save()} className={mobile ? "flex-1" : undefined}>
          {automation ? "Save" : "Create automation"}
        </Button>
      </div>
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      // Esc / close while picking a folder goes back to the form instead of dropping it
      onOpenChange={(o) => (!o && browsing ? setBrowsing(false) : onOpenChange(o))}
      title={browsing ? (form.worktree ? "Pick a repository" : "Pick a folder") : automation ? "Edit automation" : "New automation"}
      description={browsing ? undefined : "An omp agent this host starts on a schedule, whether or not an app is connected."}
      icon={<Clock3 />}
      width={720}
      tall
      footer={footer}
    >
      {browsing ? (
        <div className="flex h-full min-h-0 flex-col">
          <FolderBrowser
            className="flex-1"
            hostId={hostId}
            mode={form.worktree ? "repo" : "folder"}
            value={pick?.path}
            initialPath={form.cwd || undefined}
            autoFocus={!mobile}
            onSelect={setPick}
            onConfirm={confirmPick}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-6 pb-1">
          <Field label="Name" error={fieldError("name")}>
            {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Nightly dependency audit" invalid={!!fieldError("name")} maxLength={80} />}
          </Field>

          <Section title="Where it runs">
            <SegmentedControl<"worktree" | "inPlace">
              value={form.worktree ? "worktree" : "inPlace"}
              onValueChange={(v) => patch({ worktree: v === "worktree" })}
              options={[
                { value: "worktree", label: "New worktree each run", icon: <GitBranchPlus /> },
                { value: "inPlace", label: "In place", icon: <FolderOpen /> },
              ]}
              fill
              aria-label="Where it runs"
            />
            <p className="text-xs text-mute">
              {form.worktree ? (
                <>
                  Every run forks a fresh branch <span className="font-mono text-ink-2">automation/&lt;name&gt;-&lt;date&gt;</span> from the remote's default branch, so runs never
                  touch your checkout or each other.
                </>
              ) : (
                <>The agent works directly in the folder, on whatever is checked out there. Good for read-only reports and notes.</>
              )}
            </p>
            <Field label={form.worktree ? "Repository" : "Folder"} error={fieldError("cwd")}>
              {(id) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    value={form.cwd}
                    onChange={(e) => patch({ cwd: e.target.value })}
                    placeholder={form.worktree ? "~/code/my-repo" : "~/notes"}
                    leading={form.worktree ? <FolderGit2 className="size-4 text-mute" /> : <FolderOpen className="size-4 text-mute" />}
                    invalid={!!fieldError("cwd")}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono text-xs"
                    boxClassName="flex-1 min-w-0"
                    title={form.cwd ? tildify(form.cwd, home) : undefined}
                  />
                  <Button
                    variant="secondary"
                    icon={<FolderSearch />}
                    onClick={() => {
                      setPick(form.cwd ? { path: form.cwd } : null);
                      setBrowsing(true);
                    }}
                  >
                    Browse…
                  </Button>
                </div>
              )}
            </Field>
          </Section>

          <Field label="Prompt" hint="sent as the agent's first message" error={fieldError("prompt")}>
            {(id) => (
              <Textarea
                id={id}
                value={form.prompt}
                onChange={(e) => patch({ prompt: e.target.value })}
                placeholder="What should the agent do on every run?"
                invalid={!!fieldError("prompt")}
                maxHeight={220}
                className="min-h-[4lh]"
              />
            )}
          </Field>

          <Section title="Schedule">
            <ScheduleField draft={form.schedule} onChange={(p) => patch({ schedule: { ...form.schedule, ...p } })} preview={preview} timezone={timezone} error={fieldError("schedule")} />
          </Section>

          <Section title="Agent">
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              <Field label="Model">
                {(id) => <Select id={id} value={form.model} onValueChange={(v) => patch({ model: v })} options={modelOptions} className="w-full" aria-label="Model" />}
              </Field>
              <Field label="Thinking">
                {(id) => (
                  <Select
                    id={id}
                    value={form.thinking === DEFAULT || thinkingLevels.includes(form.thinking) ? form.thinking : DEFAULT}
                    onValueChange={(v) => patch({ thinking: v as Form["thinking"] })}
                    options={thinkingOptions}
                    className="w-full"
                    aria-label="Thinking level"
                  />
                )}
              </Field>
              <div className="md:col-span-2">
                <ToggleRow icon={<ClipboardList />} title="Plan mode" description="The agent proposes a plan and waits for your approval before editing" checked={form.plan} onChange={(plan) => patch({ plan })} />
              </div>
            </div>
          </Section>

          <Section title="Options">
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
              <ToggleRow icon={<History />} title="Catch up" description="Run once when the host comes back after missing a run" checked={form.catchUp} onChange={(catchUp) => patch({ catchUp })} />
              <ToggleRow icon={<Power />} title="Enabled" description={form.enabled ? "Runs on schedule" : "Paused: only Run now starts it"} checked={form.enabled} onChange={(enabled) => patch({ enabled })} />
            </div>
          </Section>
        </div>
      )}
    </ResponsiveDialog>
  );
}
