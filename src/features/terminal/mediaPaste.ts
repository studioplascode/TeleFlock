import { type ImageSource, mediaFiles } from "@/core/clipboardImages";

/*
 * Images and videos pasted, dropped or picked into a terminal reach its pane as their host paths,
 * the way a native terminal pastes a dropped file's path: each file is uploaded to the host
 * (`@/core/upload`), then the absolute paths go in as one bracketed paste. omp's editor turns a
 * paste made only of image / video paths into attachments (pi-tui `extractImagePastePathsFromText`:
 * `[Image #1]`, a contact sheet for a video); a shell just gets the text.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Characters a POSIX shell and omp's paste-path parser both read literally outside quotes. */
const BARE_PATH = /^[\p{L}\p{N}_./:@%+=,-]+$/u;

/**
 * A host path as pasted text. Bare when every character is literal to a shell and to omp's parser;
 * else single-quoted, or double-quoted with `\ " $ `` ` escaped when it holds a single quote. pi-tui
 * strips either quoting (`normalizePastedPath`), as a POSIX shell does.
 */
export function quotePath(path: string): string {
  if (BARE_PATH.test(path)) return path;
  if (!path.includes("'")) return `'${path}'`;
  return `"${path.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** Paths as one line of text: quoted, space-separated (pi-tui splits on unquoted whitespace). */
export function pathsText(paths: readonly string[]): string {
  return paths.map(quotePath).join(" ");
}

/**
 * Terminal input that pastes `paths` as one complete bracketed paste, whatever xterm believes:
 * herdr's re-rendered frames never carry the pane's DEC 2004 state, so `term.paste()` would always
 * send bare keystrokes. herdr unwraps a complete bracketed paste from an attached client and wraps
 * it again only when the pane's program turned bracketed paste on (omp, readline, zle); any other
 * program gets the bare text. A trailing space keeps the next paste or word apart, as native
 * terminals do after a drop (omp trims it).
 */
export function pastePathsInput(paths: readonly string[]): string {
  return `${PASTE_START}${pathsText(paths)} ${PASTE_END}`;
}

/**
 * Terminal input that pastes `text` the same way (one complete bracketed paste, see
 * {@link pastePathsInput}), so line breaks reach omp as part of the paste instead of as Enter: with
 * `term.paste()` a multi-line paste submitted its first line. Line breaks become `\r` as xterm sends
 * them. ESC characters are dropped, so clipboard text can never end the paste early (or rebuild
 * the end marker from pieces) and have the rest typed as keystrokes.
 */
export function pasteTextInput(text: string): string {
  const body = text.replaceAll("\x1b", "").replace(/\r?\n/g, "\r");
  return `${PASTE_START}${body}${PASTE_END}`;
}

/** Images and videos by MIME type. */
export function isMediaType(type: string): boolean {
  return type.startsWith("image/") || type.startsWith("video/");
}

/** How the upload indicator names a file: its name, else what it is (a pasted bitmap has none). */
export function mediaLabel(file: Blob & { name?: string }): string {
  return file.name || (file.type.startsWith("video/") ? "video" : "image");
}

/** The media files of a paste event, when its clipboard holds no text (text pastes as before). */
export function pastedMedia(data: (ImageSource & Pick<DataTransfer, "getData">) | null | undefined): File[] {
  if (!data || data.getData("text/plain").trim()) return [];
  return mediaFiles(data);
}

/** The parts of `ClipboardItem` read here (structural, so tests can pass plain objects). */
export interface ClipItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

export interface ClipContent {
  text: string;
  /** Images / videos, only when there is no text. */
  media: Blob[];
}

/**
 * Text and media of async Clipboard API items. Text wins, as in a paste event; otherwise one blob
 * per item (an item's types are renditions of the same content).
 */
export async function readClipItems(items: readonly ClipItem[]): Promise<ClipContent> {
  let text = "";
  for (const item of items) {
    if (item.types.includes("text/plain")) text += await (await item.getType("text/plain")).text();
  }
  const media: Blob[] = [];
  if (text.trim()) return { text, media };
  for (const item of items) {
    const type = item.types.find(isMediaType);
    if (type) media.push(await item.getType(type));
  }
  return { text, media };
}

/**
 * The clipboard for a Paste button: `read()` (text and images) where the webview has and allows it,
 * else `readText()`. Rejects when clipboard access is denied.
 */
export async function readClipboard(clip: Pick<Clipboard, "readText"> & { read?: () => Promise<readonly ClipItem[]> } = navigator.clipboard): Promise<ClipContent> {
  if (typeof clip.read === "function") {
    try {
      return await readClipItems(await clip.read());
    } catch {
      // Not allowed, or a type this webview can't read: fall back to plain text.
    }
  }
  return { text: await clip.readText(), media: [] };
}
