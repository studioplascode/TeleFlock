import { ArrowUp, Check, ClipboardList, Cpu, LayoutTemplate, Lock, Sparkles } from "lucide-react";
import { forwardRef, type KeyboardEvent, useImperativeHandle, useMemo, useRef } from "react";
import { useAiNaming, useAiSuggestion, useDraft, useSettings } from "@/core";
import type { ThinkingLevel } from "@/core/gen";
import { IconButton, Kbd, Popover, PopoverContent, PopoverTrigger, Select, type SelectOption, Switch, Textarea, cn } from "@/design";
import { useModelCatalog } from "@/features/workspace/shared/AgentFields";
import { templateSummary } from "@/features/workspace/shared/templates";
import { type DispatchOptions, suggestDispatchName } from "./store";
import { prefetchKey } from "./thread";

const DEFAULT = "default";
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface DispatchComposerHandle {
  focus(): void;
  /** The unsent task text. */
  text(): string;
}

export interface DispatchComposerProps {
  hostId?: string;
  /** The thread's repository: with AI naming on, the task's name is fetched while the user pauses typing. */
  repo?: string | null;
  /** Draft key of the task text (per host + repo), so an unsent task survives navigation and reload. */
  draftKey: string;
  options: DispatchOptions;
  onOptionsChange(options: DispatchOptions): void;
  /** Sends one task; the composer clears itself and keeps focus. */
  onSend(prompt: string): void;
  /** Why sending is impossible right now (no repo, host offline); disables the composer. */
  disabledReason?: string | null;
  placeholder: string;
  mobile: boolean;
}

/**
 * Multi-line task box: Enter sends (desktop), Shift+Enter is a newline, the send button works
 * everywhere. Clears and keeps focus after each send so tasks can be fired back to back. The
 * footer holds the per-dispatch options: template or model + thinking, and plan mode.
 */
export const DispatchComposer = forwardRef<DispatchComposerHandle, DispatchComposerProps>(function DispatchComposer(
  { hostId, repo, draftKey, options, onOptionsChange, onSend, disabledReason, placeholder, mobile },
  ref,
) {
  const [text, setText, clearText] = useDraft(draftKey);
  const ta = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(text);
  latest.current = text;
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), text: () => latest.current }), []);
  const disabled = !!disabledReason;
  const canSend = !disabled && !!text.trim();

  // Name the task ahead of the send (same call as the send's, cached by ai.ts): after a pause of
  // ~1.2 s with a few words typed, so most sends skip the "Naming…" wait.
  const ai = useAiNaming(hostId);
  const prefetch = ai && hostId && repo && !disabled ? prefetchKey(text) : null;
  useAiSuggestion(hostId, prefetch, () => (hostId && repo && prefetch ? suggestDispatchName(hostId, repo, prefetch) : Promise.resolve(null)), { debounceMs: 1200 });

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    clearText();
    ta.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key !== "Enter") return;
    if ((!mobile && !e.shiftKey && !e.altKey) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Textarea
      ref={ta}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label="Task"
      disabled={disabled}
      autoFocus={!mobile && !disabled}
      enterKeyHint={mobile ? "send" : undefined}
      maxHeight={mobile ? 140 : 240}
      boxClassName={cn("glass", mobile ? "rounded-[20px] px-3 py-2" : "rounded-[22px] px-4 py-3", disabled && "opacity-80")}
      className={cn(mobile ? "text-[15px]" : "text-[14px]", "disabled:cursor-not-allowed")}
      footer={
        <>
          <OptionsPopover hostId={hostId} options={options} onChange={onOptionsChange} mobile={mobile} />
          <button
            type="button"
            role="switch"
            aria-checked={options.plan}
            onClick={() => onOptionsChange({ ...options, plan: !options.plan })}
            title="Plan mode: the agent proposes a plan before editing"
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-2xs font-bold pressable focus-ring [&_svg]:size-3.5",
              options.plan ? "bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "text-mute hover:bg-white/6 hover:text-ink",
            )}
          >
            <ClipboardList />
            Plan
          </button>
          {disabledReason ? (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold text-mute-2">
              <Lock className="size-3 shrink-0" />
              <span className="truncate">{disabledReason}</span>
            </span>
          ) : (
            !mobile && (
              <span className="flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold text-mute-2 max-lg:hidden">
                <span className="flex items-center gap-1">
                  <Kbd>Enter</Kbd> dispatch
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>Shift</Kbd>
                  <Kbd>Enter</Kbd> newline
                </span>
              </span>
            )
          )}
          <span className="ml-auto flex shrink-0 items-center">
            <IconButton label="Dispatch (Enter)" size={mobile ? "md" : "sm"} variant="primary" onClick={send} disabled={!canSend}>
              <ArrowUp />
            </IconButton>
          </span>
        </>
      }
    />
  );
});

