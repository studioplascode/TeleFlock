import { create } from "zustand";
import { core, toApiError } from "@/core";
import type { RecordingFrame, RecordingShot, RecordingVoice } from "@/core/gen";
import { toast } from "@/design";
import { type BrowserEvent, type BrowserFrame, captureTab, measureElements, observeBrowser } from "@/features/browser/observe";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { CLICK_RING_MS, Compositor, decodeJpeg, type Mask, type Overlay } from "./compose";
import { EventLog, recordingTime, type RecEvent, type ShotReason } from "./model";
import { openReview, startRecordings, useRecordings } from "./store";
import { formatTime } from "./timeline";

/*
 * The recorder: Record in the browser panel starts a recording in the app core (which captures the
 * microphone), then everything the panel reports of the user's own tabs goes into it: screencast
 * frames drawn into the video's pictures (≤ 10 a second, `compose.ts`), screenshots at the start,
 * at clicks, after pages load, at errors and at the end, and the event log (`model.ts`). It all goes
 * to the app core in batches twice a second; nothing leaves the device. Pause leaves time out of the
 * recording (and of the microphone); Stop saves it and opens the review sheet.
 */

export type RecorderPhase = "idle" | "starting" | "recording" | "paused" | "stopping";

export interface RecorderState {
  phase: RecorderPhase;
  id: string | null;
  /** Epoch ms Record took effect: t = 0 of the recording. */
  startedAt: number;
  /** Closed pauses, epoch ms. */
  pauses: [number, number][];
  pausedAt: number | null;
  voice: RecordingVoice | null;
  /** The agent whose tab is shown (its tabs are not recorded), if any. */
  watching: string | null;
}

const IDLE: RecorderState = { phase: "idle", id: null, startedAt: 0, pauses: [], pausedAt: null, voice: null, watching: null };

export const useRecorder = create<RecorderState>(() => IDLE);

/** Recording time at `now`, pauses left out. */
export function elapsedOf(s: RecorderState, now = Date.now()): number {
  return s.phase === "idle" || s.phase === "starting" ? 0 : recordingTime(now, s.startedAt, s.pauses, s.pausedAt);
}

/** Video pictures at most this often (the video's 10 fps). */
const FRAME_MS = 100;
/** Batches go to the app core this often. */
const BATCH_MS = 500;
const FRAME_QUALITY = 0.72;
const SHOT_QUALITY = 0.85;
/** Screenshots per recording at most. */
export const MAX_SHOTS = 60;
/** A page's screenshot waits this long after its navigation (it has rendered by then, mostly). */
const PAGE_SHOT_DELAY = 800;
/** An error's screenshot waits this long (to show what the page made of it). */
const ERROR_SHOT_DELAY = 400;
/** Error screenshots at most this often. */
const ERROR_SHOT_GAP = 4000;
/** Without a frame by then, a pending screenshot uses the last picture. */
const SHOT_DEADLINE = 2500;
/** A picture waits this long for its covered fields to be measured again, else covers them where they were last. */
const MEASURE_MS = 300;

interface PendingShot {
  reason: "page" | "error";
  /** The frame to wait for: one at or after this epoch time. */
  after: number;
  deadline: number;
}

interface Session {
  id: string;
  log: EventLog;
  compositor: Compositor | null;
  /** The newest frame of the shown tab (null while an agent's tab is shown). */
  latest: BrowserFrame | null;
  /** The picture last drawn from, with the covers it was drawn with, for redraws (click rings) and screenshots. */
  drawn: { frame: BrowserFrame; img: HTMLImageElement; masks: Mask[] } | null;
  dirty: boolean;
  /** A picture is being drawn (ticks wait for it rather than queue more). */
  composing: boolean;
  placeholder: string | null;
  frames: RecordingFrame[];
  shots: RecordingShot[];
  shotCount: number;
  lastErrorShot: number;
  pending: PendingShot | null;
  /** Canvas work, one at a time. */
  chain: Promise<void>;
  sending: Promise<void> | null;
  off: () => void;
  timers: ReturnType<typeof setInterval>[];
  stopping: boolean;
  /** The page shown when recording started (names the recording). */
  startPage: { url: string; title?: string } | null;
}

let session: Session | null = null;

function clock(at: number): number {
  const s = useRecorder.getState();
  return recordingTime(at, s.startedAt, s.pauses, s.pausedAt);
}

function shotName(n: number, t: number, reason: ShotReason): string {
  const total = Math.floor(t / 1000);
  return `${String(n).padStart(3, "0")}-${String(Math.floor(total / 60)).padStart(2, "0")}m${String(total % 60).padStart(2, "0")}s-${reason}.jpg`;
}

