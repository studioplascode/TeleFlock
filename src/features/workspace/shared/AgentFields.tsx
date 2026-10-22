import { ClipboardList, Cpu, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useDraftState } from "@/core";
import type { AgentSpec, ModelCatalog, Settings, ThinkingLevel } from "@/core/gen";
import { Field, Input, Select, type SelectOption, Switch, Textarea, cn, spring } from "@/design";
import { AiMark } from "./ai";
import { AGENT_NAME_MAX, uniqueAgentName } from "./paths";
import { TemplatePicker } from "./templates";
import { useHostQuery } from "./useHostQuery";

/** Editable agent launch options shared by the New worktree and New agent flows. */
export interface AgentDraft {
  start: boolean;
  name: string;
  /** The user typed a name; stop deriving it. */
  nameTouched: boolean;
  /** `provider/id`, or "default" for the host's default role. */
  model: string;
  thinking: ThinkingLevel | "default";
  plan: boolean;
  prompt: string;
}

const DEFAULT = "default";
const ALL_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function initialAgentDraft(settings: Pick<Settings, "defaultModel" | "defaultThinking" | "defaultPlan"> | undefined): AgentDraft {
  return {
    start: true,
    name: "",
    nameTouched: false,
    model: settings?.defaultModel ?? DEFAULT,
    thinking: settings?.defaultThinking ?? DEFAULT,
    plan: settings?.defaultPlan ?? false,
    prompt: "",
  };
}

type AgentText = Pick<AgentDraft, "name" | "nameTouched" | "prompt">;
const NO_TEXT: AgentText = { name: "", nameTouched: false, prompt: "" };

/**
 * An agent draft whose typed fields (name, prompt) persist as a draft under `key`; the switches and
 * selects (start, model, thinking, plan) are component state seeded by `init`. Returns the draft, a
 * patcher, and a clear for the typed fields (call it after a successful launch).
 */
export function useAgentDraft(key: string, init: () => AgentDraft): [AgentDraft, (patch: Partial<AgentDraft>) => void, () => void] {
  const [opts, setOpts] = useState(init);
  const [text, setText, clearText] = useDraftState<AgentText>(key, NO_TEXT);
  const draft = useMemo(() => ({ ...opts, ...text }), [opts, text]);
  const patch = (p: Partial<AgentDraft>) => {
    const { name, nameTouched, prompt, ...rest } = p;
    if (name !== undefined || nameTouched !== undefined || prompt !== undefined) {
      setText((t) => ({ name: name ?? t.name, nameTouched: nameTouched ?? t.nameTouched, prompt: prompt ?? t.prompt }));
    }
    if (Object.keys(rest).length > 0) setOpts((o) => ({ ...o, ...rest }));
  };
  return [draft, patch, clearText];
}

export function toAgentSpec(d: AgentDraft): AgentSpec {
  return {
    kind: "omp",
    name: d.name.trim() || undefined,
    model: d.model === DEFAULT ? undefined : d.model,
    thinking: d.thinking === DEFAULT ? undefined : d.thinking,
    plan: d.plan,
    prompt: d.prompt.trim() || undefined,
  };
}

/** herdr agent names must be unique among live agents, shell-safe and at most 32 chars. */
export function agentNameError(name: string, taken: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) return "Letters, digits, . _ - only";
  if (n.length > AGENT_NAME_MAX) return `At most ${AGENT_NAME_MAX} characters`;
  if (taken.includes(n)) return `An agent named “${n}” is already running`;
  return null;
}

/**
 * The auto name of an untyped agent: the tiny model's suggestion when herdr accepts it (made unique),
 * else `fallback` (today's derivation). `ai` says which one won.
 */
export function autoAgentName(suggestion: string | null, fallback: string, taken: readonly string[]): { name: string; ai: boolean } {
  const s = suggestion?.trim();
  if (s && !agentNameError(s, [])) return { name: uniqueAgentName(s, taken), ai: true };
  return { name: fallback, ai: false };
}

export function useModelCatalog(hostId: string | undefined): ModelCatalog | undefined {
  return useHostQuery(hostId, "host.models", {}).data;
}

export interface AgentFieldsProps {
  hostId: string;
  draft: AgentDraft;
  onChange: (patch: Partial<AgentDraft>) => void;
  /** Placeholder for the name when not typed (derived from branch/folder). */
  derivedName?: string;
  /** The tiny model's name for the typed prompt (placeholder `auto · ✨ <name>` while the name is untyped). */
  suggestedName?: string | null;
  takenNames: readonly string[];
  /** Show the "start an agent" switch (worktree flow). */
  toggleable?: boolean;
  compact?: boolean;
}

