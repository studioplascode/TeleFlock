import { describe, expect, test } from "bun:test";
import { type Block, type Inline, parseBlocks, parseInline } from "./parse";

const maths = (src: string) => parseInline(src).filter((n): n is Extract<Inline, { t: "math" }> => n.t === "math");
const text = (src: string) =>
  parseInline(src)
    .map((n) => (n.t === "text" ? n.v : n.t === "math" ? `«${n.tex}»` : ""))
    .join("");

describe("inline math", () => {
  test("dollar pairs, \\(…\\) and inline $$ are math", () => {
    expect(maths("the area is $\\pi r^2$ here")).toEqual([{ t: "math", tex: "\\pi r^2", display: false }]);
    expect(maths("so \\(a^2+b^2=c^2\\) holds")).toEqual([{ t: "math", tex: "a^2+b^2=c^2", display: false }]);
    expect(maths("see $$E=mc^2$$ now")).toEqual([{ t: "math", tex: "E=mc^2", display: true }]);
    expect(maths("$1$ and $x_{n}$")).toHaveLength(2);
  });

  test("prices stay text", () => {
    for (const s of ["It costs $5 and $10 each.", "Total: $5 + $3 = $8", "from $5-$10", "$5.00/$10.00 per seat", "between $100 and $200 a month", "US$5 or US$10", "five bucks: $5"]) {
      expect(maths(s)).toEqual([]);
    }
    expect(text("costs $5 and $10")).toBe("costs $5 and $10");
  });

  test("prose between dollars and shell variables stay text", () => {
    expect(maths("I paid $5 and got 5$")).toEqual([]);
    expect(maths("use $HOME/$USER here")).toEqual([]);
    expect(maths("export $HOME and $PATH")).toEqual([]);
    expect(maths("echo $VAR1 or $VAR2")).toEqual([]);
  });

  test("a price before real math doesn't swallow it", () => {
    expect(text("pay $5, then $x^2$ appears")).toBe("pay $5, then «x^2» appears");
  });

  test("an escaped dollar is a dollar, not math", () => {
    expect(maths("\\$5 and \\$10")).toEqual([]);
    expect(text("\\$5 and \\$10")).toBe("$5 and $10");
  });

  test("code spans keep their dollars", () => {
    expect(maths("run `echo $x$y` and `$HOME`")).toEqual([]);
  });

  test("unclosed math while streaming is plain text until it closes", () => {
    expect(maths("the value $x^2")).toEqual([]);
    expect(maths("the value \\(x^2")).toEqual([]);
    expect(maths("the value $x^2$")).toHaveLength(1);
  });

  test("an escaped dollar inside math doesn't close it", () => {
    expect(maths("$a \\$ b$")).toEqual([{ t: "math", tex: "a \\$ b", display: false }]);
  });
});

const kinds = (blocks: Block[]) => blocks.map((b) => b.t);

