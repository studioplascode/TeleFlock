import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, CornerDownLeft, ImagePlus, Send, Star, X, Zap } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { fitImages, imageFiles, readImages } from "@/core/clipboardImages";
import type { DraftImage } from "@/core/draftImages";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  Kbd,
  Spinner,
  Textarea,
  cn,
  isTauri,
} from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { capturePort, type Port, requestId, type ToCapture, type ToMain } from "./link";
import type { CaptureOption, CaptureQuestion, CaptureSnapshot, CaptureTarget } from "./snapshot";
import { imagesLabel } from "./task";

/*
 * The Quick capture window (`capture.html`, desktop): a small always-on-top box the global
 * shortcut or the tray opens. Type or paste a task (screenshots too) and Enter dispatches it to
 * Dispatch's current repo; Ctrl+Enter opens it in Dispatch instead; number keys answer the oldest
 * question. Everything is done by the main window (`QuickCaptureBridge`); this page only shows
 * what it posts and asks it to act.
 */

/** Typed text survives hiding the window and restarts (the main window never touches this key). */
const TEXT_KEY = "tf.capture.text";
/** How long a sent task's confirmation shows before the window hides. */
const SENT_HIDE_MS = 1100;
/** A request the main window didn't answer by then failed. */
const ANSWER_TIMEOUT_MS = 12_000;
/** Hello again until the first picture arrives (the main page may still be starting). */
const HELLO_RETRY_MS = 1500;
const MIN_HEIGHT = 150;

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = mac ? "⌘" : "Ctrl";

type Action = "send" | "edit" | "answer" | "open";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; what: Action }
  | { kind: "done"; what?: Action; ok: boolean; title: string; detail?: string };

