import { type CoreError, toApiError } from "@/core/errors";
import { MAX_UPLOAD_BYTES, type UploadOptions, type UploadedFile, formatBytes, uploadFile } from "@/core/upload";
import { mediaLabel } from "./mediaPaste";

type Media = Blob & { name?: string };
type Upload = (hostId: string, file: Media, opts: UploadOptions) => Promise<UploadedFile>;

/** What the terminal's upload indicator shows: every running batch summed. */
export interface UploadProgress {
  /** The file's name for a single file, else "N files". */
  readonly label: string;
  readonly sent: number;
  readonly total: number;
}

export interface BatchResult {
  /** Host paths of the files that arrived, in the order given. */
  paths: string[];
  /** Stopped by `cancel` (the indicator's ×, or the attachment went away): paste nothing. */
  cancelled: boolean;
  /** The upload that failed and ended the batch (files after it were not sent). */
  failed?: { name: string; error: CoreError };
  /** Files left out up front. */
  skipped: { name: string; reason: string }[];
}

interface Batch {
  label: string;
  files: number;
  sent: number;
  total: number;
  ctrl: AbortController;
}

/**
 * The uploads of one terminal. Each paste, drop or pick is a batch: its files go to the host one
 * after another, and its caller pastes their paths together once all have arrived. Batches run side
 * by side; `progress` sums them for the indicator, and `cancel` stops them all.
 */
export class TermUploads {
  private readonly batches = new Set<Batch>();
  private readonly listeners = new Set<() => void>();
  private view: UploadProgress | null = null;

  constructor(private readonly upload: Upload = uploadFile) {}

  /** `useSyncExternalStore` pair: only the indicator re-renders while chunks go out. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly progress = (): UploadProgress | null => this.view;

  async run(hostId: string, files: readonly Media[]): Promise<BatchResult> {
    const result: BatchResult = { paths: [], cancelled: false, skipped: [] };
    const todo = files.filter((f) => {
      const reason = f.size === 0 ? "The file is empty." : f.size > MAX_UPLOAD_BYTES ? `It is ${formatBytes(f.size)}; the host takes up to ${formatBytes(MAX_UPLOAD_BYTES)}.` : null;
      if (reason) result.skipped.push({ name: mediaLabel(f), reason });
      return !reason;
    });
    const [first] = todo;
    if (!first) return result;
    const batch: Batch = {
      label: todo.length === 1 ? mediaLabel(first) : `${todo.length} files`,
      files: todo.length,
      sent: 0,
      total: todo.reduce((n, f) => n + f.size, 0),
      ctrl: new AbortController(),
    };
    this.batches.add(batch);
    this.publish();
    let current = first;
    try {
      for (const file of todo) {
        current = file;
        const before = batch.sent;
        const done = await this.upload(hostId, file, {
          signal: batch.ctrl.signal,
          onProgress: (sent) => {
            batch.sent = before + sent;
            this.publish();
          },
        });
        batch.sent = before + file.size;
        result.paths.push(done.path);
      }
    } catch (e) {
      const error = toApiError(e);
      if (error.code === "cancelled" || batch.ctrl.signal.aborted) result.cancelled = true;
      else result.failed = { name: mediaLabel(current), error };
    } finally {
      this.batches.delete(batch);
      this.publish();
    }
    // A cancel that came while the last file finished still means "don't paste".
    if (result.cancelled || batch.ctrl.signal.aborted) return { ...result, cancelled: true, paths: [] };
    return result;
  }

  cancel(): void {
    for (const b of this.batches) b.ctrl.abort();
  }

  private publish(): void {
    let sent = 0;
    let total = 0;
    let files = 0;
    let only: Batch | undefined;
    for (const b of this.batches) {
      sent += b.sent;
      total += b.total;
      files += b.files;
      only = b;
    }
    this.view = !only ? null : { label: this.batches.size === 1 ? only.label : `${files} files`, sent, total };
    for (const listener of this.listeners) listener();
  }
}
