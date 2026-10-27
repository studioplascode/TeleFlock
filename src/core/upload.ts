import type { UploadBegun } from "@/core/gen";
import type { HostClient } from "./client";
import { core } from "./client";
import { apiError, toApiError } from "./errors";

/*
 * Files sent to a host in chunks (`upload.*`, architecture §3.12): videos for prompts, images
 * pasted into a terminal. The host keeps them under `<hostd home>/uploads/<day>/<name>` and answers
 * the absolute path; the caller hands that path to the agent as text (it reads the file with its
 * own tools).
 *
 * One chunk per request, one request at a time (the host refuses chunks out of order). The chunk
 * size follows the link: about 3 s of data per chunk, 64 KiB to 1 MiB, halved after a timeout, so
 * a chunk stays well inside the 30 s request timeout on a slow phone link and other requests on
 * the same connection never wait long behind one. Transient failures (timeouts, a lost connection)
 * are retried with backoff for up to 10 minutes; each retry first asks the host where the upload
 * stands (`upload.status`), so a chunk whose answer was lost is not sent twice. A host that lost
 * the upload (its daemon restarted) gets it again from the start.
 */

/** Largest file the host takes (tf-hostd `ops::upload::MAX_FILE`). */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
export const MIN_CHUNK = 64 * 1024;
export const FIRST_CHUNK = 256 * 1024;
export const MAX_CHUNK = 1024 * 1024;
/** Each chunk should take about this long at the measured rate. */
const CHUNK_MS = 3_000;
/** Consecutive failures are retried for this long before the upload gives up. */
const GIVE_UP_MS = 10 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** Times the host may lose an upload (daemon restart, idle for an hour) before it fails. */
const MAX_RESTARTS = 3;
/** Codes worth another try besides `retryable` errors. */
const TRANSIENT: Record<string, true> = { timeout: true, not_connected: true, disconnected: true };

export interface UploadOptions {
  /** After each chunk the host confirmed: bytes it has, of `total`. */
  onProgress?(sent: number, total: number): void;
  /**
   * Abort: the request in flight completes, then the upload is dropped on the host (`upload.cancel`,
   * not awaited; a finished file goes too) and the promise rejects with code `cancelled`.
   */
  signal?: AbortSignal;
  /** MIME type for the host (default `file.type`): names the extension of a file without one. */
  mime?: string;
}

export interface UploadedFile {
  /** Absolute path on the host. */
  path: string;
  size: number;
  sha256: string;
  /** The host's id for it: `upload.cancel { uploadId }` deletes the file again (within a day). */
  uploadId: string;
}

/** Test seams: time and waiting. */
export interface UploadEnv {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realEnv: UploadEnv = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
};

/**
 * Upload `file` to `hostId` (named `file.name`; the host sanitizes it and keeps it unique). Rejects
 * with a `CoreError`: `cancelled` (aborted), `unsupported` (the host's daemon predates uploads),
 * `invalid_params` (empty, over 2 GiB), or the host's / connection's error once retrying ends.
 */
export function uploadFile(hostId: string, file: Blob & { name?: string }, opts: UploadOptions = {}): Promise<UploadedFile> {
  return uploadVia(core.host(hostId), file, opts);
}