function OptionsPopover({ hostId, options, onChange, mobile }: { hostId?: string; options: DispatchOptions; onChange(o: DispatchOptions): void; mobile: boolean }) {
  const templates = useSettings((s) => s.templates);
  const catalog = useModelCatalog(hostId);
  const template = templates.find((t) => t.id === options.templateId);
  const modelLabel = (id: string) => {
    if (id === DEFAULT) return "Default model";
    const m = catalog?.models.find((x) => `${x.provider}/${x.id}` === id);
    return m?.label ?? id.split("/").pop() ?? id;
  };
  const label = template ? template.name : [modelLabel(options.model), options.thinking !== DEFAULT && options.thinking].filter(Boolean).join(" · ");

  const modelOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [{ value: DEFAULT, label: "Host default", icon: <Sparkles /> }];
    for (const m of catalog?.models ?? []) opts.push({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider });
    if (options.model !== DEFAULT && !opts.some((o) => o.value === options.model)) opts.push({ value: options.model, label: options.model });
    return opts;
  }, [catalog, options.model]);
  const thinkingOptions: SelectOption[] = [{ value: DEFAULT, label: "Default" }, ...LEVELS.map((l) => ({ value: l, label: l }))];

  const row = "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-sm font-semibold text-ink-2 hover:bg-white/7 hover:text-ink focus-ring";
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-2xs font-bold text-mute pressable focus-ring hover:bg-white/6 hover:text-ink data-[state=open]:bg-white/8 data-[state=open]:text-ink [&_svg]:size-3.5 [&_svg]:shrink-0",
          mobile ? "max-w-[46vw]" : "max-w-[260px]",
        )}
        aria-label="Agent options"
      >
        {template ? <LayoutTemplate /> : <Cpu />}
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex w-[min(340px,calc(100vw-24px))] flex-col gap-3">
        {templates.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="kicker px-1 pb-1">Template</span>
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={cn(row, t.id === options.templateId && "bg-accent/14 text-ink")}
                onClick={() => onChange({ templateId: t.id, model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan })}
              >
                <LayoutTemplate className="size-4 shrink-0 text-mute" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{t.name}</span>
                  <span className="truncate text-2xs font-medium text-mute-2">{templateSummary(t)}</span>
                </span>
                {t.id === options.templateId && <Check className="size-4 shrink-0 text-accent-hi" />}
              </button>
            ))}
            <button type="button" className={cn(row, !template && "bg-accent/14 text-ink")} onClick={() => onChange({ ...options, templateId: null })}>
              <Cpu className="size-4 shrink-0 text-mute" />
              <span className="flex-1">Custom model</span>
              {!template && <Check className="size-4 shrink-0 text-accent-hi" />}
            </button>
          </div>
        )}
        {!template && (
          <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
            <Select value={options.model} onValueChange={(model) => onChange({ ...options, model })} options={modelOptions} className="w-full min-w-0" aria-label="Model" />
            <Select
              value={options.thinking}
              onValueChange={(t) => onChange({ ...options, thinking: t as DispatchOptions["thinking"] })}
              options={thinkingOptions}
              className="w-full min-w-0"
              aria-label="Thinking"
            />
          </div>
        )}
        <label className="flex items-center gap-2.5 px-1 text-xs font-semibold text-mute">
          <Switch checked={options.plan} onCheckedChange={(plan) => onChange({ ...options, plan })} label="Plan mode" />
          Plan mode — propose a plan before editing
        </label>
      </PopoverContent>
    </Popover>
  );
}
