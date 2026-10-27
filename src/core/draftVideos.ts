import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isVideoFile } from "./clipboardImages";
import { core } from "./client";
import { apiError, toApiError } from "./errors";
import { formatBytes, MAX_UPLOAD_BYTES, type UploadedFile, type UploadOptions, uploadFile } from "./upload";

/*
 * Videos attached to a draft (the session composer, Dispatch). A video goes to the host as a file
 * (`upload.ts`) as soon as the host is known, shows as a chip with its progress, and reaches the
 * agent as one reference line per video in the prompt (`withVideoRefs`): the agent reads the file
 * from that host path with its own tools (omp's read shows a video as a preview grid, or one frame
 * with `:<frame>` / `:<time>`). Images stay inline (`clipboardImages.ts`).
 *
 * Kept in memory per draft key: an upload can't outlive the page (the browser reads the file only
 * while the page that picked it is open), but switching agents or views keeps it going. One upload
 * runs at a time per host; the others wait their turn. Removing a chip drops its upload on the host,
 * finished or not (its prompt never went out); a sent video's file stays (the host prunes uploads
 * after 30 days).
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
}

/** What the prompt says about a video. */
export interface VideoRef {
  name: string;
  size: number;
  path: string;
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
const aborts = new Map<string, AbortController>();
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

/** Queue `id`'s upload to its host, from the start. */
function start(id: string): void {
  const v = useVideoStore.getState().videos[id];
  const file = files.get(id);
  if (!v?.hostId) return;
  if (!file) {
    patch(id, { phase: "failed", error: "The file can't be read any more; attach it again" });
    return;
  }
  aborts.get(id)?.abort();
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  patch(id, { phase: "queued", sent: 0, path: undefined, uploadId: undefined, error: undefined });
  const hostId = v.hostId;
  const run = async () => {
    if (ctrl.signal.aborted) return;
    patch(id, { phase: "uploading" });
    try {
      const done = await transport.upload(hostId, file, { signal: ctrl.signal, mime: v.mime, onProgress: (sent) => ctrl.signal.aborted || patch(id, { sent }) });
      if (!ctrl.signal.aborted) patch(id, { phase: "done", sent: done.size, path: done.path, uploadId: done.uploadId });
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

/** Stop `id`'s upload and drop it on the host (partial or finished). */
function dropOnHost(id: string): void {
  const ctrl = aborts.get(id);
  if (ctrl) {
    // uploadFile drops it on the host once its request in flight is answered.
    ctrl.abort();
    aborts.delete(id);
    return;
  }
  const v = useVideoStore.getState().videos[id];
  if (v?.hostId && v.uploadId) void transport.cancel(v.hostId, v.uploadId).catch(() => undefined);
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

export function getDraftVideos(key: string): DraftVideo[] {
  const s = useVideoStore.getState();
  return pick(s, s.drafts[key]);
}

/** One video, while this page keeps it (released or never attached here: undefined). */
export function getVideo(id: string): DraftVideo | undefined {
  return useVideoStore.getState().videos[id];
}

/** A draft's videos, live. */
export function useDraftVideos(key: string): DraftVideo[] {
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

/** Forget videos whose prompt went out (their files stay on the host). */
export function releaseVideos(ids: readonly string[]): void {
  for (const id of ids) {
    files.delete(id);
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
    return { refs: list.map((v) => ({ name: v.name, size: v.size, path: v.path ?? "" })) };
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
 * One prompt line per video: where it is on the host, so the agent reads it with its tools.
 * `Attached video "clip.mp4" (12.3 MB): /home/me/.teleflock/uploads/2026-10-27/clip.mp4 (read it to see it)`
 */
export function videoRefLine(v: VideoRef): string {
  return `Attached video "${v.name}" (${formatBytes(v.size)}): ${v.path} (read it to see it)`;
}

/** `text` with a reference line per video after it (just the lines when there is no text). */
export function withVideoRefs(text: string, refs: readonly VideoRef[]): string {
  if (!refs.length) return text;
  const lines = refs.map(videoRefLine).join("\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}
