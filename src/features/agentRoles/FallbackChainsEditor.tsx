import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { ModelInfo } from "@/core/gen";
import { Button, cn, IconButton, Input, Select, type SelectOption } from "@/design";
import { BUILTIN_ROLES, deepEqual, keepThinking } from "@/features/ompSettings/model";
import { ModelCombobox, ThinkingSelect } from "@/features/ompSettings/ModelRoles";
import {
  CHAIN_KEY_KINDS,
  type ChainKeyKind,
  type ChainMap,
  type ChainRow,
  type ChainRowCheck,
  chainRecord,
  chainRows,
  formatChainEntry,
  isModelSelector,
  isWildcard,
  joinChainKey,
  MAX_CHAIN_ENTRIES,
  MAX_CHAINS,
  nextChainId,
  parseChainEntry,
  splitChainKey,
  validateChains,
} from "./roles";

const OTHER = "\u0000other";

/**
 * Chain rows for a parent that holds the record: rows a record can't hold yet (no key, a key
 * twice) stay here while they are edited, the parent gets `chainRecord(rows)` on each change,
 * and a record that changes from outside (reset, the host's answer) re-seeds the rows.
 */
export function useChainRows(value: ChainMap, onChange: (next: ChainMap) => void): [ChainRow[], (rows: ChainRow[]) => void] {
  const [rows, setRows] = useState(() => chainRows(value));
  const [seen, setSeen] = useState(value);
  if (!deepEqual(seen, value)) {
    setSeen(value);
    if (!deepEqual(chainRecord(rows), value)) setRows(chainRows(value));
  }
  const change = (next: ChainRow[]) => {
    setRows(next);
    const record = chainRecord(next);
    setSeen(record);
    if (!deepEqual(record, value)) onChange(record);
  };
  return [rows, change];
}

export interface FallbackChainsEditorProps {
  rows: readonly ChainRow[];
  onChange: (rows: ChainRow[]) => void;
  models: readonly ModelInfo[];
  /** Role names besides omp's built-in ones (custom roles), offered as role keys. */
  customRoles?: readonly string[];
  /** The host's chains: shown read-only for context (per-agent editors), each can be copied to edit. */
  hostChains?: ChainMap;
}

/**
 * omp's `retry.fallbackChains` as cards: a key (role, exact model, provider wildcard or id-prefixed
 * wildcard) and the fallbacks tried in order, each with an optional thinking level (wildcards
 * always take the failing turn's). Controlled over rows (`useChainRows` adapts a record).
 */
