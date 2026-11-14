import { Boxes, Layers, Pencil, Route, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSettings } from "@/core";
import type { ModelInfo, ModelPreset } from "@/core/gen";
import { Chip, IconButton, spring } from "@/design";
import { deletePreset, renamePresetAsk } from "@/features/agentRoles/ModelPresets";
import { presetFields, roleGroups } from "@/features/agentRoles/presets";
import { selectorLabel } from "@/features/agentRoles/roles";
import { Section, useModels } from "./parts";

/** What one preset sets: the main model, its roles grouped by model, its fallback chains. */
function PresetDetails({ preset, models }: { preset: ModelPreset; models: readonly ModelInfo[] }) {
  const f = presetFields(preset);
  const groups = roleGroups(f.roleModels, models);
  const chains = Object.entries(f.fallbackChains);
  return (
    <div className="mt-1.5 flex min-w-0 flex-col gap-1">
      {/* every chip at most the line's width (a long model id truncates instead of running past the card) */}
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Chip className="h-5 max-w-full min-w-0 text-2xs">
          <span className="truncate">{f.model !== "default" ? selectorLabel(models, f.model) : "host default model"}</span>
        </Chip>
        {f.thinking !== "default" && <Chip className="h-5 text-2xs">think {f.thinking}</Chip>}
      </div>
      {groups.map((g) => (
        <p key={g.model} className="flex min-w-0 items-baseline gap-1.5 text-xs text-mute">
          <Boxes className="size-3 shrink-0 translate-y-0.5 text-mute-2" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-mono text-2xs text-ink-2">{g.roles.map((r) => `@${r}`).join(" ")}</span> → {g.model}
          </span>
        </p>
      ))}
      {chains.map(([key, entries]) => (
        <p key={key} className="flex min-w-0 items-baseline gap-1.5 text-xs text-mute">
          <Route className="size-3 shrink-0 translate-y-0.5 text-mute-2" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-mono text-2xs text-ink-2">{key}</span> → {entries.length ? entries.map((e) => selectorLabel(models, e)).join(", then ") : "no fallbacks"}
          </span>
        </p>
      ))}
    </div>
  );
}

/** Saved model presets (`Settings.modelPresets`): what each sets, Rename and Delete. New ones are saved where agents start. */
export function ModelPresets({ index }: { index: number }) {
  const presets = useSettings((s) => s.modelPresets);
  const models = useModels();
  return (
    <Section
      index={index}
      icon={<Layers />}
      title="Model presets"
      description="A main model, thinking level, model roles and fallback chains you start agents with in one pick: in Dispatch's More options and in the Agent options of New agent, New worktree, Fan out and automations."
    >
      {presets.length === 0 ? (
        <p className="py-2 text-sm text-mute-2">No presets yet. Set up an agent's models in Dispatch's More options or in Agent options when you start one, then choose Save as preset.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          <AnimatePresence initial={false}>
            {presets.map((p) => (
              <motion.li
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
                transition={spring.smooth}
                className="flex items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-ink">{p.name}</div>
                  <PresetDetails preset={p} models={models} />
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <IconButton label={`Rename ${p.name}`} size="sm" onClick={() => void renamePresetAsk(p)}>
                    <Pencil />
                  </IconButton>
                  <IconButton label={`Delete ${p.name}`} size="sm" variant="danger" onClick={() => void deletePreset(p)}>
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
