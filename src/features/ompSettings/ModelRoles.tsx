import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ModelInfo, OmpSetting, ThinkingLevel } from "@/core/gen";
import { Button, cn, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, formatCompact, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Select } from "@/design";
import { useModels } from "@/features/session/header/useModels";
import { Ticks } from "@/features/shell/Ticks";
import { formatRoleSelector, keepThinking, parseRoleSelector, ROLE_NAME, type RoleRow, roleRecord, roleRows, THINKING_LEVELS, withRole } from "./model";

const NO_LEVEL = "__default";

export interface ModelComboboxProps {
  /** `provider/id` (or a wildcard) picked now. */
  value?: string;
  models: readonly ModelInfo[];
  /** Accessible name of the trigger. */
  label: string;
  onPick: (model: string) => void;
  /** Trigger text while nothing is picked. */
  placeholder?: ReactNode;
  /** Typed text that matches no model and may be used as-is (default: anything with a `/`). */
  accept?: (typed: string) => boolean;
  /** Also offer `provider/*` for every provider of the catalog. */
  wildcards?: boolean;
  /** Why a model can't be picked here; its row shows it and is disabled. */
  unavailable?: (model: string) => string | undefined;
  invalid?: boolean;
  disabled?: boolean;
  /** Trigger button classes (width). */
  className?: string;
  /** A trigger of the caller's own (e.g. an "Add" button) instead of the field. */
  trigger?: ReactNode;
}

/**
 * Searchable model list of the host; typed `provider/id` text that matches nothing can be used
 * as-is. Shared by the Model roles page and the per-agent role and fallback-chain editors.
 */
