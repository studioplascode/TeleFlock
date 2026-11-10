import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "@/design";
import { inTauri } from "@/core/transport/tauri";

/**
 * The app's own help for documents (src-tauri `docs.rs`): the `tfdoc:` scheme that serves a sandboxed
 * page's wrapper with its own Content-Security-Policy (an `srcdoc` frame would inherit the app's,
 * which blocks inline scripts), and Open in browser (a temporary file the system opens).
 */

/** Pages are served through `tfdoc:` in the desktop app; the Android app shows them without scripts in `srcdoc` frames. */
export const servesDocuments = (): boolean => inTauri() && !isAndroid;

/** Open in browser: the desktop app (the Android WebView has no file handover). */
export const canOpenInBrowser = (): boolean => inTauri() && !isAndroid;

/** Stages a wrapper document; answers the URL its iframe loads. */
export function stageDocument(html: string): Promise<string> {
  return invoke<string>("doc_stage", { html });
}

export function releaseDocument(url: string): void {
  invoke("doc_release", { url }).catch(() => undefined);
}

function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Writes `data` (text, or a file's bytes) to a temporary file named `name` and opens it with the system's handler. */
export async function openInBrowser(name: string, data: { text: string } | { blob: Blob }): Promise<void> {
  const bytes = "text" in data ? new TextEncoder().encode(data.text) : new Uint8Array(await data.blob.arrayBuffer());
  await invoke("doc_open", { name, base64: base64Of(bytes) });
}
