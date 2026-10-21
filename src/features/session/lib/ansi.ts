import type { CSSProperties } from "react";
import { lruMemo } from "./lru";

/**
 * ANSI SGR → styled segments. Handles 16/256/truecolor fg/bg, bold, dim, italic, underline,
 * inverse and strikethrough; strips every other escape (cursor moves, OSC titles, …) and
 * resolves carriage-return overwrites line by line so progress bars render as their final state.
 */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

/** Dark-theme tuned base palette (normal 0-7, bright 8-15). */
const BASE: readonly string[] = [
  "#3b3b4f", "#ff6b8b", "#a3e635", "#fbbf24", "#7fa2e7", "#c084fc", "#22d3ee", "#dcdce4",
  "#6e6e82", "#ff8aa5", "#bef264", "#fde68a", "#a5c0f5", "#d8b4fe", "#67e8f9", "#ffffff",
];

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return BASE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(i / 36) % 6] ?? 0;
  const g = steps[Math.floor(i / 6) % 6] ?? 0;
  const b = steps[i % 6] ?? 0;
  return `rgb(${r} ${g} ${b})`;
}

function applySgr(params: number[], s: AnsiStyle): AnsiStyle {
  let style = { ...s };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) style = {};
    else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 7) style.inverse = true;
    else if (p === 9) style.strike = true;
    else if (p === 22) style.bold = style.dim = false;
    else if (p === 23) style.italic = false;
    else if (p === 24) style.underline = false;
    else if (p === 27) style.inverse = false;
    else if (p === 29) style.strike = false;
    else if (p >= 30 && p <= 37) style.fg = BASE[p - 30];
    else if (p === 39) style.fg = undefined;
    else if (p >= 40 && p <= 47) style.bg = BASE[p - 40];
    else if (p === 49) style.bg = undefined;
    else if (p >= 90 && p <= 97) style.fg = BASE[p - 90 + 8];
    else if (p >= 100 && p <= 107) style.bg = BASE[p - 100 + 8];
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let c: string | undefined;
      if (mode === 5) {
        c = color256(params[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        c = `rgb(${params[i + 2] ?? 0} ${params[i + 3] ?? 0} ${params[i + 4] ?? 0})`;
        i += 4;
      }
      if (p === 38) style.fg = c;
      else style.bg = c;
    }
  }
  return style;
}

/** Resolve `\r` overwrites: within each line keep what the last carriage return wrote. */
function resolveCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      // Later writes overwrite earlier ones from column 0.
      let out = "";
      for (const part of parts) out = part + out.slice(visibleLength(part));
      return out;
    })
    .join("\n");
}

function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

// CSI, OSC (BEL or ST terminated) and lone two-byte escapes.
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;?:]*)([A-Za-z@`])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOc]/g;

/** ANSI → styled segments (memoised; treat the result as immutable). */
export const parseAnsi: (input: string) => AnsiSegment[] = lruMemo(400, parseAnsiUncached);

function parseAnsiUncached(input: string): AnsiSegment[] {
  const text = resolveCarriageReturns(input);
  const out: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    // Drop other control chars except tab/newline.
    // eslint-disable-next-line no-control-regex
    const clean = chunk.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (!clean) return;
    const prev = out[out.length - 1];
    if (prev && prev.style === style) prev.text += clean;
    else out.push({ text: clean, style });
  };
  ESC_RE.lastIndex = 0;
  for (let m = ESC_RE.exec(text); m; m = ESC_RE.exec(text)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === "m") {
      const params = (m[1] ?? "")
        .split(/[;:]/)
        .filter((x) => x !== "")
        .map((x) => Number.parseInt(x, 10))
        .filter((x) => Number.isFinite(x));
      style = applySgr(params, style);
    }
  }
  push(text.slice(last));
  return out;
}

/** Plain text without escapes (for copy, search, detection). */
export function stripAnsi(input: string): string {
  return parseAnsi(input)
    .map((s) => s.text)
    .join("");
}

export function ansiCss(style: AnsiStyle): CSSProperties | undefined {
  if (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse && !style.strike) return undefined;
  const fg = style.inverse ? (style.bg ?? "#0b0b10") : style.fg;
  const bg = style.inverse ? (style.fg ?? "#dcdce4") : style.bg;
  const deco = [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: style.bold ? 700 : undefined,
    opacity: style.dim ? 0.6 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}
