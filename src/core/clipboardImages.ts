import { trackDraftWork } from "./draftFlush";
import { type DraftImage, MAX_DRAFT_IMAGES, updateDraftImages } from "./draftImages";

/*
 * Files out of a paste, a drop or a picker, and what each attaches to a prompt as
 * (`splitAttachments`): images go inline, every other file (videos, PDFs, text and code,
 * spreadsheets, Office and OpenDocument files, archives…) is uploaded to the host and named in the
 * prompt by its path there (`draftUploads.ts`, `upload.ts`). Engines disagree on where they put
 * pasted and dropped files: WebKitGTK (the Linux app) lists a pasted screenshot only in `items`
 * (`getAsFile()`), Chromium (WebView2, Android) in both `items` and `files`, and a drop from a file
 * manager in `files`. Then the composers' attach path for images (`attachImages`): very large images
 * scaled down, and the images of one prompt kept within the count and the relay's message size
 * (`fitImages`).
 */

/** The parts of `DataTransfer` read here (structural, so tests can pass plain objects). */
export interface TransferSource {
  items?: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile"> & { webkitGetAsEntry?(): Pick<FileSystemEntry, "isDirectory"> | null }> | null;
  files?: ArrayLike<File> | null;
}

/**
 * Files of a clipboard / drag payload that `keep` accepts, in order: those of `items`, or of
 * `files` when `items` lists none. Never both: Chromium hands out one pasted image as two File
 * objects, one per list, whose `lastModified` differ (each is stamped when it is made), so the
 * lists cannot be matched up and merging them attached every pasted image twice. A dropped folder
 * is listed as a file too, one nothing can read: it is left out (where the engine tells folders
 * apart, `webkitGetAsEntry`).
 */
function pickFiles(data: TransferSource | null | undefined, keep: (f: File) => boolean): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  let folders = 0;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folders++;
      continue;
    }
    const f = item.getAsFile();
    if (f) fromItems.push(f);
  }
  // Only folders in `items`: `files` would hand them over again.
  return (fromItems.length > 0 || folders > 0 ? fromItems : Array.from(data.files ?? [])).filter(keep);
}

/** The platform handed a file over without telling its type (some drops, Android providers): its extension has to. */
function untyped(f: Pick<File, "type">): boolean {
  return f.type === "" || f.type === "application/octet-stream";
}

/** Video containers by extension, for files the platform hands over without a type. */
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|3gp|mpe?g)$/i;
/** TypeScript sources, which platforms type by their extension as MPEG transport streams (`video/mp2t`). */
const TS_SOURCE = /\.[cm]?ts$/i;

/**
 * A video: a `video/*` type (not a TypeScript source taken for an MPEG transport stream), or a
 * video extension when the type is missing.
 */
export function isVideoFile(f: Pick<File, "name" | "type">): boolean {
  if (f.type.startsWith("video/")) return !(f.type === "video/mp2t" && TS_SOURCE.test(f.name));
  return untyped(f) && VIDEO_EXT.test(f.name);
}

/**
 * Images that go inline, by type: the formats omp hands models (its `SUPPORTED_IMAGE_MIME_TYPES`),
 * mapped to the type they are sent as. Any other image (SVG, HEIC, TIFF, BMP…) would be refused
 * inline, so it uploads like any file and the agent reads or converts it there.
 */
