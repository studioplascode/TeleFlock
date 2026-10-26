import { CalendarClock, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Input, Select, Spinner, cn } from "@/design";
import { formatWhen, hostWhen } from "./format";
import { EVERY_HOURS, EVERY_MINUTES, fitEvery, PRESET_LABELS, type PresetKind, type ScheduleDraft, scheduleToCron } from "./schedule";
import type { PreviewState } from "./useAutomations";

const KINDS: PresetKind[] = ["minutes", "hours", "daily", "weekdays", "weekly", "custom"];
/** Monday first. */
const WEEK: { day: number; short: string; long: string }[] = [
  { day: 1, short: "Mo", long: "Monday" },
  { day: 2, short: "Tu", long: "Tuesday" },
  { day: 3, short: "We", long: "Wednesday" },
  { day: 4, short: "Th", long: "Thursday" },
  { day: 5, short: "Fr", long: "Friday" },
  { day: 6, short: "Sa", long: "Saturday" },
  { day: 0, short: "Su", long: "Sunday" },
];

const clamp = (v: string, lo: number, hi: number, fallback: number) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

function Inline({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-2">{children}</div>;
}

function NumberBox({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange(v: number): void; label: string }) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(clamp(e.target.value, min, max, value))}
      boxClassName="w-[84px]"
      className="tabular"
    />
  );
}

function EveryBox({ value, choices, onChange, label }: { value: number; choices: readonly number[]; onChange(v: number): void; label: string }) {
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onChange(Number(v))}
      options={choices.map((n) => ({ value: String(n), label: String(n) }))}
      aria-label={label}
      className="w-[84px] tabular"
    />
  );
}

function TimeBox({ draft, onChange }: { draft: ScheduleDraft; onChange(p: Partial<ScheduleDraft>): void }) {
  return (
    <Input
      type="time"
      aria-label="Time"
      value={hhmm(draft.hour, draft.minute)}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":");
        if (h === undefined || m === undefined) return;
        onChange({ hour: clamp(h, 0, 23, draft.hour), minute: clamp(m, 0, 59, draft.minute) });
      }}
      boxClassName="w-[120px]"
      className="tabular"
    />
  );
}

export interface ScheduleFieldProps {
  draft: ScheduleDraft;
  onChange(patch: Partial<ScheduleDraft>): void;
  preview: PreviewState;
  /** Host time zone (from `automation.list`). */
  timezone?: string;
  error?: string | null;
}

/** Preset picker + its inputs (or a raw cron), and the host's live reading of the result. */
export function ScheduleField({ draft, onChange, preview, timezone, error }: ScheduleFieldProps) {
  const cron = scheduleToCron(draft);
  const p = preview.preview;
  const stale = preview.loading || preview.schedule !== cron.trim();
  const setKind = (kind: PresetKind) => onChange(kind === "custom" ? { kind, cron } : kind === "minutes" || kind === "hours" ? { kind, every: fitEvery(kind, draft.every) } : { kind });
  const problem = preview.error?.message ?? (p && !p.valid ? (p.error ?? "Invalid schedule") : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={draft.kind} onValueChange={(v) => setKind(v as PresetKind)} options={KINDS.map((k) => ({ value: k, label: PRESET_LABELS[k] }))} aria-label="Schedule" className="min-w-44 max-md:flex-1" />
        {draft.kind !== "custom" && (
          <code className="ml-auto rounded-xs bg-black/25 px-1.5 py-0.5 font-mono text-2xs text-mute" title="The cron expression this preset saves">
            {cron}
          </code>
        )}
      </div>

      {draft.kind === "minutes" && (
        <Inline>
          Every <EveryBox label="Minutes between runs" value={draft.every} choices={EVERY_MINUTES} onChange={(every) => onChange({ every })} /> minutes
        </Inline>
      )}
      {draft.kind === "hours" && (
        <Inline>
          Every <EveryBox label="Hours between runs" value={draft.every} choices={EVERY_HOURS} onChange={(every) => onChange({ every })} /> hours, at minute
          <NumberBox label="Minute past the hour" value={draft.minute} min={0} max={59} onChange={(minute) => onChange({ minute })} />
        </Inline>
      )}
      {(draft.kind === "daily" || draft.kind === "weekdays") && (
        <Inline>
          {draft.kind === "daily" ? "Every day" : "Monday to Friday"} at <TimeBox draft={draft} onChange={onChange} />
        </Inline>
      )}
      {draft.kind === "weekly" && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
            {WEEK.map((d) => {
              const on = draft.days.includes(d.day);
              return (
                <button
                  key={d.day}
                  type="button"
                  aria-pressed={on}
                  aria-label={d.long}
                  title={d.long}
                  onClick={() => {
                    const days = on ? draft.days.filter((x) => x !== d.day) : [...draft.days, d.day];
                    if (days.length > 0) onChange({ days });
                  }}
                  className={cn(
                    "grid h-9 min-w-10 flex-1 place-items-center rounded-md px-2 text-xs font-bold pressable focus-ring max-w-14",
                    on ? "bg-accent/22 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5)]" : "well text-mute hover:text-ink",
                  )}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          <Inline>
            at <TimeBox draft={draft} onChange={onChange} />
          </Inline>
        </div>
      )}
      {draft.kind === "custom" && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={draft.cron}
            onChange={(e) => onChange({ cron: e.target.value })}
            placeholder="0 9 * * 1-5"
            aria-label="Cron expression"
            invalid={!stale && !!problem}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono"
          />
          <p className="text-2xs text-mute-2">
            <span className="font-mono text-mute">minute hour day-of-month month day-of-week</span> · <span className="font-mono">*</span>,{" "}
            <span className="font-mono">1-5</span>, <span className="font-mono">*/15</span>, <span className="font-mono">mon,wed</span>,{" "}
            <span className="font-mono">@daily</span>
          </p>
        </div>
      )}

      <div className="rounded-md well px-3.5 py-3" aria-live="polite">
        <div className="flex items-center gap-2">
          {problem && !stale ? <CircleAlert className="size-4 shrink-0 text-error" /> : <CalendarClock className="size-4 shrink-0 text-accent-hi" />}
          <span className={cn("min-w-0 flex-1 text-sm font-bold", problem && !stale ? "text-error" : "text-ink", stale && "opacity-60")}>
            {problem ?? p?.description ?? (preview.loading ? "Reading the schedule…" : "—")}
          </span>
          {preview.loading && <Spinner size={14} className="shrink-0" />}
        </div>
        {p?.valid && p.next.length > 0 && (
          <ol className={cn("mt-2 flex flex-col gap-0.5 pl-6 text-xs text-mute tabular", stale && "opacity-60")}>
            {p.next.map((t) => {
              const there = timezone ? hostWhen(t, timezone) : null;
              return (
                <li key={t} className="flex flex-wrap gap-x-2">
                  <span className="text-ink-2">{formatWhen(t)}</span>
                  {there && <span className="text-mute-2">· {there} host time</span>}
                </li>
              );
            })}
          </ol>
        )}
        {timezone && <p className="mt-2 pl-6 text-2xs text-mute-2">Times follow the host's clock ({timezone}).</p>}
      </div>
      {error && <p className="text-xs font-semibold text-error">{error}</p>}
    </div>
  );
}
