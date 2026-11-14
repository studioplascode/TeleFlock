/**
 * Small, synchronous syntax highlighter for transcript code blocks, diffs, file previews and the
 * code of tool calls. One sticky-regex pass per line set; no async grammar loading, so it can run
 * on every streamed chunk of the block that is still growing. What a regex can't read has a small
 * hand-written scanner (`Scan`): template literals and f-strings with code inside, regex literals,
 * shell words, expansions and heredocs. Code inside code (an interpolation, `$(…)`) is tokenised
 * with the same grammar, at most MAX_DEPTH levels deep, and every scanner reads forward from its
 * start, so a block costs time linear in its length (times that depth).
 */

import { lruMemo } from "./lru";

export type TokenKind = "kw" | "str" | "num" | "com" | "fn" | "type" | "op" | "punc" | "attr" | "var" | "tag" | "lit" | "plain";

export interface Token {
  text: string;
  kind: TokenKind;
}

type Push = (text: string, kind: TokenKind) => void;

/**
 * A hand-written rule: reads what starts at `i` in `code`, pushes its tokens and returns where it
 * ended, or -1 when it doesn't apply there. `depth`: how deep in code inside code `code` is.
 */
type Scan = (code: string, i: number, push: Push, g: Grammar, depth: number) => number;

interface Grammar {
  /** Ordered rules; the first that matches at the cursor wins. */
  rules: ([RegExp, TokenKind] | Scan)[];
  keywords: Set<string>;
  literals: Set<string>;
  /** A word right after `.` is still a keyword (Rust's `.await`); otherwise it is a member (`map.get`, `re.match`). */
  memberKeywords?: boolean;
}

/** How deep code inside code (an interpolation in a string in an interpolation…) is tokenised; deeper reads as plain text. */
const MAX_DEPTH = 4;

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_LIT = words("true false null undefined nil None True False NaN Infinity this self super");

