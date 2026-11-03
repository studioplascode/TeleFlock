import { ArrowUp, AtSign, CornerDownRight, FileText, ListPlus, Lock, Mic, MicOff, Paperclip, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { core, drafts, getTranscript, markResuming, navigate, parseAgentKey, useAgent, useCore, useDraft, useDraftImages, useResuming, useSession, useUi } from "@/core";
import { attachImages, dragHasFiles, IMAGES_TOO_LARGE, imageChars, isVideoFile, MAX_PROMPT_IMAGE_CHARS, mediaFiles } from "@/core/clipboardImages";
import { attachVideos, detachDraftVideos, releaseVideos, removeDraftVideo, retryVideos, uploadDraftVideos, useDraftVideos, type VideoRef, whenUploaded, withVideoRefs } from "@/core/draftVideos";
import type { CommandInfo, ImageInput } from "@/core/gen";
import { useHerdrDown, useHostName } from "@/features/hosts/HerdrControls";
import { herdrNotRunning } from "@/features/hosts/herdrHealth";
import { PHASE_TEXT } from "@/features/shell/status";
import { openTerminal } from "@/features/board/agentActions";
import { cn, formatUsd, GlowBorder, IconButton, Kbd, Lightbox, LightboxTrigger, Spinner, spring, Textarea, toast } from "@/design";
import { useFirstUse } from "@/features/shell/hints";
import { errorText, hostCall, usePending } from "../api";
import { composerDraftKey, useSessionUi } from "../state";
import { todoCounts } from "../tools/TodoList";
import { usePendingQueue, userRowsWithText } from "./queue";
import { QueueStrip } from "./QueueStrip";
import { isSlashDraft, runSlash, type SlashContext } from "./slash";
import { ComposerPopup, useSlashPalette } from "./SlashPalette";
import { useRamblerDictation } from "@/features/dictation/useRamblerDictation";
import { PasteChips, PasteMenu } from "./PasteChips";
import { usePasteAttach } from "./usePasteAttach";
import { VideoChips } from "./VideoChips";

/**
 * First-use caption while the agent works (mounted only then, so idle sessions don't use up its
 * showings). Hands its `done` to the composer, which retires it on the first follow-up.
 */
function SteerHint({ doneRef }: { doneRef: RefObject<(() => void) | null> }) {
  const { show, done } = useFirstUse("composer.steer");
  useEffect(() => {
    doneRef.current = done;
  });
  if (!show) return null;
  return <div className="mb-1.5 px-2 text-2xs leading-snug text-mute">Steer lands mid-turn; a follow-up waits for the turn to end.</div>;
}

/**
 * Phone: context, todos and cost at a glance in the composer's icon row; opens the inspector sheet.
 * Short of room it gives way before any button does: its segments wrap onto a second line that the
 * button clips, so the cost goes first, then the todos (whole segments, never cut off), and the pill
 * (an inline background, cloned per line) hugs what is left.
 */
function StatusPill({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const ctx = meta?.context ?? agent?.omp?.context;
  const cost = meta?.cost ?? agent?.omp?.cost;
  const todos = meta?.todos.length ? todoCounts(meta.todos) : agent?.omp?.todos;
  return (
    <button
      type="button"
      onClick={() => useSessionUi.getState().setSheet(agentKey, true)}
      aria-label={`Inspector: context ${ctx ? `${Math.round(ctx.pct)}% used` : "unknown"}${cost ? `, ${formatUsd(cost.usd)} spent` : ""}${todos?.total ? `, ${todos.done} of ${todos.total} todos done` : ""}`}
      className="pressable focus-ring block h-8 min-w-0 overflow-hidden rounded-full text-left text-[11px] leading-8 font-bold whitespace-normal text-ink-2 tabular"
    >
      {/* py: Manrope's 15px content area at 11px + 2 × 8.5px = the 32px row */}
      <span className="box-decoration-clone rounded-full bg-ink/[0.05] px-2.5 py-[8.5px] shadow-hairline">
        <span data-status={ctx && ctx.pct >= 85 ? "error" : ctx && ctx.pct >= 65 ? "needs-you" : undefined} className={cn("whitespace-nowrap", ctx && ctx.pct >= 65 && "st-text")}>
          ctx {ctx ? `${Math.round(ctx.pct)}%` : "—"}
        </span>
        {todos?.total ? (
          <>
            <wbr />
            <span className="whitespace-nowrap text-mute">
              {" "}
              · {todos.done}/{todos.total}
            </span>
          </>
        ) : null}
        {cost && (
          <>
            <wbr />
            <span className="whitespace-nowrap text-mute"> · {formatUsd(cost.usd)}</span>
          </>
        )}
      </span>
    </button>
  );
}

export interface ComposerProps {
  agentKey: string;
  /** Phone layout: bigger touch targets, mic, no hint row; Enter is a newline (the send button or Ctrl/Meta+Enter sends). */
  mobile?: boolean;
  className?: string;
  autoFocus?: boolean;
}

/** The `@` file search under the caret (the `/` palette is `useSlashPalette`'s). */
type Popup = { kind: "mention"; query: string; start: number; items: string[]; loading: boolean };

const MENTION_RE = /(^|\s)@([^\s@]*)$/;

/**
 * Composer: Enter sends (steer while the agent works, prompt when idle), Alt+Enter queues a
 * follow-up, Esc stops. `/` opens the command palette, `@` searches files in the agent's cwd,
 * images paste/drop in as attachments, and so do videos (uploaded to the host as files the agent reads).
 */
export function Composer({ agentKey, mobile = false, className, autoFocus = false }: ComposerProps) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta, ui } = useSession(agentKey);
  // Text and images persist per agent (switching views, closing the session, restarts).
  const draftKey = composerDraftKey(agentKey);
  const [text, setText] = useDraft(draftKey);
  const [images, setImages] = useDraftImages(draftKey);
  // Videos upload to the host as soon as they are attached (kept in memory, not across restarts).
  const videos = useDraftVideos(draftKey);
  const focusNonce = useSessionUi((s) => s.composerFocus[agentKey]);
  const [popup, setPopup] = useState<Popup | null>(null);
  /** Attachment open in the lightbox. */
  const [viewing, setViewing] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, run] = usePending();
  /** A send waiting for its videos to finish uploading. */
  const [waitingUploads, setWaitingUploads] = useState(false);
  const uploadWait = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  /** Retires the "steer vs follow-up" caption (set while it is mounted). */
  const steerDone = useRef<(() => void) | null>(null);
  // Large pastes become chips, as in omp's editor; "Attach as local file" saves into the session.
  const paste = usePasteAttach({
    draftKey,
    hostId,
    text,
    setText,
    ta,
    saveFile: (t) => core.host(hostId).call("session.writeLocal", { agentId, text: t }),
  });

  const caps = meta?.caps;
  const working = agent?.column === "running" || agent?.live.streaming === true || agent?.live.tool != null;
  const queue = meta?.queue ?? agent?.omp?.queue;
  const cwd = meta?.cwd ?? agent?.cwd;
  /** The latest render's agent state, for a send that waited for its videos. */
  const live = useRef({ working, caps });
  live.current = { working, caps };
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    if (!working || mobile) return;
    const track = (e: globalThis.KeyboardEvent) => setAltHeld(e.altKey);
    const reset = () => setAltHeld(false);
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", reset);
      setAltHeld(false);
    };
  }, [working, mobile]);
  // A parked agent (pane closed when it was marked done) takes prompts: the host resumes it first.
  const resuming = useResuming(agentKey);
  // Not online: the transcript is the copy saved on this device, and every control needs the host.
  const hostWait = useCore((s) => (s.status[hostId]?.phase === "online" ? null : `${s.profiles.find((p) => p.id === hostId)?.name ?? hostId} ${PHASE_TEXT[s.status[hostId]?.phase ?? "idle"]}`));
  // herdr is down on the host: that is the reason, not the link to omp
  const herdr = useHerdrDown(hostId);
  const hostName = useHostName(hostId);
  const disabledReason = !agent
    ? "Agent not found"
    : hostWait
      ? hostWait
      : herdr && !agent.parked
        ? herdrNotRunning(hostName, herdr)
        : agent.parked
      ? resuming
        ? "Resuming…"
        : null
      : agent.omp?.link !== "live"
        ? "Not connected to this session"
        : !caps
          ? "Loading session…"
          : !caps.prompt && !(working && (caps.steer || caps.followUp))
            ? agent.needs?.answerable === false
              ? "omp is showing a dialog only the terminal can answer"
              : agent.needs
                ? "Answer the question above first"
                : "This session can't take prompts right now"
            : null;

  // Dictation, tidied into a prompt by a model on the agent's host when Rambler is on (Settings → Dictation).
  const ramble = useRamblerDictation({
    hostId,
    about: [agent?.repo && `Repository: ${agent.repo}`, agent?.title && `Agent task: ${agent.title}`].filter(Boolean).join("\n"),
    text,
    setText,
    field: ta,
    mobile,
  });
  const dictation = ramble.dictation;

  // Focus requests from elsewhere ("Prompt…" on a board card).
  useEffect(() => {
    if (!focusNonce) return;
    const el = ta.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    useSessionUi.getState().consumeComposerFocus(agentKey);
  }, [focusNonce, agentKey]);

  // The session's own commands (extensions, prompt templates, skills) for the palette.
  const [custom, setCustom] = useState<CommandInfo[]>([]);
  const canList = agent?.omp?.link === "live" && caps?.bridge === true;
  const sessionId = meta?.sessionId;
  useEffect(() => {
    if (!canList) return;
    let live = true;
    core
      .host(hostId)
      .call("agent.commands", { agentId })
      .then((r) => live && setCustom(r.commands))
      .catch(() => live && setCustom([]));
    return () => {
      live = false;
    };
  }, [hostId, agentId, canList, sessionId]);

  const slashCtx: SlashContext = {
    hostId,
    agentId,
    key: agentKey,
    meta,
    custom,
    openTerminal: () =>
      agent?.parked ? openTerminal(agentKey, mobile) : mobile ? navigate({ name: "terminal", hostId, agentId }) : useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent?.paneId }),
  };
  const palette = useSlashPalette({
    custom,
    setText,
    ta,
    mobile,
    run: (command) => void run(runSlash(slashCtx, command)),
    unavailable: (c) => c.mode === "native" && c.cap != null && meta != null && !meta.caps[c.cap],
  });

  const updatePopup = (value: string, caret: number) => {
    if (palette.update(value, caret)) {
      searchSeq.current++;
      setPopup(null);
      return;
    }
    const before = value.slice(0, caret);
    const mention = MENTION_RE.exec(before);
    if (mention && cwd) {
      const query = mention[2] ?? "";
      const start = caret - query.length - 1;
      const seq = ++searchSeq.current;
      setPopup((p) => ({ kind: "mention", query, start, items: p?.kind === "mention" ? p.items : [], loading: true }));
      window.setTimeout(() => {
        if (seq !== searchSeq.current) return;
        core
          .host(hostId)
          .call("fs.search", { root: cwd, query, limit: 24 })
          .then((res) => {
            if (seq !== searchSeq.current) return;
            setPopup({ kind: "mention", query, start, items: res.files, loading: false });
            setSel(0);
          })
          .catch(() => seq === searchSeq.current && setPopup({ kind: "mention", query, start, items: [], loading: false }));
      }, 110);
      return;
    }
    searchSeq.current++;
    setPopup(null);
  };

  const pickMention = (path: string) => {
    if (popup?.kind !== "mention") return;
    const el = ta.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${path} `;
    const next = text.slice(0, popup.start) + insert + text.slice(caret);
    setText(next);
    setPopup(null);
    const pos = popup.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const send = async (followUp: boolean) => {
    if (!text.trim() && images.length === 0 && videos.length === 0) return;
    // Paste tokens become their text (or `<attachment>` block) first, as omp's editor does on submit.
    const prepared = await paste.prepare(text);
    if (!prepared.ok) {
      toast({ title: prepared.title, description: prepared.hint, status: "error" });
      return;
    }
    const full = prepared.text;
    const body = full.trim();
    // A leading space escapes a slash: " /path is a file" goes to the model as text. A command is judged on
    // what was typed (paste tokens still unexpanded), so a pasted log or path that starts with "/" is text.
    const escaped = text.startsWith(" /");
    if (isSlashDraft(text) && images.length === 0 && videos.length === 0) {
      const okRun = await run(runSlash(slashCtx, body));
      if (okRun) {
        setText("");
        paste.sent(prepared.carried);
      }
      return;
    }
    if (disabledReason) {
      toast({ title: "Can't send", description: disabledReason, status: "error" });
      return;
    }
    if (imageChars(images) > MAX_PROMPT_IMAGE_CHARS) {
      toast({ title: "The images are too large", description: `${IMAGES_TOO_LARGE} Remove some.`, status: "error" });
      return;
    }
    // A send already waits for its videos: another one would send them twice.
    if (uploadWait.current) {
      toast({ title: "Sending once the videos are uploaded", status: "idle", duration: 2600 });
      return;
    }
    const typed = escaped ? full.slice(1) : body;
    // Videos go as one line each with their path on the host, once uploaded (the agent reads them).
    const sentVideos = videos.map((v) => v.id);
    let refs: VideoRef[] = [];
    if (sentVideos.length) {
      uploadWait.current = true;
      setWaitingUploads(true);
      try {
        // A recording waits for the send before it leaves the device.
        uploadDraftVideos(sentVideos, hostId);
        refs = await whenUploaded(sentVideos);
      } catch (e) {
        const { title, hint } = errorText(e);
        toast({ title: "Video not uploaded", description: hint ? `${title} — ${hint}` : title, status: "error" });
        return;
      } finally {
        uploadWait.current = false;
        setWaitingUploads(false);
      }
    }
    const prompt = withVideoRefs(typed, refs);
    // Every video was removed while the send waited, and nothing else was in it.
    if (!prompt.trim() && images.length === 0) return;
    // Read after the wait: the agent may have started or ended a turn meanwhile.
    const at = live.current;
    const delivery = followUp ? "followUp" : at.working && at.caps && !at.caps.steer && at.caps.followUp ? "followUp" : "auto";
    const sentImages = images;
    const imgs: ImageInput[] = sentImages.map(({ mime, data }) => ({ mime, data }));
    // Into a working agent this queues (steer or follow-up): show it in the strip right away.
    const queuedKind = !at.working || !prompt.trim() ? null : delivery === "followUp" ? "follow" : "steer";
    const pendingId = queuedKind
      ? usePendingQueue.getState().add(agentKey, { text: prompt, kind: queuedKind, before: userRowsWithText(getTranscript(agentKey).items, prompt) })
      : null;
    const res = await run(hostCall(hostId, "agent.prompt", { agentId, text: prompt, images: imgs, delivery }, { failure: "Prompt not delivered" }));
    if (pendingId !== null) {
      if (res.ok) usePendingQueue.getState().sent(agentKey, pendingId);
      else usePendingQueue.getState().remove(agentKey, pendingId);
    }
    if (res.ok) {
      // the host resumes a parked agent with this prompt; the view follows it to its new id
      if (agent?.parked) markResuming(agentKey, true);
      // Only what was sent: anything typed or attached while sending stays in the draft.
      const cur = drafts.get(draftKey);
      drafts.set(draftKey, cur.startsWith(text) ? cur.slice(text.length).trimStart() : cur);
      setImages((cur) => cur.filter((i) => !sentImages.includes(i)));
      // Sent: off the draft, their files stay on the host for the agent.
      detachDraftVideos(draftKey, sentVideos);
      releaseVideos(sentVideos);
      paste.sent(prepared.carried);
      setPopup(null);
      if (delivery === "followUp") steerDone.current?.();
    }
  };

  const abort = () => void run(hostCall(hostId, "agent.abort", { agentId }, { failure: "Stop failed" }));

  const addFiles = async (files: Iterable<File>) => {
    const all = [...files];
    const vids = all.filter(isVideoFile);
    if (vids.length > 0) {
      const { added, skipped } = attachVideos(draftKey, hostId, vids);
      if (skipped) toast({ title: added ? "Some videos were left out" : "Video not attached", description: skipped, status: "error" });
    }
    const imgs = all.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    try {
      // Very large images (a Linux screenshot paste) are scaled down; the total stays under the
      // relay's message limit.
      const { added, skipped } = await attachImages(draftKey, imgs);
      if (skipped) toast({ title: added ? "Some images were left out" : "Image not attached", description: skipped, status: "error" });
    } catch (e) {
      toast({ title: "Couldn't attach image", description: e instanceof Error ? e.message : String(e), status: "error" });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (paste.onKeyDown(e)) return;
    if (palette.onKeyDown(e)) return;
    const items = popup?.items ?? [];
    if (popup && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s <= 0 ? items.length - 1 : s - 1));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        const p = popup.items[sel];
        if (p) pickMention(p);
        return;
      }
    }
    if (e.key === "Escape") {
      if (popup) {
        e.preventDefault();
        e.stopPropagation();
        setPopup(null);
        return;
      }
      // Focus mode: Esc leaves focus (the Stop button still stops); the view's handler does it.
      if (useUi.getState().focusMode) return;
      if (working && caps?.abort !== false) {
        e.preventDefault();
        e.stopPropagation();
        abort();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !mobile) {
      // Empty composer + pending ask: let Enter bubble so the ask card sends its selection.
      if (ui && !text.trim() && images.length === 0 && videos.length === 0) return;
      e.preventDefault();
      void send(e.altKey);
    } else if (e.key === "Enter" && mobile && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send(e.altKey);
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
    // Any file: never let the webview navigate to it; images and videos are attached.
    if (dragHasFiles(e.dataTransfer) || e.dataTransfer.files.length > 0) e.preventDefault();
    const files = mediaFiles(e.dataTransfer);
    if (files.length > 0) void addFiles(files);
  };

  const hasContent = text.trim() !== "" || images.length > 0 || videos.length > 0;
  // Phone, nothing typed: one row (text + attach/mic/stop) so the transcript keeps the height;
  // the first character expands to the full toolbar with send.
  const inline = mobile && !hasContent && !dictation.listening && !dictation.error;
  const placeholder = disabledReason
    ? disabledReason
    : agent?.parked
      ? "Message it to resume the session"
      : agent?.needs
        ? "Answer above, or steer…"
        : working
          ? mobile
            ? "Steer the agent…"
            : "Steer the agent · Alt+Enter queues a follow-up"
          : mobile
            ? "Message omp · / commands"
            : "Message omp · / commands · @ files";
  // Holding Alt while the agent works previews follow-up mode on the send button and hints.
  const followMode = working && altHeld && caps?.followUp === true;

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(e) => {
        if (dragHasFiles(e.dataTransfer)) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <AnimatePresence>
        {!paste.menu &&
          (palette.element ??
            (popup && (
              <ComposerPopup
                key="mention"
                label="Files"
                icon={<AtSign className="size-3" />}
                title={cwd ? `Files in ${cwd}` : "Files"}
                busy={popup.loading && <Spinner size={11} className="ml-auto" />}
                mobile={mobile}
              >
                {popup.items.length === 0
                  ? !popup.loading && <div className="px-3 py-3 text-xs text-mute-2">No files match “{popup.query}”</div>
                  : popup.items.map((p, i) => (
                      <button
                        key={p}
                        type="button"
                        role="option"
                        aria-selected={i === sel}
                        onMouseEnter={() => setSel(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickMention(p)}
                        className={cn("flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left font-mono text-[12px]", i === sel ? "bg-accent/18 text-ink" : "text-ink-2")}
                      >
                        <FileText className="size-3.5 shrink-0 text-mute-2" />
                        <span className="truncate">
                          {p.includes("/") && <span className="text-mute-2">{p.slice(0, p.lastIndexOf("/") + 1)}</span>}
                          {(() => {
                            const name = p.slice(p.lastIndexOf("/") + 1);
                            const at = popup.query ? name.toLowerCase().indexOf(popup.query.toLowerCase()) : -1;
                            if (at < 0) return name;
                            return (
                              <>
                                {name.slice(0, at)}
                                <span className="font-bold text-accent-hi">{name.slice(at, at + popup.query.length)}</span>
                                {name.slice(at + popup.query.length)}
                              </>
                            );
                          })()}
                        </span>
                      </button>
                    ))}
              </ComposerPopup>
            )))}
      </AnimatePresence>
      <AnimatePresence>{paste.menu && <PasteMenu key="paste" paste={paste} mobile={mobile} />}</AnimatePresence>

      <QueueStrip
        hostId={hostId}
        agentId={agentId}
        agentKey={agentKey}
        queue={queue}
        working={working}
        canPull={caps?.bridge === true}
        busy={sending}
        run={run}
        onCopy={(t) => setText(t)}
        onPulled={(t) => {
          setText((cur) => (cur.trim() ? `${t}\n\n${cur}` : t));
          requestAnimationFrame(() => ta.current?.focus());
        }}
      />

      {ramble.panel}
      {working && !disabledReason && <SteerHint doneRef={steerDone} />}
      <GlowBorder
        status="running"
        active={working && !disabledReason}
        radius={22}
        className={cn("relative rounded-[22px] transition-shadow duration-300", dragging && "shadow-[0_0_0_2px_var(--color-accent),var(--shadow-glow-accent)]")}
      >
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3 pb-1">
            {images.map((img, i) => (
              <motion.div key={i} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.bouncy }} className="group/img relative shrink-0">
                <LightboxTrigger label={`View attachment ${i + 1}`} onClick={() => setViewing(i)}>
                  <img src={img.preview} alt={`attachment ${i + 1}`} className="size-14 rounded-md object-cover shadow-hairline" />
                </LightboxTrigger>
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setImages((cur) => cur.filter((x) => x !== img))}
                  className="pressable focus-ring absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-tile-4 text-ink shadow-d1"
                >
                  <X className="size-3" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
        <VideoChips
          videos={videos}
          onRemove={(id) => removeDraftVideo(draftKey, id)}
          onRetry={(id) => retryVideos([id])}
          mobile={mobile}
          className={cn("px-3 pb-1", images.length > 0 ? "pt-1" : "pt-3")}
        />
        <PasteChips paste={paste} mobile={mobile} className={cn("px-3 pb-1", images.length > 0 || videos.length > 0 ? "pt-1" : "pt-3")} />
        <Lightbox
          images={images.map((img, i) => ({ src: img.preview, alt: `attachment ${i + 1}` }))}
          index={viewing !== null && viewing < images.length ? viewing : null}
          onIndexChange={setViewing}
        />
        <Textarea
          ref={ta}
          value={dictation.listening && dictation.interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${dictation.interim}` : text}
          onChange={(e) => {
            const r = paste.change(e.target.value, e.target.selectionStart ?? e.target.value.length, (e.nativeEvent as InputEvent).isComposing === true);
            updatePopup(r.text, r.caret);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            paste.onSelect(el);
            if (popup?.kind === "mention" || el.value.includes("@")) updatePopup(el.value, el.selectionStart ?? el.value.length);
          }}
          onCopy={(e) => paste.onCopy(e)}
          onCut={(e) => paste.onCopy(e, true)}
          onBlur={() =>
            window.setTimeout(() => {
              setPopup(null);
              palette.close();
              // Clicked elsewhere: omp's menu keeps the paste inline, a chip's menu closes.
              if (document.activeElement !== ta.current) paste.close();
            }, 120)
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="Message"
          data-composer=""
          autoFocus={autoFocus}
          // Phone: Enter is a newline (the button sends; Ctrl/Meta+Enter from a hardware keyboard), so the keyboard shows a return key.
          enterKeyHint={mobile ? "enter" : undefined}
          maxHeight={mobile ? 160 : 260}
          boxClassName={cn(
            "rounded-[22px] glass px-4 py-3 md:[@media(max-height:720px)]:py-2",
            mobile && "py-2 pr-2 pl-4 [&>div]:mt-1.5",
            // one row: the text keeps room to type, the icon row (status pill first) gives way
            inline && "flex-row items-center gap-1 py-1 pr-1 [&>div]:mt-0",
            !!disabledReason && "opacity-80",
          )}
          className={cn("text-[14px]", mobile && "min-h-[1lh] text-[15px]", inline && "min-w-[30%] flex-1 overflow-hidden whitespace-nowrap")}
          footer={
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <IconButton label="Attach images or videos" size={mobile ? "md" : "sm"} onClick={() => fileInput.current?.click()} disabled={!!disabledReason}>
                <Paperclip />
              </IconButton>
              {dictation.supported && (
                <IconButton
                  label={dictation.listening ? "Stop dictation" : "Dictate"}
                  size={mobile ? "md" : "sm"}
                  variant={dictation.listening ? "sunset" : "ghost"}
                  onClick={dictation.toggle}
                  disabled={!!disabledReason}
                  className={cn(dictation.listening && "tf-loop animate-breathe [--tf-breath:1.1s]")}
                >
                  {dictation.listening ? <MicOff /> : <Mic />}
                </IconButton>
              )}
              {mobile && agent?.omp?.link === "live" && <StatusPill agentKey={agentKey} />}
              {disabledReason ? (
                inline ? null : (
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold text-mute-2">
                    <Lock className="size-3 shrink-0" />
                    {disabledReason}
                  </span>
                )
              ) : (
                !mobile && (
                  <span className="flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold text-mute-2">
                    {working && hasContent && !text.startsWith("/") && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wider uppercase transition-colors duration-200",
                          followMode ? "bg-ink/8 text-ink-2" : "bg-accent/18 text-accent-hi",
                        )}
                      >
                        {followMode ? "follow-up · after this turn" : "steer · lands mid-turn"}
                      </span>
                    )}
                    <span className={cn("flex items-center gap-1 transition-colors", working && !followMode && "text-accent-hi")}>
                      <Kbd>Enter</Kbd>
                      {working ? "steer" : "send"}
                    </span>
                    {working ? (
                      <span className={cn("flex items-center gap-1 transition-colors", followMode && "text-ink")}>
                        <Kbd>Alt</Kbd>
                        <Kbd>Enter</Kbd>
                        follow-up
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <Kbd>Shift</Kbd>
                        <Kbd>Enter</Kbd>
                        newline
                      </span>
                    )}
                    {working && !hasContent && (
                      <span className="flex items-center gap-1">
                        <Kbd>Esc</Kbd>
                        stop turn
                      </span>
                    )}
                  </span>
                )
              )}
              {dictation.error && <span className="line-clamp-2 min-w-0 text-2xs leading-tight font-semibold text-error">{dictation.error}</span>}
              {dictation.openSettings && (
                <button type="button" className="relative shrink-0 rounded-xs text-2xs font-extrabold text-accent-hi touch-hit focus-ring hover:underline" onClick={dictation.openSettings}>
                  Open settings
                </button>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {working && hasContent && !disabledReason && caps?.followUp && !followMode && (
                  <IconButton label="Queue follow-up (Alt+Enter)" size={mobile ? "md" : "sm"} variant="secondary" onClick={() => void send(true)} disabled={sending || waitingUploads}>
                    <ListPlus />
                  </IconButton>
                )}
                {working && (!hasContent || mobile) && caps?.abort !== false && (
                  <IconButton label="Stop turn (Esc)" size={mobile ? "lg" : "sm"} variant="danger" onClick={abort} disabled={sending}>
                    <Square className="fill-current" />
                  </IconButton>
                )}
                {(hasContent || !working) && !inline && (
                  <IconButton
                    label={waitingUploads ? "Sending once the videos are uploaded" : followMode ? "Queue follow-up (Alt+Enter)" : `${working ? "Steer" : "Send"}${mobile ? "" : " (Enter)"}`}
                    size={mobile ? "lg" : "sm"}
                    variant="primary"
                    onClick={() => void send(followMode)}
                    disabled={!hasContent || sending || waitingUploads || (!!disabledReason && !text.trim().startsWith("/"))}
                  >
                    {sending || waitingUploads ? <Spinner size={14} /> : followMode ? <ListPlus /> : working ? <CornerDownRight /> : <ArrowUp />}
                  </IconButton>
                )}
              </span>
            </>
          }
        />
        {dragging && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[22px] bg-accent/10 text-sm font-bold text-accent-ink backdrop-blur-[2px]">Drop images or videos to attach</div>
        )}
      </GlowBorder>
    </div>
  );
}
