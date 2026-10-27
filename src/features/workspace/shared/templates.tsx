import { motion } from "motion/react";
import { BookmarkPlus, Check, LayoutTemplate, X } from "lucide-react";
import { aiNamingEnabled, draftKey, drafts, suggestTemplateName, useSettings } from "@/core";
import type { AgentTemplate } from "@/core/gen";
import { Button, IconButton, cn, spring, toast } from "@/design";
import type { AgentDraft } from "./AgentFields";
import { describeError } from "./errors";
import { confirmAction, promptText } from "./overlays";

const DEFAULT = "default";

/** The draft fields a template sets. An empty template prompt keeps whatever the user typed. */
export function applyTemplate(t: AgentTemplate, draft: Pick<AgentDraft, "prompt">): Pick<AgentDraft, "model" | "thinking" | "plan" | "prompt"> {
  return { model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan, prompt: t.prompt || draft.prompt };
}

/** The template whose settings the draft currently matches (the picker highlights it); one whose prompt matches too wins. */
export function matchingTemplate(templates: readonly AgentTemplate[], d: Pick<AgentDraft, "model" | "thinking" | "plan" | "prompt">): AgentTemplate | undefined {
  const same = templates.filter((t) => (t.model ?? DEFAULT) === d.model && (t.thinking ?? DEFAULT) === d.thinking && t.plan === d.plan);
  return same.find((t) => t.prompt && t.prompt === d.prompt) ?? same.find((t) => !t.prompt);
}

/** Short "opus-5 · high · plan" summary of a template. */
export function templateSummary(t: AgentTemplate): string {
  return [t.model ? (t.model.split("/").pop() ?? t.model) : "default model", t.thinking, t.plan && "plan"].filter(Boolean).join(" · ");
}

/** Runs a settings write; failures become a toast. */
async function persist(write: Promise<void>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch (e) {
    toast({ title: "Couldn't save templates", description: describeError(e).title, status: "error" });
    return false;
  }
}

/** Ask for a name and store the draft's model/thinking/plan/prompt as a new template (the name is prefilled by the tiny model on `hostId`, when on). */
export async function saveDraftAsTemplate(d: Pick<AgentDraft, "model" | "thinking" | "plan" | "prompt">, hostId?: string): Promise<AgentTemplate | null> {
  const existing = useSettings.getState().templates;
  const key = draftKey("template.saveAs");
  const name = await promptText({
    title: "Save as template",
    body: "Saves the model, thinking level, plan mode and prompt so you can start agents like this in one tap.",
    label: "Template name",
    draftKey: key,
    confirmLabel: "Save template",
    validate: (v) => (!v.trim() ? "Give it a name" : existing.some((t) => t.name.toLowerCase() === v.trim().toLowerCase()) ? "A template with that name exists" : null),
    prefill:
      hostId && aiNamingEnabled(hostId)
        ? () =>
            suggestTemplateName(hostId, {
              model: d.model === DEFAULT ? undefined : d.model,
              thinking: d.thinking === DEFAULT ? undefined : d.thinking,
              plan: d.plan,
              prompt: d.prompt.trim() || undefined,
            })
        : undefined,
  });
  if (!name) return null;
  const t: AgentTemplate = {
    id: `tpl-${Date.now().toString(36)}`,
    name,
    model: d.model === DEFAULT ? undefined : d.model,
    thinking: d.thinking === DEFAULT ? undefined : d.thinking,
    plan: d.plan,
    prompt: d.prompt.trim(),
  };
  if (!(await persist(useSettings.getState().saveTemplate(t)))) return null;
  drafts.clear(key);
  toast({ title: `Saved template “${name}”`, description: templateSummary(t), status: "done", duration: 2500 });
  return t;
}

async function deleteTemplate(t: AgentTemplate) {
  const ok = await confirmAction({ title: `Delete template “${t.name}”?`, confirmLabel: "Delete", danger: true });
  if (ok) await persist(useSettings.getState().removeTemplate(t.id));
}

export interface TemplatePickerProps {
  /** Host whose tiny model names a new template. */
  hostId?: string;
  draft: AgentDraft;
  onApply: (patch: Partial<AgentDraft>) => void;
  className?: string;
}

/** Template chips that prefill the agent form, plus "Save as template". */
export function TemplatePicker({ hostId, draft, onApply, className }: TemplatePickerProps) {
  const templates = useSettings((s) => s.templates);
  const active = matchingTemplate(templates, draft);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <LayoutTemplate className="size-3.5 text-mute-2" />
        <span className="text-2xs font-bold tracking-[0.02em] text-mute">Templates</span>
        <Button size="sm" variant="ghost" icon={<BookmarkPlus />} className="ml-auto h-7" onClick={() => void saveDraftAsTemplate(draft, hostId)}>
          Save as template
        </Button>
      </div>
      {templates.length === 0 ? (
        <p className="text-2xs text-mute-2">No templates yet. Set up the agent below, then save it as a template.</p>
      ) : (
        <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 scroll-fade-x" role="radiogroup" aria-label="Templates">
          {templates.map((t) => {
            const on = active?.id === t.id;
            return (
              <div key={t.id} className="group relative shrink-0">
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onApply(applyTemplate(t, draft))}
                  title={t.description ?? templateSummary(t)}
                  className={cn(
                    "relative flex h-11 max-w-56 flex-col items-start justify-center rounded-md px-3 pr-7 text-left transition-colors focus-ring pressable",
                    on ? "text-ink" : "bg-white/4 text-ink-2 shadow-hairline hover:bg-white/7",
                  )}
                >
                  {on && (
                    <motion.span
                      layoutId="tpl-active"
                      transition={spring.snappy}
                      className="absolute inset-0 rounded-md bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]"
                      aria-hidden
                    />
                  )}
                  <span className="relative flex items-center gap-1 truncate text-xs font-bold">
                    {on && <Check className="size-3 text-accent" />}
                    {t.name}
                  </span>
                  <span className="relative truncate text-[10.5px] text-mute-2">{templateSummary(t)}</span>
                </button>
                <IconButton
                  label={`Delete template ${t.name}`}
                  size="sm"
                  className="absolute top-1 right-0.5 size-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3"
                  onClick={() => void deleteTemplate(t)}
                >
                  <X />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
