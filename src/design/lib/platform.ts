import { isTauri as tauriIsTauri } from "@tauri-apps/api/core";

/** True inside a Tauri webview (desktop or Android); false in a plain browser (e.g. `bun run dev`). */
export const isTauri: () => boolean = tauriIsTauri;

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isAndroid = /Android/i.test(ua);
export const isWindows = /Windows/i.test(ua);
/** macOS: the Tauri window keeps native traffic lights over the title bar (tauri.macos.conf.json). */
export const isMac = !isAndroid && /Macintosh|Mac OS X/i.test(ua);

/** Desktop Tauri window with custom chrome (TitleBar renders window controls). */
export function hasCustomWindowChrome(): boolean {
  return isTauri() && !isAndroid && !isMac;
}
