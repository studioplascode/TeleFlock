import { motion } from "motion/react";
import { ArrowUp, Check, ClipboardList, Cpu, ImagePlus, LayoutTemplate, Lock, Sparkles, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, forwardRef, type KeyboardEvent, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type DraftImage, useAiNaming, useAiSuggestion, useDraft, useDraftImages, useSettings } from "@/core";
import { dragHasFiles, imageFiles, shrinkImage } from "@/core/clipboardImages";
import type { ThinkingLevel } from "@/core/gen";
import { IconButton, Kbd, Lightbox, LightboxTrigger, Popover, PopoverContent, PopoverTrigger, Select, type SelectOption, Switch, Textarea, cn, spring, toast } from "@/design";
import { fileToImageInput } from "@/features/session/api";
import { useModelCatalog } from "@/features/workspace/shared/AgentFields";
import { templateSummary } from "@/features/workspace/shared/templates";
import { imageChars, MAX_TASK_IMAGE_CHARS, MAX_TASK_IMAGES } from "./images";
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
  /** Draft key of the task text and images (per target + repo), so an unsent task survives navigation and reload. */
  draftKey: string;
  options: DispatchOptions;
  onOptionsChange(options: DispatchOptions): void;
  /** Sends one task (text, images or both); false = refused (the draft stays). The composer clears itself and keeps focus. */
  onSend(prompt: string, images: readonly DraftImage[]): boolean;
  /** Why sending is impossible right now (no repo, host offline); disables the composer. */
  disabledReason?: string | null;
  placeholder: string;
  mobile: boolean;
}

/**
 * Attach `files` to `current` within a task's caps (8 images, total size under the relay's
 * message limit); very large images are scaled down first. Returns the images that fit and why
 * others were left out.
 */
async function attachImages(current: readonly DraftImage[], files: readonly File[]): Promise<{ added: DraftImage[]; skipped?: string }> {
  const room = MAX_TASK_IMAGES - current.length;
  const tooMany = `A task takes at most ${MAX_TASK_IMAGES} images.`;
  if (room <= 0) return { added: [], skipped: tooMany };
  let chars = imageChars(current);
  const added: DraftImage[] = [];
  let skipped = files.length > room ? tooMany : undefined;
  for (const f of files.slice(0, room)) {
    const img = await fileToImageInput(await shrinkImage(f));
    if (chars + img.data.length > MAX_TASK_IMAGE_CHARS) {
      skipped = `The images of one task stay under ${Math.round((MAX_TASK_IMAGE_CHARS * 3) / 4 / 1024 / 1024)} MB in total (the host connection's message limit).`;
      continue;
    }
    chars += img.data.length;
    added.push(img);
  }
  return { added, skipped };
}

/**
 * Multi-line task box: Enter sends (desktop), Shift+Enter is a newline, the send button works
 * everywhere. Clears and keeps focus after each send so tasks can be fired back to back. Images
 * come in by the attach button, paste or drop and go with the task (an image-only task is fine).
 * The footer holds the per-dispatch options: template or model + thinking, and plan mode.
 */
export const DispatchComposer = forwardRef<DispatchComposerHandle, DispatchComposerProps>(function DispatchComposer(
  { hostId, repo, draftKey, options, onOptionsChange, onSend, disabledReason, placeholder, mobile },
  ref,
) {
  const [text, setText, clearText] = useDraft(draftKey);
  const [images, setImages] = useDraftImages(draftKey);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(text);
  latest.current = text;
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), text: () => latest.current }), []);
  const disabled = !!disabledReason;
  const canSend = !disabled && (!!text.trim() || images.length > 0);

  // Name the task ahead of the send (same call as the send's, cached by ai.ts): after a pause of
  // ~1.2 s with a few words typed, so most sends skip the "Naming…" wait.
  const ai = useAiNaming(hostId);
  const prefetch = ai && hostId && repo && !disabled ? prefetchKey(text) : null;
  useAiSuggestion(hostId, prefetch, () => (hostId && repo && prefetch ? suggestDispatchName(hostId, repo, prefetch) : Promise.resolve(null)), { debounceMs: 1200 });

  const send = () => {
    if (!canSend) return;
    const sent = images;
    if (!onSend(text.trim(), sent)) return;
    clearText();
    // Only what was sent: an image attached meanwhile stays.
    setImages((cur) => cur.filter((i) => !sent.includes(i)));
    ta.current?.focus();
  };

  const addFiles = async (files: readonly File[]) => {
    if (!files.length || disabled) return;
    try {
      // Caps against what is attached right now.
      const { added, skipped } = await attachImages(images, files);
      if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_TASK_IMAGES));
      if (skipped) toast({ title: added.length ? "Some images were left out" : "Image not attached", description: skipped, status: "error" });
    } catch (e) {
      toast({ title: "Couldn't attach image", description: e instanceof Error ? e.message : String(e), status: "error" });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // `items` too: WebKitGTK (Linux) lists pasted screenshots only there.
    const files = imageFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (dragHasFiles(e.dataTransfer) || e.dataTransfer.files.length > 0) e.preventDefault();
    void addFiles(imageFiles(e.dataTransfer));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key !== "Enter") return;
    if ((!mobile && !e.shiftKey && !e.altKey) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div
      className={cn("relative rounded-[22px] transition-shadow duration-200", dragging && "shadow-[0_0_0_2px_var(--color-accent),var(--shadow-glow-accent)]")}
      onDragOver={(e) => {
        if (!disabled && dragHasFiles(e.dataTransfer)) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-3 pt-1 pb-2" aria-label="Attached images">
          {images.map((img, i) => (
            <motion.div key={i} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.bouncy }} className="relative shrink-0 pt-1.5 pr-1.5">
              <LightboxTrigger label={`View image ${i + 1}`} onClick={() => setViewing(i)}>
                <img src={img.preview} alt={`image ${i + 1}`} className={cn("rounded-md object-cover shadow-hairline", mobile ? "size-12" : "size-14")} />
              </LightboxTrigger>
              <button
                type="button"
                aria-label={`Remove image ${i + 1}`}
                onClick={() => setImages((cur) => cur.filter((x) => x !== img))}
                className="pressable focus-ring absolute top-0 right-0 grid size-5 place-items-center rounded-full bg-tile-4 text-ink shadow-d1"
              >
                <X className="size-3" />
              </button>
            </motion.div>
          ))}
        </div>
      )}
      <Textarea
        ref={ta}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
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
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(imageFiles({ files: e.target.files }));
                e.target.value = "";
              }}
            />
            <IconButton label="Attach images" size={mobile ? "md" : "sm"} onClick={() => fileInput.current?.click()} disabled={disabled || images.length >= MAX_TASK_IMAGES}>
              <ImagePlus />
            </IconButton>
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
      <Lightbox images={images.map((img, i) => ({ src: img.preview, alt: `image ${i + 1}` }))} index={viewing !== null && viewing < images.length ? viewing : null} onIndexChange={setViewing} />
    </div>
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
