/**
 * What a browser's CSS tokenizer sees in a theme (CSS Syntax Level 3 §4), as far as the theme
 * checks need it: comments, strings, `url()` tokens, function names, at-keywords and blocks. Names
 * and values come out with escapes decoded (`\75rl(` is `url(`, `@\69mport` is `@import`), and a
 * comment is only a comment where a browser reads one: never inside a string or an unquoted
 * `url()`. Everything else (identifiers, numbers, whitespace, delimiters) is consumed the same way
 * a browser does, so token boundaries match, and left out. Pure, no DOM.
 */

export type CssToken =
  | { type: "comment"; start: number; end: number; closed: boolean }
  /** `closed` false: the string ran into a newline (a bad string) or the end of the text. */
  | { type: "string"; value: string; start: number; end: number; closed: boolean }
  /** An unquoted `url(…)`; `bad` when it holds a quote, `(`, whitespace inside or a broken escape, which a browser drops. */
  | { type: "url"; value: string; start: number; end: number; bad: boolean }
  /** A function token (`name(`), the name lowercased. A quoted `url("…")` is the function `url`. */
  | { type: "function"; name: string; start: number; end: number }
  /** `@name`, lowercased. */
  | { type: "at-keyword"; name: string; start: number; end: number }
  | { type: "open"; char: "(" | "[" | "{"; start: number }
  | { type: "close"; char: ")" | "]" | "}"; start: number };

const isNewline = (c: string | undefined) => c === "\n" || c === "\r" || c === "\f";
const isWhitespace = (c: string | undefined) => c === " " || c === "\t" || isNewline(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const HEX = /^[0-9a-fA-F]$/;
function isIdentStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code >= 0x80 || c === "_";
}
/** The spec's non-printable code points: a raw one inside an unquoted url() breaks it. */
function isNonPrintable(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
}

/** A `\` at `i` that starts an escape (not followed by a newline). */
const validEscape = (css: string, i: number) => css[i] === "\\" && !isNewline(css[i + 1]);

/** The code point an escape stands for; `i` is just past the `\`. Returns it and the index after it. */
function escape(css: string, i: number): [string, number] {
  if (i >= css.length) return ["\uFFFD", i];
  if (HEX.test(css[i] ?? "")) {
    let j = i;
    while (j < css.length && j - i < 6 && HEX.test(css[j] ?? "")) j++;
    const n = Number.parseInt(css.slice(i, j), 16);
    // one whitespace after the hex digits belongs to the escape (CRLF is one newline)
    if (css[j] === "\r" && css[j + 1] === "\n") j += 2;
    else if (isWhitespace(css[j])) j++;
    return [String.fromCodePoint(n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff ? 0xfffd : n), j];
  }
  const cp = String.fromCodePoint(css.codePointAt(i) ?? 0xfffd);
  return [cp, i + cp.length];
}

/** Would the text at `i` start an identifier? */
function startsIdent(css: string, i: number): boolean {
  const c = css[i];
  if (c === "-") return isIdentStart(css[i + 1]) || css[i + 1] === "-" || validEscape(css, i + 1);
  if (c === "\\") return validEscape(css, i);
  return isIdentStart(c);
}

function startsNumber(css: string, i: number): boolean {
  const c = css[i];
  if (c === "+" || c === "-") return isDigit(css[i + 1]) || (css[i + 1] === "." && isDigit(css[i + 2]));
  if (c === ".") return isDigit(css[i + 1]);
  return isDigit(c);
}

/** An identifier starting at `i` (which `startsIdent`), escapes decoded. */
function ident(css: string, i: number): [string, number] {
  let out = "";
  while (i < css.length) {
    const c = css[i];
    if (isIdentStart(c) || isDigit(c) || c === "-") {
      out += c;
      i++;
    } else if (validEscape(css, i)) {
      const [cp, next] = escape(css, i + 1);
      out += cp;
      i = next;
    } else break;
  }
  return [out, i];
}

/** A number and its unit or `%`; returns the index after it. */
function numeric(css: string, i: number): number {
  if (css[i] === "+" || css[i] === "-") i++;
  while (isDigit(css[i])) i++;
  if (css[i] === "." && isDigit(css[i + 1])) {
    i += 2;
    while (isDigit(css[i])) i++;
  }
  const e = css[i];
  if ((e === "e" || e === "E") && (isDigit(css[i + 1]) || ((css[i + 1] === "+" || css[i + 1] === "-") && isDigit(css[i + 2])))) {
    i += 2;
    while (isDigit(css[i])) i++;
  }
  if (startsIdent(css, i)) return ident(css, i)[1];
  return css[i] === "%" ? i + 1 : i;
}

