/**
 * Binary files in Review: which ones the webview shows (images, video, audio, PDF), which versions
 * of a file a preview shows, and how much of a file is read and how. Pure; the loader
 * (`mediaLoad.ts`) and the views (`MediaPreview.tsx`, `PdfView.tsx`) live next to it.
 */
import type { FileStatus } from "@/core/gen";
import type { DiffFile } from "./parse";

export type MediaKind = "image" | "video" | "audio" | "pdf";

/** What a file shows as, and the type its bytes get in the webview. */
export interface MediaType {
  kind: MediaKind;
  mime: string;
}

const m = (kind: MediaKind, mime: string): MediaType => ({ kind, mime });

/** By extension: what every webview TeleFlock runs in can show (formats a platform lacks fail per file). */
const BY_EXT: Record<string, MediaType> = {
  png: m("image", "image/png"),
  apng: m("image", "image/apng"),
  jpg: m("image", "image/jpeg"),
  jpeg: m("image", "image/jpeg"),
  gif: m("image", "image/gif"),
  webp: m("image", "image/webp"),
  avif: m("image", "image/avif"),
  bmp: m("image", "image/bmp"),
  ico: m("image", "image/x-icon"),
  svg: m("image", "image/svg+xml"),
  mp4: m("video", "video/mp4"),
  m4v: m("video", "video/mp4"),
  webm: m("video", "video/webm"),
  mov: m("video", "video/quicktime"),
  ogv: m("video", "video/ogg"),
  mp3: m("audio", "audio/mpeg"),
  wav: m("audio", "audio/wav"),
  ogg: m("audio", "audio/ogg"),
  oga: m("audio", "audio/ogg"),
  opus: m("audio", "audio/ogg"),
  m4a: m("audio", "audio/mp4"),
  flac: m("audio", "audio/flac"),
  aac: m("audio", "audio/aac"),
  pdf: m("pdf", "application/pdf"),
};

/** The file name's extension, lowercased; empty without one (`.gitignore` has none). */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mediaByPath(path: string): MediaType | undefined {
  return BY_EXT[extOf(path)];
}

/** Bytes a signature check reads (`sniffMedia`). */
export const SNIFF_BYTES = 64;

/**
 * What a file's first bytes say it is, for a binary file whose name says nothing. Only signatures
 * that don't occur by chance in other binaries.
 */