const INLINE_TYPES: Readonly<Record<string, string>> = { "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/gif": "image/gif", "image/webp": "image/webp" };
/** The same formats by extension, for files the platform hands over without a type. */
const INLINE_EXT: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The type an image goes inline with (by its type, else its extension); null for every file that uploads. */
function inlineImageType(f: Pick<File, "name" | "type">): string | null {
  if (!untyped(f)) return INLINE_TYPES[f.type] ?? null;
  const dot = f.name.lastIndexOf(".");
  return dot > 0 ? (INLINE_EXT[f.name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/**
 * What `files` attach to a prompt as, in order: `images` inline (`INLINE_TYPES`; one handed over
 * without a type, or as `image/jpg`, gets the type it is sent as, so it is read, scaled and sent
 * as what it is), `uploads` to the host as files: videos and every other file (`draftUploads.ts`).
 */
export function splitAttachments(files: Iterable<File>): { images: File[]; uploads: File[] } {
  const images: File[] = [];
  const uploads: File[] = [];
  for (const f of files) {
    const type = inlineImageType(f);
    if (!type) uploads.push(f);
    else images.push(type === f.type ? f : new File([f], f.name, { type, lastModified: f.lastModified }));
  }
  return { images, uploads };
}

/** Image files of a clipboard / drag payload, each once, in order (`items`, else `files`). */
export function imageFiles(data: TransferSource | null | undefined): File[] {
  return pickFiles(data, (f) => f.type.startsWith("image/"));
}

/** Every file of a clipboard / drag payload, as `imageFiles` (dropped folders left out). */
export function transferFiles(data: TransferSource | null | undefined): File[] {
  return pickFiles(data, () => true);
}

/** A drag carries files (drag-over: their contents are not readable yet, only their kind). */
export function dragHasFiles(data: Pick<TransferSource, "items"> | null | undefined): boolean {
  return Array.from(data?.items ?? []).some((i) => i.kind === "file");
}

/** Images larger than this are scaled down before they are attached (when the platform can). */
export const SHRINK_ABOVE_BYTES = 3 * 1024 * 1024;
/** Longest edge of a scaled-down image (still sharp for screenshots of a 4K screen's half). */
const MAX_EDGE = 2560;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * A very large image (> 3 MB) scaled to ≤ 2560 px on its longest edge and re-encoded (PNG stays
 * PNG unless that is still too big, then JPEG). Returns the original when it is small, a GIF
 * (animation would be lost), not decodable here, or not actually smaller after the work.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (file.size <= SHRINK_ABOVE_BYTES || file.type === "image/gif" || typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return file;
    }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    let blob = await toBlob(canvas, file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
    if (blob && blob.size > SHRINK_ABOVE_BYTES && blob.type === "image/png") blob = await toBlob(canvas, "image/jpeg", 0.88);
    if (!blob || blob.size >= file.size) return file;
    const ext = blob.type === "image/png" ? ".png" : ".jpg";
    return new File([blob], `${file.name.replace(/\.[^.]*$/, "") || "image"}${ext}`, { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/**
 * Base64 characters of images per prompt (session prompt or Dispatch task). The request carries
 * them to the host in one relay message (16 MiB cap), so they stay well under it with room for
 * the rest of the request.
 */
export const MAX_PROMPT_IMAGE_CHARS = 12 * 1024 * 1024;

/** Sum of base64 characters (what the request carries). */
export function imageChars(images: readonly Pick<DraftImage, "data">[]): number {
  return images.reduce((n, i) => n + i.data.length, 0);
}

/** Why images were left out of a prompt, for a toast. */
export const IMAGES_TOO_LARGE = `The images of one prompt stay under ${Math.round((MAX_PROMPT_IMAGE_CHARS * 3) / 4 / 1024 / 1024)} MB in total (the host connection's message limit).`;

/** A file as a prompt image (base64, with a data: URL preview). */
async function fileToImageInput(file: File): Promise<DraftImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const mime = file.type || "image/png";
  const data = btoa(bin);
  return { mime, data, preview: `data:${mime};base64,${data}` };
}

/** Image files read as prompt images, very large ones scaled down first (`shrinkImage`). No draft is touched. */
export async function readImages(files: readonly File[]): Promise<DraftImage[]> {
  const out: DraftImage[] = [];
  // One at a time: a batch of big screenshots decoded at once is a lot of memory.
  for (const f of files) if (f.type.startsWith("image/")) out.push(await fileToImageInput(await shrinkImage(f)));
  return out;
}

/**
 * `incoming` appended to `current` within a prompt's caps (`MAX_DRAFT_IMAGES` images,
 * `MAX_PROMPT_IMAGE_CHARS` in total); `skipped` says why some were left out. Pure: run it inside
 * the draft's update so it checks against the images attached by then.
 */
export function fitImages(current: readonly DraftImage[], incoming: readonly DraftImage[]): { images: DraftImage[]; skipped?: string } {
  const images = [...current];
  let chars = imageChars(current);
  let skipped: string | undefined;
  for (const img of incoming) {
    if (images.length >= MAX_DRAFT_IMAGES) {
      skipped = `A prompt takes at most ${MAX_DRAFT_IMAGES} images.`;
      break;
    }
    if (chars + img.data.length > MAX_PROMPT_IMAGE_CHARS) {
      skipped = IMAGES_TOO_LARGE;
      continue;
    }
    chars += img.data.length;
    images.push(img);
  }
  return skipped ? { images, skipped } : { images };
}

/**
 * Read `files` (scaled down when very large) and add them to draft `key`'s images within the
 * caps, checked against the images attached by the time they are read (pastes can overlap).
 * Returns how many were added and why others were left out. A flush (`flushAll`: the app about
 * to restart) waits for the reading.
 */
export function attachImages(key: string, files: readonly File[]): Promise<{ added: number; skipped?: string }> {
  return trackDraftWork(
    readImages(files).then((loaded) => {
      const out: { added: number; skipped?: string } = { added: 0 };
      updateDraftImages(key, (cur) => {
        const fit = fitImages(cur, loaded);
        out.added = fit.images.length - cur.length;
        out.skipped = fit.skipped;
        return fit.images;
      });
      return out;
    }),
  );
}
