import { ArrowUp, AtSign, CornerDownRight, FileText, ImagePlus, ListPlus, Lock, Mic, MicOff, Pencil, Slash, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { core, navigate, parseAgentKey, useAgent, useSession, useUi } from "@/core";
import type { CommandInfo, ImageInput } from "@/core/gen";
import type { OmpSubcommand } from "@/core/ompCommands";
import { cn, GlowBorder, IconButton, Kbd, Spinner, spring, Textarea, toast } from "@/design";
import { fileToImageInput, hostCall, type PendingImage, usePending } from "../api";
import { useSessionUi } from "../state";
import { findCommand, MODE_BADGE, matchCommands, matchSubs, parseSlash, runSlash, type SlashCommand, type SlashContext } from "./slash";
import { useDictation } from "./useDictation";

export interface ComposerProps {
  agentKey: string;
  /** Phone layout: bigger touch targets, mic, no hint row. */
  mobile?: boolean;
  className?: string;
  autoFocus?: boolean;
}

type Popup =
  | { kind: "slash"; items: SlashCommand[] }
  | { kind: "sub"; cmd: SlashCommand; items: OmpSubcommand[] }
  | { kind: "mention"; query: string; start: number; items: string[]; loading: boolean };

const MENTION_RE = /(^|\s)@([^\s@]*)$/;

/**
 * Composer: Enter sends (steer while the agent works, prompt when idle), Alt+Enter queues a
 * follow-up, Esc stops. `/` opens the command palette, `@` searches files in the agent's cwd,
 * images paste/drop in as attachments.
 */
export function Composer({ agentKey, mobile = false, className, autoFocus = false }: ComposerProps) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta, ui } = useSession(agentKey);
  const draft = useSessionUi((s) => s.draft[agentKey]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [sel, setSel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, run] = usePending();
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const caps = meta?.caps;
  const working = agent?.column === "running" || agent?.live.streaming === true || agent?.live.tool != null;
  const queue = meta?.queue ?? agent?.omp?.queue;
  const cwd = meta?.cwd ?? agent?.cwd;
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
  const disabledReason = !agent
    ? "Agent not found"
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

  const dictation = useDictation((phrase) => setText((t) => (t && !t.endsWith(" ") ? `${t} ${phrase}` : t + phrase)));

  // Text pushed in from elsewhere (queue chip, tree "edit from here").
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    ta.current?.focus();
  }, [draft]);

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
    openTerminal: () => (mobile ? navigate({ name: "terminal", hostId, agentId }) : useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent?.paneId })),
  };

  const updatePopup = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash && value.indexOf("\n") < 0) {
      setPopup({ kind: "slash", items: matchCommands(slash[1] ?? "", custom) });
      setSel(0);
      return;
    }
    // `/name <partial>`: offer the command's subcommands / argument choices.
    const sub = /^\/(\S+?)[\s:](\S*)$/.exec(before);
    const subCmd = sub && value.indexOf("\n") < 0 ? findCommand(parseSlash(before)?.name ?? "", custom) : undefined;
    if (sub && subCmd?.subs) {
      const items = matchSubs(subCmd, sub[2] ?? "");
      setPopup(items.length ? { kind: "sub", cmd: subCmd, items } : null);
      setSel(sub[2] ? 0 : -1);
      return;
    }
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

  const pickSlash = (c: SlashCommand) => {
    if (c.instant && !c.subs) {
      setText("");
      setPopup(null);
      void run(runSlash(slashCtx, `/${c.name}`));
      return;
    }
    const v = `/${c.name} `;
    setText(v);
    setPopup(c.subs ? { kind: "sub", cmd: c, items: c.subs } : null);
    setSel(-1);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(v.length, v.length);
    });
  };

  /** A subcommand without arguments runs right away; one with arguments is completed for typing. */
  const pickSub = (cmd: SlashCommand, s: OmpSubcommand) => {
    setPopup(null);
    if (!s.args) {
      setText("");
      void run(runSlash(slashCtx, `/${cmd.name} ${s.name}`));
      return;
    }
    const v = `/${cmd.name} ${s.name} `;
    setText(v);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(v.length, v.length);
    });
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
    const body = text.trim();
    if (!body && images.length === 0) return;
    if (body.startsWith("/") && images.length === 0) {
      const okRun = await run(runSlash(slashCtx, body));
      if (okRun) setText("");
      return;
    }
    if (disabledReason) {
      toast({ title: "Can't send", description: disabledReason, status: "error" });
      return;
    }
    // Leading space escapes a slash: " /path is a file" goes to the model as text.
    const prompt = text.startsWith(" /") ? text.slice(1) : text.trim();
    const delivery = followUp ? "followUp" : working && caps && !caps.steer && caps.followUp ? "followUp" : "auto";
    const imgs: ImageInput[] = images.map(({ mime, data }) => ({ mime, data }));
    const res = await run(hostCall(hostId, "agent.prompt", { agentId, text: prompt, images: imgs, delivery }, { failure: "Prompt not delivered" }));
    if (res.ok) {
      setText("");
      setImages([]);
      setPopup(null);
      if (delivery === "followUp") toast({ title: "Queued follow-up", description: prompt.slice(0, 80), status: "running", duration: 2200 });
    }
  };

  const abort = () => void run(hostCall(hostId, "agent.abort", { agentId }, { failure: "Stop failed" }));

  const addFiles = async (files: Iterable<File>) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    try {
      const loaded = await Promise.all(imgs.map(fileToImageInput));
      setImages((cur) => [...cur, ...loaded].slice(0, 8));
    } catch (e) {
      toast({ title: "Couldn't attach image", description: e instanceof Error ? e.message : String(e), status: "error" });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
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
      // Argument choices start unselected: Enter sends the command as typed (e.g. bare `/jobs`).
      const choosing = popup.kind !== "sub" || sel >= 0;
      if (e.key === "Tab" || (choosing && e.key === "Enter" && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        if (popup.kind === "slash") {
          const c = popup.items[sel];
          if (c) pickSlash(c);
        } else if (popup.kind === "sub") {
          const s = popup.items[Math.max(sel, 0)];
          if (s) pickSub(popup.cmd, s);
        } else {
          const p = popup.items[sel];
          if (p) pickMention(p);
        }
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
      if (ui && !text.trim() && images.length === 0) return;
      e.preventDefault();
      void send(e.altKey);
    } else if (e.key === "Enter" && mobile && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send(e.altKey);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  };

  const hasContent = text.trim() !== "" || images.length > 0;
  const placeholder = disabledReason
    ? disabledReason
    : agent?.needs
      ? "Answer above, or steer…"
      : working
        ? mobile
          ? "Steer the agent…"
          : "Steer the agent · Alt+Enter queues a follow-up"
        : mobile
          ? "Message omp · / commands"
          : "Message omp · / commands · @ files";
  const occurrences = new Map<string, number>();
  const queued = [...(queue?.steering ?? []).map((t) => ({ t, kind: "steer" as const })), ...(queue?.followUp ?? []).map((t) => ({ t, kind: "follow" as const }))].map((q) => {
    // Stable keys (text + occurrence) so a delivered message animates out instead of re-keying the rest.
    const base = `${q.kind}:${q.t}`;
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return { ...q, id: `${base}#${n}` };
  });
  // Holding Alt while the agent works previews follow-up mode on the send button and hints.
  const followMode = working && altHeld && caps?.followUp === true;
  // omp's Alt+Up pops the last steer if any, else the last follow-up: highlight that chip.
  const canDequeue = caps?.bridge === true && queued.length > 0;
  const popIdx = queue?.steering.length ? queue.steering.length - 1 : queued.length - 1;
  const dequeue = async (edit: boolean) => {
    const r = await run(hostCall(hostId, "agent.dequeue", { agentId }, { failure: "Couldn't pull the message back" }));
    if (!r.ok) return;
    const t = r.value.text;
    if (!t) {
      toast({ title: "Already delivered", description: "The queue was empty by the time the request arrived.", status: "idle" });
      return;
    }
    if (edit) {
      setText((cur) => (cur.trim() ? `${t}\n\n${cur}` : t));
      requestAnimationFrame(() => ta.current?.focus());
    } else toast({ title: "Removed from the queue", description: t.length > 80 ? `${t.slice(0, 80)}…` : t, status: "done", duration: 2600 });
  };

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <AnimatePresence>
        {popup && (popup.items.length > 0 || popup.kind === "mention") && (
          <motion.div
            key={popup.kind}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            className="absolute inset-x-0 bottom-full z-popover mb-2 overflow-hidden rounded-lg bg-[linear-gradient(180deg,#22222e,#181820)] shadow-[var(--shadow-d3),inset_0_0_0_1px_rgb(255_255_255/0.09)]"
            role="listbox"
            aria-label={popup.kind === "slash" ? "Commands" : popup.kind === "sub" ? `/${popup.cmd.name} arguments` : "Files"}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-2xs font-bold text-mute-2">
              {popup.kind === "mention" ? <AtSign className="size-3" /> : <Slash className="size-3" />}
              {popup.kind === "slash" ? "Commands" : popup.kind === "sub" ? `/${popup.cmd.name} · pick an argument or keep typing` : cwd ? `Files in ${cwd}` : "Files"}
              {popup.kind === "mention" && popup.loading && <Spinner size={11} className="ml-auto" />}
              {!mobile && (
                <span className="ml-auto flex items-center gap-1">
                  <Kbd>↑↓</Kbd>
                  <Kbd>Tab</Kbd>
                  {popup.kind === "sub" && sel < 0 && <span className="ml-1 font-semibold">Enter sends as typed</span>}
                </span>
              )}
            </div>
            <div className="max-h-[300px] overflow-y-auto p-1">
              {popup.kind === "slash" ? (
                popup.items.map((c, i) => {
                  const unavailable = c.mode === "native" && c.cap != null && meta != null && !meta.caps[c.cap];
                  const badge = c.source === "omp" || c.source === "teleflock" ? MODE_BADGE[c.mode] : c.source;
                  return (
                    <button
                      key={c.name}
                      type="button"
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSlash(c)}
                      title={c.mode === "terminal" ? "Opens omp's own UI in the agent's terminal" : c.mode === "report" ? "omp prints the result in its terminal; TeleFlock opens it for you" : undefined}
                      className={cn("flex w-full items-baseline gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px]", i === sel ? "bg-accent/18 text-ink" : "text-ink-2", unavailable && "opacity-45")}
                    >
                      <span className="shrink-0 font-mono font-bold whitespace-nowrap text-accent-hi">/{c.name}</span>
                      {c.args && !mobile && <span className="truncate font-mono text-[11px] text-mute-2">{c.args}</span>}
                      <span className="ml-auto truncate pl-3 text-xs text-mute">{c.description}</span>
                      {badge && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 text-[9.5px] font-bold tracking-wider whitespace-nowrap uppercase",
                            c.mode === "terminal" || c.mode === "report" ? "bg-accent/14 text-accent-hi" : "bg-white/6 text-mute-2",
                          )}
                        >
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })
              ) : popup.kind === "sub" ? (
                popup.items.map((s, i) => {
                  const mode = popup.cmd.modeFor(s.name);
                  const badge = MODE_BADGE[mode];
                  return (
                    <button
                      key={s.name}
                      type="button"
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSub(popup.cmd, s)}
                      className={cn("flex w-full items-baseline gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px]", i === sel ? "bg-accent/18 text-ink" : "text-ink-2")}
                    >
                      <span className="font-mono font-bold text-accent-hi">{s.name}</span>
                      {s.args && !mobile && <span className="truncate font-mono text-[11px] text-mute-2">{s.args}</span>}
                      <span className="ml-auto truncate pl-3 text-xs text-mute">{s.description}</span>
                      {badge && mode !== "direct" && <span className="shrink-0 rounded-full bg-accent/14 px-1.5 text-[9.5px] font-bold tracking-wider whitespace-nowrap text-accent-hi uppercase">{badge}</span>}
                    </button>
                  );
                })
              ) : popup.items.length === 0 ? (
                !popup.loading && <div className="px-3 py-3 text-xs text-mute-2">No files match “{popup.query}”</div>
              ) : (
                popup.items.map((p, i) => (
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
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {queued.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 flex flex-wrap items-center gap-1.5 overflow-hidden px-1"
            aria-label="Queued messages"
          >
            <span className="mr-0.5 text-[10px] font-extrabold tracking-[0.1em] text-mute-2 uppercase">Queued · {queued.length}</span>
            <AnimatePresence initial={false} mode="popLayout">
              {queued.map((q, i) => (
                <motion.button
                  layout
                  key={q.id}
                  type="button"
                  initial={{ opacity: 0, scale: 0.8, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0, transition: spring.bouncy }}
                  exit={{ opacity: 0, scale: 0.85, y: -10, transition: { duration: 0.22 } }}
                  title={`${q.kind === "steer" ? "Steering: lands mid-turn" : "Follow-up: runs after this turn"}\n${q.t}\nClick to copy into the composer`}
                  onClick={() => setText(q.t)}
                  className={cn(
                    "focus-ring flex max-w-[300px] items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11.5px] font-semibold shadow-hairline",
                    q.kind === "steer" ? "bg-accent/14 text-accent-ink" : "bg-white/5 text-ink-2",
                    canDequeue && i === popIdx && "shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-extrabold tracking-wider uppercase",
                      q.kind === "steer" ? "bg-accent/25 text-accent-hi" : "bg-white/8 text-mute",
                    )}
                  >
                    {q.kind === "steer" ? <CornerDownRight className="size-2.5" /> : <ListPlus className="size-2.5" />}
                    {q.kind === "steer" ? "steer" : "next"}
                  </span>
                  <span className="truncate">{q.t}</span>
                  <span className="tf-loop size-1.5 shrink-0 animate-breathe rounded-full bg-current opacity-70" aria-hidden />
                </motion.button>
              ))}
              {canDequeue && (
                <motion.span key="dequeue" layout className="flex items-center gap-0.5">
                  <IconButton label="Pull the highlighted message back into the composer to edit it" size="sm" disabled={sending} onClick={() => void dequeue(true)}>
                    <Pencil />
                  </IconButton>
                  <IconButton label="Remove the highlighted message from the queue" size="sm" disabled={sending} onClick={() => void dequeue(false)}>
                    <X />
                  </IconButton>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

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
                <img src={img.preview} alt={`attachment ${i + 1}`} className="size-14 rounded-md object-cover shadow-hairline" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                  className="pressable focus-ring absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-tile-4 text-ink shadow-d1"
                >
                  <X className="size-3" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
        <Textarea
          ref={ta}
          value={dictation.listening && dictation.interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${dictation.interim}` : text}
          onChange={(e) => {
            setText(e.target.value);
            updatePopup(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (popup?.kind === "mention" || el.value.includes("@")) updatePopup(el.value, el.selectionStart ?? el.value.length);
          }}
          onBlur={() => window.setTimeout(() => setPopup(null), 120)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="Message"
          data-composer=""
          autoFocus={autoFocus}
          enterKeyHint={mobile ? "send" : undefined}
          maxHeight={mobile ? 160 : 260}
          boxClassName={cn("rounded-[22px] glass px-4 py-3", !!disabledReason && "opacity-80")}
          className={cn("text-[14px]", mobile && "text-[15px]")}
          footer={
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <IconButton label="Attach image" size="sm" onClick={() => fileInput.current?.click()} disabled={!!disabledReason}>
                <ImagePlus />
              </IconButton>
              {mobile && dictation.supported && (
                <IconButton
                  label={dictation.listening ? "Stop dictation" : "Dictate"}
                  size="sm"
                  variant={dictation.listening ? "sunset" : "ghost"}
                  onClick={dictation.toggle}
                  disabled={!!disabledReason}
                  className={cn(dictation.listening && "tf-loop animate-breathe [--tf-breath:1.1s]")}
                >
                  {dictation.listening ? <MicOff /> : <Mic />}
                </IconButton>
              )}
              {disabledReason ? (
                <span className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-semibold text-mute-2">
                  <Lock className="size-3 shrink-0" />
                  {disabledReason}
                </span>
              ) : (
                !mobile && (
                  <span className="flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold text-mute-2">
                    {working && hasContent && !text.startsWith("/") && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wider uppercase transition-colors duration-200",
                          followMode ? "bg-white/8 text-ink-2" : "bg-accent/18 text-accent-hi",
                        )}
                      >
                        {followMode ? "follow-up · after this turn" : "steer · lands mid-turn"}
                      </span>
                    )}
                    <span className={cn("flex items-center gap-1 transition-colors", working && !followMode && "text-accent-hi")}>
                      <Kbd>Enter</Kbd>
                      {working ? "steer" : "send"}
                    </span>
                    <span className={cn("flex items-center gap-1 transition-colors", followMode && "text-ink")}>
                      <Kbd>Alt</Kbd>
                      <Kbd>Enter</Kbd>
                      follow-up
                    </span>
                    {working && !hasContent && (
                      <span className="flex items-center gap-1">
                        <Kbd>Esc</Kbd>
                        stop
                      </span>
                    )}
                  </span>
                )
              )}
              {dictation.error && <span className="truncate text-2xs font-semibold text-error">{dictation.error}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {working && hasContent && !disabledReason && caps?.followUp && !followMode && (
                  <IconButton label="Queue follow-up (Alt+Enter)" size="sm" variant="secondary" onClick={() => void send(true)} disabled={sending}>
                    <ListPlus />
                  </IconButton>
                )}
                {working && (!hasContent || mobile) && caps?.abort !== false && (
                  <IconButton label="Stop (Esc)" size={mobile ? "md" : "sm"} variant="danger" onClick={abort} disabled={sending}>
                    <Square className="fill-current" />
                  </IconButton>
                )}
                {(hasContent || !working) && (
                  <IconButton
                    label={followMode ? "Queue follow-up (Alt+Enter)" : working ? "Steer (Enter)" : "Send (Enter)"}
                    size={mobile ? "md" : "sm"}
                    variant="primary"
                    onClick={() => void send(followMode)}
                    disabled={!hasContent || sending || (!!disabledReason && !text.trim().startsWith("/"))}
                  >
                    {sending ? <Spinner size={14} /> : followMode ? <ListPlus /> : working ? <CornerDownRight /> : <ArrowUp />}
                  </IconButton>
                )}
              </span>
            </>
          }
        />
        {dragging && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[22px] bg-accent/10 text-sm font-bold text-accent-ink backdrop-blur-[2px]">Drop images to attach</div>
        )}
      </GlowBorder>
    </div>
  );
}
