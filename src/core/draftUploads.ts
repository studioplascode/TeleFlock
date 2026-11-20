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
 * Files attached to a draft (the session composer, Dispatch) that go to the host instead of
 * inline like images: videos, and every other file a prompt carries (PDFs, text and code,
 * spreadsheets, Office and OpenDocument files, archives…). Each goes to the host as a file
 * (`upload.ts`) as soon as the host is known, shows as a chip with its progress, and reaches the
 * agent as one reference line in the prompt (`withUploadRefs`): the agent reads the file from that
 * host path with its own tools (omp's read shows a video as a preview grid, or one frame with
 * `:<frame>` / `:<time>`; it turns PDFs and Office documents into text). A TeleFlock Browser
 * recording attaches as an upload with a source (`attachUploadSource`): it uploads its files itself
 * (video, timeline, screenshots) once its host is known and writes its own reference block.
 *
 * Kept in memory per draft key, and what a restart can keep is written through to IndexedDB
 * (`StoredUploads`): an uploaded file comes back as it was (it is on the host), one cut off
 * mid-upload comes back failed (the browser reads a picked file only while the page that picked it
 * lives). Switching agents or views keeps an upload going. One upload runs at a time per host; the
 * others wait their turn. While any runs, the desktop app's updater holds an automatic restart
 * (`setDraftWorkBusy`). Removing a chip drops its upload on the host, finished or not (its prompt
 * never went out); a sent file stays (the host prunes uploads after 30 days).
 */

/**
 * `pending`: no host yet (Dispatch Auto: the host the task goes to) → `queued` (another upload to the
 * same host goes first) → `uploading` → `done` (`path` set) or `failed` (`error`; retry starts over).
 */
export type UploadPhase = "pending" | "queued" | "uploading" | "done" | "failed";

/** What an upload is when not a video: a browser recording, or any other file (a document). Its chip and prompt line say so. */
export type UploadKind = "recording" | "file";

export interface DraftUpload {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** The host it uploads to; null until known. */
  hostId: string | null;
  phase: UploadPhase;
  /** Bytes the host has. */
  sent: number;
  /** Absolute path on the host, once uploaded. */
  path?: string;
  /** The host's id of the finished upload (to drop it again). */
  uploadId?: string;
  error?: string;
  /** Absent: a video (what drafts stored before other files came along). */
  kind?: UploadKind;
  /** Where its bytes come from when not a picked file (`DraftUploadSource`): `<kind>:<id>`, kept across a restart. */
  source?: string;
  /** Its own prompt text once uploaded (a recording names its timeline, video and screenshots). */
  ref?: string;
  /** More uploads on the host that go with it (dropped with it). */
  extra?: string[];
}

/** What the prompt says about an upload. */
export interface UploadRef {
  name: string;
  size: number;
  path: string;
  /** Absent: a video. */
  kind?: UploadKind;
  /** The whole reference text, when the upload made its own (`DraftUpload.ref`). */
  ref?: string;
}

/**
 * A draft upload whose bytes are not a picked file but something the app keeps (a browser
 * recording): it uploads itself, possibly as several files, and says what the prompt carries.
 */
export interface DraftUploadSource {
  upload(hostId: string, opts: UploadOptions): Promise<UploadedFile & { ref?: string; extra?: string[] }>;
}

/** Uploads per prompt at most (as many as images). */
export const MAX_DRAFT_UPLOADS = 8;

interface UploadsState {
  uploads: Record<string, DraftUpload>;
  /** Draft key → its uploads' ids, in attach order. */
  drafts: Record<string, string[]>;
}

const useUploadStore = create<UploadsState>()(() => ({ uploads: {}, drafts: {} }));
const files = new Map<string, File>();
const sources = new Map<string, DraftUploadSource>();
const aborts = new Map<string, AbortController>();
/** Source kind → how a stored source comes back after a restart (`registerUploadSource`). */
const resolvers = new Map<string, (id: string) => DraftUploadSource | null>();
/** The last upload queued per host: the next one starts after it. */
const queues = new Map<string, Promise<void>>();
let seq = 0;
const NONE: DraftUpload[] = [];

/** How files reach a host and are dropped there again: `upload.ts` and `upload.cancel`, unless a test swaps them. */
export interface UploadTransport {
  upload(hostId: string, file: File, opts: UploadOptions): Promise<UploadedFile>;
  cancel(hostId: string, uploadId: string): Promise<unknown>;
}

let transport: UploadTransport = {
  upload: uploadFile,
  cancel: (hostId, uploadId) => core.host(hostId).call("upload.cancel", { uploadId }),
};

/** Swaps the transport (tests); returns the previous one. */
export function setUploadTransport(next: UploadTransport): UploadTransport {
  const prev = transport;
  transport = next;
  return prev;
}

