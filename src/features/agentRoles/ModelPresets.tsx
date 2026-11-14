import { BookmarkPlus, Check, Ellipsis, Layers, PencilLine, ReplaceAll, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { draftKey, drafts, useSettings } from "@/core";
import type { ModelInfo, ModelPreset, ThinkingLevel } from "@/core/gen";
import { Button, Chip, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, IconButton, toast } from "@/design";
import { keepThinking } from "@/features/ompSettings/model";
import { ModelCombobox, ThinkingSelect } from "@/features/ompSettings/ModelRoles";
import { useModels } from "@/features/session/header/useModels";
import { AgentOptionsSection } from "@/features/workspace/shared/AgentOptions";
import { describeError } from "@/features/workspace/shared/errors";
import { promptText } from "@/features/workspace/shared/overlays";
import {
  cleanPresetName,
  everyRole,
  isHostDefaults,
  MAX_PRESETS,
  matchingPreset,
  newPreset,
  newPresetId,
  oneModelEverywhere,
  type PresetFields,
  type PresetPatch,
  presetFields,
  presetNameProblem,
  presetSummary,
  removePreset,
  renamePreset,
  resetPatch,
  restorePreset,
  sameFields,
  suggestPresetName,
  upsertPreset,
} from "./presets";
import { isModelSelector, selectorLabel, validateOverrides } from "./roles";

// ───────────────────────────── saved presets ─────────────────────────────

/** Saves the preset list (optimistic, as every settings write); a failure toasts and the list goes back. */
async function writePresets(list: ModelPreset[]): Promise<boolean> {
  try {
    await useSettings.getState().update({ modelPresets: list });
    return true;
  } catch (e) {
    toast({ title: "Couldn't save model presets", description: describeError(e).title, status: "error" });
    return false;
  }
}

/** Asks for a name (a suggestion filled in) and saves the fields as a new preset. */
export async function savePresetAs(fields: PresetFields, models: readonly ModelInfo[]): Promise<ModelPreset | null> {
  const saved = useSettings.getState().modelPresets;
  if (saved.length >= MAX_PRESETS) {
    toast({ title: `At most ${MAX_PRESETS} model presets`, description: "Delete one in Settings → Model presets first.", status: "error" });
    return null;
  }
  const key = draftKey("modelPreset.saveAs");
  const name = await promptText({
    title: "Save as preset",
    body: "Saves the main model, thinking level, model roles and fallback chains, so you can start agents like this in one pick.",
    label: "Preset name",
    initial: suggestPresetName(fields, models, saved),
    draftKey: key,
    confirmLabel: "Save preset",
    validate: (v) => presetNameProblem(v, useSettings.getState().modelPresets),
  });
  if (!name) return null;
  const p = newPreset(newPresetId(), name, fields);
  if (!(await writePresets(upsertPreset(useSettings.getState().modelPresets, p)))) return null;
  drafts.clear(key);
  toast({ title: `Saved preset “${p.name}”`, description: presetSummary(presetFields(p), models), status: "done", duration: 2600 });
  return p;
}

export async function renamePresetAsk(p: ModelPreset): Promise<void> {
  const key = draftKey("modelPreset.rename", p.id);
  const name = await promptText({
    title: `Rename “${p.name}”`,
    label: "Preset name",
    initial: p.name,
    draftKey: key,
    confirmLabel: "Rename",
    validate: (v) => presetNameProblem(v, useSettings.getState().modelPresets, p.id),
  });
  if (name === null) return;
  if (cleanPresetName(name) === p.name || (await writePresets(renamePreset(useSettings.getState().modelPresets, p.id, name)))) drafts.clear(key);
}

/** Deletes at once; Undo in the toast puts it back in its place. */
export async function deletePreset(p: ModelPreset): Promise<void> {
  const list = useSettings.getState().modelPresets;
  const index = list.findIndex((x) => x.id === p.id);
  if (index < 0 || !(await writePresets(removePreset(list, p.id)))) return;
  toast({
    title: `Deleted preset “${p.name}”`,
    status: "done",
    duration: 6000,
    action: { label: "Undo", onClick: () => void writePresets(restorePreset(useSettings.getState().modelPresets, p, index)) },
  });
}

/** The saved preset a launch's fields are (reactive). */
export function useMatchingPreset(value: PresetFields): ModelPreset | undefined {
  const presets = useSettings((s) => s.modelPresets);
  return matchingPreset(presets, value);
}

/** Header chip of `AgentOptions` for the preset the launch's fields are; null when none. */
export function presetChip(p: ModelPreset | undefined): ReactNode {
  return p ? (
    <Chip key="preset" tone="accent" icon={<Layers />} className="h-5 max-w-56 min-w-0 px-2 text-2xs">
      <span className="truncate">{p.name}</span>
    </Chip>
  ) : null;
}

/** Rename and Delete of one preset (the ⋯ on its chip). */
export function PresetMenu({ preset, className }: { preset: ModelPreset; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`More for preset ${preset.name}`} size="sm" className={cn("size-6 [&_svg]:size-3.5", className)}>
          <Ellipsis />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={<PencilLine />} onSelect={() => void renamePresetAsk(preset)}>
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => void deletePreset(preset)}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ───────────────────────────── the section ─────────────────────────────

export interface ModelPresetsSectionProps {
  hostId: string;
  /** The launch's main model, thinking, own roles and chains now, with its decide-for-me policy. */
  value: PresetPatch;
  /**
   * Spreads a preset, Reset all or One model for every role over the form (`withPreset`). Return an
   * undo when spreading the previous value back would not restore the form (a template it cleared).
   */
  onApply: (patch: PresetPatch) => void | (() => void);
  /** A running session's roles (`SessionRolesDialog`): its Default role is the main model and nothing applies before Save. */
  session?: boolean;
}

/**
 * The model presets of a launch's options (New agent, New worktree, Fan out, automations, Dispatch's
 * More options) and of a running session's roles: the saved presets (one click applies; ⋯ renames
 * or deletes), Save as preset, One model for every role and Reset all. Each change of more than
 * the host's defaults offers Undo.
 */
export function ModelPresetsSection({ hostId, value, onApply, session = false }: ModelPresetsSectionProps) {
  const presets = useSettings((s) => s.modelPresets);
  const { catalog } = useModels(hostId);
  const models = catalog?.models ?? [];
  const [every, setEvery] = useState(false);
  const active = matchingPreset(presets, value);
  const empty = isHostDefaults(value);
  const nothingToSave = isHostDefaults({ ...value, autoAnswer: undefined });
  const full = presets.length >= MAX_PRESETS;

  const apply = (patch: PresetPatch, title: string) => {
    // Only the fields a preset sets: Undo must not put back a name or prompt typed meanwhile.
    const before: PresetPatch = { model: value.model, thinking: value.thinking, roleModels: { ...value.roleModels }, fallbackChains: { ...value.fallbackChains }, autoAnswer: value.autoAnswer };
    const undo = onApply(patch);
    const changed = !sameFields(before, patch) || ("autoAnswer" in patch && patch.autoAnswer !== before.autoAnswer);
    // Nothing of its own was replaced: nothing to undo.
    if (!changed || isHostDefaults(before)) return;
    toast({
      title,
      description: session ? "Save for this session to use it." : undefined,
      status: "done",
      duration: 6000,
      action: { label: "Undo", onClick: () => (undo ? undo() : void onApply(before)) },
    });
  };

  const saveWhy = full
    ? `At most ${MAX_PRESETS} presets: delete one in Settings → Model presets`
    : nothingToSave
      ? "Set a model or roles first"
      : active
        ? `These are the settings of “${active.name}”`
        : !validateOverrides(value.roleModels, value.fallbackChains).ok
          ? "Fix the roles or chains marked below first"
          : undefined;
  return (
    <AgentOptionsSection
      title="Model presets"
      note={session ? "Apply one to this session's roles (its main model becomes the Default role), or save these roles as one." : "The main model, thinking, model roles and fallback chains in one pick. Saved on this device."}
      action={
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw />}
          disabled={empty}
          title={session ? "Back to the host's roles and fallback chains (Save for this session applies it)" : "Back to the host's main model, thinking, roles, fallback chains and decide for me. Plan mode stays."}
          onClick={() => apply(resetPatch(), session ? "Back to the host's roles" : "Back to the host's defaults")}
          className="h-7"
        >
          Reset all
        </Button>
      }
    >
      {presets.length === 0 ? (
        <p className="text-xs text-mute-2">
          {session ? "No presets yet. Set this session's roles below, then save them as a preset." : "No presets yet. Set the main model and the roles below (or use one model for every role), then save them as a preset."}
        </p>
      ) : (
        <div role="radiogroup" aria-label="Model presets" className="flex min-w-0 flex-wrap gap-1.5">
          {presets.map((p) => {
            const on = active?.id === p.id;
            const summary = presetSummary(presetFields(p), models);
            return (
              <div key={p.id} className="relative max-w-full min-w-0">
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={summary}
                  onClick={() => apply(presetFields(p), `Applied “${p.name}”`)}
                  className={cn(
                    "flex h-11 w-full max-w-72 min-w-0 flex-col items-start justify-center rounded-md pr-8 pl-3 text-left transition-colors focus-ring pressable",
                    on ? "bg-accent/16 text-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]" : "bg-ink/4 text-ink-2 shadow-hairline hover:bg-ink/7",
                  )}
                >
                  <span className="flex max-w-full min-w-0 items-center gap-1 text-xs font-bold">
                    {on && <Check className="size-3 shrink-0 text-accent" />}
                    <span className="truncate">{p.name}</span>
                  </span>
                  <span className="max-w-full truncate text-[10.5px] text-mute-2">{summary}</span>
                </button>
                <PresetMenu preset={p} className="absolute top-1/2 right-1 -translate-y-1/2" />
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" icon={<BookmarkPlus />} disabled={!!saveWhy} title={saveWhy} onClick={() => void savePresetAs(value, models)}>
          Save as preset…
        </Button>
        <Button size="sm" variant={every ? "primary" : "secondary"} icon={<ReplaceAll />} aria-expanded={every} onClick={() => setEvery(!every)}>
          One model for every role…
        </Button>
      </div>
      {every && (
        <EveryRole
          models={models}
          roles={everyRole(catalog?.roles.map((r) => r.role) ?? [], value.roleModels)}
          value={value}
          onCancel={() => setEvery(false)}
          onPick={(model, thinking, roles) => {
            setEvery(false);
            apply(oneModelEverywhere(value, model, thinking, roles), `${selectorLabel(models, model)} for every role`);
          }}
        />
      )}
    </AgentOptionsSection>
  );
}

/** One model for every role: a model and level, then the main model and every chat role run it. */
function EveryRole({ models, roles, value, onPick, onCancel }: { models: readonly ModelInfo[]; roles: readonly string[]; value: PresetFields; onPick: (model: string, thinking: ThinkingLevel | undefined, roles: readonly string[]) => void; onCancel: () => void }) {
  const [model, setModel] = useState(value.model !== "default" ? value.model : undefined);
  const [thinking, setThinking] = useState(value.thinking !== "default" ? value.thinking : undefined);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md well px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* Phones: the picker takes its own line (it grows to fill this wrapper). */}
        <div className="flex min-w-0 max-md:w-full">
          <ModelCombobox
            value={model}
            models={models}
            label="Model for every role"
            placeholder="Pick a model"
            accept={isModelSelector}
            onPick={(m) => {
              setModel(m);
              setThinking(keepThinking(models, m, thinking));
            }}
          />
        </div>
        <ThinkingSelect model={model} models={models} value={thinking} label="Thinking for every role" disabled={!model} onChange={setThinking} />
        <Button size="sm" variant="primary" disabled={!model} onClick={() => model && onPick(model, thinking, roles)} className="h-9">
          Use for every role
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-9">
          Cancel
        </Button>
      </div>
      <p className="text-2xs text-mute-2">
        The main model and these roles run it: <span className="font-mono">{roles.join(", ")}</span>. Model kinds (image, web search, speech, dictation, judge) and the fallback chains stay as they are.
      </p>
    </div>
  );
}

/**
 * The saved presets as rows of a menu (Dispatch's agent options menu): one click applies. Nothing
 * when there are none.
 */
export function PresetRows({ hostId, value, onApply, rowClassName }: { hostId?: string; value: PresetFields; onApply: (patch: PresetPatch) => void; rowClassName: string }) {
  const presets = useSettings((s) => s.modelPresets);
  const { catalog } = useModels(hostId ?? "", !!hostId);
  if (presets.length === 0) return null;
  const active = matchingPreset(presets, value);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="kicker px-1 pb-1">Model presets</span>
      {presets.map((p) => (
        <button key={p.id} type="button" className={cn(rowClassName, active?.id === p.id && "bg-accent/14 text-ink")} onClick={() => onApply(presetFields(p))}>
          <Layers className="size-4 shrink-0 text-mute" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{p.name}</span>
            <span className="truncate text-2xs font-medium text-mute-2">{presetSummary(presetFields(p), catalog?.models ?? [])}</span>
          </span>
          {active?.id === p.id && <Check className="size-4 shrink-0 text-accent-hi" />}
        </button>
      ))}
    </div>
  );
}
