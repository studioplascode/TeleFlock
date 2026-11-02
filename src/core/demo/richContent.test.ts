import { describe, expect, test } from "bun:test";
import { parseBlocks, parseInline } from "@/features/session/markdown/parse";
import { prepareSvg } from "@/features/session/markdown/svg";
import { FLOCK_SVG, RICH_TEXT, richContentSteps } from "./richContent";

describe("the demo's rich transcript text", () => {
  const blocks = parseBlocks(RICH_TEXT);
  test("has three closed mermaid fences, one svg fence and a display formula", () => {
    const code = blocks.filter((b) => b.t === "code");
    expect(code.map((b) => b.lang)).toEqual(["mermaid", "mermaid", "svg", "mermaid"]);
    expect(code.every((b) => !b.open)).toBe(true);
    expect(blocks.filter((b) => b.t === "math")).toHaveLength(1);
    expect(prepareSvg(FLOCK_SVG)).not.toBeNull();
  });

  test("the paragraph with formulas and prices takes the formulas and leaves the prices", () => {
    const formulas = blocks.flatMap((b) => (b.t === "p" ? parseInline(b.text).flatMap((n) => (n.t === "math" ? [n.tex] : [])) : []));
    expect(formulas).toEqual(["L = \\lambda W", "\\lambda = 120", "W = 45", "5.4", "p_{99} \\approx \\mu + 2.33\\,\\sigma"]);
    const prices = blocks.find((b): b is Extract<typeof b, { t: "p" }> => b.t === "p" && b.text.startsWith("Prices"));
    expect(prices && parseInline(prices.text).some((n) => n.t === "math")).toBe(false);
  });

  test("the history writes an svg, a mermaid file and a markdown file with their whole content", () => {
    const paths = richContentSteps().flatMap((s) => (s.t === "tool" && s.spec.view?.type === "diff" ? s.spec.view.files.map((f) => f.path) : []));
    expect(paths).toEqual(["docs/img/flock.svg", "docs/flow.mmd", "docs/architecture.md"]);
  });
});
