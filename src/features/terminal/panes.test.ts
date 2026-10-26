import { describe, expect, test } from "bun:test";
import type { PaneInfo, Workspace } from "@/core/gen";
import { hostPanes, paneDetail, paneName } from "./panes";

const pane = (p: Partial<PaneInfo>): PaneInfo => ({ id: "w1:p1", focused: false, ...p });

describe("paneName", () => {
  test("a program wins over a stale shell title, unless the title names it", () => {
    expect(paneName(pane({ process: "vim", title: "~/code/app" }))).toBe("vim");
    expect(paneName(pane({ process: "bun", title: "bun run dev" }))).toBe("bun run dev");
  });

  test("an idle shell is called by its title, else the shell, folder, id", () => {
    expect(paneName(pane({ process: "zsh", title: "build box" }))).toBe("build box");
    expect(paneName(pane({ process: "-bash" }))).toBe("-bash");
    expect(paneName(pane({ cwd: "/home/u/code/app/" }))).toBe("app");
    expect(paneName(pane({}))).toBe("w1:p1");
  });

  test("detail adds the process the name hides and a ~-relative folder", () => {
    expect(paneDetail(pane({ process: "zsh", title: "build box", cwd: "/home/u/x" }), "/home/u")).toBe("zsh · ~/x");
    expect(paneDetail(pane({ process: "vim", cwd: "/srv" }), "/home/u")).toBe("/srv");
    expect(paneDetail(pane({ process: "bun", title: "bun run dev", cwd: "/home/u/app" }), "/home/u", "/home/u/app")).toBe("");
    expect(paneDetail(pane({ process: "zsh", cwd: "/home/u/app/infra" }), "/home/u", "/home/u/app/")).toBe("./infra");
  });
});

test("hostPanes orders by workspace order, then tabs and panes", () => {
  const ws = (id: string, order: number, panes: string[][]): Workspace => ({
    id,
    label: id,
    cwd: "/",
    tabs: panes.map((ids, i) => ({ id: `${id}:t${i}`, label: `t${i}`, panes: ids.map((p) => pane({ id: p })) })),
    rollup: "idle",
    order,
  });
  const refs = hostPanes([ws("w2", 1, [["w2:p1"]]), ws("w1", 0, [["w1:p1", "w1:p2"], ["w1:p3"]])]);
  expect(refs.map((r) => `${r.tab.label}/${r.pane.id}`)).toEqual(["t0/w1:p1", "t0/w1:p2", "t1/w1:p3", "t0/w2:p1"]);
});
