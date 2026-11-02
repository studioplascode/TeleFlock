import { type CoreClient, core, drafts, navigate, parseAgentKey } from "@/core";
import { attachImages } from "@/core/clipboardImages";
import { attachVideoSource, hydrateDraftVideos, type VideoSource } from "@/core/draftVideos";
import type { RecordingDetail, RecordingInfo } from "@/core/gen";
import { type UploadedFile, type UploadOptions, type UploadSource, uploadFile } from "@/core/upload";
import { toast } from "@/design";
import { openPrefilledTask } from "@/features/capture/prefill";
import { imageFilesOf, mergeDraftText, type TaskImage, type TaskVideo } from "@/features/capture/task";
import { composerDraftKey, useSessionUi } from "@/features/session/state";
import type { RecEvent } from "./model";
import { docOf, fileStem, INLINE_SHOTS, inlineTimeline, MAX_SHOT_FILES, pickShots, recordingRef, spokenText, taskText, voiceNote } from "./prompt";
import { closeReview } from "./store";
import { buildTimeline, type RecordingDoc, type Spoken, type Timeline, timelineJson, timelineMarkdown } from "./timeline";

/** What sending reads and writes through: the app core and the host's uploads (tests pass fakes). */
export interface RecordingIo {
  app: CoreClient["app"];
  upload(hostId: string, file: UploadSource | File, opts: UploadOptions): Promise<UploadedFile>;
  cancel(hostId: string, uploadId: string): Promise<unknown>;
}

const realIo: RecordingIo = {
  app: (method, params) => core.app(method, params),
  upload: uploadFile,
  cancel: (hostId, uploadId) => core.host(hostId).call("upload.cancel", { uploadId }),
};

/*
 * Sending a recording to an agent: a new task in Dispatch or a prompt to an existing session, both
 * through the composer, so the user sees the task text before it goes. The recording attaches as a
 * draft video with a source (`attachVideoSource`): nothing leaves the device until the prompt is
 * sent; then its files go to the agent's host (`upload.*`): the video with the review's cuts
 * applied, the screenshots, and the timeline written with their paths on that host. A few
 * screenshots also go as images in the prompt.
 */

/** What a send reads of a recording, with the review's edits applied. */
export interface Prepared {
  info: RecordingInfo;
  detail: RecordingDetail;
  events: RecEvent[];
  spoken: Spoken[];
  doc: RecordingDoc;
  timeline: Timeline;
  /** Screenshots uploaded as files, and the ones also attached as images. */
  shotFiles: string[];
  inlineShots: string[];
  /** The task text: as edited in review, else Rambler's rewrite when chosen, else what was said. */
  task: string;
  /** Why there is no transcript, when there is none. */
  voiceNote?: string;
}

/** Reads a recording and applies its review edits. */
export async function prepare(id: string, io: RecordingIo = realIo): Promise<Prepared> {
  const detail = await io.app("recording.get", { id });
  const info = detail.info;
  const doc = docOf(info);
  const events = detail.events as RecEvent[];
  const spoken: Spoken[] = info.transcript.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text }));
  const timeline = buildTimeline({ events, spoken, duration: info.durationMs, doc });
  const stored = new Set(detail.shots.map((s) => s.name));
  const kept = { ...timeline, shots: timeline.shots.filter((s) => stored.has(s.name)) };
  const shotFiles = pickShots(kept, MAX_SHOT_FILES);
  const inlineShots = pickShots({ ...kept, shots: kept.shots.filter((s) => shotFiles.includes(s.name)) }, INLINE_SHOTS);
  const note = voiceNote(info);
  return { info, detail, events, spoken, doc, timeline, shotFiles, inlineShots, task: taskText(doc, spokenText(spoken, timeline)), ...(note ? { voiceNote: note } : {}) };
}

/**
 * A file the app core keeps for recording `id`, uploaded without loading it into the page. A
 * file whose size changed meanwhile fails the upload rather than sending parts of two files.
 */
