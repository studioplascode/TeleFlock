import { Bug, Camera, Eye, EyeOff, Globe, Keyboard, MessageSquareText, MonitorPlay, MousePointerClick, Scissors, Send, Sparkles, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, toApiError, useCore, usePrefs } from "@/core";
import { suggestRamble } from "@/core/ai";
import type { RecordingDetail, RecordingInfo } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, cn, Dialog, DialogContent, Input, Spinner, Switch, Textarea, toast, Tooltip } from "@/design";
import { AgentPicker } from "@/features/capture/PrefillBanner";
import type { RecEvent } from "./model";
import { type Mark, Player } from "./Player";
import { docOf, spokenText, taskText, voiceNote } from "./prompt";
import { deleteRecording, recordingStateText } from "./RecordingsList";
import { newTaskInDispatch, sendToAgent } from "./send";
import { closeReview, useRecording } from "./store";
import { buildTimeline, type Cut, formatLength, formatTime, mapTime, type RecordingDoc, removedRanges, type Spoken, type TimelineEntry } from "./timeline";

/*
 * After Stop: watch the recording back, trim its start and end, remove parts (something private on
 * screen or said), drop lines from the timeline, read the transcript, let Rambler tidy it into the
 * task, then send it: a new Dispatch task, an existing agent, or keep it for later. Edits are saved
 * with the recording (`recording.update`), so a recording kept for later opens as it was left.
 */

const RAMBLE_ABOUT = "A screen recording of a problem in a web app: the user narrates while clicking through it, for a coding agent to fix";

function entryIcon(kind: TimelineEntry["kind"], level?: string): ReactNode {
  if (level === "error" || level === "warning") return <Bug className={level === "error" ? "text-error" : "text-review"} />;
  switch (kind) {
    case "speech":
      return <MessageSquareText className="text-accent-hi" />;
    case "click":
      return <MousePointerClick />;
    case "type":
    case "key":
      return <Keyboard />;
    case "navigate":
    case "tab":
    case "ui":
      return <Globe />;
    case "shot":
      return <Camera />;
    case "watch":
      return <Eye />;
    default:
      return <MonitorPlay />;
  }
}

/** The first online host, to ask Rambler. */
function useAnyOnlineHost(): string | undefined {
  return useCore((s) => s.profiles.find((p) => s.status[p.id]?.phase === "online")?.id);
}

export function ReviewSheet({ id }: { id: string }) {
  const info = useRecording(id);
  return (
    <Dialog open onOpenChange={(o) => !o && closeReview()}>
      <DialogContent width={1180} icon={<MonitorPlay />} title="Review the recording" description={info ? `${formatLength(info.durationMs)} · ${formatBytes(info.bytes)} · ${recordingStateText(info)}` : "Loading…"} className="h-[min(860px,calc(100dvh-48px))]">
        {info ? <Review info={info} /> : <p className="text-sm text-mute">This recording is gone.</p>}
      </DialogContent>
    </Dialog>
  );
}

