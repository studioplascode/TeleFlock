import { describe, expect, test } from "bun:test";
import { evalCells, shownEvalCells } from "./evalArgs";

describe("evalCells", () => {
  test("a single cell: its code as written, Python unless it says js", () => {
    const code = 'import os\n\nfor name in os.listdir("."):\n    print(f"{name!r}")';
    expect(evalCells({ language: "py", code, title: "List files", timeout: 30 })).toEqual([{ language: "python", code, title: "List files" }]);
    expect(evalCells({ code: "1 + 1" })).toEqual([{ language: "python", code: "1 + 1" }]);
    expect(evalCells({ language: "js", code: "await fetch(url)", title: "  " })).toEqual([{ language: "javascript", code: "await fetch(url)" }]);
  });

  test("older omp's cells, each with its own language and title", () => {
    expect(
      evalCells({
        cells: [
          { language: "py", code: "x = 1", title: "Set up" },
          { language: "js", code: "console.log(2)" },
        ],
      }),
    ).toEqual([
      { language: "python", code: "x = 1", title: "Set up" },
      { language: "javascript", code: "console.log(2)" },
    ]);
  });

  test("arguments still being written give the cells with code so far, never a throw", () => {
    for (const args of [undefined, null, {}, "{\"lang", [], 42, { language: "py" }, { code: 12 }, { cells: "x" }, { cells: [null, 3, {}] }]) expect(evalCells(args)).toEqual([]);
    expect(evalCells({ language: "py", code: "   \n" })).toEqual([]);
    expect(evalCells({ cells: [{ code: "a = 1" }, { language: "js" }] })).toEqual([{ language: "python", code: "a = 1" }]);
  });
});

describe("shownEvalCells", () => {
  test("eval calls without a view or with a screenshot; nothing for other tools or views", () => {
    const args = { language: "js", code: "await tab.screenshot()" };
    expect(shownEvalCells({ tool: "eval", args })).toHaveLength(1);
    expect(shownEvalCells({ tool: "eval", args, view: { type: "image", image: { mime: "image/png", data: "iVBO" } } })).toHaveLength(1);
    expect(shownEvalCells({ tool: "bash", args })).toEqual([]);
    expect(shownEvalCells({ tool: "eval", args, view: { type: "markdown", text: "x" } })).toEqual([]);
  });
});