/** `uploadFile` through any host client (tests pass a fake host). */
export async function uploadVia(host: HostClient, file: Blob & { name?: string }, opts: UploadOptions = {}, env: UploadEnv = realEnv): Promise<UploadedFile> {
  const { signal, onProgress } = opts;
  const name = file.name ?? "";
  const size = file.size;
  const mime = opts.mime ?? (file.type || undefined);
  const label = name || "The file";
  if (size === 0) throw apiError("invalid_params", `${label} is empty`);
  if (size > MAX_UPLOAD_BYTES) throw apiError("invalid_params", `${label} is ${formatBytes(size)}; uploads go up to ${formatBytes(MAX_UPLOAD_BYTES)}`);

  let begun: UploadBegun | null = null;
  try {
    let step: "begin" | "status" | "chunk" | "finish" = "begin";
    let sent = 0;
    let chunk = FIRST_CHUNK;
    let failingSince: number | null = null;
    let failures = 0;
    let restarts = 0;
    let resyncs = 0;
    for (;;) {
      if (signal?.aborted) throw apiError("cancelled", "Upload cancelled");
      try {
        if (step === "begin") {
          begun = await host.call("upload.begin", { name, size, ...(mime ? { mime } : {}) });
          sent = 0;
          step = "chunk";
          onProgress?.(0, size);
        } else if (!begun) {
          step = "begin";
          continue;
        } else if (step === "status") {
          sent = (await host.call("upload.status", { uploadId: begun.uploadId })).received;
          step = sent >= size ? "finish" : "chunk";
          onProgress?.(sent, size);
        } else if (step === "chunk") {
          const len = Math.min(chunk, begun.maxChunk, size - sent);
          const data = await readBase64(file, sent, sent + len);
          if (signal?.aborted) continue;
          const t0 = env.now();
          sent = (await host.call("upload.chunk", { uploadId: begun.uploadId, offset: sent, data })).received;
          chunk = nextChunkSize(len, env.now() - t0, begun.maxChunk);
          resyncs = 0;
          if (sent >= size) step = "finish";
          onProgress?.(sent, size);
        } else {
          const done = await host.call("upload.finish", { uploadId: begun.uploadId });
          // Aborted while finishing: the cancel below drops the finished file.
          if (signal?.aborted) continue;
          const uploadId = begun.uploadId;
          begun = null;
          return { path: done.path, size: done.size, sha256: done.sha256, uploadId };
        }
        failingSince = null;
        failures = 0;
      } catch (e) {
        const err = toApiError(e);
        if (err.code === "unknown_method") {
          throw apiError("unsupported", "This host's TeleFlock daemon is too old for uploads", { hint: "Reconnect the host with this app to update it" });
        }
        if (err.code === "not_found" && begun && step !== "begin") {
          // The host lost the upload (its daemon restarted, or it sat idle for an hour): start over.
          if (++restarts > MAX_RESTARTS) throw err;
          begun = null;
          step = "begin";
          continue;
        }
        if (err.code === "upload_offset" && ++resyncs <= 3) {
          step = "status";
          continue;
        }
        if (!(err.retryable || TRANSIENT[err.code])) throw err;
        failingSince ??= env.now();
        if (env.now() - failingSince > GIVE_UP_MS) throw err;
        if (err.code === "timeout" && step === "chunk") chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2 / MIN_CHUNK) * MIN_CHUNK);
        await env.sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 1_000, signal);
        failures++;
        // The request may have landed (only its answer was lost): ask where the upload stands.
        if (begun && step === "chunk") step = "status";
      }
    }
  } catch (e) {
    // Never left half-done on the host: drop it (best effort; an unreachable host expires it).
    // (Widened: TypeScript doesn't see the try block's assignments here.)
    const open = begun as UploadBegun | null;
    if (open) void host.call("upload.cancel", { uploadId: open.uploadId }).catch(() => undefined);
    throw toApiError(e);
  }
}

/** Bytes `[start, end)` of `file` as base64. */
async function readBase64(file: Blob, start: number, end: number): Promise<string> {
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The next chunk's size after `bytes` took `ms`: about 3 s at that rate, at most twice the last
 * chunk (one quick answer is not a fast link yet), 64 KiB to `limit` in 64 KiB steps.
 */
export function nextChunkSize(bytes: number, ms: number, limit: number = MAX_CHUNK): number {
  const fits = Math.min((bytes / Math.max(ms, 1)) * CHUNK_MS, bytes * 2, limit, MAX_CHUNK);
  return Math.max(MIN_CHUNK, Math.floor(fits / MIN_CHUNK) * MIN_CHUNK);
}

/** `12.3 MB`, `640 KB`, `2 GB` (binary units, as file managers on Windows show them). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
