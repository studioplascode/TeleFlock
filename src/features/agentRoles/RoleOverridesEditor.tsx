import { ChevronDown, Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ModelInfo } from "@/core/gen";
import { Button, cn, IconButton, Input } from "@/design";
import { formatRoleSelector, keepThinking, parseRoleSelector, ROLE_NAME, type RoleRow, roleRows, withRole } from "@/features/ompSettings/model";
import { ModelCombobox, ThinkingSelect } from "@/features/ompSettings/ModelRoles";
import { useModels } from "@/features/session/header/useModels";
import { FallbackChainsEditor, useChainRows } from "./FallbackChainsEditor";
import { type ChainMap, isModelSelector, type RoleMap, selectorLabel, validateRoles } from "./roles";

export interface RoleOverridesEditorProps {
  hostId: string;
  /** The agent's own roles (role → `provider/id[:thinking]`); a role left out uses the host's. */
  value: RoleMap;
  onChange: (next: RoleMap) => void;
  /** What the host assigns: `host.models` roles at launch, `SessionRoleModels.host` for a running session. */
  host: RoleMap;
  /**
   * `editable`: Default is a role like the others (a running session). Launch forms: the read-only
   * text for it (their Model / Thinking fields are the agent's main model).
   */
  defaultRow: "editable" | { readOnlyText: ReactNode };
  /** The agent's own fallback chains; the chains section shows with `onChainsChange`. */
  chains?: ChainMap;
  onChainsChange?: (next: ChainMap) => void;
  /** The host's chains, read-only context in the chains section. */
  hostChains?: ChainMap;
}

/**
 * One agent's own omp roles over the host's: chat roles, model kinds (collapsed until one is
 * set), custom roles, then its fallback chains. A role without its own model shows the host's; a
 * picked model overrides it (with a thinking level), × goes back to the host default. Controlled.
 */
export function RoleOverridesEditor({ hostId, value, onChange, host, defaultRow, chains, onChainsChange, hostChains }: RoleOverridesEditorProps) {
  const { catalog, error } = useModels(hostId);
  const models = catalog?.models ?? [];
  const [added, setAdded] = useState<string[]>([]);
  const [name, setName] = useState("");
  const rows = roleRows({ ...host, ...value }, added);
  const [kindsOpen, setKindsOpen] = useState(() => rows.some((r) => r.kind && value[r.id]));
  const check = validateRoles(value);
  const kindsSet = rows.filter((r) => r.kind && value[r.id]).length;
  const custom = rows.filter((r) => !r.builtin);
  const nameTrim = name.trim();
  const nameError = nameTrim && (!ROLE_NAME.test(nameTrim) ? "Letters, digits, - and _; starts with a letter" : rows.some((r) => r.id === nameTrim) ? "That role exists" : undefined);
  const addRole = () => {
    if (!nameTrim || nameError) return;
    setAdded((a) => [...a, nameTrim]);
    setName("");
  };
  const line = (r: RoleRow) => {
    const own = value[r.id];
    const readOnly = r.id === "default" && defaultRow !== "editable" && !own ? defaultRow.readOnlyText : undefined;
    return (
      <OverrideLine
        key={r.id}
        row={r}
        own={own}
        hostValue={host[r.id]}
        models={models}
        error={check.errors[r.id]}
        readOnly={readOnly}
        note={r.id === "default" && defaultRow === "editable" ? "Changing Default switches this session's model" : undefined}
        onChange={(selector) => onChange(withRole(value, r.id, selector))}
        // A custom role only added here (nothing assigned, not the host's) can go again.
        onRemove={!r.builtin && !own && host[r.id] === undefined ? () => setAdded((a) => a.filter((x) => x !== r.id)) : undefined}
      />
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error && <p className="text-xs text-warn">Couldn't load the host's models ({error}); type a provider/id selector instead.</p>}
      <div>
        <div className="kicker">Chat roles</div>
        <div className="flex flex-col divide-y divide-line">{rows.filter((r) => r.builtin && !r.kind).map(line)}</div>
      </div>
      <div>
        <button type="button" aria-expanded={kindsOpen} onClick={() => setKindsOpen(!kindsOpen)} className="kicker flex items-center gap-1.5 rounded-xs focus-ring">
          Model kinds
          {kindsSet > 0 && <span className="font-semibold tracking-normal normal-case text-accent-hi">{kindsSet} set</span>}
          <ChevronDown className={cn("size-3.5 transition-transform duration-200", kindsOpen && "rotate-180")} />
        </button>
        {kindsOpen && <div className="flex flex-col divide-y divide-line">{rows.filter((r) => r.kind).map(line)}</div>}
      </div>
      <div>
        <div className="kicker">Custom roles</div>
        {custom.length > 0 && <div className="flex flex-col divide-y divide-line">{custom.map(line)}</div>}
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
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRole();
                }
              }}
            />
            {nameError && <p className="text-xs font-semibold text-error">{nameError}</p>}
          </div>
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={!nameTrim || !!nameError} onClick={addRole} className="h-9">
            Add role
          </Button>
        </div>
      </div>
      {check.general.map((g) => (
        <p key={g} className="text-xs font-semibold text-error">
          {g}
        </p>
      ))}
      {onChainsChange && <ChainsSection chains={chains ?? {}} onChange={onChainsChange} models={models} customRoles={custom.map((r) => r.id)} hostChains={hostChains} />}
    </div>
  );
}