function overlayAt(s: Session, t: number, tab: string, masks: Mask[], outline?: Mask): Overlay {
  const page = s.log.current;
  const click = s.log.lastClickMark;
  return {
    ...(page?.url ? { url: page.url } : {}),
    ...(page?.title ? { title: page.title } : {}),
    clicks: click && click.tab === tab && t - click.t <= CLICK_RING_MS && t >= click.t ? [{ x: click.x, y: click.y, age: t - click.t }] : [],
    masks,
    ...(outline ? { outline } : {}),
  };
}

/** The fields to cover in a picture of `tab` (`EventLog.covers`), measured again first: they may have moved, gone or come back. */
async function masksFor(s: Session, tab: string): Promise<Mask[]> {
  const refs = s.log.coverRefs(tab);
  if (refs.length) {
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const late = new Promise<null>((resolve) => setTimeout(resolve, MEASURE_MS, null));
    const m = await Promise.race([measureElements(tab, refs), late]);
    if (m) s.log.measured(tab, refs, m);
  }
  return s.log.covers(tab);
}

/** Queue canvas work behind what runs (frames and screenshots share one canvas). */
function onCanvas(s: Session, work: () => Promise<void>): Promise<void> {
  s.chain = s.chain.then(work).catch((e: unknown) => console.warn("[recording] frame failed", e));
  return s.chain;
}

/** Draw the newest picture (a new frame, or the last one again for a click's ring) into the video. */
function composeFrame(s: Session): Promise<void> {
  s.dirty = false;
  s.composing = true;
  const done = onCanvas(s, async () => {
    if (session !== s || useRecorder.getState().phase !== "recording") return;
    const now = Date.now();
    if (s.placeholder) {
      if (!s.compositor) return;
      const page = s.log.current;
      s.compositor.drawPlaceholder(`Watching the tab of ${s.placeholder}`, "An agent's tab: not recorded", { ...(page?.url ? { url: page.url } : {}), ...(page?.title ? { title: page.title } : {}) });
      s.frames.push({ t: clock(now), data: await s.compositor.jpeg(FRAME_QUALITY), width: s.compositor.width, height: s.compositor.height });
      return;
    }
    const f = s.latest;
    if (!f) return;
    const fresh = s.drawn?.frame !== f;
    const img = fresh ? await decodeJpeg(f.data) : s.drawn?.img;
    if (!img) return;
    s.compositor ??= new Compositor(f.width, f.height);
    const masks = await masksFor(s, f.tabId);
    const t = clock(fresh ? Math.min(f.at, now) : now);
    s.compositor.draw(img, f, overlayAt(s, t, f.tabId, masks));
    s.drawn = { frame: f, img, masks };
    s.frames.push({ t, data: await s.compositor.jpeg(FRAME_QUALITY), width: s.compositor.width, height: s.compositor.height });
    if (s.shotCount === 0) await shoot(s, "start");
    const p = s.pending;
    if (p && (f.at >= p.after || now >= p.deadline)) {
      s.pending = null;
      await shoot(s, p.reason);
    }
  });
  return done.finally(() => {
    s.composing = false;
  });
}

/**
 * A screenshot of the last picture with the covers it was drawn with (input since may have moved
 * the focus on), the click's ring and the clicked element outlined; logged where it was taken.
 */
async function shoot(s: Session, reason: ShotReason, outline?: Mask): Promise<void> {
  const d = s.drawn;
  if (!d || !s.compositor || s.shotCount >= MAX_SHOTS) return;
  const t = clock(Date.now());
  s.compositor.draw(d.img, d.frame, overlayAt(s, Math.max(t, s.log.lastClickMark?.t ?? 0), d.frame.tabId, d.masks, outline));
  const name = shotName(++s.shotCount, t, reason);
  s.shots.push({ name, data: await s.compositor.jpeg(SHOT_QUALITY) });
  s.log.mark({ t, tab: d.frame.tabId, kind: "shot", name, reason });
}

function onFrame(s: Session, f: BrowserFrame): void {
  if (useRecorder.getState().phase !== "recording") return;
  s.log.noteOwner(f.tabId, f.owner);
  if (f.owner?.kind === "agent") return;
  if (s.log.current && s.log.current.tab !== f.tabId) return;
  s.latest = f;
  s.dirty = true;
}

