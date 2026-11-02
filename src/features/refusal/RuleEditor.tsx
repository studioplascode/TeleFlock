import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ModelInfo, RefusalAfter, RefusalRule } from "@/core/gen";
import { Button, IconButton, Input, SegmentedControl } from "@/design";
import { keepThinking } from "@/features/ompSettings/model";
import { ModelCombobox, ThinkingSelect } from "@/features/ompSettings/ModelRoles";
import { type CategoryChoice, checkDraft, type RuleDraft, ruleWords } from "./model";

function Labeled({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-bold text-ink-2">{label}</span>
      {children}
      {error ? <p className="text-xs font-semibold text-error">{error}</p> : hint ? <p className="text-2xs text-mute-2">{hint}</p> : null}
    </div>
  );
}

const CATEGORIES: { value: CategoryChoice; label: string }[] = [
  { value: "cyber", label: "Cyber" },
  { value: "any", label: "Any refusal" },
  { value: "other", label: "Other…" },
];

const AFTER: { value: RefusalAfter; label: string }[] = [
  { value: "stay", label: "Stay on the new model" },
  { value: "back", label: "Switch back" },
];

export interface RuleEditorProps {
  models: readonly ModelInfo[];
  /** The host's rules; `editing` is the index of the one being changed (`null`: a new rule). */
  rules: readonly RefusalRule[];
  editing: number | null;
  initial: RuleDraft;
  saving: boolean;
  onSave(rule: RefusalRule): void;
  onCancel(): void;
}

/**
 * The rule form of Settings → Refusal fallback: what is refused (a category, on which model), which model the turn
 * goes on with, at which thinking level, and whether the agent stays there. The checks are `checkDraft`'s; Save waits
 * until the rule is valid, and the sentence under the fields reads the rule back.
 */
export function RuleEditor({ models, rules, editing, initial, saving, onSave, onCancel }: RuleEditorProps) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const check = checkDraft(draft, rules, editing);
  const words = check.rule ? ruleWords(check.rule, models) : undefined;
  // What has been picked is checked at once; a field still empty only says what it needs.
  const errors = { ...check.errors };
  if (!draft.to) delete errors.to;
  if (draft.category === "other" && !draft.other.trim()) delete errors.category;
  const pickable = (typed: string) => /^\S+$/.test(typed);
  return (
    <div role="group" aria-label={editing === null ? "New refusal rule" : "Change refusal rule"} className="flex flex-col gap-3.5 rounded-lg bg-ink/[0.03] p-3.5 shadow-hairline max-md:p-3">
      <div className="grid grid-cols-2 gap-3.5 max-md:grid-cols-1">
        <Labeled label="When the provider refuses for" error={errors.category}>
          <SegmentedControl size="sm" aria-label="Refusal category" value={draft.category} options={CATEGORIES} onValueChange={(category) => set({ category })} className="self-start max-md:w-full" fill />
          {draft.category === "other" && (
            <Input
              value={draft.other}
              aria-label="Category the provider names"
              placeholder="bio"
              invalid={!!errors.category}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono text-sm"
              boxClassName="h-9"
              onChange={(e) => set({ other: e.target.value })}
            />
          )}
        </Labeled>
        <Labeled label="on the model" error={errors.from} hint={draft.from ? undefined : "Every model, or pick one (or a provider's family)."}>
          <div className="flex min-w-0 items-center gap-1.5">
            <ModelCombobox
              value={draft.from}
              models={models}
              label="Refused model"
              placeholder="Any model"
              wildcards
              accept={(typed) => pickable(typed) && (typed.includes("/") || typed.endsWith("*"))}
              invalid={!!errors.from}
              className="w-full flex-1"
              onPick={(from) => set({ from })}
            />
            {draft.from && (
              <IconButton size="sm" label="Any model" onClick={() => set({ from: undefined })}>
                <X />
              </IconButton>
            )}
          </div>
        </Labeled>
        <Labeled label="Go on with" error={errors.to} hint={draft.to ? undefined : "The turn goes on here, once, without a new prompt."}>
          <ModelCombobox
            value={draft.to}
            models={models}
            label="Model to go on with"
            placeholder="Pick a model"
            accept={(typed) => /^[^\s*]+\/\S+$/.test(typed)}
            unavailable={(id) => (id === draft.from ? "The refused model" : undefined)}
            invalid={!!errors.to}
            className="w-full"
            onPick={(to) => set({ to, thinking: keepThinking(models, to, draft.thinking) })}
          />
        </Labeled>
        <Labeled label="Thinking level">
          <ThinkingSelect model={draft.to} models={models} value={draft.thinking} label="Thinking level on the new model" defaultLabel="Keep the turn's level" onChange={(thinking) => set({ thinking })} className="w-full" />
        </Labeled>
      </div>
      <Labeled
        label="Afterwards"
        hint={draft.after === "stay" ? "The agent keeps the new model for the rest of its session." : "Once that turn ends the agent returns to the refused model and its thinking level. A subagent finishes its run on the new model."}
      >
        <SegmentedControl size="sm" aria-label="After the turn" value={draft.after} options={AFTER} onValueChange={(after) => set({ after })} className="self-start max-md:w-full" fill />
      </Labeled>
      {check.errors.rule && <p className="text-xs font-semibold text-error">{check.errors.rule}</p>}
      {words && !check.errors.rule && <p className="text-xs text-ink-2">{words.sentence}</p>}
      {check.notes.map((n) => (
        <p key={n} className="text-xs text-warn">
          {n}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Check />} loading={saving} disabled={!check.rule} onClick={() => check.rule && onSave(check.rule)}>
          {editing === null ? "Add rule" : "Save rule"}
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