function grammar(
  keywords: string,
  opts: { hashComment?: boolean; slashComment?: boolean; backtick?: boolean; template?: boolean; regex?: boolean; pyStrings?: boolean; lifetimes?: boolean; memberKeywords?: boolean } = {},
): Grammar {
  const rules: Grammar["rules"] = [];
  if (opts.slashComment !== false) {
    rules.push([/\/\/[^\n]*/y, "com"]);
    rules.push([/\/\*[\s\S]*?(?:\*\/|$)/y, "com"]);
  }
  if (opts.hashComment) rules.push([/#[^\n]*/y, "com"]);
  if (opts.regex) rules.push(jsRegex);
  if (opts.pyStrings) rules.push(pyString);
  else rules.push([/"(?:[^"\\\n]|\\.)*"?/y, "str"]);
  if (opts.lifetimes) rules.push([/'[a-zA-Z_]\w*(?!')/y, "type"]);
  if (!opts.pyStrings) rules.push([/'(?:[^'\\\n]|\\.)*'?/y, "str"]);
  if (opts.template) rules.push(jsTemplate);
  else if (opts.backtick) rules.push([/`(?:[^`\\]|\\.)*`?/y, "str"]);
  rules.push([/@[A-Za-z_][\w.]*/y, "attr"]);
  rules.push([/\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)[a-zA-Z]*\b/y, "num"]);
  rules.push([/[A-Za-z_$][\w$]*(?=\s*\()/y, "fn"]);
  rules.push([/[A-Z][\w$]*/y, "type"]);
  rules.push([/[A-Za-z_$][\w$]*/y, "plain"]);
  rules.push([/=>|->|::|[=!<>]=?=?|&&|\|\||[+\-*/%^&|~?:]+/y, "op"]);
  rules.push([/[{}()[\];,.]/y, "punc"]);
  return { rules, keywords: words(keywords), literals: C_LIKE_LIT, memberKeywords: opts.memberKeywords };
}

/** Code inside code (an interpolation, a command substitution): tokenised with `g` one level deeper, plain past MAX_DEPTH. */
function nested(code: string, g: Grammar, push: Push, depth: number): void {
  if (depth >= MAX_DEPTH) push(code, "plain");
  else tokenizeInto(code, g, push, depth + 1);
}

/** Index after the `'…'` or `"…"` string (backslash escapes) that starts at `i`; at its line's end when it isn't closed there (`lines`: it may span lines). */
function skipQuoted(code: string, i: number, lines = false): number {
  const q = code.charCodeAt(i);
  for (let j = i + 1; j < code.length; j++) {
    const c = code.charCodeAt(j);
    if (c === 92) j++;
    else if (c === q) return j + 1;
    else if (c === 10 && !lines) return j;
  }
  return code.length;
}

// ------------------------------------------------------------------ JavaScript / TypeScript

/** A JS template literal: its text as a string, the code in each `${…}` as JS. */
function jsTemplate(code: string, i: number, push: Push, g: Grammar, depth: number): number {
  if (code.charCodeAt(i) !== 96) return -1;
  let from = i;
  let j = i + 1;
  while (j < code.length) {
    const c = code.charCodeAt(j);
    if (c === 92) j += 2;
    else if (c === 96) {
      push(code.slice(from, j + 1), "str");
      return j + 1;
    } else if (c === 36 && code.charCodeAt(j + 1) === 123) {
      push(code.slice(from, j), "str");
      push("${", "kw");
      const end = jsInterpolationEnd(code, j + 2);
      nested(code.slice(j + 2, end), g, push, depth);
      if (end < code.length) push("}", "kw");
      j = from = end + 1;
    } else j++;
  }
  push(code.slice(from), "str");
  return code.length;
}

/**
 * Where the `${…}` whose code starts at `from` closes: the index of its `}`, past nested braces,
 * strings and template literals (with their own `${…}`); the end of `code` while it is unclosed.
 */
function jsInterpolationEnd(code: string, from: number): number {
  // Per level, the braces open in a `${…}`; -1: the text of a template literal inside it.
  const levels = [0];
  for (let j = from; j < code.length; j++) {
    const c = code.charCodeAt(j);
    const open = levels[levels.length - 1] as number;
    if (open < 0) {
      if (c === 92) j++;
      else if (c === 96) levels.pop();
      else if (c === 36 && code.charCodeAt(j + 1) === 123) {
        levels.push(0);
        j++;
      }
    } else if (c === 34 || c === 39) j = skipQuoted(code, j) - 1;
    else if (c === 96) levels.push(-1);
    else if (c === 123) levels[levels.length - 1] = open + 1;
    else if (c === 125) {
      if (open > 0) levels[levels.length - 1] = open - 1;
      else {
        levels.pop();
        if (levels.length === 0) return j;
      }
    }
  }
  return code.length;
}

/** Words after which `/` starts a regex literal, not a division. */
const REGEX_AFTER = words("return typeof instanceof in of new delete void throw case do else yield await");

/** A JS regex literal (`/ab+c/gi`) where one can start (not after a value, as in `a / b`), closed on its line. */
function jsRegex(code: string, i: number, push: Push): number {
  if (code.charCodeAt(i) !== 47) return -1;
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j] as string)) j--;
  if (j >= 0) {
    const before = code[j] as string;
    if (/[\w$]/.test(before)) {
      let k = j;
      while (k > 0 && /[\w$]/.test(code[k - 1] as string)) k--;
      if (!REGEX_AFTER.has(code.slice(k, j + 1))) return -1;
    } else if (/[)\]}"'`.]/.test(before)) return -1;
  }
  let set = false;
  for (let e = i + 1; e < code.length; e++) {
    const c = code.charCodeAt(e);
    if (c === 10) return -1;
    if (c === 92) e++;
    else if (c === 91) set = true;
    else if (c === 93) set = false;
    else if (c === 47 && !set) {
      // `//` is a comment, matched before this
      if (e === i + 1) return -1;
      let end = e + 1;
      while (end < code.length && /[a-z]/.test(code[end] as string)) end++;
      push(code.slice(i, end), "str");
      return end;
    }
  }
  return -1;
}

// ------------------------------------------------------------------ Python