describe("display math blocks", () => {
  test("one-line and multi-line forms", () => {
    expect(parseBlocks("$$ x^2 $$")).toEqual([{ t: "math", src: "$$ x^2 $$", tex: "x^2", open: false }]);
    expect(parseBlocks("\\[ y \\]")).toMatchObject([{ t: "math", tex: "y", open: false }]);
    expect(parseBlocks("Intro:\n$$\n\\int_0^1 x\\,dx\n= \\tfrac12\n$$\nafter")).toMatchObject([{ t: "p" }, { t: "math", tex: "\\int_0^1 x\\,dx\n= \\tfrac12", open: false }, { t: "p", text: "after" }]);
    expect(parseBlocks("\\[\na\n\\]")).toMatchObject([{ t: "math", tex: "a" }]);
  });

  test("a bare delimiter still waiting for its math is an open block while streaming", () => {
    expect(parseBlocks("$$\nx =")).toMatchObject([{ t: "math", open: true, tex: "x =" }]);
    expect(parseBlocks("$$")).toMatchObject([{ t: "math", open: true }]);
    expect(parseBlocks("$$\nx = 1\n$$")).toMatchObject([{ t: "math", open: false }]);
  });

  test("a blank line before any closer means it was never math", () => {
    expect(kinds(parseBlocks("$$\nnot math\n\nnext paragraph"))).toEqual(["p", "p"]);
    expect(kinds(parseBlocks("$$ is the shell's pid\n\nnext"))).toEqual(["p", "p"]);
    expect(kinds(parseBlocks("$$ is the shell's pid"))).toEqual(["p"]);
  });

  test("delimiters that never close don't hide a later pair", () => {
    expect(parseBlocks("\\[\n\\[\nx\n\n\\[\ny\n\\]")).toMatchObject([{ t: "p" }, { t: "p" }, { t: "math", tex: "y", open: false }]);
    expect(parseBlocks("$$ a\n- i\n$$\n$$\nz\n$$")).toMatchObject([{ t: "math", tex: "a\n- i" }, { t: "math", tex: "z" }]);
  });

  test("a delimiter alone ends a paragraph without a blank line", () => {
    expect(kinds(parseBlocks("so we get\n$$\nx\n$$"))).toEqual(["p", "math"]);
  });

  test("math inside list items and quotes", () => {
    expect(JSON.stringify(parseBlocks("- item\n  $$\n  x\n  $$"))).toContain('"t":"math"');
    expect(JSON.stringify(parseBlocks("> $$ z $$"))).toContain('"t":"math"');
  });

  test("fences with dollars stay code", () => {
    const blocks = parseBlocks("```sh\n$$\necho hi\n$$\n```");
    expect(blocks).toMatchObject([{ t: "code", lang: "sh", open: false }]);
  });
});

describe("fences while streaming", () => {
  test("a mermaid fence is open until its closing line arrives", () => {
    expect(parseBlocks("```mermaid\ngraph TD\n  A-->B")).toMatchObject([{ t: "code", lang: "mermaid", open: true }]);
    expect(parseBlocks("```mermaid\ngraph TD\n  A-->B\n``")).toMatchObject([{ t: "code", lang: "mermaid", open: true }]);
    expect(parseBlocks("```mermaid\ngraph TD\n  A-->B\n```")).toMatchObject([{ t: "code", lang: "mermaid", open: false, code: "graph TD\n  A-->B" }]);
  });

  test("text after the closed fence is a separate block", () => {
    const blocks = parseBlocks("```svg\n<svg/>\n```\nDone.");
    expect(kinds(blocks)).toEqual(["code", "p"]);
  });
});

const t = (v: string): Inline => ({ t: "text", v });
const code = (v: string): Inline => ({ t: "code", v });
const em = (...c: Inline[]): Inline => ({ t: "em", c });
const strong = (...c: Inline[]): Inline => ({ t: "strong", c });
const del = (...c: Inline[]): Inline => ({ t: "del", c });
const link = (href: string, ...c: Inline[]): Inline => ({ t: "link", href, c });
const br: Inline = { t: "br" };

