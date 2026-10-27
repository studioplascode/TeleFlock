/**
 * Demo uploads (`upload.*`): like tf-hostd's (chunks strictly in order, a sanitized unique name
 * under `~/.teleflock/uploads/<day>/`), but nothing is stored: each upload is just its offset. A
 * chunk takes as long as it would at ~4 MB/s, so the composer chips show their progress.
 */
import type { UploadBegun, UploadFinished, UploadProgress } from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

const BYTES_PER_MS = 4 * 1024;
const MAX_CHUNK = 1024 * 1024;
const MAX_FILE = 2 * 1024 ** 3;
const EXT_BY_MIME: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

interface Upload {
  size: number;
  received: number;
  path: string;
}

export class DemoUploads {
  private readonly running = new Map<string, Upload>();
  private readonly finished = new Map<string, UploadFinished>();
  private seq = 0;

  constructor(
    private readonly clock: DemoClock,
    /** The demo host's home folder. */
    private readonly home: string,
  ) {}

  async call(method: string, p: Record<string, unknown>): Promise<unknown> {
    const id = typeof p.uploadId === "string" ? p.uploadId : "";
    switch (method) {
      case "upload.begin":
        return this.begin(p);
      case "upload.chunk":
        return this.chunk(id, p);
      case "upload.status": {
        const done = this.finished.get(id);
        if (done) return { uploadId: id, received: done.size, size: done.size } satisfies UploadProgress;
        const u = this.upload(id);
        return { uploadId: id, received: u.received, size: u.size } satisfies UploadProgress;
      }
      case "upload.finish": {
        const done = this.finished.get(id);
        if (done) return done;
        const u = this.upload(id);
        if (u.received !== u.size) throw apiError("invalid_params", `upload ${id} has ${u.received} of its ${u.size} bytes`);
        const result: UploadFinished = { path: u.path, size: u.size, sha256: fakeDigest(u.path, u.size) };
        this.running.delete(id);
        this.finished.set(id, result);
        return result;
      }
      case "upload.cancel":
        this.running.delete(id);
        this.finished.delete(id);
        return {};
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private upload(id: string): Upload {
    const u = this.running.get(id);
    if (!u) throw apiError("not_found", `upload ${id} is gone`, { hint: "Start the upload again" });
    return u;
  }

  private begin(p: Record<string, unknown>): UploadBegun {
    const name = typeof p.name === "string" ? p.name : "";
    const size = typeof p.size === "number" ? p.size : 0;
    if (size <= 0) throw apiError("invalid_params", `${name || "The file"} is empty`);
    if (size > MAX_FILE) throw apiError("invalid_params", `${name} is larger than 2 GiB`);
    const mime = typeof p.mime === "string" ? p.mime : "";
    const now = new Date(this.clock.now());
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dir = `${this.home}/.teleflock/uploads/${day}`;
    const file = demoFileName(name, mime);
    const taken = new Set([...this.running.values()].map((u) => u.path).concat([...this.finished.values()].map((f) => f.path)));
    const dot = file.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
    let path = `${dir}/${file}`;
    for (let n = 2; taken.has(path); n++) path = `${dir}/${stem}-${n}${ext}`;
    const uploadId = `up_demo${(this.seq++).toString(16)}`;
    this.running.set(uploadId, { size, received: 0, path });
    return { uploadId, path, maxChunk: MAX_CHUNK };
  }

  private async chunk(id: string, p: Record<string, unknown>): Promise<UploadProgress> {
    const u = this.upload(id);
    const data = typeof p.data === "string" ? p.data : "";
    const offset = typeof p.offset === "number" ? p.offset : -1;
    const len = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (len <= 0 || len > MAX_CHUNK) throw apiError("invalid_params", `a chunk carries 1 B to 1024 KiB, not ${len} B`);
    if (offset !== u.received) throw apiError("upload_offset", `upload ${id} is at byte ${u.received}, not ${offset}`);
    if (offset + len > u.size) throw apiError("invalid_params", `the chunk ends at byte ${offset + len}, past the file's ${u.size} bytes`);
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    await new Promise<void>((resolve) => this.clock.after(Math.round(len / BYTES_PER_MS), resolve));
    if (this.running.get(id) !== u) throw apiError("not_found", `upload ${id} is gone`);
    u.received = offset + len;
    return { uploadId: id, received: u.received, size: u.size };
  }
}

/** The host's naming, roughly: letters, digits, `-_.`; the extension kept or taken from the type. */
function demoFileName(name: string, mime: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : (EXT_BY_MIME[mime] ?? "");
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64) || (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "upload");
  return ext ? `${stem}.${ext}` : stem;
}

/** A stable stand-in for the SHA-256 the demo never computes. */
function fakeDigest(path: string, size: number): string {
  let h = 0x811c9dc5;
  for (const c of `${path}:${size}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
}