/** A string whose opening quote is at `start`. */
function string(css: string, start: number): CssToken & { type: "string" } {
  const quote = css[start];
  let value = "";
  let i = start + 1;
  while (i < css.length) {
    const c = css[i] as string;
    if (c === quote) return { type: "string", value, start, end: i + 1, closed: true };
    if (isNewline(c)) return { type: "string", value, start, end: i, closed: false };
    if (c === "\\") {
      const next = css[i + 1];
      if (next === undefined) i++;
      else if (isNewline(next)) i += next === "\r" && css[i + 2] === "\n" ? 3 : 2;
      else {
        const [cp, after] = escape(css, i + 1);
        value += cp;
        i = after;
      }
      continue;
    }
    value += c;
    i++;
  }
  return { type: "string", value, start, end: css.length, closed: false };
}

/** The rest of a broken `url(`: up to and including its `)`. */
function badUrlEnd(css: string, i: number): number {
  while (i < css.length) {
    if (css[i] === ")") return i + 1;
    i = validEscape(css, i) ? escape(css, i + 1)[1] : i + 1;
  }
  return css.length;
}

/** An unquoted url; `i` is just past `url(`. */
function url(css: string, start: number, i: number): CssToken & { type: "url" } {
  while (isWhitespace(css[i])) i++;
  let value = "";
  while (i < css.length) {
    const c = css[i] as string;
    if (c === ")") return { type: "url", value, start, end: i + 1, bad: false };
    if (isWhitespace(c)) {
      while (isWhitespace(css[i])) i++;
      if (i >= css.length) break;
      if (css[i] === ")") return { type: "url", value, start, end: i + 1, bad: false };
      return { type: "url", value, start, end: badUrlEnd(css, i), bad: true };
    }
    if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) return { type: "url", value, start, end: badUrlEnd(css, i), bad: true };
    if (c === "\\") {
      if (!validEscape(css, i)) return { type: "url", value, start, end: badUrlEnd(css, i), bad: true };
      const [cp, next] = escape(css, i + 1);
      value += cp;
      i = next;
      continue;
    }
    value += c;
    i++;
  }
  return { type: "url", value, start, end: css.length, bad: false };
}

export function tokenize(css: string): CssToken[] {
  const out: CssToken[] = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i] as string;
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close < 0 ? css.length : close + 2;
      out.push({ type: "comment", start: i, end, closed: close >= 0 });
      i = end;
    } else if (c === '"' || c === "'") {
      const s = string(css, i);
      out.push(s);
      i = s.end;
    } else if (c === "(" || c === "[" || c === "{") {
      out.push({ type: "open", char: c, start: i });
      i++;
    } else if (c === ")" || c === "]" || c === "}") {
      out.push({ type: "close", char: c, start: i });
      i++;
    } else if (c === "#") {
      const n = css[i + 1];
      i = isIdentStart(n) || isDigit(n) || n === "-" || validEscape(css, i + 1) ? ident(css, i + 1)[1] : i + 1;
    } else if (c === "@") {
      if (startsIdent(css, i + 1)) {
        const [name, next] = ident(css, i + 1);
        out.push({ type: "at-keyword", name: name.toLowerCase(), start: i, end: next });
        i = next;
      } else i++;
    } else if (startsNumber(css, i)) {
      i = numeric(css, i);
    } else if (c === "-" && css[i + 1] === "-" && css[i + 2] === ">") {
      i += 3; // CDC
    } else if (c === "<" && css.startsWith("!--", i + 1)) {
      i += 4; // CDO
    } else if (startsIdent(css, i)) {
      const [name, next] = ident(css, i);
      if (css[next] !== "(") {
        i = next;
        continue;
      }
      const lower = name.toLowerCase();
      let j = next + 1;
      if (lower === "url") {
        // url( + optional whitespace + a quote is the function url(); anything else is a url token
        while (isWhitespace(css[j]) && isWhitespace(css[j + 1])) j++;
        const q = isWhitespace(css[j]) ? css[j + 1] : css[j];
        if (q !== '"' && q !== "'") {
          const u = url(css, i, j);
          out.push(u);
          i = u.end;
          continue;
        }
      }
      out.push({ type: "function", name: lower, start: i, end: next + 1 });
      i = next + 1;
    } else {
      i++; // whitespace, delimiters, `:` `;` `,`, a lone `\`
    }
  }
  return out;
}
