/**
 * Theme CSS, pure: read a theme's name and variables, check it, scope it to a preview, write
 * templates. No DOM, so it runs in bun tests and anywhere in the app.
 *
 * A theme is plain CSS that TeleFlock puts in its own <style> after the app's styles. It normally
 * sets variables on `:root` (THEME_VAR_GROUPS); any other rule works too and applies app-wide.
 * Nothing may come from the network: `@import` is refused and `url()` takes `data:` URIs only, so a
 * theme behaves the same under the desktop app's CSP and in a plain browser. Those checks run on
 * the tokens a browser sees (lexer.ts), so escapes and comments can't hide a load.
 */

import { type CssToken, tokenize } from "./lexer";
import { THEME_VAR_GROUPS, THEME_VAR_NAMES, THEME_VAR_PREFIXES, isColorVar } from "./vars";

/** Largest theme accepted (UTF-16 code units, about the same in bytes for CSS). */
export const MAX_THEME_LENGTH = 64 * 1024;

export interface ThemeIssue {
  /** 1-based line in the theme text. */
  line: number;
  severity: "error" | "warning";
  message: string;
}

export interface ThemeCssInfo {
  /** From the header comment's `TeleFlock theme: <name>` line. */
  name?: string;
  /** From the header comment's `Starts from: <name>` line. */
  base?: string;
  /** Custom properties declared in rules for the document root (`:root`, `html`, `:host`, `body`); the last wins. */
  vars: Map<string, string>;
  /** `color-scheme` declared in a root rule. */
  colorScheme?: "light" | "dark";
  issues: ThemeIssue[];
}

export interface InspectOptions {
  /** Does this value parse as one colour? (`CSS.supports("color", v)` in the app.) Omit to skip the check. */
  isColor?: (value: string) => boolean;
}

/** Selectors that mean the document root in a theme; a preview maps them to its own element. */
const ROOT_SELECTORS = new Set([":root", "html", ":host", "body"]);

/** At-rules whose block holds rules (scoped recursively); every other block is kept as written. */
const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "scope", "starting-style", "document"]);

/** Functions whose string arguments are URLs (`image-set("a.png" 1x)`); an unquoted url() is a URL anyway. */
const URL_FUNCTIONS = new Set(["url", "src", "image-set", "-webkit-image-set", "image"]);

/** Functions that put a value from elsewhere where they stand (a variable, an attribute, a condition). */
const SUBSTITUTIONS = new Set(["var", "env", "attr", "if", "inherit"]);

const CLOSER = { "(": ")", "[": "]", "{": "}" } as const;

// ---------- scanning ----------

/**
 * The text with every comment blanked to spaces (newlines kept), so offsets and line numbers stay
 * those of the original and the parser never meets a comment. Comments are the tokenizer's: a
 * `/*` inside a string or an unquoted url() is text, as in a browser.
 */
function blankComments(css: string, tokens: readonly CssToken[]): string {
  let out = "";
  let at = 0;
  for (const t of tokens) {
    if (t.type !== "comment") continue;
    out += css.slice(at, t.start) + css.slice(t.start, t.end).replace(/[^\n]/g, " ");
    at = t.end;
  }
  return out + css.slice(at);
}

/** Index just past the string starting at `i` (a quote). An unescaped newline or the end of input ends it unterminated. */
function stringEnd(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length) {
    const c = css[j];
    if (c === "\\") j += 2;
    else if (c === quote) return j + 1;
    else if (c === "\n") return j;
    else j++;
  }
  return Math.min(j, css.length);
}