export function FallbackChainsEditor({ rows, onChange, models, customRoles = [], hostChains }: FallbackChainsEditorProps) {
  const check = validateChains(rows);
  const keys = rows.map((r) => joinChainKey(r.kind, r.value));
  const roles = [...BUILTIN_ROLES.map((r) => r.id), ...customRoles.filter((c) => !BUILTIN_ROLES.some((r) => r.id === c))];
  const providers = [...new Set(models.map((m) => m.provider))];
  const update = (id: number, patch: Partial<ChainRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (seed?: Pick<ChainRow, "kind" | "value" | "entries">) => {
    // A role no chain (of the agent or the host) uses yet, so a new chain hides nothing.
    const role = roles.find((id) => !keys.includes(id) && !(hostChains && Object.hasOwn(hostChains, id))) ?? roles.find((id) => !keys.includes(id));
    onChange([...rows, { id: nextChainId(rows), ...(seed ?? (role ? { kind: "role" as const, value: role, entries: [] } : { kind: "provider" as const, value: "", entries: [] })) }]);
  };
  const hostEntries = hostChains ? Object.entries(hostChains) : [];
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {hostEntries.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md bg-white/[0.03] px-3 py-2.5 shadow-hairline">
          <span className="kicker">The host's chains</span>
          <ul className="flex flex-col gap-1">
            {hostEntries.map(([key, entries]) => {
              const replaced = keys.includes(key);
              return (
                <li key={key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <span className={cn("font-mono font-semibold text-ink-2", replaced && "line-through decoration-mute-2")}>{key}</span>
                  <span className="text-mute-2">→</span>
                  <span className="min-w-0 font-mono break-all text-mute">{entries.length ? entries.join(", ") : "no fallbacks"}</span>
                  {replaced ? (
                    <span className="text-2xs font-semibold text-accent-hi">replaced below</span>
                  ) : (
                    <button
                      type="button"
                      className="rounded-xs text-2xs font-semibold text-accent-hi hover:underline focus-ring disabled:opacity-45"
                      disabled={rows.length >= MAX_CHAINS}
                      onClick={() => add({ ...splitChainKey(key), entries: [...entries] })}
                    >
                      Change for this agent
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-2xs text-mute-2">An agent chain with the same key replaces the host's.</p>
        </div>
      )}
      {rows.map((r, i) => (
        <ChainCard
          key={r.id}
          row={r}
          index={i}
          check={check.rows[i] ?? { entries: [] }}
          models={models}
          roles={roles}
          providers={providers}
          taken={new Set(keys.filter((_, j) => j !== i))}
          hidesHost={!!hostChains && Object.hasOwn(hostChains, keys[i] ?? "")}
          perAgent={!!hostChains}
          onChange={(patch) => update(r.id, patch)}
          onRemove={() => onChange(rows.filter((x) => x.id !== r.id))}
        />
      ))}
      {check.general.map((g) => (
        <p key={g} className="text-xs font-semibold text-error">
          {g}
        </p>
      ))}
      <Button size="sm" variant="secondary" icon={<Plus />} className="self-start" disabled={rows.length >= MAX_CHAINS} onClick={() => add()}>
        Add chain
      </Button>
    </div>
  );
}

interface ChainCardProps {
  row: ChainRow;
  index: number;
  check: ChainRowCheck;
  models: readonly ModelInfo[];
  roles: readonly string[];
  providers: readonly string[];
  /** Keys of the other chains. */
  taken: ReadonlySet<string>;
  /** The host has a chain of this key (an empty one hides it). */
  hidesHost: boolean;
  perAgent: boolean;
  onChange: (patch: Partial<ChainRow>) => void;
  onRemove: () => void;
}

function ChainCard({ row, index, check, models, roles, providers, taken, hidesHost, perAgent, onChange, onRemove }: ChainCardProps) {
  const bad = !!check.key || !!check.chain || check.entries.some(Boolean);
  const n = index + 1;
  const setKind = (kind: ChainKeyKind) => {
    if (kind === row.kind) return;
    const free = (v: string) => !taken.has(joinChainKey(kind, v));
    let value = "";
    if (kind === "role") value = roles.find(free) ?? "";
    else if (kind === "provider") {
      const own = row.kind === "role" ? "" : (row.value.split("/")[0] ?? "");
      value = own && free(own) ? own : "";
    }
    onChange({ kind, value });
  };
  const setEntries = (entries: string[]) => onChange({ entries });
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-lg bg-white/[0.035] p-3 shadow-hairline max-md:p-2.5", bad && "shadow-[inset_0_0_0_1px_rgb(255_77_94/0.45)]")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          aria-label={`Chain ${n} key type`}
          className="h-9 w-48 min-w-0 max-sm:flex-1"
          value={row.kind}
          onValueChange={(v) => {
            const k = CHAIN_KEY_KINDS.find((x) => x.kind === v);
            if (k) setKind(k.kind);
          }}
          options={CHAIN_KEY_KINDS.map((k) => ({ value: k.kind, label: k.label, hint: k.hint }))}
        />
        <IconButton size="sm" label={`Remove chain ${n}`} className="sm:order-last" onClick={onRemove}>
          <Trash2 />
        </IconButton>
        <div className="min-w-0 flex-1 basis-52 max-sm:basis-full">
          <KeyField row={row} n={n} models={models} roles={roles} providers={providers} taken={taken} invalid={!!check.key} onChange={onChange} />
        </div>
      </div>
      {check.key && <p className="text-xs font-semibold text-error">{check.key}</p>}
      {row.entries.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {row.entries.map((e, i) => (
            <EntryRow
              key={`${i}:${e}`}
              entry={e}
              index={i}
              count={row.entries.length}
              chain={n}
              models={models}
              error={check.entries[i]}
              onChange={(next) => setEntries(row.entries.map((x, j) => (j === i ? next : x)))}
              onMove={(to) => {
                const next = [...row.entries];
                const [item] = next.splice(i, 1);
                if (item !== undefined) next.splice(to, 0, item);
                setEntries(next);
              }}
              onRemove={() => setEntries(row.entries.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      )}
      {row.entries.length === 0 && <p className="text-xs text-mute">{perAgent && hidesHost ? "No fallbacks: the host's chain for this key is not used" : "No fallbacks for this key"}</p>}
      {check.chain && <p className="text-xs font-semibold text-error">{check.chain}</p>}
      <ModelCombobox
        models={models}
        label={`Add a fallback to chain ${n}`}
        wildcards
        accept={(t) => isModelSelector(t) || isWildcard(t)}
        onPick={(m) => setEntries([...row.entries, m])}
        trigger={
          <Button size="sm" variant="ghost" icon={<Plus />} className="self-start" disabled={row.entries.length >= MAX_CHAIN_ENTRIES}>
            Add fallback
          </Button>
        }
      />
    </div>
  );
}

function KeyField({ row, n, models, roles, providers, taken, invalid, onChange }: Pick<ChainCardProps, "row" | "models" | "roles" | "providers" | "taken" | "onChange"> & { n: number; invalid: boolean }) {
  const [otherProvider, setOtherProvider] = useState(false);
  const label = `Chain ${n} key`;
  switch (row.kind) {
    case "role": {
      const options: SelectOption[] = roles.map((id) => {
        const builtin = BUILTIN_ROLES.find((r) => r.id === id);
        const used = taken.has(id);
        return { value: id, label: builtin ? `${builtin.name} · @${id}` : `@${id}`, hint: used ? "has a chain" : builtin?.description, disabled: used };
      });
      if (row.value && !roles.includes(row.value)) options.push({ value: row.value, label: `@${row.value}` });
      return <Select aria-label={label} className="h-9 w-full min-w-0" value={row.value} placeholder="Pick a role" onValueChange={(value) => onChange({ value })} options={options} />;
    }
    case "model":
      return (
        <ModelCombobox
          value={row.value || undefined}
          models={models}
          label={label}
          placeholder="Pick a model"
          wildcards
          invalid={invalid}
          className="w-full"
          accept={(t) => isModelSelector(t) || isWildcard(t)}
          unavailable={(m) => (taken.has(m) ? "has a chain" : undefined)}
          // A wildcard picked here is a wildcard key.
          onPick={(m) => onChange(splitChainKey(m))}
        />
      );
    case "provider":
      if (providers.length > 0 && !otherProvider && (!row.value || providers.includes(row.value))) {
        return (
          <Select
            aria-label={label}
            className="h-9 w-full min-w-0"
            value={row.value}
            placeholder="Pick a provider"
            onValueChange={(v) => (v === OTHER ? setOtherProvider(true) : onChange({ value: v }))}
            options={[
              ...providers.map((p) => ({ value: p, label: `${p}/*`, hint: taken.has(`${p}/*`) ? "has a chain" : undefined, disabled: taken.has(`${p}/*`) })),
              { value: OTHER, label: "Other provider…" },
            ]}
          />
        );
      }
      return (
        <Input
          aria-label={label}
          value={row.value}
          placeholder="openrouter"
          invalid={invalid}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono text-sm"
          boxClassName="h-9 w-full"
          trailing={<span className="font-mono text-xs text-mute-2">/*</span>}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      );
    case "prefix":
      return (
        <Input
          aria-label={label}
          value={row.value}
          placeholder="openrouter/google"
          invalid={invalid}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono text-sm"
          boxClassName="h-9 w-full"
          trailing={<span className="font-mono text-xs text-mute-2">/*</span>}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      );
  }
}

interface EntryRowProps {
  entry: string;
  index: number;
  count: number;
  chain: number;
  models: readonly ModelInfo[];
  error?: string;
  onChange: (entry: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function EntryRow({ entry, index, count, chain, models, error, onChange, onMove, onRemove }: EntryRowProps) {
  const parsed = parseChainEntry(entry);
  const what = `fallback ${index + 1} of chain ${chain}`;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="w-5 shrink-0 text-right font-mono text-2xs text-mute-2 tabular">{index + 1}</span>
      <ModelCombobox
        value={parsed.model}
        models={models}
        label={`Model of ${what}`}
        wildcards
        invalid={!!error}
        className="w-auto min-w-0 flex-1 basis-44"
        accept={(t) => isModelSelector(t) || isWildcard(t)}
        onPick={(m) => onChange(formatChainEntry(m, keepThinking(models, m, parsed.thinking)))}
      />
      <div className="flex items-center gap-1 max-sm:w-full max-sm:pl-6.5">
        <ThinkingSelect
          model={parsed.wildcard ? undefined : parsed.model}
          models={models}
          value={parsed.thinking}
          defaultLabel={parsed.wildcard ? "Inherit (wildcard)" : "Inherit"}
          disabled={parsed.wildcard}
          label={`Thinking of ${what}`}
          className="w-36 max-md:w-36 max-sm:flex-1"
          onChange={(level) => onChange(formatChainEntry(parsed.model, level))}
        />
        <IconButton size="sm" label={`Move ${what} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
          <ArrowUp />
        </IconButton>
        <IconButton size="sm" label={`Move ${what} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
          <ArrowDown />
        </IconButton>
        <IconButton size="sm" label={`Remove ${what}`} onClick={onRemove}>
          <X />
        </IconButton>
      </div>
      {error && <p className="basis-full pl-6.5 text-xs font-semibold text-error">{error}</p>}
    </li>
  );
}
