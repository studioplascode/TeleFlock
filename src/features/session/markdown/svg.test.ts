import { describe, expect, test } from "bun:test";
import { prepareSvg, previewKind, svgDataUrl } from "./svg";

describe("prepareSvg", () => {
  test("adds the namespace an SVG image needs", () => {
    const p = prepareSvg('<svg width="40" height="20"><circle r="3"/></svg>')!;
    expect(p.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(p).toMatchObject({ width: 40, height: 20 });
    expect(p.svg).toContain("</svg>");
  });

  test("sizes from the viewBox when width/height are missing or relative", () => {
    expect(prepareSvg('<svg viewBox="0 0 120 60"></svg>')).toMatchObject({ width: 120, height: 60 });
    const mermaid = prepareSvg('<svg id="m" width="100%" style="max-width: 300px;" viewBox="0 0 300 150"><g/></svg>')!;
    expect(mermaid).toMatchObject({ width: 300, height: 150 });
    expect(mermaid.svg).not.toContain('width="100%"');
    expect(mermaid.svg).toContain('style="max-width: 300px;"');
  });

  test("one given side scales the other by the viewBox ratio", () => {
    expect(prepareSvg('<svg width="200" viewBox="0 0 100 50"></svg>')).toMatchObject({ width: 200, height: 100 });
  });

  test("no size at all gets a viewBox so it still scales", () => {
    const p = prepareSvg("<svg><rect/></svg>")!;
    expect(p).toMatchObject({ width: 300, height: 150 });
    expect(p.svg).toContain('viewBox="0 0 300 150"');
  });

  test("self-closing root and an XML prolog survive", () => {
    expect(prepareSvg('<svg width="5" height="5"/>')!.svg).toMatch(/<svg[^>]*><\/svg>$/);
    expect(prepareSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 4 4"></svg>')!.svg.startsWith("<?xml")).toBe(true);
  });

  test("background goes under the drawing, on the viewBox's bounds", () => {
    const p = prepareSvg('<svg viewBox="-10 -5 100 50"><circle/></svg>', "#fff")!;
    expect(p.svg).toMatch(/<svg[^>]*><rect x="-10" y="-5" width="100" height="50" fill="#fff"\/><circle\/>/);
  });

  test("xlink references get their namespace; mermaid's <br> becomes XML", () => {
    expect(prepareSvg('<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>')!.svg).toContain("xmlns:xlink");
    expect(prepareSvg('<svg viewBox="0 0 1 1"><text>a<br>b</text></svg>')!.svg).toContain("<br/>");
  });

  test("not an svg, or too large", () => {
    expect(prepareSvg("<div>hi</div>")).toBeNull();
    expect(prepareSvg("<svgx/>")).toBeNull();
    expect(prepareSvg(`<svg viewBox="0 0 1 1">${"a".repeat(1_600_000)}</svg>`)).toBeNull();
  });

  test("whatever an svg fence holds, preparing it takes linear time", () => {
    const within = (ms: number, run: () => unknown) => {
      const t = performance.now();
      run();
      expect(performance.now() - t).toBeLessThan(ms);
    };
    // a root tag that never ends (no `>` anywhere after it), at the size limit
    within(1000, () => expect(prepareSvg("<svg ".repeat(300_000))).toBeNull());
    // spaces around what is not a length, and before the root tag's end
    within(1000, () => expect(prepareSvg(`<svg width="1${" ".repeat(300_000)}!" height="2"></svg>`)).toMatchObject({ width: 300, height: 2 }));
    within(1000, () => expect(prepareSvg(`<svg viewBox="0 0 4 2"${" ".repeat(300_000)}/>`)).toMatchObject({ width: 4, height: 2 }));
    // over the limit: refused before anything is searched
    within(1000, () => expect(prepareSvg(`<svg ${"a".repeat(2_000_000)}`)).toBeNull());
  });

  test("scripts are not stripped but live only inside an image document", () => {
    // Displayed through <img>, where no script runs; the markup is passed through untouched.
    const p = prepareSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>')!;
    expect(svgDataUrl(p.svg).startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(svgDataUrl(p.svg)).not.toContain("<");
  });
});

describe("previewKind", () => {
  test("by extension", () => {
    expect(previewKind("a/b/logo.SVG")).toBe("svg");
    expect(previewKind("flow.mmd")).toBe("mermaid");
    expect(previewKind("x.mermaid")).toBe("mermaid");
    expect(previewKind("docs/README.md")).toBe("markdown");
    expect(previewKind("a.ts")).toBeUndefined();
    expect(previewKind("svg")).toBeUndefined();
  });
});

describe("prepareSvg scale", () => {
  test("enlarges the drawn size, keeps the drawing, and the background covers the viewBox", () => {
    const p = prepareSvg('<svg viewBox="0 0 100 50"><circle/></svg>', "#000", 3)!;
    expect(p).toMatchObject({ width: 300, height: 150 });
    expect(p.svg).toContain('viewBox="0 0 100 50"');
    expect(p.svg).toContain('<rect x="0" y="0" width="100" height="50" fill="#000"/>');
    const bare = prepareSvg('<svg width="40" height="20"><circle/></svg>', "#000", 2)!;
    expect(bare.svg).toContain('viewBox="0 0 40 20"');
    expect(bare.svg).toContain('width="80"');
  });
});
