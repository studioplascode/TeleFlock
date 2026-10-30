import { Blocks, Boxes, ChevronRight, CircleX, KeyRound, type LucideIcon, Lock, SlidersHorizontal } from "lucide-react";
import { type ComponentProps, useId, useState } from "react";
import type { SyncChange, SyncItem, SyncItemResult, SyncPlan, SyncSection, SyncSignIn } from "@/core/gen";
import { Button, Chip, cn } from "@/design";
import { providerName } from "@/features/accounts/providers";
import { plural } from "@/features/mcp/model";
import { Ticks } from "@/features/shell/Ticks";
import { ABSENT, changeHint, changeLabel, formatValue, groupPlan, missingNeeds, type PlanSection, preview, sectionState, selectable, signInText, withIds } from "./model";

/** One icon per plan section (Settings and MCP servers as their pages show them). */
export const SECTION_ICON: Record<SyncSection, LucideIcon> = { settings: SlidersHorizontal, roles: Boxes, mcp: Blocks, signIns: KeyRound };

/** The change chip's tint. */
export const CHANGE_TONE: Record<SyncChange, ComponentProps<typeof Chip>["tone"]> = {
  add: "done",
  change: "review",
  remove: "error",
  unknown: "idle",
  unsupported: "neutral",
  same: "neutral",
};

export interface PlanSectionsProps {
  plan: SyncPlan;
  selected: ReadonlySet<string>;
  onSelect(next: Set<string>): void;
  /** Host names. */
  source: string;
  target: string;
  /** The last copies' outcome per item: a failure shows on its row. */
  results: ReadonlyMap<string, SyncItemResult>;
}

/** The plan's differences by section, each choosable item with its checkbox; equal items folded per section. */
export function PlanSections({ plan, selected, onSelect, source, target, results }: PlanSectionsProps) {
  const needs = missingNeeds(plan, selected);
  return (
    <div className="flex flex-col gap-5">
      {groupPlan(plan).map((s) => (
        <SectionBlock key={s.section} section={s} selected={selected} onSelect={onSelect} needs={needs} source={source} target={target} results={results} />
      ))}
    </div>
  );
}

function SectionBlock({
  section,
  selected,
  onSelect,
  needs,
  source,
  target,
  results,
}: Omit<PlanSectionsProps, "plan"> & { section: PlanSection; needs: ReadonlyMap<string, SyncItem | null> }) {
  const Icon = SECTION_ICON[section.section];
  const state = sectionState(section, selected);
  const counts = [section.items.length ? plural(section.items.length, "difference") : "", section.same.length ? `${section.same.length} same` : ""].filter(Boolean).join(" · ");
  return (
    <section aria-label={section.title} className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5 px-1">
        <input
          type="checkbox"
          aria-label={`Choose every ${section.title} difference`}
          className="size-4 shrink-0 accent-[#a35cf0]"
          checked={state === "all"}
          ref={(el) => {
            if (el) el.indeterminate = state === "some";
          }}
          disabled={section.choosable.length === 0}
          onChange={(e) => onSelect(withIds(selected, section.choosable, e.target.checked))}
        />
        <Icon className="size-4 shrink-0 text-mute" aria-hidden />
        <h3 className="text-sm font-bold text-ink">{section.title}</h3>
        <span className="text-2xs text-mute-2 tabular">{counts}</span>
      </div>
      {section.items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {section.items.map((item) => (
            <PlanRow
              key={item.id}
              item={item}
              chosen={selected.has(item.id)}
              onToggle={(on) => onSelect(withIds(selected, [item.id], on))}
              needed={needs.has(item.id) ? (needs.get(item.id) ?? null) : undefined}
              onInclude={(id) => onSelect(withIds(selected, [id], true))}
              source={source}
              target={target}
              result={results.get(item.id)}
            />
          ))}
        </ul>
      )}
      {section.same.length > 0 && <SameFold items={section.same} />}
    </section>
  );
}

/**
 * Where an item lives; a sign-in's provider by its app name, an MCP server's OAuth said as such.
 * None when it only repeats the label (a setting outside omp's settings panel goes by its key).
 */
export function placeText(item: SyncItem): string | undefined {
  if (item.place === item.label) return undefined;
  if (item.section !== "signIns" || !item.place) return item.place;
  return ((item.from ?? item.to) as SyncSignIn | undefined)?.mcpUrl ? "MCP server sign-in" : providerName(item.place);
}