describe("inline markup", () => {
  test("strong, emphasis, strike and code nest as written", () => {
    expect(parseInline("a **b *c* d** and ~~e~~ and `f`")).toEqual([t("a "), strong(t("b "), em(t("c")), t(" d")), t(" and "), del(t("e")), t(" and "), code("f")]);
    // five levels: bold, italic, strike, link, code
    expect(parseInline("**a *b ~~c [d `e` f](u)~~ g* h**")).toEqual([strong(t("a "), em(t("b "), del(t("c "), link("u", t("d "), code("e"), t(" f"))), t(" g")), t(" h"))]);
  });

  test("an underscore needs a word boundary, and spaced stars are text", () => {
    expect(parseInline("snake_case_name, _real_ emphasis, __bold__ and 2 * 3 * 4")).toEqual([t("snake_case_name, "), em(t("real")), t(" emphasis, "), strong(t("bold")), t(" and 2 * 3 * 4")]);
  });

  test("links with a title, autolinks and bare URLs", () => {
    expect(parseInline('[docs](https://x.dev/a?b=1 "Title") and <https://auto.link/x> and https://bare.url/p. (see http://localhost:3000/app)')).toEqual([
      link("https://x.dev/a?b=1", t("docs")),
      t(" and "),
      link("https://auto.link/x", t("https://auto.link/x")),
      t(" and "),
      link("https://bare.url/p", t("https://bare.url/p")),
      t(". (see "),
      link("http://localhost:3000/app", t("http://localhost:3000/app")),
      t(")"),
    ]);
    expect(parseInline("[**bold** link](u)")).toEqual([link("u", strong(t("bold")), t(" link"))]);
    expect(parseInline("![alt text](./pic.png) and ![](data:image/png;base64,AAAA)")).toEqual([{ t: "image", alt: "alt text", src: "./pic.png" }, t(" and "), { t: "image", alt: "", src: "data:image/png;base64,AAAA" }]);
  });

  test("escapes, soft breaks and hard breaks", () => {
    expect(parseInline("a\\*b\\_c \\\\ d \\q")).toEqual([t("a*b_c \\ d \\q")]);
    expect(parseInline("first  \nsecond\\\nthird\nfourth")).toEqual([t("first"), br, t("second"), br, t("third fourth")]);
  });

  test("code spans take longer fences and drop a padding space; an unclosed one runs to the end", () => {
    expect(parseInline("``a ` b`` and ` x ` and `  y  `")).toEqual([code("a ` b"), t(" and "), code("x"), t(" and "), code(" y ")]);
    expect(parseInline("run `npm test")).toEqual([t("run "), code("npm test")]);
  });

  test("openers that find no closer stay text", () => {
    const s = "[not a link] (x) and [a](b c) and 5 * 6 and *unclosed";
    expect(parseInline(s)).toEqual([t(s)]);
    expect(parseInline("a < b and x<y> and <b>html</b>")).toEqual([t("a < b and x<y> and <b>html</b>")]);
  });

  test("openers that never close don't hide the one that does", () => {
    expect(parseInline("[ [ [ ]x [a](u) end")).toEqual([t("[ [ [ ]x "), link("u", t("a")), t(" end")]);
    expect(parseInline("[a](b [a](b [c](d) end")).toEqual([t("[a](b [a](b "), link("d", t("c")), t(" end")]);
    expect(parseInline('[a](b "t" x [a](b "t" x [c](d "e") end')).toEqual([t('[a](b "t" x [a](b "t" x '), link("d", t("c")), t(" end")]);
    expect(parseInline("<http://a b> <http://a b> <https://ok.dev> end")).toEqual([t("<http://a b> <http://a b> "), link("https://ok.dev", t("https://ok.dev")), t(" end")]);
    expect(parseInline("![ ![ ]x ![a](u) end")).toEqual([t("![ ![ ]x "), { t: "image", alt: "a", src: "u" }, t(" end")]);
    expect(parseInline("$a $a $a $x$ end")).toEqual([t("$a $a $a "), { t: "math", tex: "x", display: false }, t(" end")]);
  });
});

