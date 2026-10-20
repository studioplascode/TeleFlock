/*
 * Tiny line-oriented syntax highlighter for the diff viewer. Diff lines are highlighted one at a
 * time (only the rows on screen), so per-line tokenising with one sticky regex per language family
 * is plenty: no grammar engine, no worker, ~1µs per short line, results cached.
 */

export type TokenKind = "kw" | "str" | "num" | "com" | "type" | "fn" | "prop" | "tag" | "attr" | "op" | "plain";
export type Token = readonly [TokenKind, string];

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_KW = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum export extends
  false finally for from function get if implements import in infer instanceof interface is keyof let module namespace new null
  of override package private protected public readonly return satisfies set static super switch this throw true try type typeof
  undefined var void while with yield
  fn impl mut pub crate use mod struct trait where match loop move ref self Self dyn unsafe extern
  func go defer chan select range map fallthrough
  def elif except lambda pass raise nonlocal global and or not None True False del assert
  int long short char float double bool boolean byte string void final throws synchronized volatile transient native
  auto register sizeof typedef union unsigned signed goto inline constexpr nullptr template typename operator virtual friend
  val fun when object companion data sealed lateinit
`);

const SHELL_KW = words(`if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit echo cd source alias`);
const SQL_KW = words(`select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all null is like in exists case when then else end begin commit returning default`);

// Alternatives, in priority order. Capturing groups map to TokenKind via GROUP_KINDS.
const C_LIKE = new RegExp(
  [
    String.raw`(\/\/.*|\/\*.*?(?:\*\/|$)|#!.*)`, // 1 comment
    String.raw`("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\x60(?:[^\x60\\]|\\.)*\x60?)`, // 2 string
    String.raw`(\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)[a-zA-Z]*\b)`, // 3 number
    String.raw`(<\/?[A-Za-z][\w.:-]*|\/?>)`, // 4 jsx tag
    String.raw`([A-Za-z_$][\w$]*)(?=\s*(?:<[^>]*>)?\()`, // 5 function call
    String.raw`([A-Z][\w$]*)`, // 6 type-ish
    String.raw`([A-Za-z_$][\w$]*)`, // 7 identifier
    String.raw`([+\-*/%=!<>&|^~?:]+|=>)`, // 8 operator
  ].join("|"),
  "y",
);

const PY_LIKE = new RegExp(
  [
    String.raw`(#.*)`,
    String.raw`([rbfu]*"""[^]*?(?:"""|$)|[rbfu]*'''[^]*?(?:'''|$)|[rbfu]*"(?:[^"\\]|\\.)*"?|[rbfu]*'(?:[^'\\]|\\.)*'?)`,
    String.raw`(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?j?\b)`,
    String.raw`(@[\w.]+)`,
    String.raw`([A-Za-z_]\w*)(?=\s*\()`,
    String.raw`([A-Z]\w*)`,
    String.raw`([A-Za-z_]\w*)`,
    String.raw`([+\-*/%=!<>&|^~:]+)`,
  ].join("|"),
  "y",
);

const SHELL = new RegExp(
  [
    String.raw`(#.*)`,
    String.raw`("(?:[^"\\]|\\.)*"?|'[^']*'?)`,
    String.raw`(\b\d+\b)`,
    String.raw`(\$\{?[\w@#?*!-]+\}?)`,
    String.raw`(--?[\w-]+)`,
    String.raw`(\b[A-Z_][A-Z0-9_]*(?==))`,
    String.raw`([A-Za-z_][\w.-]*)`,
    String.raw`([|&;<>=]+)`,
  ].join("|"),
  "y",
);

const DATA = new RegExp(
  [
    String.raw`(#.*|\/\/.*)`,
    String.raw`("(?:[^"\\]|\\.)*"(?=\s*:)|[\w.-]+(?=\s*[:=]\s)|^\s*[\w.-]+(?=\s*=)|^\s*\[[^\]]*\])`, // keys / sections
    String.raw`("(?:[^"\\]|\\.)*"?|'[^']*'?)`,
    String.raw`(-?\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)`,
    String.raw`(\b(?:true|false|null|yes|no|on|off|~)\b)`,
    String.raw`([&*!|>{}[\],:=-]+)`,
  ].join("|"),
  "y",
);

const MARKUP = new RegExp(
  [
    String.raw`(<!--.*?(?:-->|$))`,
    String.raw`(<\/?[A-Za-z][\w.:-]*|\/?>)`,
    String.raw`([A-Za-z_:][\w:.-]*)(?==)`,
    String.raw`("[^"]*"?|'[^']*'?)`,
    String.raw`(&\w+;)`,
  ].join("|"),
  "y",
);

