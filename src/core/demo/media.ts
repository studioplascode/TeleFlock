/**
 * Binary files behind the demo host's image, video, audio and PDF changes, so Review's previews
 * show something real: their patches say "Binary files … differ" as git's do (with blob ids, except
 * for untracked files), `fs.read` answers the working tree's bytes and `git.show` the base's, in
 * ranges like a host. The bytes live in `mediaData.ts`, loaded with the first read.
 */
import type { ChangedFile, FileStatus } from "@/core/gen";
import type * as MediaData from "./mediaData";
import { hash } from "./rng";

type DataKey = keyof typeof MediaData;

interface DemoMedia {
  status: FileStatus;
  mime: string;
  /** The base's version (`git.show`), absent for a new file. */
  before?: DataKey;
  /** The working tree's (`fs.read`), absent for a deleted file. */
  after?: DataKey | "fakeDb";
}

const MEDIA: Record<string, DemoMedia> = {
  "docs/board-preview.png": { status: "untracked", mime: "image/png", after: "BOARD_PREVIEW_PNG" },
  "public/og-image.png": { status: "modified", mime: "image/png", before: "OG_BEFORE_PNG", after: "OG_AFTER_PNG" },
  "docs/prototype-board.png": { status: "deleted", mime: "image/png", before: "PROTOTYPE_BOARD_PNG" },
  "docs/board-tour.webm": { status: "added", mime: "video/webm", after: "BOARD_TOUR_WEBM" },
  "public/sounds/card-drop.wav": { status: "untracked", mime: "audio/wav", after: "CARD_DROP_WAV" },
  "docs/board-guide.pdf": { status: "added", mime: "application/pdf", after: "BOARD_GUIDE_PDF" },
  // Binary, but nothing a webview shows: Review says what it is and how big.
  "src/features/board/columns.sqlite": { status: "added", mime: "application/octet-stream", after: "fakeDb" },
};

/** The demo path `abs` ends with (`<worktree>/docs/board-tour.webm` → `docs/board-tour.webm`). */
export function demoMediaPath(abs: string): string | undefined {
  return Object.keys(MEDIA).find((p) => abs === p || abs.endsWith(`/${p}`));
}

/** A `ChangedFile` for a demo binary file (numstat counts no lines for binary files). */
export function demoMediaFile(path: string): ChangedFile {
  const m = MEDIA[path];
  if (!m) throw new Error(`no demo media ${path}`);
  return { path, added: 0, removed: 0, status: m.status };
}

/** git's patch of a binary file: blob ids on the index line (none for an untracked file, as hostd writes it). */
export function demoMediaPatch(path: string): string | null {
  const m = MEDIA[path];
  if (!m) return null;
  const oid = (side: string) => (hash(`${path}:${side}`) >>> 0).toString(16).padStart(8, "0").slice(0, 7);
  const out = [`diff --git a/${path} b/${path}`];
  if (m.status === "untracked") out.push("new file mode 100644");
  else {
    if (m.status === "added") out.push("new file mode 100644");
    if (m.status === "deleted") out.push("deleted file mode 100644");
    out.push(`index ${m.before ? oid("before") : "0000000"}..${m.after ? oid("after") : "0000000"}${m.status === "modified" ? " 100644" : ""}`);
  }
  out.push(`Binary files ${m.before ? `a/${path}` : "/dev/null"} and ${m.after ? `b/${path}` : "/dev/null"} differ`);
  return out.join("\n");
}

/** A SQLite file's header and empty pages: 12 KiB that are no image. */
function fakeDb(): Uint8Array {
  const b = new Uint8Array(12 * 1024);
  b.set(new TextEncoder().encode("SQLite format 3\0"));
  b[16] = 0x10;
  for (let i = 4096; i < b.length; i += 4096) b[i] = 0x0d;
  return b;
}

const decoded = new Map<string, Uint8Array>();

async function bytesOf(key: DataKey | "fakeDb"): Promise<Uint8Array> {
  let b = decoded.get(key);
  if (!b) {
    // Loaded on first use: the demo host is in every bundle, its media only matter to Review.
    b = key === "fakeDb" ? fakeDb() : Uint8Array.from(atob((await import("./mediaData"))[key]), (c) => c.charCodeAt(0));
    decoded.set(key, b);
  }
  return b;
}

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface DemoMediaRange {
  size: number;
  base64: string;
  mime: string;
  /** The read's start; absent when none was asked for (a plain `fs.read`). */
  offset?: number;
  truncated: boolean;
}

/**
 * `maxBytes` bytes (default 512 KiB, at most 8 MiB, as hostd) of a demo file's version from
 * `offset`. Undefined at once when the demo has no such version, so a caller can throw its error
 * before any wait.
 */
export function demoMediaRead(path: string, side: "before" | "after", offset: number | undefined, maxBytes: number | undefined): Promise<DemoMediaRange> | undefined {
  const m = MEDIA[path];
  const key = m?.[side];
  if (!m || !key) return undefined;
  return bytesOf(key).then((bytes) => {
    const start = Math.min(Math.max(0, offset ?? 0), bytes.length);
    const chunk = bytes.subarray(start, start + Math.min(Math.max(1, maxBytes ?? 512 * 1024), 8 << 20));
    return { size: bytes.length, base64: base64(chunk), mime: m.mime, ...(offset === undefined ? {} : { offset: start }), truncated: start + chunk.length < bytes.length };
  });
}
