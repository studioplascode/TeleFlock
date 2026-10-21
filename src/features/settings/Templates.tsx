import { ClipboardList, Copy, LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Badge, Button, Chip, Field, IconButton, Input, Select, spring, Switch, Textarea, toast } from "@/design";
import { useSettings } from "@/core";
import type { AgentTemplate, ThinkingLevel } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { closeSheet, openSheet } from "@/features/shell/sheets";
import { Section, THINKING, useModels } from "./parts";

const NONE = "__none";

function newId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function TemplateForm({ initial, onSave }: { initial: AgentTemplate; onSave: (t: AgentTemplate) => Promise<void> }) {
  const models = useModels();
  const [t, setT] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameError = touched && !t.name.trim() ? "Give the template a name." : undefined;
  const set = (patch: Partial<AgentTemplate>) => setT((prev) => ({ ...prev, ...patch }));

  const modelOptions = [
    { value: NONE, label: "Default model", hint: "Settings › New agents, else the host's omp default" },
    ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider })),
  ];
  if (t.model && !models.some((m) => `${m.provider}/${m.id}` === t.model)) modelOptions.push({ value: t.model, label: t.model, hint: "saved" });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!t.name.trim()) return;
        setSaving(true);
        const clean: AgentTemplate = { ...t, name: t.name.trim(), description: t.description?.trim() || undefined };
        onSave(clean).finally(() => setSaving(false));
      }}
    >
      <Field label="Name" error={nameError}>
        {(id) => <Input id={id} value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="Careful refactor" autoFocus invalid={!!nameError} />}
      </Field>
      <Field label="Description" hint="optional">
        {(id) => <Input id={id} value={t.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="Plan first, small commits, run the tests" />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Model" description={models.length === 0 ? "Connect a host to pick from its model catalog." : undefined}>
          {(id) => <Select id={id} className="w-full" value={t.model ?? NONE} onValueChange={(v) => set({ model: v === NONE ? undefined : v })} options={modelOptions} />}
        </Field>
        <Field label="Thinking">
          {(id) => (
            <Select
              id={id}
              className="w-full"
              value={t.thinking ?? NONE}
              onValueChange={(v) => set({ thinking: v === NONE ? undefined : (v as ThinkingLevel) })}
              options={[{ value: NONE, label: "Model default" }, ...THINKING.map((l) => ({ value: l, label: l }))]}
            />
          )}
        </Field>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-md bg-white/[0.03] px-3 py-2.5 shadow-hairline">
        <span>
          <span className="block text-sm font-bold text-ink">Start in plan mode</span>
          <span className="block text-xs text-mute">The agent proposes a plan before touching files.</span>
        </span>
        <Switch checked={t.plan} onCheckedChange={(plan) => set({ plan })} label="Start in plan mode" />
      </label>
      <Field label="Prompt" hint="optional" description="Sent as the first message. Leave empty for a pure model preset.">
        {(id) => <Textarea id={id} value={t.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Read the README, then…" maxHeight={220} />}
      </Field>
      <div className="flex justify-end gap-2 border-t border-line pt-4 md:sticky md:bottom-0 md:z-raised md:bg-[#17171f]">
        <Button variant="ghost" onClick={closeSheet}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          Save template
        </Button>
      </div>
    </form>
  );
}

/** Saved agent presets for the new-agent, new-worktree and fan-out flows. */
export function Templates({ index }: { index: number }) {
  const templates = useSettings((s) => s.templates);
  const saveTemplate = useSettings((s) => s.saveTemplate);
  const removeTemplate = useSettings((s) => s.removeTemplate);

  const run = (p: Promise<void>, label: string) =>
    p.then(
      () => {
        haptic("success");
        toast({ title: label, status: "done" });
      },
      (err: unknown) => {
        haptic("warning");
        toast({ title: `Couldn't save templates: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
        throw err;
      },
    );

  const edit = (initial: AgentTemplate | null) => {
    const base: AgentTemplate = initial ?? { id: newId(), name: "", plan: false, prompt: "" };
    openSheet({
      title: initial ? `Edit ${initial.name}` : "New template",
      description: "A reusable preset: model, thinking, plan mode and a starting prompt.",
      content: (
        <TemplateForm
          initial={base}
          onSave={(t) => run(saveTemplate(t), initial ? `Saved “${t.name}”` : `Added “${t.name}”`).then(closeSheet, () => {})}
        />
      ),
    });
  };

  const remove = (t: AgentTemplate) => {
    void run(removeTemplate(t.id), `Deleted “${t.name}”`).catch(() => {});
  };

  const duplicate = (t: AgentTemplate) => {
    void run(saveTemplate({ ...t, id: newId(), name: `${t.name} copy` }), `Duplicated “${t.name}”`).catch(() => {});
  };

  return (
    <Section
      index={index}
      icon={<LayoutTemplate />}
      title="Templates"
      description="Agent presets you can pick when starting an agent, a worktree or a fan-out."
      action={
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => edit(null)}>
          New
        </Button>
      }
    >
      {templates.length === 0 ? (
        <p className="py-2 text-sm text-mute-2">No templates yet. Save a model, thinking level and prompt you use often.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          <AnimatePresence initial={false}>
            {templates.map((t) => (
              <motion.li
                key={t.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
                transition={spring.smooth}
                className="flex items-start gap-3 py-3"
              >
                <button type="button" onClick={() => edit(t)} className="min-w-0 flex-1 rounded-sm text-left focus-ring">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-bold text-ink">{t.name}</span>
                    {t.plan && (
                      <Badge tone="accent">
                        <ClipboardList className="mr-1 size-2.5" />
                        Plan
                      </Badge>
                    )}
                  </div>
                  {t.description && <div className="truncate text-xs text-mute">{t.description}</div>}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Chip className="h-5 text-2xs">{t.model ?? "default model"}</Chip>
                    {t.thinking && <Chip className="h-5 text-2xs">think {t.thinking}</Chip>}
                    {t.prompt && (
                      <Chip className="h-5 max-w-60 min-w-0 text-2xs">
                        <span className="truncate">“{t.prompt.split("\n")[0]}”</span>
                      </Chip>
                    )}
                  </div>
                </button>
                <div className="flex shrink-0 gap-0.5">
                  <IconButton label={`Edit ${t.name}`} size="sm" onClick={() => edit(t)}>
                    <Pencil />
                  </IconButton>
                  <IconButton label={`Duplicate ${t.name}`} size="sm" onClick={() => duplicate(t)}>
                    <Copy />
                  </IconButton>
                  <IconButton label={`Delete ${t.name}`} size="sm" variant="danger" onClick={() => remove(t)}>
                    <Trash2 />
                  </IconButton>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Section>
  );
}