export function AgentFields({ hostId, draft, onChange, derivedName, suggestedName, takenNames, toggleable, compact }: AgentFieldsProps) {
  const catalog = useModelCatalog(hostId);
  const defaultRole = catalog?.roles.find((r) => r.role === "default")?.model;

  const modelOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [{ value: DEFAULT, label: "Host default", hint: defaultRole ?? "omp's default role", icon: <Sparkles /> }];
    for (const m of catalog?.models ?? []) opts.push({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider });
    if (draft.model !== DEFAULT && !opts.some((o) => o.value === draft.model)) opts.push({ value: draft.model, label: draft.model, hint: "from settings" });
    return opts;
  }, [catalog, defaultRole, draft.model]);

  const selectedModel = catalog?.models.find((m) => `${m.provider}/${m.id}` === draft.model);
  const levels = selectedModel?.thinking.length ? selectedModel.thinking : ALL_LEVELS;
  const thinkingOptions: SelectOption[] = [
    { value: DEFAULT, label: "Default" },
    ...levels.map((l) => ({ value: l, label: l[0]?.toUpperCase() + l.slice(1) })),
  ];
  const nameError = agentNameError(draft.name, takenNames);

  const body = (
    <div className={cn("grid gap-3.5", compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2")}>
      <TemplatePicker hostId={hostId} draft={draft} onApply={onChange} className={compact ? undefined : "md:col-span-2"} />
      <Field
        label="Agent name"
        hint={
          draft.nameTouched ? undefined : suggestedName ? (
            <span className="flex items-center gap-1">
              auto <AiMark />
            </span>
          ) : (
            "auto"
          )
        }
        error={nameError}
      >
        {(id) => (
          <Input
            id={id}
            value={draft.name}
            placeholder={suggestedName ? `auto · ✨ ${suggestedName}` : derivedName || "derived from the branch"}
            invalid={!!nameError}
            onChange={(e) => onChange({ name: e.target.value, nameTouched: e.target.value !== "" })}
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
      </Field>
      <Field label="Model">
        {(id) => (
          <Select id={id} value={draft.model} onValueChange={(v) => onChange({ model: v })} options={modelOptions} className="w-full" aria-label="Model" />
        )}
      </Field>
      <Field label="Thinking">
        {(id) => (
          <Select
            id={id}
            value={levels.includes(draft.thinking as ThinkingLevel) || draft.thinking === DEFAULT ? draft.thinking : DEFAULT}
            onValueChange={(v) => onChange({ thinking: v as AgentDraft["thinking"] })}
            options={thinkingOptions}
            className="w-full"
            aria-label="Thinking level"
          />
        )}
      </Field>
      <label className="flex h-[62px] cursor-pointer items-center gap-3 self-end rounded-md well px-3.5">
        <ClipboardList className="size-4 text-mute" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-bold">Plan mode</span>
          <span className="text-2xs text-mute-2">Agent proposes a plan before editing</span>
        </span>
        <Switch checked={draft.plan} onCheckedChange={(v) => onChange({ plan: v })} label="Plan mode" />
      </label>
      <Field label="Initial prompt" hint="optional" className={compact ? undefined : "md:col-span-2"}>
        {(id) => (
          <Textarea
            id={id}
            value={draft.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder="What should the agent work on? Sent as soon as it's ready."
            maxHeight={180}
            className="min-h-[3lh]"
          />
        )}
      </Field>
    </div>
  );

  if (!toggleable) return body;
  return (
    <div className="flex flex-col gap-3.5">
      <label
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-lg px-3.5 py-3 transition-[background-color,box-shadow] duration-300",
          draft.start ? "bg-accent/12 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "well",
        )}
      >
        <span className={cn("grid size-9 place-items-center rounded-md transition-colors", draft.start ? "bg-omp text-white shadow-glow-accent" : "bg-tile-4 text-mute")}>
          <Cpu className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-bold">Start an omp agent</span>
          <span className="text-2xs text-mute">In the new worktree's pane, shared with TeleFlock</span>
        </span>
        <Switch checked={draft.start} onCheckedChange={(v) => onChange({ start: v })} label="Start an omp agent" />
      </label>
      <AnimatePresence initial={false}>
        {draft.start && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            className="overflow-hidden"
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
