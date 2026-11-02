import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isVideoFile } from "./clipboardImages";
import { core } from "./client";
import { setDraftWorkBusy, trackDraftWork } from "./draftFlush";
import { draftSlots, indexedDbSlots, type SlotBackend } from "./draftSlots";
import { apiError, toApiError } from "./errors";
import { formatBytes, MAX_UPLOAD_BYTES, type UploadedFile, type UploadOptions, uploadFile } from "./upload";

/*
 * Videos attached to a draft (the session composer, Dispatch). A video goes to the host as a file
 * (`upload.ts`) as soon as the host is known, shows as a chip with its progress, and reaches the
 * agent as one reference line per video in the prompt (`withVideoRefs`): the agent reads the file
 * from that host path with its own tools (omp's read shows a video as a preview grid, or one frame
 * with `:<frame>` / `:<time>`). Images stay inline (`clipboardImages.ts`). A TeleFlock Browser
 * recording attaches as a video with a source (`attachVideoSource`): it uploads its files itself
 * (video, timeline, screenshots) once its host is known and writes its own reference block.
 *
 * Kept in memory per draft key, and what a restart can keep is written through to IndexedDB
 * `tf.draftVideos`/`videos` (`StoredVideos`): an uploaded video comes back as it was (its file is on
 * the host), one cut off mid-upload comes back failed (the browser reads a picked file only while
 * the page that picked it lives). Switching agents or views keeps an upload going. One upload runs
 * at a time per host; the others wait their turn. While any runs, the desktop app's updater holds
 * an automatic restart (`setDraftWorkBusy`). Removing a chip drops its upload on the host, finished
 * or not (its prompt never went out); a sent video's file stays (the host prunes uploads after 30
 * days).
 */

/**
 * `pending`: no host yet (Dispatch Auto: the host the task goes to) → `queued` (another upload to the
 * same host goes first) → `uploading` → `done` (`path` set) or `failed` (`error`; retry starts over).
 */
export type VideoPhase = "pending" | "queued" | "uploading" | "done" | "failed";

export interface DraftVideo {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** The host it uploads to; null until known. */
  hostId: string | null;
  phase: VideoPhase;
  /** Bytes the host has. */
  sent: number;
  /** Absolute path on the host, once uploaded. */
  path?: string;
  /** The host's id of the finished upload (to drop it again). */
  uploadId?: string;
  error?: string;
  /** What it is when not a plain video file (a browser recording: its chip says so). */
  kind?: "recording";
  /** Where its bytes come from when not a picked file (`VideoSource`): `<kind>:<id>`, kept across a restart. */
  source?: string;
  /** Its own prompt text once uploaded (a recording names its timeline, video and screenshots). */
  ref?: string;
  /** More uploads on the host that go with it (dropped with it). */
  extra?: string[];
}

/** What the prompt says about a video. */
export interface VideoRef {
  name: string;
  size: number;
  path: string;
  /** The whole reference text, when the video made its own (`DraftVideo.ref`). */
  ref?: string;
}

/**
 * A draft video whose bytes are not a picked file but something the app keeps (a browser
 * recording): it uploads itself, possibly as several files, and says what the prompt carries.
 */
export interface VideoSource {
  upload(hostId: string, opts: UploadOptions): Promise<UploadedFile & { ref?: string; extra?: string[] }>;
}

/** Videos per prompt at most. */
export const MAX_DRAFT_VIDEOS = 4;

interface VideosState {
  videos: Record<string, DraftVideo>;
  /** Draft key → its videos' ids, in attach order. */
  drafts: Record<string, string[]>;
}

const useVideoStore = create<VideosState>()(() => ({ videos: {}, drafts: {} }));
const files = new Map<string, File>();
const sources = new Map<string, VideoSource>();
const aborts = new Map<string, AbortController>();
/** Source kind → how a stored source comes back after a restart (`registerVideoSource`). */
const resolvers = new Map<string, (id: string) => VideoSource | null>();
/** The last upload queued per host: the next one starts after it. */
const queues = new Map<string, Promise<void>>();
let seq = 0;
const NONE: DraftVideo[] = [];