function patch(id: string, change: Partial<DraftUpload>): void {
  useUploadStore.setState((s) => {
    const cur = s.uploads[id];
    return cur ? { uploads: { ...s.uploads, [id]: { ...cur, ...change } } } : s;
  });
}

function pick(s: UploadsState, ids: readonly string[] | undefined): DraftUpload[] {
  return ids?.length ? ids.map((id) => s.uploads[id]).filter((u): u is DraftUpload => !!u) : NONE;
}

/** A draft's upload as stored: no file (a restart loses it, unless a `source` brings it back), the host path once uploaded. */
export type StoredUpload = Pick<DraftUpload, "id" | "name" | "size" | "mime" | "hostId" | "path" | "uploadId" | "kind" | "source" | "ref" | "extra">;

/** What is stored per draft key. */
export interface StoredUploads {
  /** Named for what it held before other files came along, so drafts stored back then still come back. */
  videos: StoredUpload[];
  at: number;
}

export type DraftUploadBackend = SlotBackend<StoredUploads>;

const stored = draftSlots<StoredUpload[], StoredUploads>({
  // The database and store keep their first names too (see `StoredUploads.videos`).
  backend: indexedDbSlots<StoredUploads>("tf.draftVideos", "videos", { maxStored: 40, maxAgeMs: 30 * 86_400_000 }),
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
export function setDraftUploadBackend(next: DraftUploadBackend): DraftUploadBackend {
  return stored.setBackend(next);
}

/** Draft keys whose stored uploads are back in the store. */
const restored = new Set<string>();

/**
 * Brings draft `key`'s stored uploads back (once per key; resolves when they are in): an uploaded
 * one as it was, one a restart cut off as failed, unless its source can be read again (a
 * recording still on this device): that one waits for its host again. Uploads the page holds
 * already are left alone.
 */
export async function hydrateDraftUploads(key: string): Promise<void> {
  await stored.hydrate(key);
  if (restored.has(key)) return;
  restored.add(key);
  const s = useUploadStore.getState();
  const back = stored.get(key).filter((u) => !s.uploads[u.id]);
  if (!back.length) return;
  const uploads = back.map((u): DraftUpload => {
    if (u.path) return { ...u, phase: "done", sent: u.size };
    const [kind = "", sourceId = ""] = u.source?.split(/:(.*)/s) ?? [];
    const source = u.source ? resolvers.get(kind)?.(sourceId) : null;
    if (!source) return { ...u, phase: "failed", sent: 0, error: "TeleFlock restarted before it was uploaded; attach it again" };
    sources.set(u.id, source);
    return { ...u, phase: "pending", sent: 0 };
  });
  useUploadStore.setState((st) => ({
    uploads: { ...st.uploads, ...Object.fromEntries(uploads.map((u) => [u.id, u])) },
    drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), ...uploads.map((u) => u.id)] },
  }));
  for (const u of uploads) if (u.phase === "pending" && u.hostId) start(u.id);
}

/** What is stored of draft `key`'s uploads changes only with the list and the uploads finishing. */
function storedSignature(s: UploadsState, key: string): string {
  return pick(s, s.drafts[key])
    .map((u) => `${u.id}\u0000${u.path ?? ""}`)
    .join("\u0001");
}

useUploadStore.subscribe((s, prev) => {
  for (const key of new Set([...Object.keys(s.drafts), ...Object.keys(prev.drafts)])) {
    if (storedSignature(s, key) === storedSignature(prev, key)) continue;
    // Stored uploads come back first: the list written must not drop them unseen.
    const write = hydrateDraftUploads(key).then(() => {
      const now = useUploadStore.getState();
      stored.update(key, () => pick(now, now.drafts[key]).map(({ id, name, size, mime, hostId, path, uploadId, kind, source, ref, extra }) => ({ id, name, size, mime, hostId, path, uploadId, kind, source, ref, extra })));
    });
    void trackDraftWork(write);
  }
  const uploading = (v: UploadsState) => Object.values(v.uploads).some((x) => x.phase === "queued" || x.phase === "uploading");
  if (uploading(s) !== uploading(prev)) setDraftWorkBusy("uploads", uploading(s));
});

