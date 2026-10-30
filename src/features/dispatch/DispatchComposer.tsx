import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Check, ClipboardList, Cpu, LayoutTemplate, Lock, Paperclip, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, forwardRef, type KeyboardEvent, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type DraftImage, useAiNaming, useAiSuggestion, useDraft, useDraftImages, useSettings } from "@/core";
import { attachImages, dragHasFiles, isVideoFile, mediaFiles } from "@/core/clipboardImages";
import { attachVideos, detachDraftVideos, MAX_DRAFT_VIDEOS, removeDraftVideo, retryVideos, useDraftVideos } from "@/core/draftVideos";
import type { ThinkingLevel } from "@/core/gen";
import { expandPastes } from "@/core/pastes";
import { Button, IconButton, Kbd, Lightbox, LightboxTrigger, Popover, PopoverContent, PopoverTrigger, Select, type SelectOption, Switch, Textarea, cn, spring, toast } from "@/design";
import { AgentRolesSection, useHostTakesRoles } from "@/features/agentRoles/AgentRolesSection";
import { launchMainText, overridesSummary } from "@/features/agentRoles/roles";
import { policyChipText } from "@/features/autoAnswer/format";
import { useHostAutoAnswer } from "@/features/autoAnswer/hooks";
import { AutoAnswerSection } from "@/features/autoAnswer/PolicyEditor";
import { useModelCatalog } from "@/features/workspace/shared/AgentFields";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { templateSummary } from "@/features/workspace/shared/templates";
import { PasteChips, PasteMenu } from "@/features/session/composer/PasteChips";
import { usePasteAttach } from "@/features/session/composer/usePasteAttach";
import { VideoChips } from "@/features/session/composer/VideoChips";
import { MAX_TASK_IMAGES } from "./images";
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
  /** Draft key of the task text, images and videos (per target + repo), so an unsent task survives navigation (text and images: reloads too). */
  draftKey: string;
  /** The host videos upload to as soon as they are attached; null (Auto) = the host each task goes to, when it is sent. */
  uploadHost: string | null;
  options: DispatchOptions;
  onOptionsChange(options: DispatchOptions): void;
  /** Sends one task (text, images, videos (`@/core/draftVideos` ids), any mix); false = refused (the draft stays). The composer clears itself and keeps focus. */
  onSend(prompt: string, images: readonly DraftImage[], videos: readonly string[]): boolean;
  /** Why sending is impossible right now (no repo, host offline); disables the composer. */
  disabledReason?: string | null;
  placeholder: string;
  mobile: boolean;
}

/**
 * Multi-line task box: Enter sends (desktop), Shift+Enter is a newline, the send button works
 * everywhere. Clears and keeps focus after each send so tasks can be fired back to back. Images
 * and videos come in by the attach button, paste or drop and go with the task (a task of images or
 * videos alone is fine): images inline, videos uploaded to the host (their paths go with the first
 * prompt). The footer holds the per-dispatch options: template or model + thinking, and plan mode.
 */
