/**
 * Small, synchronous syntax highlighter for transcript code blocks, diffs and file previews.
 * One sticky-regex pass per line set; no async grammar loading, so it can run on every
 * streamed chunk of the block that is still growing.
 */

export type TokenKind = "kw" | "str" | "num" | "com" | "fn" | "type" | "op" | "punc" | "attr" | "var" | "tag" | "lit" | "plain";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Grammar {
  /** Ordered rules; the first that matches at the cursor wins. */
  rules: [RegExp, TokenKind][];
  keywords: Set<string>;
  literals: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_LIT = words("true false null undefined nil None True False NaN Infinity this self super");

function grammar(keywords: string, opts: { hashComment?: boolean; slashComment?: boolean; backtick?: boolean; triple?: boolean; lifetimes?: boolean; dollarVars?: boolean } = {}): Grammar {
  const rules: [RegExp, TokenKind][] = [];
  if (opts.slashComment !== false) {
    rules.push([/\/\/[^\n]*/y, "com"]);
    rules.push([/\/\*[\s\S]*?(?:\*\/|$)/y, "com"]);
  }
  if (opts.hashComment) rules.push([/#[^\n]*/y, "com"]);
  if (opts.triple) rules.push([/("""|''')[\s\S]*?(?:\1|$)/y, "str"]);
  rules.push([/"(?:[^"\\\n]|\\.)*"?/y, "str"]);
  if (opts.lifetimes) rules.push([/'[a-zA-Z_]\w*(?!')/y, "type"]);
  rules.push([/'(?:[^'\\\n]|\\.)*'?/y, "str"]);
  if (opts.backtick) rules.push([/`(?:[^`\\]|\\.)*`?/y, "str"]);
  if (opts.dollarVars) rules.push([/\$\{?[A-Za-z_][\w]*\}?|\$[0-9@#?*!$-]/y, "var"]);
  rules.push([/@[A-Za-z_][\w.]*/y, "attr"]);
  rules.push([/\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)[a-zA-Z]*\b/y, "num"]);
  rules.push([/[A-Za-z_$][\w$]*(?=\s*\()/y, "fn"]);
  rules.push([/[A-Z][\w$]*/y, "type"]);
  rules.push([/[A-Za-z_$][\w$]*/y, "plain"]);
  rules.push([/=>|->|::|[=!<>]=?=?|&&|\|\||[+\-*/%^&|~?:]+/y, "op"]);
  rules.push([/[{}()[\];,.]/y, "punc"]);
  return { rules, keywords: words(keywords), literals: C_LIKE_LIT };
}

const JS = grammar(
  "const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends implements interface type enum import export from as default async await yield try catch finally throw void readonly public private protected static abstract declare namespace keyof infer satisfies is get set",
  { backtick: true },
);
const RUST = grammar(
  "fn let mut const static struct enum trait impl pub use mod crate match if else for while loop return break continue where as in ref move async await dyn type unsafe extern Self",
  { lifetimes: true },
);
const PY = grammar("def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal async await del assert match case", {
  hashComment: true,
  slashComment: false,
  triple: true,
});
const GO = grammar("func package import var const type struct interface map chan go defer return if else for range switch case default break continue select fallthrough goto", { backtick: true });
const SH = grammar("if then else elif fi for while until do done case esac in function return export local readonly unset source alias echo cd exit set shift trap eval exec", {
  hashComment: true,
  slashComment: false,
  dollarVars: true,
});
const KOTLIN = grammar("fun val var class object interface data sealed open override private public internal protected return if else when for while do in is as import package try catch finally throw suspend companion init enum constructor typealias by lateinit");
const JAVA = grammar("public private protected class interface enum extends implements static final void return if else for while do switch case break continue new try catch finally throw throws import package abstract synchronized volatile transient instanceof var record sealed permits yield");
const C = grammar("int char float double long short unsigned signed void struct union enum typedef const static extern return if else for while do switch case break continue goto sizeof auto register volatile inline class namespace template typename public private protected virtual override new delete using nullptr constexpr");
const YAML = grammar("", { hashComment: true, slashComment: false });
const TOML = YAML;
const SQL = grammar(
  "select from where insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as and or not null is in exists distinct union all case when then else end begin commit rollback",
  { slashComment: false },
);
const CSS: Grammar = {
  rules: [
    [/\/\*[\s\S]*?(?:\*\/|$)/y, "com"],
    [/"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y, "str"],
    [/#[\da-fA-F]{3,8}\b/y, "num"],
    [/-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|dvh|s|ms|deg|fr)?/y, "num"],
    [/@[\w-]+/y, "kw"],
    [/--[\w-]+/y, "var"],
    [/[\w-]+(?=\s*:)/y, "attr"],
    [/[.#]?[A-Za-z_][\w-]*/y, "plain"],
    [/[{}()[\];,:]/y, "punc"],
  ],
  keywords: words("important"),
  literals: words(""),
};
const JSON_G: Grammar = {
  rules: [
    [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, "attr"],
    [/"(?:[^"\\\n]|\\.)*"?/y, "str"],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, "num"],
    [/[A-Za-z_]\w*/y, "plain"],
    [/[{}[\],:]/y, "punc"],
  ],
  keywords: words(""),
  literals: words("true false null"),
};
const HTML: Grammar = {
  rules: [
    [/<!--[\s\S]*?(?:-->|$)/y, "com"],
    [/<\/?[A-Za-z][\w.-]*/y, "tag"],
    [/\/?>/y, "tag"],
    [/[A-Za-z_:][\w:.-]*(?==)/y, "attr"],
    [/"[^"]*"?|'[^']*'?/y, "str"],
    [/[^<>"'=\s]+/y, "plain"],
  ],
  keywords: words(""),
  literals: words(""),
};

const LANGS: Record<string, Grammar> = {
  js: JS, javascript: JS, jsx: JS, ts: JS, typescript: JS, tsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS,
  rs: RUST, rust: RUST,
  py: PY, python: PY,
  go: GO, golang: GO,
  sh: SH, bash: SH, zsh: SH, shell: SH, console: SH, fish: SH, ps1: SH, powershell: SH,
  kt: KOTLIN, kts: KOTLIN, kotlin: KOTLIN, swift: KOTLIN, scala: KOTLIN,
  java: JAVA, cs: JAVA, csharp: JAVA, dart: JAVA,
  c: C, h: C, cpp: C, cc: C, hpp: C, "c++": C, zig: C,
  yaml: YAML, yml: YAML, toml: TOML, ini: TOML, conf: TOML, dockerfile: SH, makefile: SH,
  sql: SQL,
  css: CSS, scss: CSS, less: CSS,
  json: JSON_G, jsonc: JSON_G, json5: JSON_G, jsonl: JSON_G,
  html: HTML, xml: HTML, svg: HTML, vue: HTML, svelte: HTML,
};

const EXT_ALIASES: Record<string, string> = { md: "markdown", markdown: "markdown", txt: "text", lock: "text", log: "text" };

/** Normalise a fence info string or a file path into a language key (or undefined). */
export function languageFor(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const h = hint.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (LANGS[h]) return h;
  const base = h.split("/").pop() ?? h;
  if (base === "dockerfile" || base === "makefile") return base;
  const ext = base.includes(".") ? base.split(".").pop() : undefined;
  if (ext && LANGS[ext]) return ext;
  if (ext && EXT_ALIASES[ext]) return EXT_ALIASES[ext];
  return undefined;
}

/** Tokenise source text. Unknown languages return one plain token. */
export function highlight(code: string, lang: string | undefined): Token[] {
  const g = lang ? LANGS[lang] : undefined;
  if (!g) return [{ text: code, kind: "plain" }];
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code.charCodeAt(i);
    // whitespace fast path
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      let j = i + 1;
      while (j < n) {
        const c = code.charCodeAt(j);
        if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
        j++;
      }
      push(code.slice(i, j), "plain");
      i = j;
      continue;
    }
    let matched = false;
    for (const [re, kind] of g.rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length > 0) {
        let k = kind;
        if (kind === "plain" || kind === "fn" || kind === "type") {
          const w = m[0];
          const lw = g === SQL ? w.toLowerCase() : w;
          if (g.keywords.has(lw)) k = "kw";
          else if (g.literals.has(w)) k = "lit";
        }
        push(m[0], k);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      push(code[i] ?? "", "plain");
      i++;
    }
  }
  return out;
}

/** Tailwind classes per token kind (dark theme, omp-tinted). */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: "text-[#d8a6ff]",
  str: "text-[#bef264]",
  num: "text-[#fdba74]",
  com: "text-mute-2 italic",
  fn: "text-[#8ab4ff]",
  type: "text-[#67e8f9]",
  op: "text-[#f0a3d8]",
  punc: "text-mute",
  attr: "text-[#f9a8d4]",
  var: "text-[#fde68a]",
  tag: "text-[#f472b6]",
  lit: "text-[#fdba74]",
  plain: "",
};