export function sniffMedia(b: Uint8Array): MediaType | undefined {
  const bytes = (at: number, ...xs: number[]) => xs.every((x, k) => b[at + k] === x);
  const ascii = (at: number, s: string) => bytes(at, ...Array.from(s, (c) => c.charCodeAt(0)));
  if (bytes(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return BY_EXT.png;
  if (bytes(0, 0xff, 0xd8, 0xff)) return BY_EXT.jpg;
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return BY_EXT.gif;
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return BY_EXT.webp;
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return BY_EXT.wav;
  if (ascii(0, "%PDF-")) return BY_EXT.pdf;
  if (ascii(4, "ftyp")) {
    if (ascii(8, "avif") || ascii(8, "avis")) return BY_EXT.avif;
    if (ascii(8, "qt  ")) return BY_EXT.mov;
    if (ascii(8, "M4A ")) return BY_EXT.m4a;
    return BY_EXT.mp4;
  }
  if (bytes(0, 0x1a, 0x45, 0xdf, 0xa3)) return BY_EXT.webm;
  if (ascii(0, "OggS")) return BY_EXT.ogg;
  if (ascii(0, "fLaC")) return BY_EXT.flac;
  if (ascii(0, "ID3")) return BY_EXT.mp3;
  return undefined;
}

/**
 * Files Review shows as a preview or a "Binary file" line instead of hunks: the ones git calls
 * binary, and media files whatever git calls them (a PDF of uncompressed streams diffs as text, a
 * Git LFS file as its pointer), except an SVG with lines to show: that one is reviewed as text.
 */
export function isBinaryLike(file: DiffFile): boolean {
  const type = mediaByPath(file.path);
  return file.binary || (type !== undefined && (file.hunks.length === 0 || type.mime !== "image/svg+xml"));
}

/** `old`: the file at the diff's base; `new`: the working tree. */
export type Side = "old" | "new";

/** The versions a preview shows: both for a modified file, the base's for a deleted one, else the working tree's. */
export function mediaSides(status: FileStatus): Side[] {
  if (status === "modified") return ["old", "new"];
  if (status === "deleted") return ["old"];
  return ["new"];
}

/** The revision `git.show` reads the old side from: the sha of a `ref (sha)` base, else the base itself. */
export function baseRev(base: string): string {
  return /\(([0-9a-f]{7,64})\)\s*$/.exec(base)?.[1] ?? base.trim();
}

// ── how much is read ──

/** Larger files wait for "Load anyway". */
export const PREVIEW_MAX = 32 << 20;
/** Never read past this, asked or not: the webview holds the whole file. */
export const LOAD_MAX = 256 << 20;
/** fs.read's most on hosts before 0.9.1, which read from the start only: the whole file in one read. */
export const RANGELESS_MAX = 8 << 20;
/** The first read: all of a typical image, else the start of the file and its size. */
export const FIRST_READ = 1 << 20;
/** Every further read: a small share of the link's 30 s request time on a slow phone connection. */
export const CHUNK = 2 << 20;

/** `read`: now; `ask`: on "Load anyway"; `never`: too large to read at all. */
export type SizeVerdict = "read" | "ask" | "never";

/** Whether a file of `size` bytes is read. `rangeless`: the host reads from the start only (before 0.9.1). */
export function sizeVerdict(size: number, forced: boolean, rangeless: boolean): SizeVerdict {
  if (size > (rangeless ? RANGELESS_MAX : LOAD_MAX)) return "never";
  if (size > PREVIEW_MAX && !forced) return "ask";
  return "read";
}

/** One read of a file: its size, the bytes from `offset`, whether more follow. */
export interface ReadRange {
  size: number;
  /** Where the read started; absent when the host ignored the range (before 0.9.1). */
  offset?: number;
  bytes: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

export type RangeReader = (offset: number, maxBytes: number) => Promise<ReadRange>;

export type ReadOutcome =
  | { state: "ready"; parts: Uint8Array<ArrayBuffer>[]; size: number; type: MediaType }
  /** Not something the webview shows (or nothing to show: `size` 0). */
  | { state: "binary"; size: number }
  | { state: "tooLarge"; size: number; verdict: "ask" | "never"; rangeless: boolean };

/**
 * Reads a file for its preview: a first read tells its size (and, for a name that says nothing,
 * what it is), then ranges until it is whole. A host that reads from the start only gets one read
 * of the whole file. `onProgress(received, size)` after each range.
 */
export async function readMedia(read: RangeReader, path: string, opts: { forced: boolean; onProgress?: (received: number, size: number) => void; alive?: () => boolean }): Promise<ReadOutcome> {
  const named = mediaByPath(path);
  const first = await read(0, named ? FIRST_READ : SNIFF_BYTES);
  const rangeless = first.offset === undefined;
  const type = named ?? sniffMedia(first.bytes);
  if (!type || first.size === 0) return { state: "binary", size: first.size };
  const verdict = sizeVerdict(first.size, opts.forced, rangeless);
  if (verdict !== "read") return { state: "tooLarge", size: first.size, verdict, rangeless };
  if (rangeless) {
    const whole = first.truncated ? await read(0, first.size) : first;
    return { state: "ready", parts: [whole.bytes], size: whole.bytes.length, type };
  }
  const parts = [first.bytes];
  let received = first.bytes.length;
  let more = first.truncated;
  while (more && received < first.size && (opts.alive?.() ?? true)) {
    opts.onProgress?.(received, first.size);
    const r = await read(received, CHUNK);
    if (r.bytes.length === 0) break;
    parts.push(r.bytes);
    received += r.bytes.length;
    more = r.truncated;
  }
  return { state: "ready", parts, size: received, type };
}

/** Same bytes in both: a re-read that changed nothing keeps what is on screen (a playing video goes on). */
export function sameBytes(a: Uint8Array, parts: readonly Uint8Array[]): boolean {
  let at = 0;
  for (const p of parts) {
    if (at + p.length > a.length) return false;
    for (let i = 0; i < p.length; i++) if (a[at + i] !== p[i]) return false;
    at += p.length;
  }
  return at === a.length;
}

/** Small images (icons, sprites) are drawn at a whole multiple, crisp, up to `min` px on their longer side. */
export function upscale(w: number, h: number, min = 96): number {
  const long = Math.max(w, h);
  if (long <= 0 || long >= min) return 1;
  return Math.max(1, Math.floor(min / long));
}

/** `1:05`, `12:40`, `1:02:03`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