function lineIndex(css: string): (i: number) => number {
  const starts = [0];
  for (let i = 0; i < css.length; i++) if (css[i] === "\n") starts.push(i + 1);
  return (i) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

interface RuleNode {
  kind: "rule";
  selector: string;
  /** Block contents, without the braces. */
  body: string;
  bodyStart: number;
  line: number;
}

interface AtNode {
  kind: "at";
  /** Lowercased, without `@`. */
  name: string;
  prelude: string;
  /** Rules inside a grouping at-rule. */
  rules?: CssNode[];
  /** The block of any other at-rule, braces included; absent for a statement (`@import …;`). */
  rawBlock?: string;
  line: number;
}

type CssNode = RuleNode | AtNode;

interface Parser {
  /** Comment-blanked source. */
  src: string;
  /** The original text (strings are read from here: they never contain blanked comments). */
  issues: ThemeIssue[];
  lineOf: (i: number) => number;
}

/** Reads up to (not including) the first top-level char in `stops`, skipping strings and parentheses. */
function readUntil(p: Parser, i: number, stops: string): number {
  let depth = 0;
  while (i < p.src.length) {
    const c = p.src[i] as string;
    if (c === '"' || c === "'") {
      i = stringEnd(p.src, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(c)) return i;
    i++;
  }
  return i;
}

/** Index just past the `}` matching the `{` at `i`. Braces inside parentheses (an unquoted url()) don't count, as in a browser. */
function blockEnd(p: Parser, i: number): number {
  let depth = 0;
  let parens = 0;
  let j = i;
  while (j < p.src.length) {
    const c = p.src[j];
    if (c === '"' || c === "'") {
      j = stringEnd(p.src, j);
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (parens === 0 && c === "{") depth++;
    else if (parens === 0 && c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  p.issues.push({ line: p.lineOf(i), severity: "error", message: "This block never closes: add }." });
  return p.src.length;
}

function parseRules(p: Parser, start: number, end: number): CssNode[] {
  const nodes: CssNode[] = [];
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(p.src[i] as string)) i++;
    if (i >= end) break;
    const c = p.src[i];
    if (c === "}") {
      p.issues.push({ line: p.lineOf(i), severity: "error", message: "This } closes nothing: remove it." });
      i++;
      continue;
    }
    if (c === ";") {
      i++;
      continue;
    }
    if (c === "@") {
      const nameMatch = /^@([\w-]+)/.exec(p.src.slice(i, i + 64));
      const name = (nameMatch?.[1] ?? "").toLowerCase();
      const preludeStart = i + 1 + name.length;
      const stop = readUntil(p, preludeStart, "{;}");
      const prelude = p.src.slice(preludeStart, stop).trim();
      const line = p.lineOf(i);
      if (stop >= end || p.src[stop] !== "{") {
        nodes.push({ kind: "at", name, prelude, line });
        i = stop < end && p.src[stop] === ";" ? stop + 1 : stop;
        continue;
      }
      const close = Math.min(blockEnd(p, stop), end);
      if (GROUPING_AT_RULES.has(name)) nodes.push({ kind: "at", name, prelude, rules: parseRules(p, stop + 1, close - 1), line });
      else nodes.push({ kind: "at", name, prelude, rawBlock: p.src.slice(stop, close), line });
      i = close;
      continue;
    }
    const stop = readUntil(p, i, "{;}");
    if (stop >= end || p.src[stop] !== "{") {
      p.issues.push({ line: p.lineOf(i), severity: "error", message: "Expected a { after this selector." });
      i = stop < end && p.src[stop] !== "}" ? stop + 1 : Math.max(stop, i + 1);
      continue;
    }
    const close = Math.min(blockEnd(p, stop), end);
    nodes.push({ kind: "rule", selector: p.src.slice(i, stop).trim(), body: p.src.slice(stop + 1, close - 1), bodyStart: stop + 1, line: p.lineOf(i) });
    i = close;
  }
  return nodes;
}

interface Declaration {
  prop: string;
  value: string;
  important: boolean;
  line: number;
}

/** Top-level declarations of a block body (nested rules, CSS nesting style, are skipped). */
function declarations(p: Parser, body: string, offset: number): Declaration[] {
  const out: Declaration[] = [];
  let i = 0;
  let pieceStart = 0;
  let depth = 0;
  let braces = 0;
  const flush = (end: number) => {
    const piece = body.slice(pieceStart, end);
    const colon = topLevelColon(piece);
    if (colon > 0) {
      const prop = piece.slice(0, colon).trim();
      let value = piece.slice(colon + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
      const lead = piece.length - piece.trimStart().length;
      if (/^(--[\w-]+|[a-zA-Z-]+)$/.test(prop)) out.push({ prop, value, important, line: p.lineOf(offset + pieceStart + lead) });
    }
  };
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      i = stringEnd(body, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "{") braces++;
    else if (c === "}") {
      braces = Math.max(0, braces - 1);
      if (braces === 0) pieceStart = i + 1;
    } else if (c === ";" && depth === 0 && braces === 0) {
      flush(i);
      pieceStart = i + 1;
    }
    i++;
  }
  if (braces === 0) flush(body.length);
  return out;
}

function topLevelColon(piece: string): number {
  let depth = 0;
  for (let i = 0; i < piece.length; i++) {
    const c = piece[i];
    if (c === '"' || c === "'") {
      i = stringEnd(piece, i) - 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ":" && depth === 0) return i;
    else if (c === "{") return -1;
  }
  return -1;
}

/** Selector list split on top-level commas (`:is(a, b)` stays whole). */
function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' || c === "'") {
      i = stringEnd(selector, i) - 1;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}

function isRootSelector(selector: string): boolean {
  return splitSelectors(selector).every((s) => ROOT_SELECTORS.has(s.toLowerCase()));
}

// ---------- token checks ----------

/**
 * What the tokens a browser sees (lexer.ts) say is wrong, as errors: comments, strings and
 * brackets that never close, and everything the theme would load. That is a url() that isn't a
 * `data:` URI, such a string in a URL function (`image-set("…")`), a value put into a URL
 * function from elsewhere (`image-set(var(--u))`: the variable could hold an address), a
 * malformed url() and an @import, however escaped (`\75rl(`, `@\69mport`) or commented.
 */
function tokenIssues(tokens: readonly CssToken[], lineOf: (i: number) => number): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  const loads: ThemeIssue[] = [];
  const importLines = new Set<number>();
  const error = (list: ThemeIssue[], at: number, message: string) => list.push({ line: lineOf(at), severity: "error", message });
  const load = (value: string, at: number) => {
    const v = value.trim();
    if (v === "" || /^data:/i.test(v)) return;
    error(loads, at, `Themes load nothing from the network or disk: url(${v.length > 48 ? `${v.slice(0, 45)}…` : v}) isn't allowed. Embed it as a data: URI.`);
  };
  // open blocks and functions, innermost last (what each block holds is up to its closer, as in a browser)
  const open: { close: string; fn?: string; at: number }[] = [];
  // the URL function a token is in, if any: a type() inside image-set() holds a MIME type, a {} block declarations
  const urlFunction = () => {
    for (let k = open.length - 1; k >= 0; k--) {
      const o = open[k];
      if (!o || o.close === "}" || o.fn === "type") return undefined;
      if (o.fn && URL_FUNCTIONS.has(o.fn)) return o.fn;
    }
    return undefined;
  };
  for (const t of tokens) {
    if (t.type === "comment") {
      if (!t.closed) error(issues, t.start, "This comment never ends: add */.");
    } else if (t.type === "string") {
      if (!t.closed) error(issues, t.start, "This string never ends: add the closing quote.");
      else if (urlFunction()) load(t.value, t.start);
    } else if (t.type === "url") {
      if (t.bad) error(loads, t.start, "This url() is malformed (a quote, bracket or space inside the address): put the address in quotes.");
      else load(t.value, t.start);
    } else if (t.type === "function") {
      const fn = urlFunction();
      if (fn && (SUBSTITUTIONS.has(t.name) || t.name.startsWith("--")))
        error(loads, t.start, `Themes load nothing from the network or disk, so ${fn}() can't take ${t.name}(): it could hand it an address. Put the data: URI in directly.`);
      open.push({ close: ")", fn: t.name, at: t.start });
    } else if (t.type === "open") {
      open.push({ close: CLOSER[t.char], at: t.start });
    } else if (t.type === "close") {
      if (open.at(-1)?.close === t.char) open.pop();
    } else if (t.name === "import") {
      error(issues, t.start, "Themes can't @import other stylesheets: paste their rules in instead.");
      importLines.add(lineOf(t.start));
    }
  }
  // a block left open swallows the rest of the theme in a browser; the parser reports an open {}
  for (const o of open) if (o.close !== "}") error(issues, o.at, `This ${o.fn ? `${o.fn}(` : o.close === ")" ? "(" : "["} never closes: add ${o.close}.`);
  // an @import's url() is the same mistake: report it once
  return [...issues, ...loads.filter((i) => !importLines.has(i.line))];
}

// ---------- inspect ----------

const HEADER_NAME = /TeleFlock theme:[ \t]*([^\n]*)/i;
const HEADER_BASE = /Starts from:[ \t]*([^\n]*)/i;

/** The first comment of the text, if the text starts with one (whitespace aside). */
function headerComment(css: string): string | undefined {
  const m = /^\s*\/\*([\s\S]*?)\*\//.exec(css);
  return m?.[1];
}

function parse(css: string, issues: ThemeIssue[]): { p: Parser; nodes: CssNode[] } {
  const lineOf = lineIndex(css);
  const tokens = tokenize(css);
  issues.push(...tokenIssues(tokens, lineOf));
  const p: Parser = { src: blankComments(css, tokens), issues, lineOf };
  return { p, nodes: parseRules(p, 0, p.src.length) };
}

/** Name, variables, colour scheme and every problem of a theme's CSS. Errors block saving and applying. */
export function inspectThemeCss(css: string, opts: InspectOptions = {}): ThemeCssInfo {
  const issues: ThemeIssue[] = [];
  const header = headerComment(css);
  const name = header ? HEADER_NAME.exec(header)?.[1]?.trim() : undefined;
  const base = header ? HEADER_BASE.exec(header)?.[1]?.trim() : undefined;
  const vars = new Map<string, string>();
  let colorScheme: "light" | "dark" | undefined;

  if (css.length > MAX_THEME_LENGTH) {
    issues.push({ line: 1, severity: "error", message: `This theme is ${Math.round(css.length / 1024)} KB; themes can be up to ${MAX_THEME_LENGTH / 1024} KB.` });
    return { name, base, vars, colorScheme, issues };
  }

  const { p, nodes } = parse(css, issues);

  const visit = (list: CssNode[], inRootContext: boolean) => {
    for (const node of list) {
      if (node.kind === "at") {
        if (node.rules) visit(node.rules, inRootContext && (node.name === "layer" || node.name === "media" || node.name === "supports"));
        continue;
      }
      const root = isRootSelector(node.selector);
      for (const d of declarations(p, node.body, node.bodyStart)) {
        if (d.prop.startsWith("--")) checkVar(d, opts, issues);
        if (!root || !inRootContext) continue;
        if (d.prop.startsWith("--")) vars.set(d.prop, d.value);
        else if (d.prop.toLowerCase() === "color-scheme") {
          const scheme = d.value.trim().toLowerCase();
          if (scheme === "light" || scheme === "dark") colorScheme = scheme;
          else issues.push({ line: d.line, severity: "warning", message: `color-scheme should be light or dark (it styles native controls and scrollbars), not "${d.value}".` });
        }
      }
    }
  };
  visit(nodes, true);
  return { name, base, vars, colorScheme, issues: issues.sort((a, b) => a.line - b.line) };
}

function checkVar(d: Declaration, opts: InspectOptions, issues: ThemeIssue[]): void {
  const name = d.prop;
  if (THEME_VAR_NAMES.has(name)) {
    if (opts.isColor && isColorVar(name) && !/var\(/i.test(d.value) && !opts.isColor(d.value))
      issues.push({ line: d.line, severity: "warning", message: `${name}: "${d.value}" isn't a colour, so TeleFlock ignores it.` });
    return;
  }
  if (name.startsWith("--st-")) {
    issues.push({ line: d.line, severity: "warning", message: `${name} follows the status colours on each element: set --color-run-1, --color-sun-2 … instead.` });
    return;
  }
  if (!THEME_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))) return;
  const guess = closestVar(name);
  issues.push({ line: d.line, severity: "warning", message: `${name} isn't a TeleFlock variable${guess ? `; did you mean ${guess}?` : "."}` });
}

function closestVar(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(3, Math.floor(name.length / 4)) + 1;
  for (const known of THEME_VAR_NAMES) {
    const d = editDistance(name, known, bestDistance);
    if (d < bestDistance) {
      best = known;
      bestDistance = d;
    }
  }
  return best;
}

/** Levenshtein distance, giving up (returning `cap`) once every path exceeds it. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin >= cap) return cap;
    prev = cur;
  }
  return prev[b.length] ?? cap;
}

export function hasErrors(info: Pick<ThemeCssInfo, "issues">): boolean {
  return info.issues.some((i) => i.severity === "error");
}

// ---------- scope ----------

/**
 * The theme confined to `scope` (a selector for a preview element that also carries
 * `.tf-theme-scope`): root rules land on the element, every other rule under it; `@keyframes`,
 * `@font-face` and friends stay as written (they style nothing by themselves). "" for a theme with
 * errors, so a preview never shows what can't be applied.
 */
export function scopeThemeCss(css: string, scope: string): string {
  const issues: ThemeIssue[] = [];
  if (css.length > MAX_THEME_LENGTH) return "";
  const { nodes } = parse(css, issues);
  if (issues.some((i) => i.severity === "error")) return "";
  return emit(nodes, scope);
}

function emit(nodes: CssNode[], scope: string): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "rule") {
      out += `${splitSelectors(node.selector).map((s) => scopeSelector(s, scope)).join(", ")} {${node.body}}\n`;
    } else if (node.rules) {
      out += `@${node.name} ${node.prelude} {\n${emit(node.rules, scope)}}\n`;
    } else if (node.rawBlock) {
      out += `@${node.name} ${node.prelude} ${node.rawBlock}\n`;
    }
  }
  return out;
}

