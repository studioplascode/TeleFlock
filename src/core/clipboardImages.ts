/*
 * Image files out of a paste or a drop. Browsers disagree on where they put them: Chromium lists
 * a pasted screenshot in both `files` and `items`, WebKitGTK (the Linux app) often only in
 * `items` (`getAsFile()`), and a drop from a file manager in `files`. Both are read and merged.
 */

/** The parts of `DataTransfer` read here (structural, so tests can pass plain objects). */
export interface ImageSource {
  items?: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">> | null;
  files?: ArrayLike<File> | null;
}

/** Image files of a clipboard / drag payload: `items` and `files`, deduplicated, in order. */
export function imageFiles(data: ImageSource | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    // The same image listed in both: `getAsFile()` returns a new File object each time.
    const id = `${f.name}\u0000${f.size}\u0000${f.type}\u0000${f.lastModified}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(f);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) add(item.getAsFile());
  }
  for (const f of Array.from(data.files ?? [])) add(f);
  return out;
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