function onEvent(s: Session, e: BrowserEvent): void {
  const phase = useRecorder.getState().phase;
  if (phase === "paused") return s.log.notePaused(e);
  if (phase !== "recording") return;
  s.log.add(e);
  const cur = s.log.current;
  if (!s.startPage && cur?.url && cur.recorded) s.startPage = { url: cur.url, ...(cur.title ? { title: cur.title } : {}) };
  else if (s.startPage && !s.startPage.title && cur?.recorded && cur.url === s.startPage.url && cur.title) s.startPage = { ...s.startPage, title: cur.title };
  const watching = cur && !cur.recorded ? (cur.agent ?? "an agent") : null;
  if (watching !== s.placeholder) {
    s.placeholder = watching;
    if (!watching && s.latest?.tabId !== cur?.tab) s.latest = null;
    useRecorder.setState({ watching });
    s.dirty = true;
  }
  if (watching || s.log.isAgentTab(e.tabId)) return;
  switch (e.type) {
    case "pointer":
      if (e.action !== "down") return;
      // The page as it was when clicked, ring and element marked; the ring then shows in the video for a moment.
      const at = e.element?.rect;
      void onCanvas(s, () => shoot(s, "click", at ? { rect: at, ...(e.element?.scroll ? { scroll: e.element.scroll } : {}) } : undefined));
      s.dirty = true;
      setTimeout(() => session === s && (s.dirty = true), CLICK_RING_MS / 2);
      setTimeout(() => session === s && (s.dirty = true), CLICK_RING_MS + 50);
      return;
    case "navigation":
      if (!e.sameDocument) s.pending = { reason: "page", after: e.at + PAGE_SHOT_DELAY, deadline: Date.now() + SHOT_DEADLINE };
      return;
    case "console":
    case "exception":
    case "requestFailed": {
      const severe = e.type === "exception" || (e.type === "console" && e.level === "error") || (e.type === "requestFailed" && (e.status === undefined || e.status >= 500) && !/ERR_ABORTED/i.test(e.error ?? ""));
      if (!severe || s.pending || Date.now() - s.lastErrorShot < ERROR_SHOT_GAP) return;
      s.lastErrorShot = Date.now();
      s.pending = { reason: "error", after: e.at + ERROR_SHOT_DELAY, deadline: Date.now() + SHOT_DEADLINE };
      return;
    }
    default:
      return;
  }
}

/**
 * What is final goes to the app core (all of it with `final`), one batch at a time. `always`: even
 * an empty one, whose answer says whether a limit stopped the recording.
 */
async function sendBatch(s: Session, final = false, always = false): Promise<void> {
  while (s.sending) await s.sending;
  const events: RecEvent[] = final ? s.log.take() : s.log.take(Date.now());
  if (!always && !events.length && !s.frames.length && !s.shots.length) return;
  const frames = s.frames.splice(0);
  const shots = s.shots.splice(0);
  const run = (async () => {
    try {
      const r = await core.app("recording.append", { id: s.id, frames, events, shots });
      if (r.stop && !s.stopping) {
        toast({ title: "Recording stopped", description: r.stop, status: "error" });
        void stopRecording();
      }
    } catch (e) {
      if (s.stopping) throw e;
      const err = toApiError(e);
      toast({ title: "Recording stopped", description: err.message, status: "error" });
      void stopRecording();
    }
  })();
  s.sending = run.finally(() => {
    s.sending = null;
  });
  await s.sending;
}

function tick(s: Session): void {
  const st = useRecorder.getState();
  if (st.phase !== "recording") return;
  const now = Date.now();
  if (s.pending && now >= s.pending.deadline) s.dirty = true;
  if (s.dirty && !s.composing) void composeFrame(s);
}

/** Start recording the user's tabs (and their voice unless `voice` is false). */
export async function startRecording(voice = true): Promise<void> {
  if (useRecorder.getState().phase !== "idle") return;
  useRecorder.setState({ ...IDLE, phase: "starting" });
  let info;
  try {
    info = await core.app("recording.start", { voice });
  } catch (e) {
    useRecorder.setState(IDLE);
    const err = toApiError(e);
    toast({ title: "Couldn't start recording", description: err.hint ? `${err.message} (${err.hint})` : err.message, status: "error" });
    return;
  }
  useRecorder.setState({ phase: "recording", id: info.id, startedAt: info.createdAt, voice: info.voice });
  const s: Session = {
    id: info.id,
    log: new EventLog({ clock }),
    compositor: null,
    latest: null,
    drawn: null,
    dirty: false,
    composing: false,
    placeholder: null,
    frames: [],
    shots: [],
    shotCount: 0,
    lastErrorShot: 0,
    pending: null,
    chain: Promise.resolve(),
    sending: null,
    off: () => undefined,
    timers: [],
    stopping: false,
    startPage: null,
  };
  session = s;
  const offBrowser = observeBrowser({ console: true, network: true, elements: true, frames: true, event: (e) => onEvent(s, e), frame: (f) => onFrame(s, f) });
  // The app core stops the recording at a limit by itself, also while a still page sends nothing
  // whose answer would say so: once the list shows it stopped, an append asks why, and Stop
  // finishes as for any limit.
  startRecordings();
  const unwatch = useRecordings.subscribe((st) => {
    const r = st.list?.recordings.find((x) => x.id === s.id);
    if (!r || r.state === "recording" || r.state === "paused") return;
    unwatch();
    if (session === s && !s.stopping) void sendBatch(s, false, true);
  });
  s.off = () => {
    offBrowser();
    unwatch();
  };
  s.timers.push(
    setInterval(() => tick(s), FRAME_MS),
    setInterval(() => {
      if (useRecorder.getState().phase === "recording") s.log.tick(Date.now());
      void sendBatch(s);
    }, BATCH_MS),
  );
  // A still page sends no screencast frame: a screenshot starts the video then.
  setTimeout(() => {
    if (session !== s || s.latest || s.placeholder) return;
    void captureTab(undefined, { format: "jpeg", quality: 80 }).then(async (shot) => {
      if (!shot || session !== s || s.latest) return;
      const img = await decodeJpeg(shot.data);
      const tab = s.log.current?.tab ?? "";
      s.latest = { at: shot.at, tabId: tab, data: shot.data, width: img.naturalWidth, height: img.naturalHeight, viewport: { width: img.naturalWidth, height: img.naturalHeight } };
      s.dirty = true;
    });
  }, 400);
}