/** Queue `id`'s upload to its host, from the start. */
function start(id: string): void {
  const u = useUploadStore.getState().uploads[id];
  const file = files.get(id);
  const source = sources.get(id);
  if (!u?.hostId) return;
  if (!file && !source) {
    patch(id, { phase: "failed", error: "The file can't be read any more; attach it again" });
    return;
  }
  aborts.get(id)?.abort();
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  patch(id, { phase: "queued", sent: 0, path: undefined, uploadId: undefined, error: undefined, ref: undefined, extra: undefined });
  const hostId = u.hostId;
  const run = async () => {
    if (ctrl.signal.aborted) return;
    patch(id, { phase: "uploading" });
    try {
      const opts: UploadOptions = { signal: ctrl.signal, mime: u.mime, onProgress: (sent) => ctrl.signal.aborted || patch(id, { sent }) };
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
  const u = useUploadStore.getState().uploads[id];
  if (!u?.hostId) return;
  for (const uploadId of [u.uploadId, ...(u.extra ?? [])]) if (uploadId) void transport.cancel(u.hostId, uploadId).catch(() => undefined);
}

/**
 * Attach `incoming` (the files that don't go inline: `splitAttachments`) to draft `key`, uploading
 * to `hostId` right away (null: once the host is known, `startUploads`). The same file twice, an
 * empty one or one over the host's limit is left out. Returns how many were added and why others
 * were left out.
 */
export function attachUploads(key: string, hostId: string | null, incoming: readonly File[]): { added: number; skipped?: string } {
  const s = useUploadStore.getState();
  const current = pick(s, s.drafts[key]);
  const known = new Set(current.map((u) => `${u.name}\u0000${u.size}`));
  const added: DraftUpload[] = [];
  let skipped: string | undefined;
  for (const f of incoming) {
    const id = `${f.name}\u0000${f.size}`;
    if (known.has(id)) continue;
    if (f.size === 0) {
      skipped = `${f.name} is empty.`;
      continue;
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      skipped = `${f.name} is ${formatBytes(f.size)}; uploads go up to ${formatBytes(MAX_UPLOAD_BYTES)}.`;
      continue;
    }
    if (current.length + added.length >= MAX_DRAFT_UPLOADS) {
      skipped = `A prompt takes at most ${MAX_DRAFT_UPLOADS} files.`;
      break;
    }
    known.add(id);
    const video = isVideoFile(f);
    const u: DraftUpload = { id: `u${Date.now().toString(36)}-${(seq++).toString(36)}`, name: f.name || (video ? "video" : "file"), size: f.size, mime: f.type, hostId, phase: "pending", sent: 0, ...(video ? {} : { kind: "file" as const }) };
    files.set(u.id, f);
    added.push(u);
  }
  if (added.length) {
    useUploadStore.setState((st) => ({
      uploads: { ...st.uploads, ...Object.fromEntries(added.map((u) => [u.id, u])) },
      drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), ...added.map((u) => u.id)] },
    }));
    if (hostId) for (const u of added) start(u.id);
  }
  return skipped ? { added: added.length, skipped } : { added: added.length };
}

/**
 * Attach an upload whose bytes come from `source` (a browser recording) to draft `key`. It uploads
 * when `hostId` is known (null: once the prompt goes out, through `startUploads`), and comes back
 * after a restart while the source can be read again (`registerUploadSource` for its kind). The
 * same source twice is left out.
 */
export function attachUploadSource(key: string, hostId: string | null, entry: { name: string; size: number; mime: string; kind?: UploadKind; source: string }, source: DraftUploadSource): { added: number; skipped?: string } {
  const s = useUploadStore.getState();
  const current = pick(s, s.drafts[key]);
  if (current.some((u) => u.source === entry.source)) return { added: 0 };
  if (current.length >= MAX_DRAFT_UPLOADS) return { added: 0, skipped: `A prompt takes at most ${MAX_DRAFT_UPLOADS} files.` };
  const u: DraftUpload = { id: `u${Date.now().toString(36)}-${(seq++).toString(36)}`, name: entry.name, size: entry.size, mime: entry.mime, hostId, phase: "pending", sent: 0, source: entry.source, ...(entry.kind ? { kind: entry.kind } : {}) };
  sources.set(u.id, source);
  useUploadStore.setState((st) => ({ uploads: { ...st.uploads, [u.id]: u }, drafts: { ...st.drafts, [key]: [...(st.drafts[key] ?? []), u.id] } }));
  if (hostId) start(u.id);
  return { added: 1 };
}

/** How stored uploads of source kind `kind` (`<kind>:<id>`) are read again after a restart; null when gone. */
export function registerUploadSource(kind: string, resolve: (id: string) => DraftUploadSource | null): () => void {
  resolvers.set(kind, resolve);
  return () => {
    if (resolvers.get(kind) === resolve) resolvers.delete(kind);
  };
}

export function getDraftUploads(key: string): DraftUpload[] {
  const s = useUploadStore.getState();
  return pick(s, s.drafts[key]);
}

/** One upload, while this page keeps it (released or never attached here: undefined). */
export function getUpload(id: string): DraftUpload | undefined {
  return useUploadStore.getState().uploads[id];
}

/** A draft's uploads, live; the stored ones are brought back on first use. */
export function useDraftUploads(key: string): DraftUpload[] {
  useEffect(() => {
    void hydrateDraftUploads(key);
  }, [key]);
  return useUploadStore(useShallow((s) => pick(s, s.drafts[key])));
}

