import { describe, expect, test } from "bun:test";
import { foldedPaneLabel, soleRow } from "./sidebarTree";

describe("soleRow", () => {
  test("exactly one row folds, whichever kind it is", () => {
    expect(soleRow({ agents: ["a"], shells: [] })).toEqual({ kind: "agent", agent: "a" });
    expect(soleRow({ agents: [], shells: ["s"] })).toEqual({ kind: "shell", shell: "s" });
  });

  test("none, or two or more, keep the grouped worktree", () => {
    expect(soleRow({ agents: [], shells: [] })).toBeUndefined();
    expect(soleRow({ agents: ["a"], shells: ["s"] })).toBeUndefined();
    expect(soleRow({ agents: ["a", "b"], shells: [] })).toBeUndefined();
    expect(soleRow({ agents: [], shells: ["s", "t"] })).toBeUndefined();
  });
});

describe("foldedPaneLabel", () => {
  test("a name the worktree already carries is not repeated", () => {
    expect(foldedPaneLabel("dispatch/fix-login", "fix-login")).toBeUndefined();
    expect(foldedPaneLabel("ci-main-prs-green", "CI-main-prs-green")).toBeUndefined();
  });

  test("any other name stays, as the pane's own label", () => {
    expect(foldedPaneLabel("main", "omp")).toBe("omp");
    expect(foldedPaneLabel("feat/login", "login-agent")).toBe("login-agent");
    expect(foldedPaneLabel("~", "bash")).toBe("bash");
    expect(foldedPaneLabel("main", "  ")).toBeUndefined();
  });
});
