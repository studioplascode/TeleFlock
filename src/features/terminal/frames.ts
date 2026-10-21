/*
 * Frame decoding (base64 ANSI → bytes) and localhost URL scanning.
 */

// `Uint8Array.fromBase64` (ES2026) is not in the TS lib yet; feature-detect it.
const nativeFromBase64: ((s: string) => Uint8Array) | null =
  "fromBase64" in Uint8Array && typeof Uint8Array.fromBase64 === "function"
    ? (Uint8Array.fromBase64 as (s: string) => Uint8Array).bind(Uint8Array)
    : null;

/** Base64 → bytes. Uses `Uint8Array.fromBase64` where available. */
export function decodeBase64(b64: string): Uint8Array {
  if (nativeFromBase64) return nativeFromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextDecoder();

// CSI … final, OSC … BEL/ST, other two-byte ESC sequences, and C0 controls (except LF).
// Cursor positioning (CUP/HVP/CHA/VPA, `H f G d`) and CR become a newline so absolutely positioned
// rows of a re-rendered viewport don't glue together.
const ESCAPES = /\x1b\[[0-9;?<>=!]*[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x09\x0b-\x1f\x7f]/g;

/** Visible text of an ANSI byte stream, rows separated by newlines. */
export function ansiToText(bytes: Uint8Array): string {
  return utf8.decode(bytes).replace(ESCAPES, (m, final: string | undefined) => {
    if (final === "H" || final === "f" || final === "d" || final === "G" || m === "\r") return "\n";
    if (final === "C") return " ";
    return "";
  });
}

export interface LocalhostUrl {
  url: string;
  host: string;
  port: number;
  /** ms epoch when last seen in the output. */
  seenAt: number;
}

const URL_RE = /\b(?:(https?):\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s"'<>()`]*)?/gi;

/** Localhost URLs in a text with their string ranges `[start, end)` (terminal link provider). */
export function localhostUrlRanges(text: string): { url: string; host: string; port: number; start: number; end: number }[] {
  const out: { url: string; host: string; port: number; start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const port = Number(m[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host = (m[2] ?? "localhost").toLowerCase();
    // A bare `localhost:1234` without scheme is only a URL when it isn't part of a word/path.
    const scheme = (m[1] ?? "http").toLowerCase();
    const rawPath = m[4] ?? "";
    const path = rawPath.replace(/[.,;:!?]+$/, "");
    const shownHost = host === "0.0.0.0" ? "localhost" : host;
    const start = m.index ?? 0;
    out.push({ url: `${scheme}://${shownHost}:${port}${path}`, host: shownHost, port, start, end: start + m[0].length - (rawPath.length - path.length) });
  }
  return out;
}

/** Every `http://localhost:PORT` / `127.0.0.1:PORT` (scheme optional) in a text, in order. */
export function findLocalhostUrls(text: string, seenAt = Date.now()): LocalhostUrl[] {
  return localhostUrlRanges(text).map(({ url, host, port }) => ({ url, host, port, seenAt }));
}