/** How videos reach a host and are dropped there again: `upload.ts` and `upload.cancel`, unless a test swaps them. */
export interface VideoTransport {
  upload(hostId: string, file: File, opts: UploadOptions): Promise<UploadedFile>;
  cancel(hostId: string, uploadId: string): Promise<unknown>;
}

let transport: VideoTransport = {
  upload: uploadFile,
  cancel: (hostId, uploadId) => core.host(hostId).call("upload.cancel", { uploadId }),
};

/** Swaps the transport (tests); returns the previous one. */
export function setVideoTransport(next: VideoTransport): VideoTransport {
  const prev = transport;
  transport = next;
  return prev;
}

function patch(id: string, change: Partial<DraftVideo>): void {
  useVideoStore.setState((s) => {
    const cur = s.videos[id];
    return cur ? { videos: { ...s.videos, [id]: { ...cur, ...change } } } : s;
  });
}

function pick(s: VideosState, ids: readonly string[] | undefined): DraftVideo[] {
  return ids?.length ? ids.map((id) => s.videos[id]).filter((v): v is DraftVideo => !!v) : NONE;
}

/** A draft's video as stored: no file (a restart loses it, unless a `source` brings it back), the host path once uploaded. */
export type StoredVideo = Pick<DraftVideo, "id" | "name" | "size" | "mime" | "hostId" | "path" | "uploadId" | "kind" | "source" | "ref" | "extra">;

/** What is stored per draft key. */
export interface StoredVideos {
  videos: StoredVideo[];
  at: number;
}

export type DraftVideoBackend = SlotBackend<StoredVideos>;

const stored = draftSlots<StoredVideo[], StoredVideos>({
  backend: indexedDbSlots<StoredVideos>("tf.draftVideos", "videos", { maxStored: 40, maxAgeMs: 30 * 86_400_000 }),
  empty: [],
  isEmpty: (v) => v.length === 0,
  // Malformed entries (another format) are dropped.
  decode: (s) =>
    Array.isArray(s?.videos)
      ? s.videos.filter(
          (v) =>
            typeof v?.id === "string" &&
            typeof v.name === "string" &&
            typeof v.size === "number" &&
            (v.path === undefined || typeof v.path === "string") &&
            (v.source === undefined || typeof v.source === "string") &&
            (v.ref === undefined || typeof v.ref === "string") &&
            (v.extra === undefined || (Array.isArray(v.extra) && v.extra.every((x) => typeof x === "string"))),
        )
      : [],
  encode: (videos) => ({ videos, at: Date.now() }),
});

/** Swaps the storage (tests); returns the previous one. */
export function setDraftVideoBackend(next: DraftVideoBackend): DraftVideoBackend {
  return stored.setBackend(next);
}

/** Draft keys whose stored videos are back in the store. */
const restored = new Set<string>();

/**
 * Brings draft `key`'s stored videos back (once per key; resolves when they are in): an uploaded
 * one as it was, one a restart cut off as failed, unless its source can be read again (a
 * recording still on this device): that one waits for its host again. Videos the page holds
 * already are left alone.
 */
export async function hydrateDraftVideos(key: string): Promise<void> {
  await stored.hydrate(key);
  if (restored.has(key)) return;
  restored.add(key);
  const s = useVideoStore.getState();
  const back = stored.get(key).filter((v) => !s.videos[v.id]);
  if (!back.length) return;
  const videos = back.map((v): DraftVideo => {
    if (v.path) return { ...v, phase: "done", sent: v.size };
    const [kind = "", sourceId = ""] = v.source?.split(/:(.*)/s) ?? [];
    const source = v.source ? resolvers.get(kind)?.(sourceId) : null;
    if (!source) return { ...v, phase: "failed", sent: 0, error: "TeleFlock restarted before it was uploaded; attach it again" };
    sources.set(v.id, source);
    return { ...v, phase: "pending", sent: 0 };
  });
  useVideoStore.setState((st) => ({
    videos: { ...st.videos, ...Object.fromEntries(videos.map((v) => [v.id, v])) },
    drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), ...videos.map((v) => v.id)] },
  }));
  for (const v of videos) if (v.phase === "pending" && v.hostId) start(v.id);
}

