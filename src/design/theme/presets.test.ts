import { describe, expect, test } from "bun:test";
import { contrast, over, parseColor, type Rgba } from "./color";
import { inspectThemeCss } from "./css";
import { PRESETS } from "./presets";
import { THEME_VARS } from "./vars";

// The default theme as written: tokens.css's `@theme static` block and its `:root, .tf-theme-scope` block.
const TOKENS = await (await fetch(new URL("../styles/tokens.css", import.meta.url))).text();

function defaultVars(): Map<string, string> {
  const block = (start: RegExp) => {
    const m = start.exec(TOKENS);
    if (!m) throw new Error(`tokens.css: no block ${start}`);
    const open = TOKENS.indexOf("{", m.index) + 1;
    let depth = 1;
    let i = open;
    while (depth > 0) {
      const c = TOKENS[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    return TOKENS.slice(open, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
  };
  const out = new Map<string, string>();
  for (const body of [block(/@theme static\s*\{/), block(/:root,\s*\n\.tf-theme-scope\s*\{/)])
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1] as string, (d[2] as string).trim());
  return out;
}

const DEFAULTS = defaultVars();

describe("premade themes", () => {
  test("tokens.css defines every theme variable (the editor's templates list them all)", () => {
    expect(THEME_VARS.filter((v) => !DEFAULTS.has(v.name)).map((v) => v.name)).toEqual([]);
  });

  for (const preset of PRESETS) {
    test(`${preset.name}: valid CSS that sets only theme variables, with its scheme and name`, () => {
      const info = inspectThemeCss(preset.css, { isColor: (v) => parseColor(v) !== undefined });
      expect(info.issues).toEqual([]);
      if (preset.css === "") return;
      expect(info.colorScheme).toBe(preset.scheme);
      expect(info.name).toBe(preset.name);
    });
  }

  // The default theme is the baseline (white on the omp gradient is ~2.6:1 there); every other theme
  // must keep text legible on the surfaces it sits on. High contrast clears 7:1 (AA large: 4.5:1).
  for (const preset of PRESETS.filter((p) => p.css !== "")) {
    test(`${preset.name}: text stays legible on its surfaces`, () => {
      const hc = preset.id === "contrast";
      const vars = new Map([...DEFAULTS, ...inspectThemeCss(preset.css).vars]);
      const color = (name: string, depth = 0): Rgba => {
        const value = vars.get(name);
        const ref = value && /^var\((--[\w-]+)\)$/.exec(value);
        const parsed = ref && depth < 8 ? color(ref[1] as string, depth + 1) : value && parseColor(value);
        if (!parsed) throw new Error(`${preset.id}: ${name} is not a colour (${value})`);
        return parsed;
      };
      const tile2 = color("--color-tile-2");
      const opaque = (name: string) => {
        const c = color(name);
        return c.a < 1 ? over(c, tile2) : c;
      };
      const fails: string[] = [];
      const need = (label: string, ratio: number, min: number) => {
        if (ratio < min) fails.push(`${label} ${ratio.toFixed(2)} < ${min}`);
      };
      const pair = (fg: string, bg: string, min: number) => need(`${fg} on ${bg}`, contrast(opaque(fg), opaque(bg)), min);
      const onTint = (fg: string, tint: string, alpha: number, min: number) => need(`${fg} on ${tint} tint`, contrast(opaque(fg), over({ ...color(tint), a: alpha }, tile2)), min);
      const body = hc ? 7 : 4.5;

      for (const s of ["bg", "tile-1", "tile-2", "tile-3", "pop-1", "pop-2", "sheet-1", "sheet-2"]) pair("--color-ink", `--color-${s}`, 7);
      pair("--color-ink", "--color-tile-4", body);
      need("--color-ink on --color-float", contrast(color("--color-ink"), over({ ...color("--color-float"), a: 0.94 }, color("--color-bg"))), 7);
      for (const s of ["tile-1", "tile-2", "tile-3"]) {
        pair("--color-ink-2", `--color-${s}`, body);
        pair("--color-mute", `--color-${s}`, body);
        pair("--color-mute-2", `--color-${s}`, hc ? 4.5 : 3);
      }
      pair("--color-mute", "--color-tile-4", hc ? 7 : 4);
      pair("--color-accent", "--color-tile-2", 3);
      onTint("--color-accent-ink", "--color-accent", 0.14, body);
      onTint("--color-error-ink", "--color-error", 0.12, body);
      onTint("--color-sun-ink", "--color-sun-2", 0.12, body);
      onTint("--color-warn-ink", "--color-warn", 0.12, body);
      for (const s of ["accent-hi", "run-solid", "sun-1", "sun-2", "review", "done", "idle", "error", "warn", "add", "del", "tool"]) {
        pair(`--color-${s}`, "--color-tile-2", s === "sun-1" ? 4 : body);
        pair(`--color-${s}`, "--color-tile-3", hc ? 4.5 : 3.5);
      }
      const fills: [string, string[], number][] = [
        ["on-accent", ["accent"], 4.5],
        ["on-accent", ["omp-pink", "omp-purple", "omp-blue"], 3],
        ["on-run", ["run-1", "run-2", "run-solid"], 3],
        // the sunset carries white text in every theme; the default's sun-1 is 2.6:1
        ["on-sun", ["sun-1", "sun-2"], 2.6],
        ["on-review", ["review", "review-2"], 3],
        ["on-done", ["done", "done-2"], 3],
        ["on-idle", ["idle-1", "idle-2"], 3],
        ["on-error", ["error", "error-2"], 3],
      ];
      for (const [on, list, min] of fills) for (const f of list) pair(`--color-${on}`, `--color-${f}`, hc ? 4.5 : min);

      pair("--term-fg", "--term-bg", 7);
      for (const k of ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "bright-black", "bright-red", "bright-green", "bright-yellow", "bright-blue", "bright-magenta", "bright-cyan", "bright-white"])
        pair(`--term-${k}`, "--term-bg", hc ? 4.5 : 3);
      for (const k of ["keyword", "string", "number", "function", "type", "operator", "property", "attribute", "variable", "tag", "literal", "comment", "punctuation"]) {
        const dim = !hc && (k === "comment" || k === "punctuation");
        pair(`--syntax-${k}`, "--color-bg-deep", dim ? 3 : 4.5);
        pair(`--syntax-${k}`, "--color-tile-1", dim ? 3 : 4.5);
        pair(`--syntax-${k}`, "--color-tile-3", dim ? 2.5 : 3.5);
      }
      expect(fails).toEqual([]);
    });
  }
});