/** A Python string with its prefix (`r`, `b`, `f`, `rb`, …), triple-quoted or not; an f- or t-string's `{…}` fields as Python. */
function pyString(code: string, i: number, push: Push, g: Grammar, depth: number): number {
  let q = i;
  while (q - i < 2 && /[rubft]/i.test(code[q] ?? "")) q++;
  const quote = code.charCodeAt(q);
  if ((quote !== 34 && quote !== 39) || (q > i && !/^(?:[rubft]|r[bft]|[bft]r)$/i.test(code.slice(i, q)))) return -1;
  const fields = /[ft]/i.test(code.slice(i, q));
  const triple = code.charCodeAt(q + 1) === quote && code.charCodeAt(q + 2) === quote;
  const close = triple ? 3 : 1;
  let from = i;
  let k = q + close;
  while (k < code.length) {
    const c = code.charCodeAt(k);
    if (c === 92) k += 2;
    else if (c === quote && (!triple || (code.charCodeAt(k + 1) === quote && code.charCodeAt(k + 2) === quote))) {
      push(code.slice(from, k + close), "str");
      return k + close;
    } else if (c === 10 && !triple) break;
    else if (fields && c === 123 && code.charCodeAt(k + 1) === 123) k += 2;
    else if (fields && c === 123) {
      push(code.slice(from, k), "str");
      push("{", "kw");
      const end = pyFieldEnd(code, k + 1, triple);
      pyField(code.slice(k + 1, end), push, g, depth);
      if (code.charCodeAt(end) === 125) push("}", "kw");
      k = from = code.charCodeAt(end) === 125 ? end + 1 : end;
    } else k++;
  }
  const end = Math.min(k, code.length);
  push(code.slice(from, end), "str");
  return end;
}

/** Where an f-string field whose code starts at `from` ends: its closing `}`, else where its string can't go on (a line's end, the end). */
function pyFieldEnd(code: string, from: number, triple: boolean): number {
  let open = 0;
  for (let j = from; j < code.length; j++) {
    const c = code.charCodeAt(j);
    if (c === 34 || c === 39) j = skipQuoted(code, j) - 1;
    else if (c === 10 && !triple) return j;
    else if (c === 125 && open === 0) return j;
    else if (c === 40 || c === 91 || c === 123) open++;
    else if ((c === 41 || c === 93 || c === 125) && open > 0) open--;
  }
  return code.length;
}

/** An f-string field: its expression as Python, then its conversion (`!r`) and format spec (`:>8`) as keywords. */
function pyField(text: string, push: Push, g: Grammar, depth: number): void {
  let open = 0;
  let cut = text.length;
  for (let j = 0; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 34 || c === 39) j = skipQuoted(text, j) - 1;
    else if (c === 40 || c === 91 || c === 123) open++;
    else if (c === 41 || c === 93 || c === 125) open = Math.max(0, open - 1);
    else if (open === 0 && (c === 58 || (c === 33 && text.charCodeAt(j + 1) !== 61))) {
      cut = j;
      break;
    }
  }
  nested(text.slice(0, cut), g, push, depth);
  push(text.slice(cut), "kw");
}

// ------------------------------------------------------------------ shell

