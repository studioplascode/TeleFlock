import { describe, expect, test } from "bun:test";
import { checkoutName, repoAccent } from "./RepoTag";

describe("checkout name", () => {
  test("the repo wins; otherwise the folder, with the home folder as ~", () => {
    expect(checkoutName({ repo: "teleflock", cwd: "/home/demo/.herdr/worktrees/teleflock/feat-x" }, "/home/demo")).toEqual({ repo: true, name: "teleflock" });
    expect(checkoutName({ cwd: "/home/demo/scratch/" }, "/home/demo")).toEqual({ repo: false, name: "scratch" });
    expect(checkoutName({ cwd: "/home/demo" }, "/home/demo/")).toEqual({ repo: false, name: "~" });
    expect(checkoutName({ cwd: "C:\\Users\\me\\notes" }, "C:\\Users\\me")).toEqual({ repo: false, name: "notes" });
    expect(checkoutName({ cwd: "/" })).toEqual({ repo: false, name: "/" });
    expect(checkoutName({})).toBeNull();
  });

  test("a repo keeps its accent wherever it shows", () => {
    expect(repoAccent("api-gateway")).toBe(repoAccent("api-gateway"));
    expect(repoAccent("api-gateway")).not.toBe(repoAccent("teleflock"));
  });
});
