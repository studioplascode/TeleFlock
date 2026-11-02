import { invoke } from "@tauri-apps/api/core";
import { isAndroid, isTauri } from "@/design";

/*
 * Getting the poster out: a download (browsers; desktop webviews save it to the Downloads folder),
 * the clipboard (paste it into any chat) and the share sheet: the Android app's own (its WebView has
 * neither downloads nor Web Share), else the browser's where it takes files.
 */

/** The Android app: no downloads, its share sheet instead. */
export const inAndroidApp = isTauri() && isAndroid;

/** The clipboard takes images here. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copies a PNG. The write starts inside the click with the image still being drawn (a promise):
 * WebKit only accepts clipboard writes that begin in the user's gesture.
 */
export async function copyPng(png: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** A share sheet takes image files here: the Android app's, or the browser's (phones, some desktops). */
export function canShareFiles(): boolean {
  if (inAndroidApp) return true;
  if (typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

/** Opens the share sheet with the PNG. The browser's rejects with an `AbortError` when the user closes it. */
export async function sharePng(blob: Blob, name: string, text: string): Promise<void> {
  if (inAndroidApp) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await invoke("plugin:teleflock-android|share_image", { name, data: btoa(bin), text });
    return;
  }
  await navigator.share({ files: [new File([blob], name, { type: "image/png" })], title: "Flock Wrapped", text });
}