function scopeSelector(selector: string, scope: string): string {
  const m = /^(:root|html|:host|body)(?![\w-])/i.exec(selector);
  if (!m) return `${scope} ${selector}`;
  const rest = selector.slice(m[0].length);
  // `html body`, `:root body`: both are the root here
  const tail = rest.replace(/^\s+body(?![\w-])/i, "");
  return `${scope}${tail}`;
}

// ---------- write ----------

export interface TemplateInput {
  name: string;
  /** Name of the theme it starts from. */
  base: string;
  scheme: "light" | "dark";
  /** Value for every variable (missing ones are left out). */
  values: ReadonlyMap<string, string>;
}

/**
 * A full theme: header, `color-scheme` and every variable TeleFlock reads, grouped and commented,
 * with the given values. What "New theme from …" starts with.
 */
export function themeTemplate({ name, base, scheme, values }: TemplateInput): string {
  const lines = [
    "/*",
    ` * TeleFlock theme: ${oneLine(name)}`,
    ` * Starts from: ${oneLine(base)}`,
    " *",
    " * Every variable TeleFlock reads, with this theme's values. Change any of them; delete a line",
    " * to keep the default. Colours take any CSS colour (#hex, rgb(), hsl(), oklch()). Other rules",
    " * work too and apply everywhere. Themes load nothing from the network: url() takes data: URIs.",
    " */",
    ":root {",
    `  color-scheme: ${scheme};`,
  ];
  for (const group of THEME_VAR_GROUPS) {
    const present = group.vars.filter((v) => values.has(v.name));
    if (present.length === 0) continue;
    lines.push("", `  /* ${group.title} */`);
    for (const v of present) lines.push(`  ${v.name}: ${values.get(v.name)}; /* ${v.hint} */`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
}

/** The theme with its header's name set to `name` (a header is added when there is none). */
export function withThemeName(css: string, name: string): string {
  const clean = oneLine(name);
  const m = /^(\s*\/\*)([\s\S]*?)(\*\/)/.exec(css);
  if (m && HEADER_NAME.test(m[2] ?? "")) {
    const body = (m[2] ?? "").replace(HEADER_NAME, `TeleFlock theme: ${clean}`);
    return `${m[1]}${body}${m[3]}${css.slice(m[0].length)}`;
  }
  return `/* TeleFlock theme: ${clean} */\n${css}`;
}

/** A file name for an exported theme: `nord-copy.css`. */
export function themeFileName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "teleflock-theme"}.css`;
}

/** A theme name from an imported file's name: `nord-copy.css` → "nord copy". */
export function nameFromFileName(file: string): string {
  return (
    file
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim() || "Imported theme"
  );
}