function Review({ info }: { info: RecordingInfo }) {
  const id = info.id;
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [doc, setDoc] = useState<RecordingDoc>(() => docOf(info));
  const [title, setTitle] = useState(info.title);
  const [pos, setPos] = useState(0);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [skipWait, setSkipWait] = useState(false);
  const ready = info.state === "ready";

  // The log, frames and screenshots: again once saving is done (the frames then come from the video file).
  useEffect(() => {
    let live = true;
    core
      .app("recording.get", { id })
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => toast({ title: "Couldn't open the recording", description: toApiError(e).message, status: "error" }));
    return () => {
      live = false;
    };
  }, [id, ready]);

  // The title from the core until edited here (it names itself after the first page once saved).
  const titleEdited = useRef(false);
  useEffect(() => {
    if (!titleEdited.current) setTitle(info.title);
  }, [info.title]);

  // Edits are saved a moment after the last one.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = setTimeout(() => {
      void core.app("recording.update", { id, doc, ...(titleEdited.current && title.trim() ? { title: title.trim() } : {}) }).catch((e: unknown) => console.warn("[recording] save", e));
    }, 500);
    return () => clearTimeout(t);
  }, [doc, title, id]);

  const events = useMemo(() => (detail?.events ?? []) as RecEvent[], [detail]);
  const spoken: Spoken[] = useMemo(() => info.transcript.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })), [info.transcript.segments]);
  const duration = info.durationMs;
  const removed = useMemo(() => removedRanges(doc, duration), [doc, duration]);
  // Everything, for the list (removed and hidden lines show dimmed, to bring back).
  const all = useMemo(() => buildTimeline({ events, spoken, duration, doc: { v: 1 } }), [events, spoken, duration]);
  const sent = useMemo(() => buildTimeline({ events, spoken, duration, doc }), [events, spoken, duration, doc]);
  const marks: Mark[] = useMemo(
    () =>
      all.entries.flatMap((e): Mark[] => {
        if (e.kind === "speech") return [{ t: e.t, end: spoken[e.index]?.endMs ?? e.t, kind: "speech" }];
        if (e.level) return [{ t: e.t, kind: e.level }];
        if (e.kind === "click") return [{ t: e.t, kind: "click" }];
        if (e.kind === "navigate" && !e.text.startsWith("page address")) return [{ t: e.t, kind: "page" }];
        return [];
      }),
    [all, spoken],
  );

  const spokenAll = spokenText(spoken, sent);
  const note = voiceNote(info);
  const transcribing = info.transcript.state === "waiting" || info.transcript.state === "running";
  const task = doc.task ?? taskText({ ...doc, task: undefined }, spokenAll);

  // Rambler: once per transcript when it is on (Settings → Dictation), and on request.
  const rambler = usePrefs((s) => s.rambler);
  const role = usePrefs((s) => s.ramblerRole);
  const host = useAnyOnlineHost();
  const [tidying, setTidying] = useState(false);
  const [tidyError, setTidyError] = useState<string | null>(null);
  const tidy = useCallback(async () => {
    if (!host || !spokenAll.trim()) return;
    setTidying(true);
    setTidyError(null);
    const out = await suggestRamble(host, { transcript: spokenAll, about: RAMBLE_ABOUT }, { role });
    setTidying(false);
    if (out.ok) setDoc((d) => ({ ...d, cleaned: out.value, useCleaned: true }));
    else setTidyError(out.failure.message);
  }, [host, spokenAll, role]);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !rambler || doc.cleaned || !host || info.transcript.state !== "done" || !spokenAll.trim()) return;
    asked.current = true;
    void tidy();
  }, [rambler, doc.cleaned, host, info.transcript.state, spokenAll, tidy]);

  const hidden = new Set(doc.hidden ?? []);
  const hiddenSpeech = new Set(doc.hiddenSpeech ?? []);
  const toggleHidden = (e: TimelineEntry) =>
    setDoc((d) => {
      const key = e.kind === "speech" ? "hiddenSpeech" : "hidden";
      const cur = new Set(d[key] ?? []);
      if (cur.has(e.index)) cur.delete(e.index);
      else cur.add(e.index);
      return { ...d, [key]: [...cur].sort((a, b) => a - b) };
    });
  const addCut = (c: Cut) => setDoc((d) => ({ ...d, cuts: [...(d.cuts ?? []), c] }));
  const dropCut = (c: Cut) => setDoc((d) => ({ ...d, cuts: (d.cuts ?? []).filter((x) => !(x.start === c.start && x.end === c.end)) }));

  const canSend = ready && (!transcribing || skipWait) && !sending;
  const run = async (what: () => Promise<void>) => {
    setSending(true);
    try {
      await core.app("recording.update", { id, doc, ...(title.trim() ? { title: title.trim() } : {}) });
      await what();
    } catch (e) {
      const err = toApiError(e);
      toast({ title: "Couldn't send the recording", description: err.message, status: "error" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <Input
            aria-label="Title"
            value={title}
            onChange={(e) => {
              titleEdited.current = true;
              setTitle(e.target.value);
            }}
          />
          <Player info={info} frames={detail?.frames ?? []} removed={removed} marks={marks} pos={pos} onPos={setPos} markIn={markIn} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setDoc((d) => ({ ...d, trim: { ...(d.trim ?? {}), start: Math.round(pos) } }))}>
              Start here
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDoc((d) => ({ ...d, trim: { start: d.trim?.start ?? 0, end: Math.round(pos) } }))}>
              End here
            </Button>
            {doc.trim && (
              <Button size="sm" variant="ghost" onClick={() => setDoc(({ trim: _, ...d }) => d)}>
                Undo trim
              </Button>
            )}
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            {markIn === null ? (
              <Tooltip content="Mark where a part to leave out starts, then go to where it ends">
                <Button size="sm" variant="secondary" icon={<Scissors />} onClick={() => setMarkIn(Math.round(pos))}>
                  Remove a part…
                </Button>
              </Tooltip>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Scissors />}
                  disabled={Math.abs(pos - markIn) < 100}
                  onClick={() => {
                    addCut({ start: Math.round(Math.min(markIn, pos)), end: Math.round(Math.max(markIn, pos)) });
                    setMarkIn(null);
                  }}
                >
                  Remove {formatTime(Math.min(markIn, pos))}–{formatTime(Math.max(markIn, pos))}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMarkIn(null)}>
                  Cancel
                </Button>
              </>
            )}
          </div>
          {!!doc.cuts?.length && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Removed parts">
              {doc.cuts.map((c) => (
                <li key={`${c.start}-${c.end}`} className="flex items-center gap-1 rounded-full bg-error/12 py-0.5 pr-0.5 pl-2.5 text-[11.5px] font-bold text-error tabular-nums">
                  removed {formatTime(c.start)}–{formatTime(c.end)}
                  <button type="button" aria-label={`Bring back ${formatTime(c.start)}–${formatTime(c.end)}`} onClick={() => dropCut(c)} className="focus-ring grid size-5 place-items-center rounded-full hover:bg-error/15">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11.5px] text-mute">
            Sent: {formatLength(sent.duration)} of video, {sent.entries.filter((e) => e.kind !== "shot").length} timeline lines, {sent.errors.length} {sent.errors.length === 1 ? "error" : "errors"}. Removed parts and hidden lines are not sent. Typing into password and card fields is never recorded.
          </p>
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <section aria-label="Timeline" className="flex min-h-0 flex-1 flex-col rounded-[12px] bg-tile-3 shadow-hairline">
            <h3 className="px-3 pt-2.5 pb-1.5 text-[12px] font-bold text-ink-2">Timeline</h3>
            <ol className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
              {!detail && (
                <li className="p-2 text-sm text-mute">
                  <Spinner className="mr-1.5 inline size-3.5" />
                  Loading…
                </li>
              )}
              {all.entries.map((e) => {
                const off = (e.kind === "speech" ? hiddenSpeech : hidden).has(e.index) || mapTime(e.kind === "speech" ? (e.t + (spoken[e.index]?.endMs ?? e.t)) / 2 : e.t, removed) === null;
                const near = Math.abs(e.t - pos) < 600;
                return (
                  <li key={`${e.kind}${e.index}`} className={cn("group flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px] leading-snug", near && "bg-ink/6", off && "opacity-45")}>
                    <button type="button" onClick={() => setPos(e.t)} className="focus-ring flex min-w-0 flex-1 items-start gap-2 rounded text-left">
                      <span className="mt-px w-[46px] shrink-0 font-bold text-mute tabular-nums">{formatTime(e.t)}</span>
                      <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{entryIcon(e.kind, e.level)}</span>
                      <span className={cn("min-w-0 break-words", e.kind === "speech" && "text-ink", e.level === "error" && "text-error", off && "line-through")}>{e.text}</span>
                    </button>
                    {e.kind !== "shot" && (
                      <button type="button" aria-label={off ? "Send this line" : "Don't send this line"} onClick={() => toggleHidden(e)} className="focus-ring grid size-5 shrink-0 place-items-center rounded text-mute opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink [&_svg]:size-3.5">
                        {off ? <Eye /> : <EyeOff />}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-label="Task" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[12px] font-bold text-ink-2">Task for the agent</h3>
              {spokenAll.trim() && (
                <label className="flex items-center gap-2 text-[11.5px] font-semibold text-ink-2">
                  {tidying ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5 text-accent-hi" />}
                  Clean up with Rambler
                  <Switch
                    label="Clean up with Rambler"
                    checked={!!doc.useCleaned}
                    disabled={!host || tidying}
                    onCheckedChange={(on) => {
                      setDoc((d) => ({ ...d, useCleaned: on, task: undefined }));
                      if (on && !doc.cleaned) void tidy();
                    }}
                  />
                </label>
              )}
            </div>
            {transcribing ? (
              <p className="flex items-center gap-2 text-[12px] text-mute">
                <Spinner className="size-3.5" />
                Transcribing what you said on this device{info.transcript.progress ? ` (${Math.round(info.transcript.progress * 100)}%)` : ""}…
                {!skipWait && (
                  <button type="button" className="font-bold text-accent-hi hover:underline" onClick={() => setSkipWait(true)}>
                    Send without waiting
                  </button>
                )}
              </p>
            ) : (
              note && <p className="text-[12px] text-mute">No transcript: {note}.</p>
            )}
            {tidyError && <p className="text-[12px] text-error">Rambler: {tidyError}. The task uses what you said.</p>}
            <Textarea aria-label="Task for the agent" value={task} maxHeight={150} onChange={(e) => setDoc((d) => ({ ...d, task: e.target.value }))} />
            {doc.task !== undefined && (
              <button type="button" className="self-start text-[11.5px] font-bold text-accent-hi hover:underline" onClick={() => setDoc(({ task: _, ...d }) => d)}>
                Use {doc.useCleaned && doc.cleaned ? "Rambler's version" : "what you said"} again
              </button>
            )}
          </section>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button
          variant="ghost"
          icon={<Trash2 />}
          onClick={() => void deleteRecording({ id, title: title || info.title }, closeReview)}
        >
          Delete
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => closeReview()}>
          Save for later
        </Button>
        <Button variant="secondary" icon={<Send />} disabled={!canSend} onClick={() => setPicking(true)}>
          Send to agent…
        </Button>
        <Button variant="primary" loading={sending} disabled={!canSend} onClick={() => void run(() => newTaskInDispatch(id))}>
          New task in Dispatch
        </Button>
      </div>
      {picking && <AgentPicker repo={null} placeholder="Send the recording to which agent?" onClose={() => setPicking(false)} onPick={(key) => void run(() => sendToAgent(id, key))} />}
    </div>
  );
}