function coreFile(io: RecordingIo, id: string, file: string, name: string, size: number, type: string): UploadSource {
  return {
    name,
    size,
    type,
    readBase64: async (start, end) => {
      const r = await io.app("recording.read", { id, file, offset: start, length: end - start });
      if (r.size !== size) throw new Error(`The recording changed while it was sent (${file}: ${r.size} bytes, not ${size}); send it again`);
      return r.data;
    },
  };
}

/** The size the chip shows before the upload knows better: video and screenshots. */
export function estimateSize(p: Pick<Prepared, "info" | "detail" | "shotFiles">): number {
  const shots = p.detail.shots.filter((s) => p.shotFiles.includes(s.name)).reduce((n, s) => n + s.size, 0);
  return (p.info.videoBytes ?? 0) + shots + 64 * 1024;
}

/** The render's own timeline files (names relative to the recording's folder). */
function localFiles(p: Prepared, video: string | undefined): { name: string; text: string }[] {
  const meta = { title: p.info.title, createdAt: p.info.createdAt, ...(p.voiceNote ? { voiceNote: p.voiceNote } : {}), ...(video ? { video: { ref: video, ...(p.info.width ? { width: p.info.width, height: p.info.height ?? 0 } : {}) } } : {}), shotRef: (n: string) => `shots/${n}`, jsonRef: "timeline.json" };
  return [
    { name: "timeline.md", text: timelineMarkdown(p.timeline, meta) },
    { name: "timeline.json", text: timelineJson(p.timeline, meta, p.events, p.spoken) },
  ];
}

/**
 * Uploads recording `id` to `hostId`: the video (cuts applied), the chosen screenshots, then the
 * timeline naming them by their paths there. Aborted or failed: what went up is dropped again.
 * The render is this upload's own (another host may be sent the recording meanwhile); it is
 * released when the upload ends, however it ends.
 */
export async function uploadRecording(id: string, hostId: string, opts: UploadOptions, io: RecordingIo = realIo): Promise<UploadedFile & { ref: string; extra: string[] }> {
  const p = await prepare(id, io);
  if (p.info.state !== "ready") throw new Error(p.info.state === "failed" ? (p.info.message ?? "The recording failed") : "The recording is still being saved");
  const cuts = p.timeline.removed.map((c) => ({ startMs: c.start, endMs: c.end }));
  const bundle = await io.app("recording.render", { id, cuts, files: localFiles(p, p.info.video ? "recording.mov" : undefined) });
  const stem = fileStem(p.info.title, id);
  const shotSizes = new Map(p.detail.shots.map((s) => [s.name, s.size]));
  const total = (bundle.video?.size ?? 0) + p.shotFiles.reduce((n, s) => n + (shotSizes.get(s) ?? 0), 0) + 64 * 1024;
  const done: UploadedFile[] = [];
  let before = 0;
  const step = (): UploadOptions => ({ ...(opts.signal ? { signal: opts.signal } : {}), onProgress: (sent) => opts.onProgress?.(Math.min(total, before + sent), total) });
  const put = async (src: UploadSource | File): Promise<UploadedFile> => {
    const up = await io.upload(hostId, src, step());
    done.push(up);
    before += up.size;
    return up;
  };
  try {
    const video = bundle.video ? await put(coreFile(io, id, bundle.video.file, `${stem}.mov`, bundle.video.size, "video/quicktime")) : undefined;
    const shotPaths = new Map<string, string>();
    for (const name of p.shotFiles) {
      const up = await put(coreFile(io, id, `shots/${name}`, `${stem}-${name}`, shotSizes.get(name) ?? 0, "image/jpeg"));
      shotPaths.set(name, up.path);
    }
    const shotRef = (n: string) => shotPaths.get(n) ?? `(not sent: ${n})`;
    const jsonName = `${stem}-timeline.json`;
    const meta = { title: p.info.title, createdAt: p.info.createdAt, ...(p.voiceNote ? { voiceNote: p.voiceNote } : {}), ...(video ? { video: { ref: video.path, bytes: video.size, ...(p.info.width ? { width: p.info.width, height: p.info.height ?? 0 } : {}) } } : {}), shotRef };
    const json = await put(new File([timelineJson(p.timeline, meta, p.events, p.spoken)], jsonName, { type: "application/json" }));
    const md = await put(new File([timelineMarkdown(p.timeline, { ...meta, jsonRef: json.path })], `${stem}-timeline.md`, { type: "text/markdown" }));
    const ref = recordingRef({
      title: p.info.title,
      duration: p.timeline.duration,
      timeline: md.path,
      json: json.path,
      ...(video ? { video: { path: video.path, bytes: video.size } } : {}),
      shotFiles: shotPaths.size,
      shotImages: p.inlineShots.length,
      inline: inlineTimeline(p.timeline, shotRef),
      ...(p.voiceNote ? { voiceNote: p.voiceNote } : {}),
    });
    opts.onProgress?.(before, before);
    return { path: md.path, size: before, sha256: md.sha256, uploadId: md.uploadId, ref, extra: done.filter((u) => u !== md).map((u) => u.uploadId) };
  } catch (e) {
    for (const u of done) void io.cancel(hostId, u.uploadId).catch(() => undefined);
    throw e;
  } finally {
    if (bundle.dir) void io.app("recording.release", { id, dir: bundle.dir }).catch(() => undefined);
  }
}