/** What is stored of draft `key`'s videos changes only with the list and the uploads finishing. */
function storedSignature(s: VideosState, key: string): string {
  return pick(s, s.drafts[key])
    .map((v) => `${v.id}\u0000${v.path ?? ""}`)
    .join("\u0001");
}

useVideoStore.subscribe((s, prev) => {
  for (const key of new Set([...Object.keys(s.drafts), ...Object.keys(prev.drafts)])) {
    if (storedSignature(s, key) === storedSignature(prev, key)) continue;
    // Stored videos come back first: the list written must not drop them unseen.
    const write = hydrateDraftVideos(key).then(() => {
      const now = useVideoStore.getState();
      stored.update(key, () => pick(now, now.drafts[key]).map(({ id, name, size, mime, hostId, path, uploadId, kind, source, ref, extra }) => ({ id, name, size, mime, hostId, path, uploadId, kind, source, ref, extra })));
    });
    void trackDraftWork(write);
  }
  const uploading = (v: VideosState) => Object.values(v.videos).some((x) => x.phase === "queued" || x.phase === "uploading");
  if (uploading(s) !== uploading(prev)) setDraftWorkBusy("videos", uploading(s));
});

/** Queue `id`'s upload to its host, from the start. */
function start(id: string): void {
  const v = useVideoStore.getState().videos[id];
  const file = files.get(id);
  const source = sources.get(id);
  if (!v?.hostId) return;
  if (!file && !source) {
    patch(id, { phase: "failed", error: "The file can't be read any more; attach it again" });
    return;
  }
  aborts.get(id)?.abort();
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  patch(id, { phase: "queued", sent: 0, path: undefined, uploadId: undefined, error: undefined, ref: undefined, extra: undefined });
  const hostId = v.hostId;
  const run = async () => {
    if (ctrl.signal.aborted) return;
    patch(id, { phase: "uploading" });
    try {
      const opts: UploadOptions = { signal: ctrl.signal, mime: v.mime, onProgress: (sent) => ctrl.signal.aborted || patch(id, { sent }) };
      // A source drops what it uploaded itself when aborted; a file's upload is dropped by uploadFile.
      const done: UploadedFile & { ref?: string; extra?: string[] } = source ? await source.upload(hostId, opts) : await transport.upload(hostId, file as File, opts);
      if (!ctrl.signal.aborted) patch(id, { phase: "done", sent: done.size, size: done.size, path: done.path, uploadId: done.uploadId, ...(done.ref ? { ref: done.ref } : {}), ...(done.extra ? { extra: done.extra } : {}) });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const err = toApiError(e);
      patch(id, { phase: "failed", error: err.hint ? `${err.message} (${err.hint})` : err.message });
    } finally {
      if (aborts.get(id) === ctrl) aborts.delete(id);
    }
  };
  const next = (queues.get(hostId) ?? Promise.resolve()).then(run);
  queues.set(hostId, next);
  void next.then(() => queues.get(hostId) === next && queues.delete(hostId));
}

/** Stop `id`'s upload and drop it on the host (partial or finished, with the uploads that go with it). */
function dropOnHost(id: string): void {
  const ctrl = aborts.get(id);
  if (ctrl) {
    // uploadFile (or the source) drops it on the host once its request in flight is answered.
    ctrl.abort();
    aborts.delete(id);
    return;
  }
  const v = useVideoStore.getState().videos[id];
  if (!v?.hostId) return;
  for (const uploadId of [v.uploadId, ...(v.extra ?? [])]) if (uploadId) void transport.cancel(v.hostId, uploadId).catch(() => undefined);
}

/**
 * Attach the videos among `incoming` to draft `key`, uploading to `hostId` right away (null: once the
 * host is known, `uploadDraftVideos`). Returns how many were added and why others were left out.
 */
