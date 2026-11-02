/** Base64 ⇄ bytes for screencast frames and favicons (no `Uint8Array.fromBase64` in every webview yet). */

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Decodes a base64 JPEG frame off the main thread where the webview can (`createImageBitmap`). */
export async function decodeFrame(b64: string): Promise<ImageBitmap | HTMLImageElement> {
  const bytes = decodeBase64(b64);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads a picked file as base64 (for `browser.stageFile`). */
export async function fileBase64(file: Blob): Promise<string> {
  return encodeBase64(new Uint8Array(await file.arrayBuffer()));
}