/** The draft video a recording attaches as. */
export function recordingSource(id: string): VideoSource {
  return { upload: (hostId, opts) => uploadRecording(id, hostId, opts) };
}

/** The screenshots that go as images in the prompt (each read whole; one over 1 MiB is left out). */
async function inlineImages(p: Prepared): Promise<TaskImage[]> {
  const out: TaskImage[] = [];
  for (const name of p.inlineShots) {
    const size = p.detail.shots.find((s) => s.name === name)?.size ?? 0;
    if (!size || size > 1024 * 1024) continue;
    const r = await core.app("recording.read", { id: p.info.id, file: `shots/${name}`, offset: 0, length: size });
    out.push({ mime: "image/jpeg", data: r.data, name });
  }
  return out;
}

function taskVideo(p: Prepared): TaskVideo {
  return { name: p.info.title, size: estimateSize(p), mime: "video/quicktime", kind: "recording", source: `recording:${p.info.id}`, video: recordingSource(p.info.id) };
}

/** "New task in Dispatch": the composer gets the task text, the recording and its key screenshots; the user picks where and sends. */
export async function newTaskInDispatch(id: string): Promise<void> {
  const p = await prepare(id);
  await openPrefilledTask({ text: p.task, images: await inlineImages(p), source: "recording", videos: [taskVideo(p)] });
  closeReview();
}

/** "Send to <agent>": the same into that agent's composer, focused, so one more press sends it. */
export async function sendToAgent(id: string, agentKey: string): Promise<void> {
  const p = await prepare(id);
  const key = composerDraftKey(agentKey);
  drafts.set(key, mergeDraftText(drafts.get(key), p.task));
  const images = await inlineImages(p);
  if (images.length) {
    const { skipped } = await attachImages(key, imageFilesOf(images));
    if (skipped) toast({ title: "Some screenshots were left out", description: skipped, status: "error" });
  }
  await hydrateDraftVideos(key);
  const v = taskVideo(p);
  const { skipped } = attachVideoSource(key, null, v, v.video);
  if (skipped) toast({ title: "The recording was left out", description: skipped, status: "error" });
  closeReview();
  const { hostId, agentId } = parseAgentKey(agentKey);
  navigate({ name: "agent", hostId, agentId });
  useSessionUi.getState().focusComposer(agentKey);
}