/** The uploads of `ids`, live (a Dispatch entry shows its uploads). */
export function useUploads(ids: readonly string[] | undefined): DraftUpload[] {
  return useUploadStore(useShallow((s) => pick(s, ids)));
}

/** Start the `ids` that wait for a host on `hostId`; any that went to another host starts over there. */
export function startUploads(ids: readonly string[], hostId: string): void {
  for (const id of ids) {
    const u = useUploadStore.getState().uploads[id];
    if (!u || (u.hostId === hostId && u.phase !== "pending")) continue;
    if (u.hostId) dropOnHost(id);
    patch(id, { hostId });
    start(id);
  }
}

/** Upload failed ones again (from the start). */
export function retryUploads(ids: readonly string[]): void {
  for (const id of ids) if (useUploadStore.getState().uploads[id]?.phase === "failed") start(id);
}

/** Take uploads off draft `key` (sent: they go on, for whoever waits on them). */
export function detachDraftUploads(key: string, ids: readonly string[]): void {
  useUploadStore.setState((s) => {
    const cur = s.drafts[key];
    if (!cur) return s;
    const left = cur.filter((id) => !ids.includes(id));
    const drafts = { ...s.drafts };
    if (left.length) drafts[key] = left;
    else delete drafts[key];
    return { drafts };
  });
}

/** Move uploads of draft `from` to draft `to` (a prefilled task handed to an agent); one on another host uploads again when `to` sends. */
export function moveDraftUploads(from: string, to: string, ids: readonly string[]): void {
  useUploadStore.setState((s) => {
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

/** Forget uploads whose prompt went out (their files stay on the host). */
export function releaseUploads(ids: readonly string[]): void {
  for (const id of ids) {
    files.delete(id);
    sources.delete(id);
    aborts.delete(id);
  }
  useUploadStore.setState((s) => {
    const uploads = { ...s.uploads };
    for (const id of ids) delete uploads[id];
    return { uploads };
  });
}

/** Drop uploads that will never be sent: stopped, their files deleted on the host. */
export function discardUploads(ids: readonly string[]): void {
  for (const id of ids) dropOnHost(id);
  releaseUploads(ids);
}

/** Remove an upload from draft `key` (its chip's ×). */
export function removeDraftUpload(key: string, id: string): void {
  detachDraftUploads(key, [id]);
  discardUploads([id]);
}

/**
 * Resolves with the `ids` still around once every one is uploaded (one removed meanwhile is left
 * out); rejects on the first failure (code `upload_failed`). `pending` ones must be started first.
 */
export function whenUploaded(ids: readonly string[]): Promise<UploadRef[]> {
  const settle = (s: UploadsState): { refs: UploadRef[] } | { failed: DraftUpload } | null => {
    const list = pick(s, ids);
    const failed = list.find((u) => u.phase === "failed");
    if (failed) return { failed };
    if (!list.every((u) => u.phase === "done")) return null;
    return { refs: list.map((u) => ({ name: u.name, size: u.size, path: u.path ?? "", ...(u.kind ? { kind: u.kind } : {}), ...(u.ref ? { ref: u.ref } : {}) })) };
  };
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve, reject) => {
    const finish = (r: { refs: UploadRef[] } | { failed: DraftUpload }) => {
      if ("refs" in r) resolve(r.refs);
      else reject(apiError("upload_failed", `${r.failed.name} didn't upload: ${r.failed.error ?? "unknown error"}`, { hint: "Retry the upload" }));
    };
    const first = settle(useUploadStore.getState());
    if (first) return finish(first);
    const off = useUploadStore.subscribe((s) => {
      const r = settle(s);
      if (!r) return;
      off();
      finish(r);
    });
  });
}

/**
 * One prompt line per upload: what it is and where it is on the host, so the agent reads it with
 * its tools; one that made its own reference text (a recording) says that instead.
 * `Attached video "clip.mp4" (12.3 MB): /home/me/.teleflock/uploads/2026-10-27/clip.mp4 (read it to see it)`
 * `Attached file "spec.pdf" (1.2 MB): /home/me/.teleflock/uploads/2026-10-27/spec.pdf (read it to see its contents)`
 */
export function uploadRefLine(u: UploadRef): string {
  if (u.ref) return u.ref;
  return u.kind === "file"
    ? `Attached file "${u.name}" (${formatBytes(u.size)}): ${u.path} (read it to see its contents)`
    : `Attached video "${u.name}" (${formatBytes(u.size)}): ${u.path} (read it to see it)`;
}

/** `text` with a reference line per upload after it (just the lines when there is no text); a block of several lines (a recording) stands apart. */
export function withUploadRefs(text: string, refs: readonly UploadRef[]): string {
  if (!refs.length) return text;
  const lines = refs.map(uploadRefLine).join(refs.some((r) => r.ref?.includes("\n")) ? "\n\n" : "\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}