export async function pauseRecording(): Promise<void> {
  const st = useRecorder.getState();
  const s = session;
  if (st.phase !== "recording" || !s) return;
  const now = Date.now();
  s.log.mark({ t: clock(now), kind: "pause" });
  useRecorder.setState({ phase: "paused", pausedAt: now });
  await core.app("recording.pause", { id: s.id }).catch((e: unknown) => console.warn("[recording] pause", e));
  void sendBatch(s);
}

export async function resumeRecording(): Promise<void> {
  const st = useRecorder.getState();
  const s = session;
  if (st.phase !== "paused" || !s || st.pausedAt === null) return;
  const now = Date.now();
  useRecorder.setState({ phase: "recording", pauses: [...st.pauses, [st.pausedAt, now]], pausedAt: null });
  await core.app("recording.resume", { id: s.id }).catch((e: unknown) => console.warn("[recording] resume", e));
  s.log.mark({ t: clock(Date.now()), kind: "resume" });
  s.dirty = true;
}

/** A name for a recording from the page it started on: `Shop · 14:03`. */
export function defaultTitle(page: { url: string; title?: string } | null, createdAt: number): string {
  let name = page?.title?.trim() ?? "";
  if (!name && page?.url) {
    try {
      name = new URL(page.url).host;
    } catch {
      name = "";
    }
  }
  const d = new Date(createdAt);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return name ? `${name.length > 60 ? `${name.slice(0, 59)}…` : name} · ${time}` : `Recording ${time}`;
}

/** Stop: what is pending is saved, the app core makes the video and the transcript, the review sheet opens. */
export async function stopRecording(): Promise<void> {
  const st = useRecorder.getState();
  const s = session;
  if ((st.phase !== "recording" && st.phase !== "paused") || !s || s.stopping) return;
  s.stopping = true;
  if (st.phase === "recording") {
    if (s.dirty) await composeFrame(s);
    await onCanvas(s, () => shoot(s, "end"));
  }
  useRecorder.setState({ phase: "stopping" });
  s.off();
  for (const t of s.timers) clearInterval(t);
  await s.chain;
  s.log.flush();
  if (s.log.errorsDropped) s.log.mark({ t: clock(Date.now()), kind: "note", text: `${s.log.errorsDropped} more errors were not logged` });
  try {
    await sendBatch(s, true);
  } catch (e) {
    console.warn("[recording] last batch", e);
  }
  try {
    const info = await core.app("recording.stop", { id: s.id });
    void core.app("recording.update", { id: s.id, title: defaultTitle(s.startPage, info.createdAt) }).catch(() => undefined);
    openReview(s.id);
  } catch (e) {
    const err = toApiError(e);
    toast({ title: "The recording couldn't be saved", description: err.message, status: "error" });
  } finally {
    session = null;
    useRecorder.setState(IDLE);
  }
}

/** Throw the recording away (nothing is kept) once the user agrees: what was recorded so far is lost. */
export async function discardRecording(): Promise<void> {
  const s = session;
  if (!s) return;
  if (!(await confirmAction({ title: "Discard this recording?", body: "What you have recorded so far is removed from this computer.", confirmLabel: "Discard", danger: true }))) return;
  // It went on while they decided: it may have been stopped (its review is open) meanwhile.
  if (session !== s || s.stopping) return;
  s.stopping = true;
  s.off();
  for (const t of s.timers) clearInterval(t);
  session = null;
  useRecorder.setState(IDLE);
  await core.app("recording.delete", { id: s.id }).catch((e: unknown) => console.warn("[recording] discard", e));
}

/** `00:12.3` of the recording now (the toolbar's clock). */
export function recordingClock(s: RecorderState, now = Date.now()): string {
  return formatTime(elapsedOf(s, now)).replace(/\.\d$/, "");
}
