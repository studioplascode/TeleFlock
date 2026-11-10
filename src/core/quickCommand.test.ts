import { describe, expect, test } from "bun:test";
import { quickCommand } from "./quickCommand";

describe("quickCommand reads a draft as omp's composer does", () => {
  test("`!` and `!!` run a shell command, the second without adding its output to the context", () => {
    expect(quickCommand("!ls")).toEqual({ prefix: "!", python: false, excluded: false, body: "ls" });
    expect(quickCommand("  !!git status \n")).toEqual({ prefix: "!!", python: false, excluded: true, body: "git status" });
    expect(quickCommand("! ls -la")).toEqual({ prefix: "!", python: false, excluded: false, body: "ls -la" });
    expect(quickCommand("!!!x")).toEqual({ prefix: "!!", python: false, excluded: true, body: "!x" });
    expect(quickCommand("!cd src &&\nbun test")?.body).toBe("cd src &&\nbun test");
  });

  test("nothing after the prefix is an ordinary message", () => {
    for (const draft of ["!", "!!", " ! ", "!! \n", "$", "$$", "$ ", "$$\t"]) expect(quickCommand(draft)).toBeNull();
  });

  test("`$` and `$$` then whitespace run Python", () => {
    expect(quickCommand("$ print(1)")).toEqual({ prefix: "$", python: true, excluded: false, body: "print(1)" });
    expect(quickCommand("$$ print(1)")).toEqual({ prefix: "$$", python: true, excluded: true, body: "print(1)" });
    expect(quickCommand("$\nimport os\nprint(os.getcwd())")?.body).toBe("import os\nprint(os.getcwd())");
    expect(quickCommand("$\tx = 1")?.body).toBe("x = 1");
    // Without whitespace after it, `$` is text.
    for (const draft of ["$print(1)", "$$print(1)", "$$$ x", "$HOME is unset"]) expect(quickCommand(draft)).toBeNull();
  });

  test("a `$` line that reads like a shell command is a message; `$$` always runs Python", () => {
    for (const code of ["git status", "cd src", "./run.sh", "~/bin/x", "../x", "sudo make", "bun test", "npm i", "pnpm i", "yarn", "node x.js", "python3 x.py", "cargo test", "go test", "make", "docker ps", "kubectl get pods", "ls | wc -l", "a && b", "a || b", "x 2>&1", "cat < in", "echo hi > out"]) {
      expect(quickCommand(`$ ${code}`)).toBeNull();
    }
    expect(quickCommand("$ in: 1200 out: 300 cache 80% t: 4.1s tok/s: 72")).toBeNull();
    expect(quickCommand("$$ git status")).toEqual({ prefix: "$$", python: true, excluded: true, body: "git status" });
    // Only the first line counts for the command words: Python that runs one later is Python.
    expect(quickCommand("$ import subprocess\ngit = 1")?.python).toBe(true);
    expect(quickCommand("$ gitlab_url = 'x'")?.python).toBe(true);
  });

  test("anything else is a message", () => {
    for (const draft of ["ls", "hello !ls", "/plan", " /fast on", "", "   "]) expect(quickCommand(draft)).toBeNull();
  });
});