function PlanRow({
  item,
  chosen,
  onToggle,
  needed,
  onInclude,
  source,
  target,
  result,
}: {
  item: SyncItem;
  chosen: boolean;
  onToggle(on: boolean): void;
  /** Chosen without its `needs` item: that item when it can be chosen, else null; undefined when nothing is missing. */
  needed: SyncItem | null | undefined;
  onInclude(id: string): void;
  source: string;
  target: string;
  result: SyncItemResult | undefined;
}) {
  const id = useId();
  const canChoose = selectable(item);
  const place = placeText(item);
  const identity = item.section === "signIns" ? signInText(item.from ?? item.to) : null;
  return (
    <li className={cn("rounded-lg px-3 py-2.5 transition-colors", chosen ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.03] shadow-hairline")}>
      <div className="flex items-start gap-3">
        <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[#a35cf0]" checked={chosen} disabled={!canChoose} onChange={(e) => onToggle(e.target.checked)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label htmlFor={id} className={cn("min-w-0 text-sm font-bold break-words", canChoose ? "cursor-pointer text-ink" : "text-ink-2")}>
              {item.secret && <Lock className="mr-1 inline size-3.5 align-[-2px] text-mute" aria-label="Secret" />}
              {item.label}
            </label>
            {place && <span className="min-w-0 text-2xs text-mute-2">{place}</span>}
            <Chip tone={CHANGE_TONE[item.change]} className="ml-auto" title={changeHint(item, source, target)}>
              {changeLabel(item.change, target)}
            </Chip>
          </div>
          {identity && identity !== item.label && <p className="mt-1 text-xs text-ink-2">{identity}</p>}
          {item.secret ? (
            canChoose && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-mute">
                <Lock className="size-3 shrink-0" aria-hidden />
                Secret · never shown · sealed on {source} for {target}
              </p>
            )
          ) : (
            <Values item={item} source={source} />
          )}
          {item.notes.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5 text-2xs text-warn">
              {item.notes.map((n) => (
                <li key={n}>
                  <Ticks text={n} />
                </li>
              ))}
            </ul>
          )}
          {needed !== undefined && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md bg-warn/8 px-2.5 py-1.5 text-xs text-ink-2 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]">
              <KeyRound className="size-3.5 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 flex-1">Without its secrets, its masked values stay empty on {target}.</span>
              {needed && (
                <Button size="sm" variant="secondary" onClick={() => onInclude(needed.id)}>
                  Include its secrets
                </Button>
              )}
            </div>
          )}
          {result && !result.ok && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-[#ffb1c1]">
              <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-bold">The last copy failed: </span>
                <Ticks text={result.error ?? "unknown error"} />
              </span>
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/** "Here: … → <source>: …", monospace; long values fold behind "Show all". */
function Values({ item, source }: { item: SyncItem; source: string }) {
  const [all, setAll] = useState(false);
  const hereValue = formatValue(item.section, item.to);
  const thereValue = formatValue(item.section, item.from);
  // A side without a displayable value that the change says exists (a credential being removed) reads "set".
  const a = preview(hereValue ?? (item.change === "remove" ? "set" : ABSENT[item.section]));
  const b = preview(thereValue ?? (item.change === "add" ? "set" : ABSENT[item.section]));
  const cut = a.cut || b.cut;
  return (
    <div className="mt-1.5">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-xs">
        <dt className="text-mute-2">Here</dt>
        <dd className={cn("font-mono break-all", hereValue === null ? "text-mute-2 italic" : "text-ink-2")}>{all ? (hereValue ?? a.text) : a.text}</dd>
        <dt className="text-mute-2">→ {source}</dt>
        <dd className={cn("font-mono break-all", thereValue === null ? "text-mute-2 italic" : "text-ink")}>{all ? (thereValue ?? b.text) : b.text}</dd>
      </dl>
      {cut && (
        <button type="button" className="mt-0.5 rounded-xs text-2xs font-bold text-accent-hi focus-ring" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** "N already the same", expandable: equal items aren't choosable. */
function SameFold({ items }: { items: readonly SyncItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded-xs text-xs font-semibold text-mute hover:text-ink focus-ring">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        {items.length} already the same
      </button>
      {open && (
        <ul className="mt-1.5 flex flex-col gap-1 pl-5">
          {items.map((i) => {
            const value = i.secret ? null : formatValue(i.section, i.from);
            return (
              <li key={i.id} className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="shrink-0 font-semibold text-ink-2">{i.label}</span>
                {value && <span className="min-w-0 truncate font-mono text-mute-2">{preview(value, 72).text}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
