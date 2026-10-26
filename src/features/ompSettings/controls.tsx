import { ArrowDown, ArrowUp, Check, KeyRound, Plus, RotateCcw, TriangleAlert, Undo2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { OmpSetting, OmpSettingChange, OmpSettingOption } from "@/core/gen";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  Tooltip,
  useIsMobile,
} from "@/design";
import { conditionInfo, deepEqual, editorFor, enumChoices, formatJson, isModified, memberChoices, parseJson, parseNumber, valueText } from "./model";
import { ModelRoles } from "./ModelRoles";

/** Typing pause before a text field saves (blur and Enter save at once). */
const TEXT_DEBOUNCE_MS = 900;
const CUSTOM = "\u0000custom";

function numberError(text: string): string | undefined {
  const n = parseNumber(text);
  return n.ok ? undefined : n.error;
}

export interface RowContext {
  hostId: string;
  /** Current value of any setting (conditions). */
  get: (id: string) => unknown;
  /** Host OS from HostInfo (`linux`, `macos`, `windows`). */
  os?: string;
  save: (changes: OmpSettingChange[]) => void;
}

/**
 * Text draft that saves after a typing pause, on blur and on Enter. Host echoes don't overwrite
 * what is still being typed.
 */
function useDraft(value: string, commit: (text: string) => void) {
  const [draft, setDraftState] = useState(value);
  const draftRef = useRef(value);
  const committed = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (draftRef.current !== committed.current) return;
    committed.current = value;
    draftRef.current = value;
    setDraftState(value);
  }, [value]);
  const flush = () => {
    window.clearTimeout(timer.current);
    if (draftRef.current === committed.current) return;
    committed.current = draftRef.current;
    commitRef.current(draftRef.current);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const change = (text: string) => {
    draftRef.current = text;
    setDraftState(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flushRef.current(), TEXT_DEBOUNCE_MS);
  };
  return { draft, change, flush };
}

function TextControl({ value, onCommit, label, placeholder, validate, className }: { value: string; onCommit: (text: string) => void; label: string; placeholder?: string; validate?: (text: string) => string | undefined; className?: string }) {
  const [error, setError] = useState<string | undefined>();
  const { draft, change, flush } = useDraft(value, (text) => {
    const err = validate?.(text);
    setError(err);
    if (!err) onCommit(text);
  });
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Input
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        invalid={!!error}
        spellCheck={false}
        autoCapitalize="off"
        className="font-mono text-sm"
        onChange={(e) => {
          change(e.target.value);
          if (error) setError(validate?.(e.target.value));
        }}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush();
        }}
      />
      {error && <p className="text-xs font-semibold text-error">{error}</p>}
    </div>
  );
}

/**
 * Presets (omp's options) plus "Custom…" with a free field; the field shows while the value is no
 * preset. A number setting's non-numeric option (`compaction.thresholdPercent`: "default") stands
 * for omp's default: picking it resets the setting, and the default value shows as that option.
 */
function PresetControl({ s, onCommit, kind }: { s: OmpSetting; onCommit: (v: unknown) => void; kind: "number" | "text" }) {
  const options = s.options ?? [];
  const resetOption = kind === "number" ? options.find((o) => !parseNumber(o.value).ok)?.value : undefined;
  const raw = valueText(s.value);
  const atDefault = s.value === undefined || deepEqual(s.value, s.default);
  const current = resetOption !== undefined && atDefault && !options.some((o) => o.value === raw) ? resetOption : raw;
  const isPreset = options.some((o) => o.value === current);
  const [custom, setCustom] = useState(!isPreset);
  useEffect(() => {
    if (!isPreset) setCustom(true);
  }, [isPreset]);
  const label = s.label ?? s.id;
  const commitText = (text: string) => {
    if (kind === "text") return onCommit(text);
    if (text === resetOption) return onCommit(null);
    const n = parseNumber(text);
    if (n.ok) onCommit(n.value);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2 max-md:w-full">
      <Select
        aria-label={label}
        className="w-48 max-md:flex-1"
        value={custom ? CUSTOM : current}
        onValueChange={(v) => {
          if (v === CUSTOM) return setCustom(true);
          setCustom(false);
          commitText(v);
        }}
        options={[...options.map((o) => ({ value: o.value, label: o.label, hint: o.description })), { value: CUSTOM, label: "Custom…" }]}
      />
      {custom && (
        <TextControl
          value={raw}
          label={`${label} value`}
          className="w-36 max-md:flex-1"
          onCommit={commitText}
          validate={kind === "number" ? numberError : undefined}
        />
      )}
    </div>
  );
}