export function attachVideos(key: string, hostId: string | null, incoming: readonly File[]): { added: number; skipped?: string } {
  const s = useVideoStore.getState();
  const current = pick(s, s.drafts[key]);
  const known = new Set(current.map((v) => `${v.name}\u0000${v.size}`));
  const added: DraftVideo[] = [];
  let skipped: string | undefined;
  for (const f of incoming) {
    const id = `${f.name}\u0000${f.size}`;
    if (!isVideoFile(f) || known.has(id)) continue;
    if (f.size === 0) {
      skipped = `${f.name} is empty.`;
      continue;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      skipped = `${f.name} is ${formatBytes(f.size)}; videos go up to ${formatBytes(MAX_UPLOAD_BYTES)}.`;
      continue;
    }
    if (current.length + added.length >= MAX_DRAFT_VIDEOS) {
      skipped = `A prompt takes at most ${MAX_DRAFT_VIDEOS} videos.`;
      break;
    }
    known.add(id);
    const v: DraftVideo = { id: `v${Date.now().toString(36)}-${(seq++).toString(36)}`, name: f.name || "video", size: f.size, mime: f.type, hostId, phase: "pending", sent: 0 };
    files.set(v.id, f);
    added.push(v);
  }
  if (added.length) {
    useVideoStore.setState((st) => ({
      videos: { ...st.videos, ...Object.fromEntries(added.map((v) => [v.id, v])) },
      drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), ...added.map((v) => v.id)] },
    }));
    if (hostId) for (const v of added) start(v.id);
  }
  return skipped ? { added: added.length, skipped } : { added: added.length };
}

/**
 * Attach a video whose bytes come from `source` (a browser recording) to draft `key`. It uploads
 * when `hostId` is known (null: once the prompt goes out, through `uploadDraftVideos`), and comes
 * back after a restart while the source can be read again (`registerVideoSource` for its kind).
 * The same source twice is left out.
 */
export function attachVideoSource(key: string, hostId: string | null, entry: { name: string; size: number; mime: string; kind?: "recording"; source: string }, source: VideoSource): { added: number; skipped?: string } {
  const s = useVideoStore.getState();
  const current = pick(s, s.drafts[key]);
  if (current.some((v) => v.source === entry.source)) return { added: 0 };
  if (current.length >= MAX_DRAFT_VIDEOS) return { added: 0, skipped: `A prompt takes at most ${MAX_DRAFT_VIDEOS} videos.` };
  const v: DraftVideo = { id: `v${Date.now().toString(36)}-${(seq++).toString(36)}`, name: entry.name, size: entry.size, mime: entry.mime, hostId, phase: "pending", sent: 0, source: entry.source, ...(entry.kind ? { kind: entry.kind } : {}) };
  sources.set(v.id, source);
  useVideoStore.setState((st) => ({ videos: { ...st.videos, [v.id]: v }, drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), v.id] } }));
  if (hostId) start(v.id);
  return { added: 1 };
}

/** How stored videos of source kind `kind` (`<kind>:<id>`) are read again after a restart; null when gone. */
export function registerVideoSource(kind: string, resolve: (id: string) => VideoSource | null): () => void {
  resolvers.set(kind, resolve);
  return () => {
    if (resolvers.get(kind) === resolve) resolvers.delete(kind);
  };
}

export function getDraftVideos(key: string): DraftVideo[] {
  const s = useVideoStore.getState();
  return pick(s, s.drafts[key]);
}

/** One video, while this page keeps it (released or never attached here: undefined). */
export function getVideo(id: string): DraftVideo | undefined {
  return useVideoStore.getState().videos[id];
}

/** A draft's videos, live; the stored ones are brought back on first use. */
export function useDraftVideos(key: string): DraftVideo[] {
  useEffect(() => {
    void hydrateDraftVideos(key);
  }, [key]);
  return useVideoStore(useShallow((s) => pick(s, s.drafts[key])));
}

/** The videos of `ids`, live (a Dispatch entry shows its uploads). */
export function useVideoUploads(ids: readonly string[] | undefined): DraftVideo[] {
  return useVideoStore(useShallow((s) => pick(s, ids)));
}

/** Start the `ids` that wait for a host on `hostId`; any that went to another host starts over there. */
export function uploadDraftVideos(ids: readonly string[], hostId: string): void {
  for (const id of ids) {
    const v = useVideoStore.getState().videos[id];
    if (!v || (v.hostId === hostId && v.phase !== "pending")) continue;
    if (v.hostId) dropOnHost(id);
    patch(id, { hostId });
    start(id);
  }
}