export const DispatchComposer = forwardRef<DispatchComposerHandle, DispatchComposerProps>(function DispatchComposer(
  { hostId, repo, draftKey, uploadHost, options, onOptionsChange, onSend, disabledReason, placeholder, mobile },
  ref,
) {
  const [text, setText, clearText] = useDraft(draftKey);
  const [images, setImages] = useDraftImages(draftKey);
  const videos = useDraftVideos(draftKey);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  // Large pastes become chips as in the session composer. No "Attach as local file": the agent's
  // session (where local:// lives) only exists once the task has started it.
  const paste = usePasteAttach({ draftKey, hostId, text, setText, ta, fileOff: "The new agent has no session yet: attach it as a block or inline" });
  /** The task as it would be sent: paste tokens expanded. */
  const expanded = paste.pastes.length ? expandPastes(text, paste.pastes) : text;
  const latest = useRef(expanded);
  latest.current = expanded;
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), text: () => latest.current }), []);
  const disabled = !!disabledReason;
  const canSend = !disabled && (!!text.trim() || images.length > 0 || videos.length > 0);

  // Name the task ahead of the send (same call as the send's, cached by ai.ts): after a pause of
  // ~1.2 s with a few words typed, so most sends skip the "Naming…" wait.
  const ai = useAiNaming(hostId);
  const prefetch = ai && hostId && repo && !disabled ? prefetchKey(expanded) : null;
  useAiSuggestion(hostId, prefetch, () => (hostId && repo && prefetch ? suggestDispatchName(hostId, repo, prefetch) : Promise.resolve(null)), { debounceMs: 1200 });

  const send = async () => {
    if (!canSend) return;
    const failed = videos.find((v) => v.phase === "failed");
    if (failed) {
      toast({ title: "A video didn't upload", description: `${failed.name}: ${failed.error ?? "unknown error"}. Retry it or remove it.`, status: "error" });
      return;
    }
    // Paste tokens become their text (or `<attachment>` block), as omp's editor does on submit.
    const prepared = await paste.prepare(text);
    if (!prepared.ok) {
      toast({ title: prepared.title, description: prepared.hint, status: "error" });
      return;
    }
    const sent = images;
    const sentVideos = videos.map((v) => v.id);
    if (!onSend(prepared.text.trim(), sent, sentVideos)) return;
    clearText();
    paste.sent(prepared.carried);
    // Only what was sent: an image or video attached meanwhile stays.
    setImages((cur) => cur.filter((i) => !sent.includes(i)));
    // The task waits for its videos' uploads now.
    detachDraftVideos(draftKey, sentVideos);
    ta.current?.focus();
  };

  const addFiles = async (files: readonly File[]) => {
    if (!files.length || disabled) return;
    const vids = files.filter(isVideoFile);
    if (vids.length) {
      const { added, skipped } = attachVideos(draftKey, uploadHost, vids);
      if (skipped) toast({ title: added ? "Some videos were left out" : "Video not attached", description: skipped, status: "error" });
    }
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    try {
      const { added, skipped } = await attachImages(draftKey, imgs);
      if (skipped) toast({ title: added ? "Some images were left out" : "Image not attached", description: skipped, status: "error" });
    } catch (e) {
      toast({ title: "Couldn't attach image", description: e instanceof Error ? e.message : String(e), status: "error" });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // `items` too: WebKitGTK (Linux) lists pasted screenshots only there.
    const files = mediaFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    } else paste.onPaste(e);
  };

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (dragHasFiles(e.dataTransfer) || e.dataTransfer.files.length > 0) e.preventDefault();
    void addFiles(mediaFiles(e.dataTransfer));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || paste.onKeyDown(e) || e.key !== "Enter") return;
    if ((!mobile && !e.shiftKey && !e.altKey) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void send();
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
      <AnimatePresence>{paste.menu && <PasteMenu key="paste" paste={paste} mobile={mobile} />}</AnimatePresence>
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
      <VideoChips videos={videos} onRemove={(id) => removeDraftVideo(draftKey, id)} onRetry={(id) => retryVideos([id])} mobile={mobile} className={cn("px-3 pb-2", images.length > 0 ? "pt-0" : "pt-1")} />
      <PasteChips paste={paste} mobile={mobile} className={cn("px-3 pb-2", images.length > 0 || videos.length > 0 ? "pt-0" : "pt-1")} />
      <Textarea
        ref={ta}
        value={text}
        onChange={(e) => paste.change(e.target.value, e.target.selectionStart ?? e.target.value.length, (e.nativeEvent as InputEvent).isComposing === true)}
        onSelect={(e) => paste.onSelect(e.currentTarget)}
        onCopy={(e) => paste.onCopy(e)}
        onCut={(e) => paste.onCopy(e, true)}
        onBlur={() => window.setTimeout(() => document.activeElement !== ta.current && paste.close(), 120)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        aria-label="Task"
        disabled={disabled}
        autoFocus={!mobile && !disabled}
        // Phone: Enter is a newline (the button dispatches; Ctrl/Meta+Enter from a hardware keyboard), so the keyboard shows a return key.
        enterKeyHint={mobile ? "enter" : undefined}
        maxHeight={mobile ? 140 : 240}
        boxClassName={cn("glass", mobile ? "rounded-[20px] px-3 py-2" : "rounded-[22px] px-4 py-3", disabled && "opacity-80")}
        className={cn(mobile ? "text-[15px]" : "text-[14px]", "disabled:cursor-not-allowed")}
        footer={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(mediaFiles({ files: e.target.files }));
                e.target.value = "";
              }}
            />
            <IconButton
              label="Attach images or videos"
              size={mobile ? "md" : "sm"}
              onClick={() => fileInput.current?.click()}
              disabled={disabled || (images.length >= MAX_TASK_IMAGES && videos.length >= MAX_DRAFT_VIDEOS)}
            >
              <Paperclip />
            </IconButton>
            <OptionsPopover hostId={hostId} options={options} onChange={onOptionsChange} mobile={mobile} />
            <DispatchAgentOptions hostId={hostId} options={options} onChange={onOptionsChange} mobile={mobile} />
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
              <IconButton label={mobile ? "Dispatch" : "Dispatch (Enter)"} size={mobile ? "md" : "sm"} variant="primary" onClick={send} disabled={!canSend}>
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
                onClick={() => onChange({ ...options, templateId: t.id, model: t.model ?? DEFAULT, thinking: t.thinking ?? DEFAULT, plan: t.plan })}
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

/**
 * More options of the agents dispatched from here: their own model roles and fallback chains, and
 * decide for me. A footer chip with what is set opens them in a dialog (a sheet on phones).
 */
function DispatchAgentOptions({ hostId, options, onChange, mobile }: { hostId?: string; options: DispatchOptions; onChange(o: DispatchOptions): void; mobile: boolean }) {
  const [open, setOpen] = useState(false);
  const templates = useSettings((s) => s.templates);
  const catalog = useModelCatalog(open ? hostId : undefined);
  const roles = options.roleModels ?? {};
  const chains = options.fallbackChains ?? {};
  // The policy counts where the composer's host (Auto: the next pick) has decide for me.
  const decides = !!useHostAutoAnswer(hostId);
  const takesRoles = useHostTakesRoles(hostId);
  const summary = [takesRoles ? overridesSummary(roles, chains) : null, policyChipText(decides ? options.autoAnswer : undefined)].filter(Boolean).join(" · ");
  const what = "Model roles, fallback chains and decide for me of the dispatched agents";
  // The main model is the template's, else the model menu's.
  const template = templates.find((t) => t.id === options.templateId);
  const model = template ? (template.model ?? DEFAULT) : options.model;
  const thinking = template ? (template.thinking ?? DEFAULT) : options.thinking;
  return (
    <>
      <button
        type="button"
        disabled={!hostId}
        onClick={() => setOpen(true)}
        aria-label={summary ? `More agent options: ${summary}` : "More agent options: model roles, fallback chains and decide for me"}
        title={summary ? `${what}: ${summary}` : what}
        className={cn(
          "inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-full px-2.5 text-2xs font-bold pressable focus-ring disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
          summary ? "bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "text-mute hover:bg-white/6 hover:text-ink",
          mobile ? "max-w-[30vw]" : "max-w-[220px]",
        )}
      >
        <SlidersHorizontal />
        {summary ? <span className="truncate">{summary}</span> : !mobile && "More options"}
      </button>
      {hostId && (
        <ResponsiveDialog
          open={open}
          onOpenChange={setOpen}
          title="More agent options"
          description="For the agents you dispatch from here."
          icon={<SlidersHorizontal />}
          width={760}
          tall
          footer={
            <Button variant="primary" onClick={() => setOpen(false)} className={mobile ? "flex-1" : undefined}>
              Done
            </Button>
          }
        >
          <div className="flex min-w-0 flex-col gap-5 pb-1">
            <AgentRolesSection
              hostId={hostId}
              roles={roles}
              chains={chains}
              onChange={(patch) => onChange({ ...options, ...patch })}
              mainModel={launchMainText(catalog?.models ?? [], model, thinking, catalog?.roles.find((r) => r.role === "default")?.model)}
              mainWhere="set in the agent options menu"
            />
            <AutoAnswerSection hostId={hostId} value={options.autoAnswer} onChange={(autoAnswer) => onChange({ ...options, autoAnswer })} />
          </div>
        </ResponsiveDialog>
      )}
    </>
  );
}