function ChoiceControl({ s, onCommit }: { s: OmpSetting; onCommit: (v: string) => void }) {
  const mobile = useIsMobile();
  const choices: OmpSettingOption[] = enumChoices(s);
  const current = valueText(s.value);
  if (current && !choices.some((c) => c.value === current)) choices.push({ value: current, label: current, description: "Set in config.yml" });
  const label = s.label ?? s.id;
  const segmented = choices.length <= 3 && choices.every((c) => c.label.length <= 12) && !choices.some((c) => c.description);
  if (segmented) return <SegmentedControl size="sm" value={current} onValueChange={onCommit} options={choices.map((c) => ({ value: c.value, label: c.label }))} aria-label={label} fill={mobile} />;
  return <Select aria-label={label} className="w-56 max-md:w-full" value={current} onValueChange={onCommit} options={choices.map((c) => ({ value: c.value, label: c.label, hint: c.description }))} />;
}

/** Write-only: the value never comes back from the host. */
function SecretControl({ s, onSet, onClear }: { s: OmpSetting; onSet: (v: string) => void; onClear: () => void }) {
  const [draft, setDraft] = useState("");
  const save = () => {
    if (!draft) return;
    onSet(draft);
    setDraft("");
  };
  return (
    <div className="flex min-w-0 items-center gap-2 max-md:w-full">
      <Input
        type="password"
        autoComplete="new-password"
        aria-label={s.label ?? s.id}
        value={draft}
        placeholder={s.redacted ? "•••••••• set — type to replace" : "Not set"}
        boxClassName="w-56 max-md:flex-1"
        leading={<KeyRound />}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <Button size="sm" variant="secondary" disabled={!draft} onClick={save}>
        Save
      </Button>
      {s.redacted && (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  );
}

function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function ListRows({ items, render, onChange, label }: { items: readonly string[]; render: (item: string, i: number) => ReactNode; onChange: (next: string[]) => void; label: (item: string) => string }) {
  return (
    <ol className="flex flex-col gap-1">
      {items.map((item, i) => (
        <li key={`${i}:${item}`} className="flex min-w-0 items-center gap-1.5 rounded-md well py-1 pr-1 pl-2.5">
          <span className="w-5 shrink-0 font-mono text-2xs text-mute-2 tabular">{i + 1}</span>
          <div className="min-w-0 flex-1">{render(item, i)}</div>
          <IconButton size="sm" label={`Move ${label(item)} up`} disabled={i === 0} onClick={() => onChange(moveItem(items, i, i - 1))}>
            <ArrowUp />
          </IconButton>
          <IconButton size="sm" label={`Move ${label(item)} down`} disabled={i === items.length - 1} onClick={() => onChange(moveItem(items, i, i + 1))}>
            <ArrowDown />
          </IconButton>
          <IconButton size="sm" label={`Remove ${label(item)}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X />
          </IconButton>
        </li>
      ))}
    </ol>
  );
}

/** Array over a closed vocabulary: chosen entries in order, the rest in the Add menu. */
function MembersControl({ s, choices, onCommit }: { s: OmpSetting; choices: OmpSettingOption[]; onCommit: (v: string[]) => void }) {
  const items = Array.isArray(s.value) ? s.value.filter((v): v is string => typeof v === "string") : [];
  const byValue = (v: string) => choices.find((c) => c.value === v);
  const rest = choices.filter((c) => !items.includes(c.value));
  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 && <p className="text-xs text-mute">None selected.</p>}
      <ListRows
        items={items}
        onChange={onCommit}
        label={(v) => byValue(v)?.label ?? v}
        render={(v) => {
          const c = byValue(v);
          return (
            <div className="min-w-0">
              <span className="text-sm font-semibold text-ink">{c?.label ?? v}</span>
              {c && c.label !== v && <span className="ml-2 font-mono text-2xs text-mute-2">{v}</span>}
              {c?.description && <p className="truncate text-2xs text-mute">{c.description}</p>}
              {!c && <p className="text-2xs text-warn">Not one of omp's choices</p>}
            </div>
          );
        }}
      />
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary" icon={<Plus />} className="self-start">
              Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {rest.map((c) => (
              <DropdownMenuItem key={c.value} onSelect={() => onCommit([...items, c.value])}>
                <span className="flex min-w-0 flex-col">
                  <span>{c.label}</span>
                  {c.description && <span className="max-w-72 truncate text-2xs font-normal text-mute">{c.description}</span>}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Free list of strings. */
function ListControl({ s, onCommit }: { s: OmpSetting; onCommit: (v: string[]) => void }) {
  const items = Array.isArray(s.value) ? s.value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))) : [];
  const [adding, setAdding] = useState("");
  const add = () => {
    if (!adding.trim()) return;
    onCommit([...items, adding]);
    setAdding("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <ListRows
        items={items}
        onChange={onCommit}
        label={(v) => v}
        render={(v, i) => (
          <TextControl value={v} label={`${s.label ?? s.id} entry ${i + 1}`} onCommit={(text) => onCommit(items.map((x, j) => (j === i ? text : x)))} className="[&>div]:h-8 [&>div]:bg-transparent [&>div]:shadow-none" />
        )}
      />
      <div className="flex items-center gap-2">
        <Input
          value={adding}
          aria-label={`Add to ${s.label ?? s.id}`}
          placeholder="Add an entry"
          className="font-mono text-sm"
          boxClassName="h-9 flex-1"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Button size="sm" variant="secondary" icon={<Plus />} disabled={!adding.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** JSON editor for records, object arrays and `editor: json`: saved explicitly once valid. */
function JsonControl({ s, onCommit }: { s: OmpSetting; onCommit: (v: unknown) => void }) {
  const saved = formatJson(s.value ?? (s.type === "record" ? {} : []));
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  // Host changes re-seed the editor only while it holds no local edits.
  if (base !== saved) {
    setBase(saved);
    if (draft === base) setDraft(saved);
  }
  const dirty = draft !== saved;
  const parsed = parseJson(draft, s.type);
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={draft}
        aria-label={`${s.label ?? s.id} (JSON)`}
        spellCheck={false}
        invalid={!parsed.ok}
        maxHeight={360}
        className="font-mono text-xs leading-relaxed"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {!parsed.ok ? <p className="flex-1 text-xs font-semibold text-error">{parsed.error}</p> : <p className="flex-1 text-2xs text-mute-2">{dirty ? "Unsaved changes" : "JSON"}</p>}
        {dirty && (
          <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setDraft(saved)}>
            Revert
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={<Check />}
          disabled={!dirty || !parsed.ok}
          onClick={() => {
            if (!parsed.ok) return;
            setDraft(formatJson(parsed.value));
            onCommit(parsed.value);
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function Control({ s, ctx }: { s: OmpSetting; ctx: RowContext }) {
  const set = (value: unknown) => ctx.save([{ key: s.id, value }]);
  const label = s.label ?? s.id;
  switch (editorFor(s)) {
    case "roles":
      return <ModelRoles setting={s} hostId={ctx.hostId} onCommit={set} />;
    case "secret":
      return <SecretControl s={s} onSet={set} onClear={() => set(null)} />;
    case "switch":
      return <Switch checked={s.value === true} onCheckedChange={set} label={label} />;
    case "choice":
      return <ChoiceControl s={s} onCommit={set} />;
    case "number":
      if (s.options?.length) return <PresetControl s={s} kind="number" onCommit={set} />;
      return (
        <TextControl
          value={valueText(s.value)}
          label={label}
          placeholder={s.default === undefined ? "Not set" : valueText(s.default)}
          className="w-36 max-md:w-full"
          validate={numberError}
          onCommit={(t) => {
            const n = parseNumber(t);
            if (n.ok) set(n.value);
          }}
        />
      );
    case "text":
      if (s.options?.length) return <PresetControl s={s} kind="text" onCommit={set} />;
      return (
        <TextControl
          value={valueText(s.value)}
          label={label}
          placeholder={s.runtimeOptions ? "A name omp knows (listed in omp's /settings)" : s.default ? valueText(s.default) : "Not set"}
          className="w-64 max-md:w-full"
          onCommit={(t) => set(t === "" && s.default === undefined ? null : t)}
        />
      );
    case "members":
      return <MembersControl s={s} choices={memberChoices(s) ?? []} onCommit={set} />;
    case "list":
      return <ListControl s={s} onCommit={set} />;
    case "json":
      return <JsonControl s={s} onCommit={set} />;
  }
}

const WIDE = new Set(["roles", "members", "list", "json"]);

/** One omp setting: label, hints, key, control, modified dot and reset. */
export function SettingRow({ s, ctx, showPlace }: { s: OmpSetting; ctx: RowContext; showPlace?: string }) {
  const kind = editorFor(s);
  const wide = WIDE.has(kind);
  const modified = isModified(s);
  const cond = s.condition ? conditionInfo(s.condition, ctx.get, ctx.os) : undefined;
  const defaultText = s.credential ? "" : valueText(s.default);
  const reset = modified && kind !== "roles" && (
    <IconButton size="sm" label={s.credential ? "Clear" : "Reset to omp's default"} onClick={() => ctx.save([{ key: s.id, value: null }])}>
      <RotateCcw />
    </IconButton>
  );
  return (
    <div id={`omp-setting-${s.id}`} className={cn("flex flex-col gap-2 py-3.5 first:pt-1 last:pb-1 max-md:py-3", cond?.holds === false && "[&_.omp-head]:opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className={cn("omp-head min-w-0 flex-1 basis-64", kind === "switch" ? "max-md:basis-0" : "max-md:basis-full")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {modified && <span className="size-1.5 shrink-0 rounded-full bg-accent-hi shadow-[0_0_8px_rgb(163_92_240/0.8)]" title="Changed from omp's default" />}
            <span className="text-sm font-bold text-ink">{s.label ?? s.id}</span>
            {showPlace && <span className="text-2xs font-semibold text-mute-2">{showPlace}</span>}
            {cond && (
              <span className={cn("rounded-full px-1.5 py-px text-2xs font-semibold", cond.holds === false ? "bg-white/6 text-mute-2" : "bg-white/8 text-mute")} title={`omp's own panel shows this only when it applies (${s.condition})`}>
                {cond.hint}
              </span>
            )}
            {s.env && (
              <Tooltip content={`$${s.env} in omp's environment on the host takes precedence over this setting (or fills it in while unset).`}>
                <span className="rounded-full bg-white/6 px-1.5 py-px font-mono text-2xs text-mute">${s.env}</span>
              </Tooltip>
            )}
          </div>
          {s.warning && (
            <p className="mt-1 flex items-start gap-1.5 text-xs font-semibold text-warn">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {s.warning}
            </p>
          )}
          {s.description && <p className="mt-0.5 text-xs text-mute">{s.description}</p>}
          <p className="mt-0.5 truncate font-mono text-2xs text-mute-2">
            {s.id}
            {modified && defaultText && defaultText.length <= 48 && <span> · default {defaultText}</span>}
          </p>
        </div>
        {!wide && (
          <div className={cn("flex shrink-0 items-center gap-1.5", kind !== "switch" && "max-md:w-full max-md:[&>*:first-child]:flex-1")}>
            <Control s={s} ctx={ctx} />
            {reset}
          </div>
        )}
        {wide && reset}
      </div>
      {wide && <Control s={s} ctx={ctx} />}
    </div>
  );
}