function readText(): string {
  try {
    return localStorage.getItem(TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeText(text: string): void {
  try {
    if (text) localStorage.setItem(TEXT_KEY, text);
    else localStorage.removeItem(TEXT_KEY);
  } catch {
    /* storage unavailable: memory only */
  }
}

/** The shell's window controls (no-ops in a browser tab). */
const shell = {
  hide: () => (isTauri() ? invoke("capture_hide").catch(() => {}) : Promise.resolve()),
  draft: (typing: boolean, unsaved: boolean) => (isTauri() ? invoke("capture_draft", { typing, unsaved }).catch(() => {}) : Promise.resolve()),
  fit: (height: number) => (isTauri() ? invoke("capture_resize", { height }).catch(() => {}) : Promise.resolve()),
};

type CapturePort = Port<ToCapture, ToMain>;

/** Out of the way: the main window stops posting, the shell hides the window. */
function hideWindow(port: CapturePort | null): void {
  port?.post({ kind: "bye" });
  void shell.hide();
}

export function CaptureWindow() {
  const [port] = useState(capturePort);
  const [snapshot, setSnapshot] = useState<CaptureSnapshot | null>(null);
  const [text, setText] = useState(readText);
  const [images, setImagesState] = useState<DraftImage[]>([]);
  // What async handlers (a paste being decoded) add to: the images as of now, not of their render.
  const imagesNow = useRef<DraftImage[]>([]);
  const setImages = (next: DraftImage[]) => {
    imagesNow.current = next;
    setImagesState(next);
  };
  const [pick, setPick] = useState<{ target: string; repo: string } | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ id: string; what: Action; timer: number } | null>(null);

  // ---- the main window's picture and answers
  useEffect(() => {
    if (!port) return;
    return port.listen((msg: ToCapture) => {
      if (msg.kind === "state") setSnapshot(msg.snapshot);
      else if (msg.kind === "ready") port.post({ kind: "hello" });
      else if (msg.kind === "done" && pending.current?.id === msg.id) {
        const { what, timer } = pending.current;
        window.clearTimeout(timer);
        pending.current = null;
        if (msg.ok && what === "send") {
          setText("");
          writeText("");
          imagesNow.current = [];
          setImagesState([]);
        }
        setStatus({ kind: "done", what, ok: msg.ok, title: msg.title, ...(msg.detail ? { detail: msg.detail } : {}) });
        // Dispatch or the HUD is in front now.
        if (msg.ok && (what === "edit" || what === "open")) hideWindow(port);
      }
    });
  }, [port]);

  // ---- showing and hiding: hello / bye, focus in the box
  const onShown = useEffectEvent(() => {
    port?.post({ kind: "hello" });
    if (!pending.current) setStatus({ kind: "idle" });
    setQIndex(0);
    setPick(null);
    requestAnimationFrame(() => box.current?.focus());
  });
  const onHidden = useEffectEvent(() => port?.post({ kind: "bye" }));
  useEffect(() => {
    // The shell creates the window to show it: the first load counts as shown.
    onShown();
    if (!isTauri()) {
      const onVisible = () => {
        if (document.visibilityState === "visible") onShown();
        else onHidden();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }
    const offs = [listen("tf-capture://shown", () => onShown()), listen("tf-capture://hidden", () => onHidden())];
    return () => {
      for (const off of offs) void off.then((f) => f());
    };
  }, []);
  // No picture yet: the main page may still be starting, ask again.
  useEffect(() => {
    if (snapshot || !port) return;
    const t = window.setInterval(() => port.post({ kind: "hello" }), HELLO_RETRY_MS);
    return () => window.clearInterval(t);
  }, [snapshot, port]);

  // A dispatched task's confirmation, then out of the way (unless you started typing again).
  const sentAway = status.kind === "done" && status.ok && status.what === "send";
  const onSentShown = useEffectEvent(() => {
    if (!box.current?.value) hideWindow(port);
  });
  useEffect(() => {
    if (!sentAway) return;
    const t = window.setTimeout(onSentShown, SENT_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [sentAway]);

  // The window follows its content's height (the shell clamps it).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const h = Math.max(MIN_HEIGHT, Math.ceil(el.getBoundingClientRect().height));
      if (h !== last) {
        last = h;
        void shell.fit(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const recents = snapshot?.recents ?? [];
  const target: CaptureTarget | null = (pick && recents.find((r) => r.target === pick.target && r.repo === pick.repo)) || snapshot?.target || null;
  const questions = snapshot?.questions ?? [];
  const question: CaptureQuestion | undefined = questions[Math.min(qIndex, questions.length - 1)];
  const busy = status.kind === "busy";
  const empty = !text.trim() && images.length === 0;
  // The shell's updater counts a box in use as the user being at work: typed text, and what a
  // restart would lose (pasted images, a request waiting for the main window).
  const typing = text.trim() !== "";
  const unsaved = images.length > 0 || busy;
  useEffect(() => {
    void shell.draft(typing, unsaved);
  }, [typing, unsaved]);

  const request = (what: Action, build: (id: string) => ToMain) => {
    if (!port || busy) return;
    const id = requestId();
    const timer = window.setTimeout(() => {
      if (pending.current?.id !== id) return;
      pending.current = null;
      setStatus({ kind: "done", what, ok: false, title: "TeleFlock didn't answer", detail: "Open TeleFlock and try again." });
    }, ANSWER_TIMEOUT_MS);
    pending.current = { id, what, timer };
    setStatus({ kind: "busy", what });
    port.post(build(id));
  };
  const payload = () => ({ text: text.trim(), images: images.map(({ mime, data }) => ({ mime, data })) });
  const send = () => {
    if (empty) return;
    const blocked = target ? target.blocked : (snapshot?.blocked ?? "Nowhere to send it yet");
    if (!target || blocked) {
      setStatus({ kind: "done", ok: false, title: blocked ?? "Nowhere to send it yet", detail: `${target ? "Pick another repository, or " : ""}${MOD}+Enter opens it in Dispatch.` });
      return;
    }
    request("send", (id) => ({ kind: "send", id, ...payload(), target: target.target, repo: target.repo }));
  };
  const edit = () => request("edit", (id) => ({ kind: "edit", id, ...payload(), ...(target ? { target: target.target, repo: target.repo } : {}) }));
  const answer = (q: CaptureQuestion, o: CaptureOption) => request("answer", (id) => ({ kind: "answer", id, agentKey: q.agentKey, requestId: q.requestId, optionId: o.id }));
  const open = (q: CaptureQuestion) => request("open", (id) => ({ kind: "open", id, agentKey: q.agentKey }));

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const fit = fitImages(imagesNow.current, await readImages(files));
    setImages(fit.images);
    if (fit.skipped) setStatus({ kind: "done", ok: false, title: "Some images were left out", detail: fit.skipped });
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(imageFiles(e.dataTransfer));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hideWindow(port);
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!empty) edit();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
      return;
    }
    // Digits answer while the box is empty (Alt+digit always does).
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit && question?.quick && (e.altKey || (empty && !e.ctrlKey && !e.metaKey && !e.shiftKey))) {
      const o = question.options[Number(digit) - 1];
      if (o) {
        e.preventDefault();
        answer(question, o);
      }
      return;
    }
    if (e.key === "Tab" && empty && questions.length > 1) {
      e.preventDefault();
      setQIndex((i) => (i + (e.shiftKey ? questions.length - 1 : 1)) % questions.length);
    }
  };

  return (
    <div
      ref={root}
      className={cn("flex flex-col border border-line-2 bg-bg text-ink", dragging && "ring-2 ring-accent ring-inset")}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 select-none">
        <span data-tauri-drag-region className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]">
          <Zap className="size-3.5" />
        </span>
        <span data-tauri-drag-region className="font-display text-sm font-bold tracking-[-0.01em]">
          {ACTIONS.quickCapture.label}
        </span>
        <span data-tauri-drag-region className="min-w-0 flex-1" />
        <TargetPicker target={target} recents={recents} blocked={snapshot?.blocked ?? null} onPick={(t) => setPick({ target: t.target, repo: t.repo })} onClosed={() => box.current?.focus()} />
        <IconButton label="Close (Esc)" size="sm" onClick={() => hideWindow(port)}>
          <X />
        </IconButton>
      </header>

      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <Textarea
          ref={box}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            writeText(e.target.value);
            if (status.kind === "done") setStatus({ kind: "idle" });
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={3}
          maxHeight={200}
          placeholder={target ? `Describe a task for ${target.repoName}… (paste a screenshot)` : "Describe a task… (paste a screenshot)"}
          aria-label="Task"
          boxClassName="bg-well"
          className="text-[14px]"
        />
        {images.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {images.map((img, i) => (
              <span key={img.preview.slice(-48) + i} className="relative size-14 overflow-hidden rounded-md shadow-hairline">
                <img src={img.preview} alt={`Image ${i + 1}`} className="size-full object-cover" />
                <button
                  type="button"
                  aria-label={`Remove image ${i + 1}`}
                  className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-black/70 text-white hover:bg-black focus-ring"
                  onClick={() => setImages(imagesNow.current.filter((x) => x !== img))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <span className="text-2xs font-semibold text-mute-2">{imagesLabel(images.length)}</span>
          </div>
        )}
        <StatusLine status={status} target={target} empty={empty} />
      </div>

      <QuestionPane
        snapshot={snapshot}
        question={question}
        index={Math.min(qIndex, Math.max(0, questions.length - 1))}
        empty={empty}
        busy={busy}
        onAnswer={answer}
        onOpen={open}
      />
    </div>
  );
}

/** Where Enter sends: Dispatch's current repo, or another recent one for this capture. */
function TargetPicker({
  target,
  recents,
  blocked,
  onPick,
  onClosed,
}: {
  target: CaptureTarget | null;
  recents: readonly CaptureTarget[];
  blocked: string | null;
  onPick: (t: CaptureTarget) => void;
  onClosed: () => void;
}) {
  if (!target) return <span className="truncate text-xs font-semibold text-mute-2">{blocked ?? "Connecting to TeleFlock…"}</span>;
  return (
    <DropdownMenu onOpenChange={(o) => !o && onClosed()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={target.blocked ?? `Enter dispatches to ${target.repoName} on ${target.where}`}
          className={cn("pressable focus-ring flex max-w-[60%] min-w-0 items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-xs font-semibold shadow-hairline hover:bg-white/[0.09]", target.blocked ? "text-warn" : "text-ink-2")}
        >
          <Send className="size-3 shrink-0" />
          <span className="truncate">{target.repoName}</span>
          <span className="truncate text-mute-2">· {target.where}</span>
          <ChevronDown className="size-3 shrink-0 text-mute" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[360px]">
        <DropdownMenuLabel>Dispatch to</DropdownMenuLabel>
        {recents.map((r) => (
          <DropdownMenuItem key={`${r.target}\u0000${r.repo}`} onSelect={() => onPick(r)} icon={r.target === target.target && r.repo === target.repo ? <Check /> : <span className="size-4" />}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{r.repoName}</span>
              <span className={cn("truncate text-2xs", r.blocked ? "text-warn" : "text-mute-2")}>{r.blocked ?? r.where}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusLine({ status, target, empty }: { status: Status; target: CaptureTarget | null; empty: boolean }) {
  if (status.kind === "busy") {
    const word = { send: "Dispatching…", edit: "Opening Dispatch…", answer: "Answering…", open: "Opening TeleFlock…" }[status.what];
    return (
      <p className="flex h-6 items-center gap-2 text-xs font-semibold text-mute">
        <Spinner size={12} /> {word}
      </p>
    );
  }
  if (status.kind === "done") {
    return (
      <p className={cn("flex min-h-6 items-center gap-2 text-xs font-semibold", status.ok ? "text-done" : "text-error")} role={status.ok ? "status" : "alert"}>
        {status.ok ? <Check className="size-3.5 shrink-0" /> : <X className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">
          {status.title}
          {status.detail && <span className="font-medium text-mute"> — {status.detail}</span>}
        </span>
      </p>
    );
  }
  return (
    <p className="flex h-6 flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden text-2xs font-semibold text-mute-2">
      <span className="flex items-center gap-1">
        <Kbd>
          <CornerDownLeft className="size-3" />
        </Kbd>
        {target ? "dispatch" : "—"}
      </span>
      <span className="flex items-center gap-1">
        <Kbd>⇧</Kbd>
        <Kbd>
          <CornerDownLeft className="size-3" />
        </Kbd>
        new line
      </span>
      <span className={cn("flex items-center gap-1", empty && "opacity-50")}>
        <Kbd>{MOD}</Kbd>
        <Kbd>
          <CornerDownLeft className="size-3" />
        </Kbd>
        open in Dispatch
      </span>
      <span className="flex items-center gap-1">
        <ImagePlus className="size-3" /> paste images
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Kbd>Esc</Kbd> hide
      </span>
    </p>
  );
}

function QuestionPane({
  snapshot,
  question,
  index,
  empty,
  busy,
  onAnswer,
  onOpen,
}: {
  snapshot: CaptureSnapshot | null;
  question: CaptureQuestion | undefined;
  index: number;
  empty: boolean;
  busy: boolean;
  onAnswer: (q: CaptureQuestion, o: CaptureOption) => void;
  onOpen: (q: CaptureQuestion) => void;
}) {
  if (!snapshot) {
    return (
      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 text-xs font-semibold text-mute-2">
        <Spinner size={12} /> Connecting to TeleFlock…
      </div>
    );
  }
  if (!question) {
    return <p className="border-t border-line px-3 py-2.5 text-xs font-semibold text-mute-2">Nobody is waiting on you.</p>;
  }
  const total = snapshot.needs;
  return (
    <section data-status="needs-you" className="flex flex-col gap-2 border-t border-line bg-white/[0.02] px-3 py-2.5" aria-label="Next question">
      <div className="flex min-w-0 items-center gap-2 text-2xs font-bold">
        <span className="size-2 shrink-0 rounded-full st-fill" aria-hidden />
        <span className="st-text uppercase tracking-[0.06em]">{question.word}</span>
        <span className="truncate text-ink-2">{question.agent}</span>
        <span className="truncate font-semibold text-mute-2">· {question.where}</span>
        <span className="ml-auto shrink-0 font-semibold text-mute-2 tabular">
          {index + 1} of {total}
        </span>
      </div>
      <p className="line-clamp-3 text-[13px] leading-snug font-semibold text-ink">{question.question || question.title}</p>
      {question.command && <pre className="line-clamp-2 rounded-xs bg-well px-2 py-1 font-mono text-2xs whitespace-pre-wrap text-ink-2">{question.command}</pre>}
      {question.quick ? (
        <div className="flex flex-wrap gap-1.5">
          {question.options.slice(0, 9).map((o, i) => (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              onClick={() => onAnswer(question, o)}
              className={cn(
                "pressable focus-ring flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold shadow-hairline disabled:opacity-50",
                o.tone === "danger" ? "bg-error/12 text-error hover:bg-error/20" : o.tone === "primary" || o.recommended ? "bg-accent/18 text-accent-ink hover:bg-accent/28" : "bg-white/[0.05] text-ink-2 hover:bg-white/[0.09]",
              )}
            >
              <Kbd className="h-4 min-w-4 px-1">{i + 1}</Kbd>
              <span className="truncate">{o.label}</span>
              {o.recommended && <Star className="size-3 shrink-0 fill-current" aria-label="recommended" />}
            </button>
          ))}
          {question.options.length > 9 && (
            <Button size="sm" variant="ghost" onClick={() => onOpen(question)}>
              +{question.options.length - 9} more
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold text-mute">{question.why}</span>
          <Button size="sm" variant="secondary" onClick={() => onOpen(question)} disabled={busy}>
            Answer in TeleFlock
          </Button>
        </div>
      )}
      {question.quick && (
        <p className="text-2xs font-semibold text-mute-2">
          {empty ? (
            <>
              <Kbd>1</Kbd>–<Kbd>{Math.min(9, question.options.length)}</Kbd> answer
            </>
          ) : (
            <>
              <Kbd>Alt</Kbd> + <Kbd>1</Kbd>–<Kbd>{Math.min(9, question.options.length)}</Kbd> answer
            </>
          )}
          {total > 1 && empty && (
            <>
              {" · "}
              <Kbd>Tab</Kbd> next question
            </>
          )}
        </p>
      )}
    </section>
  );
}
