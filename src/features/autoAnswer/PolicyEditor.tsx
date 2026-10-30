import { Timer } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { AutoAnswer } from "@/core/gen";
import { Chip, cn, Input, SegmentedControl, Switch } from "@/design";
import { AgentOptionsSection } from "@/features/workspace/shared/AgentOptions";
import { CUSTOM_MAX_MINUTES, CUSTOM_MIN_MINUTES, formatWait, NEW_POLICY, policyChipText, policySummary, WAIT_PRESETS } from "./format";
import { useHostAutoAnswer } from "./hooks";

/** What decide for me answers, said once wherever a policy is set. */
export const QUALIFIES_NOTE = "When a question with a ★ recommended option waits this long, the host picks ★ by itself. Never approvals, plan reviews or typed answers.";

type Mode = "host" | "off" | "on";

export interface PolicyEditorProps {
  /** The policy; `undefined` = the host default (offered only with `hostDefault`). */
  value: AutoAnswer | undefined;
  onChange(value: AutoAnswer | undefined): void;
  /** Offers "Host default" and says what it does; omit where the policy is the host's own default (Settings). */
  hostDefault?: AutoAnswer;
  disabled?: boolean;
}

/**
 * A decide-for-me policy: Host default · Off · On, and when on the wait (presets or whole minutes,
 * 1 min–24 h) and "Only while no app is connected". Launch forms, the running agent's dialog and
 * Settings share it.
 */
export function PolicyEditor({ value, onChange, hostDefault, disabled = false }: PolicyEditorProps) {
  const mode: Mode = value === undefined ? (hostDefault ? "host" : "off") : value.enabled ? "on" : "off";
  // switching on starts from what applied before: the policy itself, else the host default while it is on
  const base = value ?? (hostDefault?.enabled ? hostDefault : NEW_POLICY);
  const options = [...(hostDefault ? [{ value: "host" as const, label: "Host default" }] : []), { value: "off" as const, label: "Off" }, { value: "on" as const, label: "On" }];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SegmentedControl
        size="sm"
        aria-label="Decide for me"
        value={mode}
        options={options.map((o) => ({ ...o, disabled }))}
        onValueChange={(m) => onChange(m === "host" ? undefined : { ...base, enabled: m === "on" })}
        className="self-start"
      />
      {mode === "host" && hostDefault && (
        <p className="text-xs text-mute">
          {hostDefault.enabled ? `This host's default: picks ★ ${policySummary(hostDefault)}.` : "This host's default is off: questions wait for you."}
        </p>
      )}
      {mode === "off" && <p className="text-xs text-mute">{hostDefault?.enabled ? "Questions wait for you, although this host's default is on." : "Questions wait for you."}</p>}
      {mode === "on" && value && (
        <>
          <WaitPicker secs={value.afterSecs} disabled={disabled} onChange={(afterSecs) => onChange({ ...value, afterSecs })} />
          <NoAppSwitch checked={value.onlyWhenNoApp} disabled={disabled} onChange={(onlyWhenNoApp) => onChange({ ...value, onlyWhenNoApp })} />
        </>
      )}
    </div>
  );
}

function Choice({ on, disabled, onClick, children }: { on: boolean; disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-8 rounded-md px-2.5 text-xs font-bold whitespace-nowrap transition-colors pressable focus-ring disabled:opacity-45",
        on ? "bg-accent/16 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.55)]" : "text-ink-2 well hover:bg-white/6",
      )}
    >
      {children}
    </button>
  );
}

/** The wait: 5 min … 2 h, or Custom in whole minutes (1–1440). */
function WaitPicker({ secs, onChange, disabled }: { secs: number; onChange(secs: number): void; disabled: boolean }) {
  const labelId = useId();
  const [custom, setCustom] = useState(!WAIT_PRESETS.includes(secs));
  const [text, setText] = useState(() => String(Math.max(CUSTOM_MIN_MINUTES, Math.round(secs / 60))));
  const minutes = Number(text);
  const valid = Number.isInteger(minutes) && minutes >= CUSTOM_MIN_MINUTES && minutes <= CUSTOM_MAX_MINUTES;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className="text-2xs font-bold text-mute">
        Picks ★ after
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        {WAIT_PRESETS.map((s) => (
          <Choice
            key={s}
            on={!custom && secs === s}
            disabled={disabled}
            onClick={() => {
              setCustom(false);
              onChange(s);
            }}
          >
            {formatWait(s)}
          </Choice>
        ))}
        <Choice
          on={custom}
          disabled={disabled}
          onClick={() => {
            setCustom(true);
            setText(String(Math.max(CUSTOM_MIN_MINUTES, Math.round(secs / 60))));
          }}
        >
          Custom
        </Choice>
        {custom && (
          <Input
            type="number"
            inputMode="numeric"
            min={CUSTOM_MIN_MINUTES}
            max={CUSTOM_MAX_MINUTES}
            step={1}
            value={text}
            disabled={disabled}
            invalid={!valid}
            aria-label="Wait in minutes"
            trailing={<span className="text-xs font-bold text-mute">min</span>}
            boxClassName="h-8 w-28"
            onChange={(e) => {
              setText(e.target.value);
              const m = Number(e.target.value);
              if (Number.isInteger(m) && m >= CUSTOM_MIN_MINUTES && m <= CUSTOM_MAX_MINUTES) onChange(m * 60);
            }}
          />
        )}
      </div>
      {custom && !valid && (
        <p className="text-xs font-semibold text-error">
          {CUSTOM_MIN_MINUTES} to {CUSTOM_MAX_MINUTES} minutes (24 h)
        </p>
      )}
    </div>
  );
}

function NoAppSwitch({ checked, onChange, disabled }: { checked: boolean; onChange(on: boolean): void; disabled: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-bold text-ink">Only while no app is connected</span>
        <span className="block text-xs text-mute">The clock stands while a TeleFlock app is connected to this host and goes on once the last one disconnects.</span>
      </label>
    </div>
  );
}

/** Header chip of `AgentOptions` for a launch's own decide-for-me policy; null for the host default. */
export function autoAnswerChip(value: AutoAnswer | undefined): ReactNode {
  const text = policyChipText(value);
  return text ? (
    <Chip key="autoAnswer" tone="accent" icon={<Timer />} className="h-5 px-2 text-2xs">
      {text}
    </Chip>
  ) : null;
}

/**
 * `AgentOptions` section of the launch forms (New agent, New worktree, Fan out, Dispatch,
 * Automations): the agent's own decide-for-me policy (`AgentSpec.autoAnswer`); `undefined` = the
 * host default. A host without decide for me says so instead.
 */
export function AutoAnswerSection({ hostId, value, onChange }: { hostId: string; value: AutoAnswer | undefined; onChange(value: AutoAnswer | undefined): void }) {
  const hostDefault = useHostAutoAnswer(hostId);
  return (
    <AgentOptionsSection title="Decide for me" note={QUALIFIES_NOTE}>
      {hostDefault ? <PolicyEditor value={value} onChange={onChange} hostDefault={hostDefault} /> : <p className="text-xs text-mute-2">Update TeleFlock on this host to use it.</p>}
    </AgentOptionsSection>
  );
}