const CSS = new RegExp(
  [
    String.raw`(\/\*.*?(?:\*\/|$)|\/\/.*)`,
    String.raw`("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)`,
    String.raw`(-?\b\d[\d.]*(?:px|em|rem|%|vh|vw|dvh|ms|s|deg|fr|ch)?\b|#[\da-fA-F]{3,8}\b)`,
    String.raw`(@[\w-]+)`,
    String.raw`([\w-]+)(?=\s*:)`,
    String.raw`([.#][\w-]+|::?[\w-]+)`,
    String.raw`([\w-]+)(?=\()`,
  ].join("|"),
  "y",
);

const MD = new RegExp(
  [String.raw`(^#{1,6} .*)`, String.raw`(\x60[^\x60]*\x60?)`, String.raw`(\*\*[^*]+\*\*|__[^_]+__)`, String.raw`(\[[^\]]*\]\([^)]*\))`, String.raw`(^\s*(?:[-*+]|\d+\.) )`].join("|"),
  "y",
);

type Family = "c" | "py" | "sh" | "data" | "markup" | "css" | "md" | "sql" | "none";

const GROUP_KINDS: Record<Family, TokenKind[]> = {
  c: ["com", "str", "num", "tag", "fn", "type", "plain", "op"],
  py: ["com", "str", "num", "attr", "fn", "type", "plain", "op"],
  sh: ["com", "str", "num", "prop", "attr", "prop", "plain", "op"],
  data: ["com", "prop", "str", "num", "kw", "op"],
  markup: ["com", "tag", "attr", "str", "kw"],
  css: ["com", "str", "num", "kw", "prop", "type", "fn"],
  md: ["kw", "str", "type", "fn", "op"],
  sql: ["com", "str", "num", "tag", "fn", "type", "plain", "op"],
  none: [],
};

const RE: Record<Family, RegExp | null> = { c: C_LIKE, py: PY_LIKE, sh: SHELL, data: DATA, markup: MARKUP, css: CSS, md: MD, sql: C_LIKE, none: null };
const KW: Partial<Record<Family, ReadonlySet<string>>> = { c: C_LIKE_KW, py: C_LIKE_KW, sh: SHELL_KW, sql: SQL_KW };

const EXT_FAMILY: Record<string, Family> = {
  ts: "c", tsx: "c", js: "c", jsx: "c", mjs: "c", cjs: "c", mts: "c", cts: "c",
  rs: "c", go: "c", java: "c", kt: "c", kts: "c", scala: "c", swift: "c", dart: "c",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", zig: "c", php: "c", proto: "c",
  py: "py", pyi: "py", rb: "py", ex: "py", exs: "py", nim: "py",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ps1: "sh", env: "sh", dockerfile: "sh", makefile: "sh", mk: "sh",
  json: "data", jsonc: "data", json5: "data", yaml: "data", yml: "data", toml: "data", ini: "data", cfg: "data", lock: "data",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", astro: "markup", plist: "markup",
  css: "css", scss: "css", sass: "css", less: "css",
  md: "md", mdx: "md", markdown: "md",
  sql: "sql",
};

/** Language family from a file path (extension, or well-known file names). */
export function familyFor(path: string): Family {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env") || name.endsWith("rc")) return "sh";
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && EXT_FAMILY[name.slice(dot + 1)]) || "none";
}

const cache = new Map<string, Token[]>();
const CACHE_MAX = 6000;

export function tokenize(text: string, family: Family): Token[] {
  const re = RE[family];
  if (!re || text.length === 0) return [["plain", text]];
  if (text.length > 2000) return [["plain", text]]; // minified bundles: not worth it
  const key = `${family}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const kinds = GROUP_KINDS[family];
  const kw = KW[family];
  const out: Token[] = [];
  let plainStart = 0;
  let i = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) out.push(["plain", text.slice(plainStart, end)]);
  };
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m || m[0].length === 0) {
      i++;
      continue;
    }
    let g = 1;
    while (g < m.length && m[g] === undefined) g++;
    let kind = kinds[g - 1] ?? "plain";
    const val = m[0];
    if (kind === "plain" && kw) {
      if (kw.has(family === "sql" ? val.toLowerCase() : val)) kind = "kw";
    } else if ((kind === "fn" || kind === "type") && kw?.has(family === "sql" ? val.toLowerCase() : val)) {
      kind = "kw";
    }
    if (kind === "plain") {
      i += val.length;
      continue;
    }
    flushPlain(i);
    out.push([kind, val]);
    i += val.length;
    plainStart = i;
  }
  flushPlain(text.length);

  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, out);
  return out;
}

/** Token colours (Tailwind classes) tuned for the dark diff background. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: "text-[#c4a1ff]",
  str: "text-[#a5e3a0]",
  num: "text-[#ffb86b]",
  com: "text-mute-2 italic",
  type: "text-[#7fd4ff]",
  fn: "text-[#82aaff]",
  prop: "text-[#f6a6d8]",
  tag: "text-[#ff8fa3]",
  attr: "text-[#ffcb6b]",
  op: "text-[#89ddff]",
  plain: "",
};