describe("block structure", () => {
  test("a heading's closing hashes and blanks are not its text", () => {
    const heads = parseBlocks("# Title\n## Sub ##  \n###   \n#hash\n####### seven\n   ### indented ###\n# a # b\n#\ttab #");
    expect(heads.map((b) => (b.t === "h" ? `${b.level}:${b.text}` : b.t))).toEqual(["1:Title", "2:Sub", "3:", "p", "3:indented", "1:a # b", "1:tab"]);
  });

  test("a table needs a separator row: pipes, colons and blanks around its dashes", () => {
    expect(parseBlocks("| a | b |\n|:--|--:|\n| 1 | 2 `x|y` |\n| 3 \\| 4 | five |")).toMatchObject([
      { t: "table", head: ["a", "b"], align: ["left", "right"], rows: [["1", "2 `x|y`"], ["3 | 4", "five"]] },
    ]);
    for (const sep of ["- | -", "---|---", "|---|---|", ":-:|--:", "| :--- | --- |", " |-| ", "| - |"]) expect(kinds(parseBlocks(`a | b\n${sep}\nx | y`))).toEqual(["table"]);
    for (const sep of ["- - -", "||", "|", "| : |", "-- x"]) expect(kinds(parseBlocks(`a | b\n${sep}\nx | y`))).not.toContain("table");
  });

  test("a thematic break is three marks of one kind with blanks between, after at most three spaces", () => {
    expect(kinds(parseBlocks("---\n***\n_ _ _\n- - -"))).toEqual(["hr", "hr", "hr", "hr"]);
    expect(kinds(parseBlocks("    ---\n--\n-*-"))).toEqual(["p"]);
  });

  test("nested lists and quotes", () => {
    const [list, quote] = parseBlocks("- a\n  - b\n    - c\n\n> q\n> > r");
    expect(list).toMatchObject({ t: "list", items: [{ blocks: [{ t: "p", text: "a" }, { t: "list", items: [{ blocks: [{ text: "b" }] }, { blocks: [{ text: "c" }] }] }] }] });
    expect(quote).toMatchObject({ t: "quote", blocks: [{ t: "p", text: "q" }, { t: "quote", blocks: [{ t: "p", text: "r" }] }] });
  });

  test("U+2028 is an ordinary character, not the end of a line", () => {
    expect(kinds(parseBlocks("- a\u2028b\n\n```ts\u2028x\ncode\n```"))).toEqual(["list", "code"]);
  });

  test("containers nested past any real depth end as text instead of recursing once per marker", () => {
    const depthOf = (blocks: Block[]): number =>
      Math.max(0, ...blocks.map((b) => (b.t === "quote" ? 1 + depthOf(b.blocks) : b.t === "list" ? 1 + Math.max(0, ...b.items.map((i) => depthOf(i.blocks))) : 0)));
    for (const marker of ["> ", "- ", "1. "]) {
      const blocks = parseBlocks(`${marker.repeat(100_000)}deep`);
      expect(depthOf(blocks)).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(blocks)).toContain("deep");
    }
  });

  test("markup nested past any real depth ends as text instead of recursing once per opener", () => {
    const s = `${"_a ".repeat(50_000)}${"_".repeat(150_000)}`;
    expect(JSON.stringify(parseInline(s))).toContain("_a");
    expect(parseInline("**a *b ~~c [d `e` f](u)~~ g* h**")).toHaveLength(1);
  });
});

/** What `Markdown` reads from a text: its blocks, then the inline text of every paragraph, heading and table cell in them. */
function parseAll(text: string): number {
  let nodes = 0;
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.t === "p" || b.t === "h") nodes += parseInline(b.text).length;
      else if (b.t === "table") for (const cell of [...b.head, ...b.rows.flat()]) nodes += parseInline(cell).length;
      else if (b.t === "quote") walk(b.blocks);
      else if (b.t === "list") for (const item of b.items) walk(item.blocks);
    }
  };
  walk(parseBlocks(text));
  return nodes;
}

