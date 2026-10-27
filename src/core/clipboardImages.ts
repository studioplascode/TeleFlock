import { type DraftImage, MAX_DRAFT_IMAGES, updateDraftImages } from "./draftImages";

/*
 * Image (and video) files out of a paste or a drop. Browsers disagree on where they put them:
 * Chromium lists a pasted screenshot in both `files` and `items`, WebKitGTK (the Linux app) often
 * only in `items` (`getAsFile()`), and a drop from a file manager in `files`. Both are read and
 * merged. Then the composers' attach path for images (`attachImages`): very large images scaled
 * down, and the images of one prompt kept within the count and the relay's message size
 * (`fitImages`). Videos are uploaded to the host instead (`draftVideos.ts`, `upload.ts`).
 */

/** The parts of `DataTransfer` read here (structural, so tests can pass plain objects). */
export interface ImageSource {
  items?: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">> | null;
  files?: ArrayLike<File> | null;
}

/** Files of a clipboard / drag payload that `keep` accepts: `items` and `files`, deduplicated, in order. */
function pickFiles(data: ImageSource | null | undefined, keep: (f: File) => boolean): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null | undefined) => {
    if (!f || !keep(f)) return;
    // The same file listed in both: `getAsFile()` returns a new File object each time.
    const id = `${f.name}\u0000${f.size}\u0000${f.type}\u0000${f.lastModified}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(f);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") add(item.getAsFile());
  }
  for (const f of Array.from(data.files ?? [])) add(f);
  return out;
}

/** Video containers by extension, for files the platform hands over without a type. */
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|3gp|mpe?g)$/i;

/** A video: a `video/*` type, or a video extension when the type is missing (some drops, Android providers). */
export function isVideoFile(f: Pick<File, "name" | "type">): boolean {
  return f.type.startsWith("video/") || ((f.type === "" || f.type === "application/octet-stream") && VIDEO_EXT.test(f.name));
}

/** Image files of a clipboard / drag payload: `items` and `files`, deduplicated, in order. */
export function imageFiles(data: ImageSource | null | undefined): File[] {
  return pickFiles(data, (f) => f.type.startsWith("image/"));
}

/** Video files of a clipboard / drag payload (see `isVideoFile`), as `imageFiles`. */
export function videoFiles(data: ImageSource | null | undefined): File[] {
  return pickFiles(data, isVideoFile);
}

/** Image and video files of a clipboard / drag payload, as `imageFiles`. */
export function mediaFiles(data: ImageSource | null | undefined): File[] {
  return pickFiles(data, (f) => f.type.startsWith("image/") || isVideoFile(f));
}

/** A drag carries files (drag-over: their contents are not readable yet, only their kind). */
export function dragHasFiles(data: Pick<ImageSource, "items"> | null | undefined): boolean {
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

/** Image files read as prompt images, very large ones scaled down first (`shrinkImage`). */
async function readImages(files: readonly File[]): Promise<DraftImage[]> {
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
 * Returns how many were added and why others were left out.
 */
export async function attachImages(key: string, files: readonly File[]): Promise<{ added: number; skipped?: string }> {
  const loaded = await readImages(files);
  const out: { added: number; skipped?: string } = { added: 0 };
  updateDraftImages(key, (cur) => {
    const fit = fitImages(cur, loaded);
    out.added = fit.images.length - cur.length;
    out.skipped = fit.skipped;
    return fit.images;
  });
  return out;
}
