import { describe, expect, test } from "bun:test";
import { linkProps, safeHref } from "./links";

describe("agent link policy", () => {
  test("only absolute http(s) URLs are followable", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://localhost:5173")).toBe("http://localhost:5173/");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "file:///etc/passwd", "vscode://file/x", "ms-settings:", "data:text/html,x", "/relative", "#/board", "", undefined]) {
      expect(safeHref(bad)).toBeUndefined();
      expect(linkProps(bad)).toBeNull();
    }
  });

  test("clicks never navigate the webview", () => {
    const opened: string[] = [];
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    g.window = { open: (url: string) => opened.push(url) };
    try {
      const link = linkProps("https://example.com")!;
      let prevented = false;
      link.onClick({ preventDefault: () => (prevented = true) });
      expect(prevented).toBe(true);
      expect(opened).toEqual(["https://example.com/"]);
    } finally {
      g.window = prev;
    }
  });
});