function ChainsSection({ chains, onChange, models, customRoles, hostChains }: { chains: ChainMap; onChange: (next: ChainMap) => void; models: readonly ModelInfo[]; customRoles: readonly string[]; hostChains?: ChainMap }) {
  const [rows, setRows] = useChainRows(chains, onChange);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <div className="kicker">Fallback chains</div>
        <p className="mt-0.5 text-xs text-mute">After a provider error (once retries are spent) omp tries a chain's models in order.</p>
      </div>
      <FallbackChainsEditor rows={rows} onChange={setRows} models={models} customRoles={customRoles} hostChains={hostChains ?? {}} />
    </div>
  );
}

interface OverrideLineProps {
  row: RoleRow;
  /** The agent's own selector. */
  own?: string;
  hostValue?: string;
  models: readonly ModelInfo[];
  error?: string;
  /** Shown instead of the picker (launch forms' Default). */
  readOnly?: ReactNode;
  note?: string;
  onChange: (selector: string | undefined) => void;
  onRemove?: () => void;
}

function OverrideLine({ row, own, hostValue, models, error, readOnly, note, onChange, onRemove }: OverrideLineProps) {
  const parsed = own ? parseRoleSelector(own) : undefined;
  const hostText = hostValue ? selectorLabel(models, hostValue) : "not set (omp picks)";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 max-md:py-2">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold text-ink">{row.name ?? row.id}</span>
          <span className="font-mono text-2xs text-mute-2">@{row.id}</span>
        </div>
        {row.description && <p className="text-xs text-mute">{row.description}</p>}
        {note && <p className="text-xs text-mute-2">{note}</p>}
        {own && <p className="truncate text-2xs text-mute-2">Host default: {hostText}</p>}
        {error && <p className="text-xs font-semibold text-error">{error}</p>}
      </div>
      {readOnly ? (
        <p className="min-w-0 text-xs font-semibold text-ink-2 max-md:w-full md:max-w-[55%] md:text-right">{readOnly}</p>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 max-md:w-full">
          <ModelCombobox
            value={parsed?.model}
            models={models}
            label={`Model for ${row.id}`}
            placeholder="Host default"
            accept={isModelSelector}
            onPick={(m) => onChange(formatRoleSelector(m, keepThinking(models, m, parsed?.thinking)))}
          />
          {parsed ? (
            <ThinkingSelect model={parsed.model} models={models} value={parsed.thinking} label={`Thinking for ${row.id}`} onChange={(level) => onChange(formatRoleSelector(parsed.model, level))} />
          ) : (
            <span className="w-40 min-w-0 truncate text-xs text-mute-2 max-md:w-32" title={hostValue}>
              {hostText}
            </span>
          )}
          {own || onRemove ? (
            <IconButton size="sm" label={own ? `Use the host default for ${row.id}` : `Remove ${row.id}`} onClick={() => (own ? onChange(undefined) : onRemove?.())}>
              <X />
            </IconButton>
          ) : (
            <span className="size-7 shrink-0" />
          )}
        </div>
      )}
    </div>
  );
}