/** Upload failed videos again (from the start). */
export function retryVideos(ids: readonly string[]): void {
  for (const id of ids) if (useVideoStore.getState().videos[id]?.phase === "failed") start(id);
}

/** Take videos off draft `key` (sent: their uploads go on, for whoever waits on them). */
export function detachDraftVideos(key: string, ids: readonly string[]): void {
  useVideoStore.setState((s) => {
    const cur = s.drafts[key];
    if (!cur) return s;
    const left = cur.filter((id) => !ids.includes(id));
    const drafts = { ...s.drafts };
    if (left.length) drafts[key] = left;
    else delete drafts[key];
    return { drafts };
  });
}

/** Move videos of draft `from` to draft `to` (a prefilled task handed to an agent); one on another host uploads again when `to` sends. */
export function moveDraftVideos(from: string, to: string, ids: readonly string[]): void {
  useVideoStore.setState((s) => {
    const cur = s.drafts[from] ?? [];
    const moving = cur.filter((id) => ids.includes(id));
    if (!moving.length) return s;
    const left = cur.filter((id) => !moving.includes(id));
    const drafts = { ...s.drafts, [to]: [...(s.drafts[to] ?? []).filter((id) => !moving.includes(id)), ...moving] };
    if (left.length) drafts[from] = left;
    else delete drafts[from];
    return { drafts };
  });
}

/** Forget videos whose prompt went out (their files stay on the host). */
export function releaseVideos(ids: readonly string[]): void {
  for (const id of ids) {
    files.delete(id);
    sources.delete(id);
    aborts.delete(id);
  }
  useVideoStore.setState((s) => {
    const videos = { ...s.videos };
    for (const id of ids) delete videos[id];
    return { videos };
  });
}

/** Drop videos that will never be sent: uploads stopped, their files deleted on the host. */
export function discardVideos(ids: readonly string[]): void {
  for (const id of ids) dropOnHost(id);
  releaseVideos(ids);
}

/** Remove a video from draft `key` (its chip's ×). */
export function removeDraftVideo(key: string, id: string): void {
  detachDraftVideos(key, [id]);
  discardVideos([id]);
}

/**
 * Resolves with the `ids` still around once every one is uploaded (one removed meanwhile is left
 * out); rejects on the first failure (code `upload_failed`). `pending` ones must be started first.
 */
export function whenUploaded(ids: readonly string[]): Promise<VideoRef[]> {
  const settle = (s: VideosState): { refs: VideoRef[] } | { failed: DraftVideo } | null => {
    const list = pick(s, ids);
    const failed = list.find((v) => v.phase === "failed");
    if (failed) return { failed };
    if (!list.every((v) => v.phase === "done")) return null;
    return { refs: list.map((v) => ({ name: v.name, size: v.size, path: v.path ?? "", ...(v.ref ? { ref: v.ref } : {}) })) };
  };
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve, reject) => {
    const finish = (r: { refs: VideoRef[] } | { failed: DraftVideo }) => {
      if ("refs" in r) resolve(r.refs);
      else reject(apiError("upload_failed", `${r.failed.name} didn't upload: ${r.failed.error ?? "unknown error"}`, { hint: "Retry the upload" }));
    };
    const first = settle(useVideoStore.getState());
    if (first) return finish(first);
    const off = useVideoStore.subscribe((s) => {
      const r = settle(s);
      if (!r) return;
      off();
      finish(r);
    });
  });
}

/**
 * One prompt line per video: where it is on the host, so the agent reads it with its tools; a
 * video that made its own reference text (a recording) says that instead.
 * `Attached video "clip.mp4" (12.3 MB): /home/me/.teleflock/uploads/2026-10-27/clip.mp4 (read it to see it)`
 */
export function videoRefLine(v: VideoRef): string {
  return v.ref ?? `Attached video "${v.name}" (${formatBytes(v.size)}): ${v.path} (read it to see it)`;
}

/** `text` with a reference line per video after it (just the lines when there is no text); a block of several lines (a recording) stands apart. */
export function withVideoRefs(text: string, refs: readonly VideoRef[]): string {
  if (!refs.length) return text;
  const lines = refs.map(videoRefLine).join(refs.some((r) => r.ref?.includes("\n")) ? "\n\n" : "\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}