/** What ends the shell word before a position: where a comment or a flag can start. */
const SH_BOUNDARY = "(?<![^\\s;|&(])";
const SH_PARAM = /\$\{[^}\n]*\}?/y;
const SH_VAR = /\$(?:[A-Za-z_]\w*|[0-9@#?*!$-])/y;
const SH_WORD = /[^\s|&;()<>{}[\]"'`$\\=!]+/y;
const SH_HEREDOC = /<<(-?)[ \t]*(?:(['"])([A-Za-z_][\w.-]*)\2|\\?([A-Za-z_][\w.-]*))/y;
/** Words after which the next one is a command: reserved words that lead one, and the usual command prefixes. */
const SH_LEADS = words("then do else elif if while until time sudo exec xargs nohup command builtin env");

/**
 * Whether the shell word at `i` is a command: first on its line, after `;` `|` `&` `(` `{` `!`, after
 * a word that leads one, or after assignments (`FOO=1 cmd`) that stand where a command goes.
 */
function shCommandAt(code: string, i: number): boolean {
  // a value: `--opt=value`, `FOO=value`
  if (code[i - 1] === "=") return false;
  for (let at = i; ; ) {
    let j = at - 1;
    while (j >= 0 && (code[j] === " " || code[j] === "\t")) j--;
    if (j < 0) return true;
    const c = code[j] as string;
    // a new line, unless a backslash continued the one before
    if (c === "\n" || c === "\r") return code[j - 1] !== "\\";
    // the `&` of `>&2` / `<&3` redirects: no command follows it
    if (";|&({!`".includes(c)) return !(c === "&" && (code[j - 1] === ">" || code[j - 1] === "<"));
    let k = j;
    while (k >= 0 && code.charCodeAt(k) > 32) k--;
    const before = code.slice(k + 1, j + 1);
    if (SH_LEADS.has(before)) return true;
    if (!/^[A-Za-z_]\w*=/.test(before)) return false;
    at = k + 1;
  }
}

/** A shell word: a keyword or a command where a command goes, a literal, a number, else plain text. */
function shWord(code: string, i: number, push: Push, g: Grammar): number {
  SH_WORD.lastIndex = i;
  const w = SH_WORD.exec(code)?.[0];
  if (!w) return -1;
  const command = shCommandAt(code, i);
  push(w, (command || w === "in") && g.keywords.has(w) ? "kw" : g.literals.has(w) ? "lit" : command ? "fn" : /^\d+$/.test(w) ? "num" : "plain");
  return i + w.length;
}

/** `$(…)` or `` `…` `` command substitution (and `$((…))` arithmetic): the code inside as shell. */
function shSubst(code: string, i: number, push: Push, g: Grammar, depth: number): number {
  const tick = code.charCodeAt(i) === 96;
  if (!tick && (code.charCodeAt(i) !== 36 || code.charCodeAt(i + 1) !== 40)) return -1;
  const start = i + (tick ? 1 : 2);
  let end = start;
  if (tick) while (end < code.length && code.charCodeAt(end) !== 96) end += code.charCodeAt(end) === 92 ? 2 : 1;
  else end = shParenEnd(code, start);
  end = Math.min(end, code.length);
  push(tick ? "`" : "$(", "var");
  nested(code.slice(start, end), g, push, depth);
  if (end < code.length) push(tick ? "`" : ")", "var");
  return Math.min(end + 1, code.length);
}

/** Index of the `)` that closes a `$(` whose code starts at `from`, past nested parentheses and quoted strings; the end of `code` while unclosed. */
function shParenEnd(code: string, from: number): number {
  let open = 0;
  for (let j = from; j < code.length; j++) {
    const c = code.charCodeAt(j);
    if (c === 92) j++;
    else if (c === 39) {
      const e = code.indexOf("'", j + 1);
      if (e < 0) return code.length;
      j = e;
    } else if (c === 34) j = skipQuoted(code, j, true) - 1;
    else if (c === 40) open++;
    else if (c === 41) {
      if (open === 0) return j;
      open--;
    }
  }
  return code.length;
}

/** A double-quoted shell string; the `$var`, `${…}`, `$(…)` and `` `…` `` in it as expansions. */
function shDouble(code: string, i: number, push: Push, g: Grammar, depth: number): number {
  if (code.charCodeAt(i) !== 34) return -1;
  let from = i;
  let j = i + 1;
  while (j < code.length) {
    const c = code.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 34) {
      push(code.slice(from, j + 1), "str");
      return j + 1;
    }
    let end = -1;
    if (c === 96 || (c === 36 && code.charCodeAt(j + 1) === 40)) {
      push(code.slice(from, j), "str");
      end = shSubst(code, j, push, g, depth);
    } else if (c === 36) {
      SH_PARAM.lastIndex = j;
      SH_VAR.lastIndex = j;
      const v = SH_PARAM.exec(code)?.[0] ?? SH_VAR.exec(code)?.[0];
      if (v) {
        push(code.slice(from, j), "str");
        push(v, "var");
        end = j + v.length;
      }
    }
    if (end > j) j = from = end;
    else j++;
  }
  push(code.slice(from), "str");
  return code.length;
}

/** `<<EOF`, `<<-'EOF'`, …: the rest of its line as shell, then the lines up to the delimiter's as a string. */
function shHeredoc(code: string, i: number, push: Push, g: Grammar, depth: number): number {
  SH_HEREDOC.lastIndex = i;
  const m = SH_HEREDOC.exec(code);
  if (!m) return -1;
  const tabs = m[1] === "-";
  const delim = m[3] ?? m[4] ?? "";
  const head = i + m[0].length;
  push(code.slice(i, i + (tabs ? 3 : 2)), "op");
  push(code.slice(i + (tabs ? 3 : 2), head), "str");
  const eol = code.indexOf("\n", head) < 0 ? code.length : code.indexOf("\n", head);
  nested(code.slice(head, eol), g, push, depth);
  for (let k = eol + 1; k < code.length; ) {
    const e = code.indexOf("\n", k) < 0 ? code.length : code.indexOf("\n", k);
    const line = code.slice(k, e).replace(/\r$/, "");
    if ((tabs ? line.replace(/^\t+/, "") : line) === delim) {
      push(code.slice(eol, e), "str");
      return e;
    }
    k = e + 1;
  }
  // still being written: the body runs to the end
  push(code.slice(eol), "str");
  return code.length;
}

const SH: Grammar = {
  rules: [
    [new RegExp(`${SH_BOUNDARY}#[^\\n]*`, "y"), "com"],
    shHeredoc,
    [/'[^']*'?/y, "str"],
    [/\$'(?:[^'\\]|\\[\s\S])*'?/y, "str"],
    shDouble,
    shSubst,
    [SH_PARAM, "var"],
    [SH_VAR, "var"],
    [new RegExp(`${SH_BOUNDARY}--?[A-Za-z0-9][\\w-]*`, "y"), "attr"],
    // an assignment: `FOO=1 cmd`, `dd if=…`
    [/[A-Za-z_]\w*(?==)/y, "var"],
    shWord,
    [/&&|\|\||;;&?|\|&|&>>?|>>|>&|<&|<<<|<<-?|<>|[|&;<>!=]/y, "op"],
    [/[(){}[\]]/y, "punc"],
    [/\\[\s\S]?/y, "op"],
  ],
  keywords: words("if then else elif fi for while until do done case esac in function return export local readonly unset source alias exit set shift trap eval exec"),
  literals: words("true false"),
};

const JS = grammar(
  "const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends implements interface type enum import export from as default async await yield try catch finally throw void readonly public private protected static abstract declare namespace keyof infer satisfies is get set",
  { template: true, regex: true },
);
const RUST = grammar(
  "fn let mut const static struct enum trait impl pub use mod crate match if else for while loop return break continue where as in ref move async await dyn type unsafe extern Self",
  { lifetimes: true, memberKeywords: true },
);
const PY = grammar("def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal async await del assert match case", {
  hashComment: true,
  slashComment: false,
  pyStrings: true,
});
const GO = grammar("func package import var const type struct interface map chan go defer return if else for range switch case default break continue select fallthrough goto", { backtick: true });
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

const tokenCache = lruMemo(4000, (key) => {
  const sep = key.indexOf("\u0000");
  return tokenize(key.slice(sep + 1), key.slice(0, sep));
});

/** Tokenise source text (memoised; treat the result as immutable). Unknown languages return one plain token. */
export function highlight(code: string, lang: string | undefined): Token[] {
  if (!lang || !LANGS[lang]) return [{ text: code, kind: "plain" }];
  return tokenCache(`${lang}\u0000${code}`);
}

function tokenize(code: string, lang: string): Token[] {
  const g = LANGS[lang];
  if (!g) return [{ text: code, kind: "plain" }];
  const out: Token[] = [];
  const push: Push = (text, kind) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ text, kind });
  };
  tokenizeInto(code, g, push, 0);
  return out;
}

function tokenizeInto(code: string, g: Grammar, push: Push, depth: number): void {
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
    let end = -1;
    for (const rule of g.rules) {
      if (typeof rule === "function") {
        end = rule(code, i, push, g, depth);
        if (end > i) break;
        continue;
      }
      const [re, kind] = rule;
      re.lastIndex = i;
      const w = re.exec(code)?.[0];
      if (!w) continue;
      let k = kind;
      // A word is a keyword or a literal, except a member after a dot (`map.get`, `re.match`; `...rest` is no member).
      if ((kind === "plain" || kind === "fn" || kind === "type") && (g.memberKeywords || code.charCodeAt(i - 1) !== 46 || code.charCodeAt(i - 2) === 46)) {
        const lw = g === SQL ? w.toLowerCase() : w;
        if (g.keywords.has(lw)) k = "kw";
        else if (g.literals.has(w)) k = "lit";
      }
      push(w, k);
      end = i + w.length;
      break;
    }
    if (end > i) i = end;
    else {
      push(code[i] ?? "", "plain");
      i++;
    }
  }
}

/** Tailwind classes per token kind: the theme's `--syntax-*` colours. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: "text-(--syntax-keyword)",
  str: "text-(--syntax-string)",
  num: "text-(--syntax-number)",
  com: "text-(--syntax-comment) italic",
  fn: "text-(--syntax-function)",
  type: "text-(--syntax-type)",
  op: "text-(--syntax-operator)",
  punc: "text-(--syntax-punctuation)",
  attr: "text-(--syntax-attribute)",
  var: "text-(--syntax-variable)",
  tag: "text-(--syntax-tag)",
  lit: "text-(--syntax-literal)",
  plain: "",
};
