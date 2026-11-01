import { describe, expect, test } from "bun:test";
import { hasErrors, inspectThemeCss, MAX_THEME_LENGTH, nameFromFileName, scopeThemeCss, themeFileName, themeTemplate, withThemeName } from "./css";
import { THEME_VARS } from "./vars";

const errors = (css: string) => inspectThemeCss(css).issues.filter((i) => i.severity === "error");
const warnings = (css: string) => inspectThemeCss(css).issues.filter((i) => i.severity === "warning");

describe("inspectThemeCss", () => {
  test("reads the header name and base, root variables (last wins) and the colour scheme", () => {
    const info = inspectThemeCss(`/*\n * TeleFlock theme: Night Owl\n * Starts from: Nord\n */\n:root { color-scheme: light; --color-bg: #111; }\nhtml, :root { --color-bg: #222 !important; --color-ink: rgb(1 2 3); }\n.tile { --color-tile-2: red; }`);
    expect(info.name).toBe("Night Owl");
    expect(info.base).toBe("Nord");
    expect(info.colorScheme).toBe("light");
    expect(info.vars.get("--color-bg")).toBe("#222");
    expect(info.vars.get("--color-ink")).toBe("rgb(1 2 3)");
    // a variable set on an element rule is not a theme-wide value
    expect(info.vars.has("--color-tile-2")).toBe(false);
    expect(info.issues).toEqual([]);
  });

  test("values with semicolons inside strings and data URIs stay whole", () => {
    const info = inspectThemeCss(`:root { --tf-noise: url("data:image/svg+xml;utf8,<svg a='1;2'/>"); --color-bg: #000; }`);
    expect(info.vars.get("--tf-noise")).toBe(`url("data:image/svg+xml;utf8,<svg a='1;2'/>")`);
    expect(info.vars.get("--color-bg")).toBe("#000");
    expect(hasErrors(info)).toBe(false);
  });

  test("variables inside @media and @layer blocks count; inside @supports too", () => {
    const info = inspectThemeCss(`@media (min-width: 1px) { :root { --color-bg: #010101; } } @layer x { :root { --color-ink: #fff; } }`);
    expect(info.vars.get("--color-bg")).toBe("#010101");
    expect(info.vars.get("--color-ink")).toBe("#fff");
  });

  test("anything that loads from the network or disk is an error; data: URIs are fine", () => {
    expect(errors(`@import url("https://example.com/x.css");`)).toHaveLength(1);
    expect(errors(`@import "theme.css";`)).toHaveLength(1);
    expect(errors(`body { background: url(https://example.com/a.png); }`)).toHaveLength(1);
    expect(errors(`body { background: url('//cdn.example.com/a.png'); }`)).toHaveLength(1);
    expect(errors(`body { background: url(asset://localhost/etc/passwd); }`)).toHaveLength(1);
    expect(errors(`body { background-image: image-set("https://x.test/a.png" 1x); }`)).toHaveLength(1);
    expect(errors(`@font-face { font-family: X; src: url(https://x.test/x.woff2); }`)).toHaveLength(1);
    expect(errors(`body { background: url(data:image/png;base64,AAAA); cursor: url("data:image/svg+xml,<svg/>"), auto; }`)).toEqual([]);
    // the word url in a comment or string isn't a load
    expect(errors(`/* url(https://x.test) */ body::after { content: "url(https://x.test)"; }`)).toEqual([]);
  });

  test("a load can't hide behind escapes, comments or substitution: what a browser would fetch is refused", () => {
    const evil = "https://evil.test/p.png";
    const loads = [
      // escapes a browser decodes: \75 is "u", \69 is "i"; any escaped letter is that letter
      `body { background: \\75rl(${evil}); }`,
      `body { background: u\\rl(${evil}); }`,
      `body { background: \\55 RL(${evil}); }`,
      `body { background-image: \\69mage-set("${evil}" 1x); }`,
      `@\\69mport "https://evil.test/x.css";\n:root { --color-bg: #000; }`,
      `@IMPORT "https://evil.test/x.css";`,
      // inside an unquoted url() "/*" is text, so the second url() isn't in a comment
      `a { background: url(data:,/*); background-image: url(${evil}); --z: url(data:,*/); }`,
      // a URL function given its address from elsewhere
      `:root { --u: "${evil}"; } body { background-image: image-set(var(--u) 1x); }`,
      `:root { --u: "${evil}"; } body { background-image: -webkit-image-set(var(--u) 1x); }`,
      `body { background-image: image-set(if(media(width > 0): "${evil}"; else: "${evil}") 1x); }`,
      `@function --u() { result: "${evil}"; } body { background-image: image-set(--u() 1x); }`,
      `body { background-image: src(env(--u)); }`,
      `body { background-image: image("${evil}"); }`,
      `body { background-image: image-set(first-valid("${evil}") 1x); }`,
      `@font-face { font-family: X; src: url(data:,x), url(${evil}); }`,
    ];
    for (const css of loads) {
      expect({ css, refused: hasErrors(inspectThemeCss(css)) }).toEqual({ css, refused: true });
      expect(scopeThemeCss(css, "[data-p]")).toBe("");
    }
  });

  test("data: URIs stay allowed however they are written; a url() a browser drops is an error", () => {
    const fine = [
      `:root { --tf-noise: url(data:image/svg+xml,<svg><style>a{fill:red}</style></svg>); --color-bg: #000; }`,
      `body { background: url(d\\61ta:,x); }`,
      `body { background-image: image-set(url(data:,a) type("image/avif") 1x, "data:,b" 2x); }`,
      `body { background: url( "data:,/* not a comment */" ); }`,
    ];
    for (const css of fine) expect({ css, issues: inspectThemeCss(css).issues }).toEqual({ css, issues: [] });
    // braces inside an unquoted url() don't end the rule
    expect(inspectThemeCss(fine[0] as string).vars.get("--color-bg")).toBe("#000");
    expect(errors(`body { background: url(it's.png); }`)[0]?.message).toContain("malformed");
  });

  test("a parenthesis left open, which swallows the rest of a theme in a browser, is an error", () => {
    const issues = errors(`:root {\n  --color-bg: rgb(0 0 0;\n}\nbody { color: red; }`);
    expect(issues.find((i) => i.message.includes("rgb( never closes"))?.line).toBe(2);
  });

  test("broken structure is an error with its line", () => {
    expect(errors(`:root {\n  --color-bg: #000;\n`)[0]?.message).toContain("never closes");
    expect(errors(`:root { --color-bg: #000; }\n}`)[0]?.line).toBe(2);
    expect(errors(`/* open comment\n:root { }`)[0]?.message).toContain("comment");
    expect(errors(`:root { content: "open\n; }`).some((i) => i.message.includes("string"))).toBe(true);
    expect(errors(`:root --color-bg: red;`)[0]?.message).toContain("{");
  });

  test("oversized themes are refused", () => {
    expect(errors(`:root { --color-bg: #000; }${" ".repeat(MAX_THEME_LENGTH)}`)[0]?.message).toContain("KB");
  });

  test("typos in TeleFlock variables get a suggestion; other custom properties are the author's own", () => {
    const [typo] = warnings(`:root { --color-tlie-2: #000; }`);
    expect(typo?.message).toContain("--color-tile-2");
    expect(typo?.line).toBe(1);
    expect(warnings(`:root { --my-own: 1px; --brand: #fff; }`)).toEqual([]);
    expect(warnings(`:root { --st-solid: red; }`)[0]?.message).toContain("--color-run-1");
  });

  test("colour values are checked when a checker is given; var() is trusted", () => {
    const isColor = (v: string) => /^#[0-9a-f]{3,8}$/i.test(v);
    expect(inspectThemeCss(`:root { --color-bg: #12; --color-ink: var(--color-bg); --shadow-d1: none; }`, { isColor }).issues.map((i) => i.message)).toEqual([
      `--color-bg: "#12" isn't a colour, so TeleFlock ignores it.`,
    ]);
  });

  test("color-scheme must be light or dark", () => {
    expect(warnings(`:root { color-scheme: purple; }`)).toHaveLength(1);
    expect(inspectThemeCss(`:root { color-scheme: dark; }`).colorScheme).toBe("dark");
  });
});

