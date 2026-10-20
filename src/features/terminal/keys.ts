/*
 * Terminal key encoding for the send-keys toolbar and the mobile extra-keys row, plus the
 * latched (sticky) Ctrl/Alt modifiers that apply to the next key — typed or tapped.
 */

export type NamedKey = "esc" | "tab" | "enter" | "up" | "down" | "right" | "left" | "home" | "end" | "pgup" | "pgdn" | "backspace";

const BASE: Record<NamedKey, string> = {
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  backspace: "\x7f",
};

/** CSI final byte for cursor keys, used to build xterm modifier forms (`ESC [1;5A`). */
const CURSOR_FINAL: Partial<Record<NamedKey, string>> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };

export interface Mods {
  ctrl: boolean;
  alt: boolean;
}

const NO_MODS: Mods = { ctrl: false, alt: false };

/** Bytes for a named key with optional modifiers (xterm conventions). */
export function encodeKey(key: NamedKey, mods: Mods = NO_MODS): string {
  const final = CURSOR_FINAL[key];
  if (final && (mods.ctrl || mods.alt)) {
    // xterm modifier parameter: 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)
    return `\x1b[1;${1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)}${final}`;
  }
  if (key === "tab" && mods.ctrl) return "\x1b[9;5u";
  if (key === "tab" && !mods.alt && !mods.ctrl) return BASE.tab;
  const base = BASE[key];
  return mods.alt ? `\x1b${base}` : base;
}

/** Control character for a single typed character, or null when Ctrl has no meaning for it. */
function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); // @ A-Z [ \ ] ^ _
  if (ch === " " || ch === "2") return "\x00";
  if (ch === "?" || ch === "8") return "\x7f";
  if (ch === "/" || ch === "-" || ch === "7") return "\x1f";
  if (ch === "3") return "\x1b";
  if (ch === "4") return "\x1c";
  if (ch === "5") return "\x1d";
  if (ch === "6") return "\x1e";
  return null;
}

/**
 * Apply latched modifiers to typed data (from xterm `onData`, i.e. the soft keyboard).
 * Only a single printable character is modified; pasted text and escape sequences pass through
 * unchanged (cursor sequences get the xterm modifier form).
 */
export function applyMods(data: string, mods: Mods): string {
  if (!mods.ctrl && !mods.alt) return data;
  const cursor = /^\x1b\[([ABCDHF])$/.exec(data);
  if (cursor) {
    return `\x1b[1;${1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)}${cursor[1]}`;
  }
  // Single code point only (surrogate pairs count as one).
  if ([...data].length !== 1) return data;
  let out = data;
  if (mods.ctrl) out = ctrlChar(data) ?? data;
  if (mods.alt) out = `\x1b${out}`;
  return out;
}