describe("whatever an agent wrote, parsing takes linear time", () => {
  // A linear scan reads 400 KB in about 10 ms; the quadratic ones took from seconds to minutes. The bound leaves room for a slow machine.
  const LIMIT_MS = 500;
  const SIZES = [50_000, 400_000];
  const rep = (unit: string) => (n: number) => unit.repeat(Math.ceil(n / unit.length));

  // `plain`: no markup is there to read, so the whole text comes out as it went in
  const inlineCases: Record<string, { make: (n: number) => string; plain?: boolean }> = {
    "[": { make: rep("["), plain: true },
    "![": { make: rep("!["), plain: true },
    "[a](": { make: rep("[a]("), plain: true },
    "[a](b ": { make: rep("[a](b "), plain: true },
    '[a](b "': { make: rep('[a](b "'), plain: true },
    "[a]( … then one quote": { make: (n) => `${rep("[a](")(n)} "${"x".repeat(n)}`, plain: true },
    "<http://": { make: rep("<http://"), plain: true },
    "*": { make: rep("*"), plain: true },
    "*a ": { make: rep("*a "), plain: true },
    "_a ": { make: rep("_a "), plain: true },
    "~": { make: rep("~"), plain: true },
    "$": { make: rep("$"), plain: true },
    "$a ": { make: rep("$a "), plain: true },
    "$$": { make: rep("$$"), plain: true },
    "`": { make: rep("`") },
    "`a": { make: rep("`a") },
    "``a`": { make: rep("``a`") },
    "\\(": { make: rep("\\(") },
    "\\*": { make: rep("\\*") },
    "**a ": { make: rep("**a ") },
    "$a…a$": { make: (n) => `$${"a".repeat(n)}$` },
    "spaces before a hard break": { make: (n) => `a${" ".repeat(n)}b  \nc` },
    "one line per word": { make: rep("some words on a line\n") },
    "[*`$_~<!\\ a": { make: rep("[*`$_~<!\\ a") },
    "![a]($\\(`*_<http://": { make: rep("![a]($\\(`*_<http://") },
    "unclosed emphasis chained to its closers": { make: (n) => `${"_a ".repeat(n / 6)}${"_".repeat(n / 2)}` },
  };
  for (const [name, { make, plain }] of Object.entries(inlineCases)) {
    test(`inline: ${name}`, () => {
      for (const n of SIZES) {
        const src = make(n);
        const start = performance.now();
        const nodes = parseInline(src);
        expect(performance.now() - start).toBeLessThan(LIMIT_MS);
        if (plain) expect(nodes).toEqual([t(src)]);
      }
    });
  }

  test("inline: a long run of letters between dollars is one formula", () => {
    const start = performance.now();
    expect(parseInline(`$${"a".repeat(400_000)}$`)).toEqual([{ t: "math", tex: "a".repeat(400_000), display: false }]);
    expect(performance.now() - start).toBeLessThan(LIMIT_MS);
  });

  test("inline: blanks before a hard break and one line per word keep their text", () => {
    expect(parseInline(`a${" ".repeat(1000)}b  \nc`)).toEqual([t(`a${" ".repeat(1000)}b`), br, t("c")]);
    expect(parseInline("some words\non a line\n")).toEqual([t("some words on a line ")]);
  });

  const blockCases: Record<string, (n: number) => string> = {
    "a heading with a long run of blanks": (n) => `# a${" ".repeat(n)}b`,
    "a heading closed by many hashes": (n) => `# a ${"#".repeat(n)} b`,
    "a table row, then blanks": (n) => `a|b\n${" ".repeat(n)}x`,
    "a table with a wide separator": (n) => `a|b\n${"|-".repeat(n / 2)}x`,
    "a fence whose line holds U+2028": (n) => `\`\`\`${"a".repeat(n)}\u2028`,
    "a list item whose line holds U+2028": (n) => `-${" ".repeat(n)}a\u2028`,
    "bare \\[ lines, then a blank line": (n) => `${"\\[\n".repeat(n / 3)}\n`,
    "$$ openers between headings, no blank line": (n) => "$$ a\n# h\n".repeat(n / 9),
    "markers nested: > ": (n) => `${"> ".repeat(n / 2)}x`,
    "markers nested: - ": (n) => `${"- ".repeat(n / 2)}x`,
    "markers nested: 1. ": (n) => `${"1. ".repeat(n / 3)}x`,
    "markers nested: -  -  -": (n) => `-${" -".repeat(n / 2)}x`,
    "one paragraph of many lines": rep("a line of text that is not special\n"),
    "many list items": rep("- item one\n"),
    "many quote lines": rep("> quoted line\n"),
    "many short paragraphs": rep("para text\n\n"),
    "many headings": rep("# Head *x*\n"),
  };
  for (const [name, make] of Object.entries(blockCases)) {
    test(`blocks: ${name}`, () => {
      for (const n of SIZES) {
        const src = make(n);
        const start = performance.now();
        parseAll(src);
        expect(performance.now() - start).toBeLessThan(LIMIT_MS);
      }
    });
  }
});