describe("scopeThemeCss", () => {
  const scope = `[data-theme-preview="p"]`;
  test("root rules land on the scope element, other rules under it, lists split at top level only", () => {
    const out = scopeThemeCss(`:root { --color-bg: #000; }\nhtml body .tile, :is(.a, .b) > p { color: red; }\nbody { margin: 0; }`, scope);
    expect(out).toContain(`${scope} { --color-bg: #000; }`);
    expect(out).toContain(`${scope} .tile, ${scope} :is(.a, .b) > p { color: red; }`);
    expect(out).toContain(`${scope} { margin: 0; }`);
  });

  test("grouping at-rules recurse; keyframes stay as written; an import makes it refuse", () => {
    const out = scopeThemeCss(`@media (min-width: 1px) { :root { --color-ink: #fff; } } @keyframes spin { to { transform: rotate(1turn); } }`, scope);
    expect(out).toContain(`@media (min-width: 1px) {\n${scope} { --color-ink: #fff; }`);
    expect(out).toContain("@keyframes spin { to { transform: rotate(1turn); } }");
    expect(scopeThemeCss(`@import "x.css"; :root { --color-bg: #000; }`, scope)).toBe("");
    expect(scopeThemeCss(`:root { background: url(https://x.test/a.png) }`, scope)).toBe("");
  });

  test(":root with a qualifier keeps it on the scope element", () => {
    expect(scopeThemeCss(`:root:hover .x { color: red; }`, scope)).toContain(`${scope}:hover .x { color: red; }`);
  });
});

describe("templates and names", () => {
  test("a template lists every variable once, round-trips through inspect, and names itself", () => {
    const values = new Map(THEME_VARS.map((v, i) => [v.name, i % 2 ? `#${String(i).padStart(6, "0")}` : `var(--color-bg)`]));
    const css = themeTemplate({ name: "Mine */ evil", base: "Nord", scheme: "light", values });
    const info = inspectThemeCss(css);
    expect(info.issues).toEqual([]);
    expect(info.name).toBe("Mine * / evil");
    expect(info.base).toBe("Nord");
    expect(info.colorScheme).toBe("light");
    expect(info.vars).toEqual(values);
  });

  test("withThemeName replaces the header name, or adds a header", () => {
    const css = themeTemplate({ name: "A", base: "TeleFlock", scheme: "dark", values: new Map([["--color-bg", "#000"]]) });
    const renamed = withThemeName(css, "Bee");
    expect(inspectThemeCss(renamed).name).toBe("Bee");
    expect(inspectThemeCss(renamed).base).toBe("TeleFlock");
    expect(inspectThemeCss(withThemeName(":root { --color-bg: #000; }", "Plain")).name).toBe("Plain");
  });

  test("file names", () => {
    expect(themeFileName("Nord — copy ✨")).toBe("nord-copy.css");
    expect(themeFileName("✨")).toBe("teleflock-theme.css");
    expect(nameFromFileName("night_owl-v2.css")).toBe("night owl v2");
  });
});