export function ModelCombobox({ value, models, label, onPick, placeholder = "Not set", accept = (typed) => typed.includes("/"), wildcards = false, unavailable, invalid, disabled, className, trigger }: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const known = models.find((m) => `${m.provider}/${m.id}` === value);
  const providers = [...new Set(models.map((m) => m.provider))];
  const typed = query.trim();
  const listed = (id: string) => models.some((m) => `${m.provider}/${m.id}` === id) || (wildcards && providers.some((p) => `${p}/*` === id));
  const typedWhy = typed ? unavailable?.(typed) : undefined;
  const pick = (model: string) => {
    onPick(model);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className={cn(
              "well inline-flex h-9 w-60 min-w-0 items-center justify-between gap-2 rounded-md px-3 text-left text-sm font-semibold text-ink focus-ring disabled:opacity-45 max-md:flex-1",
              invalid && "shadow-[inset_0_0_0_1.5px_var(--color-error)]",
              className,
            )}
          >
            <span className={cn("min-w-0 truncate", !value && "text-mute-2")}>{known ? (known.label ?? known.id) : (value ?? placeholder)}</span>
            {known && <span className="hidden truncate font-mono text-2xs text-mute-2 sm:inline">{known.provider}</span>}
            <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-mute-2" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-24px))] p-0">
        {/* Every typed word must appear in the id or label (cmdk's default fuzzy match is too loose for model ids). */}
        <Command loop filter={(item, search) => (search.toLowerCase().split(/\s+/).every((w) => item.toLowerCase().includes(w)) ? 1 : 0)}>
          <CommandInput placeholder={wildcards ? "Search models or type provider/id or provider/*" : "Search models or type provider/id"} value={query} onValueChange={setQuery} className="h-11 text-sm" />
          <CommandList className="max-h-[min(360px,50dvh)]">
            <CommandEmpty>{models.length ? "No model matches" : "No models from this host"}</CommandEmpty>
            {typed && accept(typed) && !listed(typed) && (
              <CommandGroup heading="Custom">
                <CommandItem value={`custom ${typed}`} disabled={!!typedWhy} onSelect={() => pick(typed)} icon={<Plus />}>
                  Use <span className="font-mono">{typed}</span>
                  {typedWhy && <span className="ml-2 text-2xs text-mute-2">{typedWhy}</span>}
                </CommandItem>
              </CommandGroup>
            )}
            {providers.map((p) => (
              <CommandGroup key={p} heading={p}>
                {models
                  .filter((m) => m.provider === p)
                  .map((m) => {
                    const id = `${m.provider}/${m.id}`;
                    const why = unavailable?.(id);
                    return (
                      <CommandItem key={id} value={`${id} ${m.label ?? ""}`} disabled={!!why} onSelect={() => pick(id)} icon={id === value ? <Check className="text-accent-hi" /> : <span className="size-4" />} className="h-10">
                        <span className="font-bold">{m.label ?? m.id}</span>
                        <span className="ml-2 font-mono text-2xs text-mute-2">{m.id}</span>
                        {why ? <span className="ml-2 text-2xs text-mute-2">{why}</span> : m.contextWindow != null && <span className="ml-2 text-2xs text-mute-2 tabular">{formatCompact(m.contextWindow)}</span>}
                      </CommandItem>
                    );
                  })}
              </CommandGroup>
            ))}
            {wildcards && providers.length > 0 && (
              <CommandGroup heading="Any model of a provider">
                {providers.map((p) => {
                  const id = `${p}/*`;
                  const why = unavailable?.(id);
                  return (
                    <CommandItem key={id} value={`${id} any ${p}`} disabled={!!why} onSelect={() => pick(id)} icon={id === value ? <Check className="text-accent-hi" /> : <span className="size-4" />} className="h-10">
                      <span className="font-mono font-bold">{id}</span>
                      <span className="ml-2 text-2xs text-mute-2">{why ?? "same model id, this provider"}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface ThinkingSelectProps {
  /** `provider/id` whose levels to offer (omp's all when the catalog doesn't know it). */
  model?: string;
  models: readonly ModelInfo[];
  value?: ThinkingLevel;
  /** undefined: no explicit level. */
  onChange: (level: ThinkingLevel | undefined) => void;
  label: string;
  /** The option for no explicit level. */
  defaultLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** The thinking level of a selector: one of its model's levels, or none (`defaultLabel`). */
export function ThinkingSelect({ model, models, value, onChange, label, defaultLabel = "Model default", disabled, className }: ThinkingSelectProps) {
  const info = model ? models.find((m) => `${m.provider}/${m.id}` === model) : undefined;
  const levels: readonly ThinkingLevel[] = info?.thinking.length ? info.thinking : THINKING_LEVELS;
  const options = [{ value: NO_LEVEL, label: defaultLabel }, ...levels.map((l) => ({ value: l, label: l }))];
  if (value && !levels.includes(value)) options.push({ value, label: value });
  return (
    <Select
      aria-label={label}
      className={cn("h-9 w-40 min-w-0 max-md:w-32", className)}
      disabled={disabled}
      value={value ?? NO_LEVEL}
      onValueChange={(v) => onChange(v === NO_LEVEL ? undefined : (levels.find((l) => l === v) ?? value))}
      options={options}
    />
  );
}

function RoleLine({ row, models, onChange, onRemove }: { row: RoleRow; models: ModelInfo[]; onChange: (selector: string | undefined) => void; onRemove?: () => void }) {
  const parsed = row.selector ? parseRoleSelector(row.selector) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 max-md:py-2">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold text-ink">{row.name ?? row.id}</span>
          <span className="font-mono text-2xs text-mute-2">@{row.id}</span>
        </div>
        {row.description && <p className="text-xs text-mute">{row.description}</p>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 max-md:w-full">
        <ModelCombobox value={parsed?.model} models={models} label={`Model for ${row.id}`} onPick={(m) => onChange(formatRoleSelector(m, keepThinking(models, m, parsed?.thinking)))} />
        <ThinkingSelect
          model={parsed?.model}
          models={models}
          value={parsed?.thinking}
          label={`Thinking for ${row.id}`}
          disabled={!parsed}
          onChange={(level) => parsed && onChange(formatRoleSelector(parsed.model, level))}
        />
        {row.selector || onRemove ? (
          <IconButton size="sm" label={row.selector ? `Unassign ${row.id}` : `Remove ${row.id}`} onClick={() => (row.selector ? onChange(undefined) : onRemove?.())}>
            <X />
          </IconButton>
        ) : (
          <span className="size-7 shrink-0" />
        )}
      </div>
    </div>
  );
}

/**
 * omp's `modelRoles`: built-in chat roles, model-kind roles and custom roles, each bound to
 * `provider/id[:thinking]`. Every change writes the whole record.
 */
export function ModelRoles({ setting, hostId, onCommit }: { setting: OmpSetting; hostId: string; onCommit: (record: Record<string, string>) => void }) {
  const { catalog, error } = useModels(hostId);
  const models = catalog?.models ?? [];
  const record = roleRecord(setting.value);
  const [added, setAdded] = useState<string[]>([]);
  const [name, setName] = useState("");
  const rows = roleRows(record, added);
  const nameTrim = name.trim();
  const nameError = nameTrim && (!ROLE_NAME.test(nameTrim) ? "Letters, digits, - and _; starts with a letter" : rows.some((r) => r.id === nameTrim) ? "That role exists" : undefined);
  const set = (role: string, selector: string | undefined) => onCommit(withRole(record, role, selector));
  const line = (r: RoleRow) => (
    <RoleLine key={r.id} row={r} models={models} onChange={(sel) => set(r.id, sel)} onRemove={r.builtin ? undefined : () => setAdded((a) => a.filter((x) => x !== r.id))} />
  );
  const addRole = () => {
    if (!nameTrim || nameError) return;
    setAdded((a) => [...a, nameTrim]);
    setName("");
  };
  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-warn">Couldn't load the host's models ({error}); type a provider/id selector instead.</p>}
      <div>
        <div className="kicker">Chat roles</div>
        <div className="flex flex-col divide-y divide-line">{rows.filter((r) => r.builtin && !r.kind).map(line)}</div>
      </div>
      <div>
        <div className="kicker">Model kinds</div>
        <div className="flex flex-col divide-y divide-line">{rows.filter((r) => r.kind).map(line)}</div>
      </div>
      <div>
        <div className="kicker">Custom roles</div>
        <div className="flex flex-col divide-y divide-line">{rows.filter((r) => !r.builtin).map(line)}</div>
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-col gap-1 max-md:flex-1">
            <Input
              value={name}
              aria-label="New role name"
              placeholder="designer"
              invalid={!!nameError}
              className="font-mono text-sm"
              boxClassName="h-9 w-48 max-md:w-full"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addRole();
              }}
            />
            {nameError && <p className="text-xs font-semibold text-error">{nameError}</p>}
          </div>
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={!nameTrim || !!nameError} onClick={addRole} className="h-9">
            Add role
          </Button>
        </div>
        <p className="mt-1.5 text-2xs text-mute-2">
          <Ticks text="Use a custom role as `--model @name`, in agent definitions or with omp's `/switch`." />
        </p>
      </div>
    </div>
  );
}
