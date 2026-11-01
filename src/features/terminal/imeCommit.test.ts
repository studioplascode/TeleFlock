import { describe, expect, test } from "bun:test";
import { ImeCommits } from "./imeCommit";

describe("ImeCommits", () => {
  test("a commit without compositionstart (WebKitGTK) is taken, with the textarea value before it", () => {
    const c = new ImeCommits();
    c.beforeInput("insertFromComposition", "ls Güß 😀");
    expect(c.end("[dictated]")).toEqual({ text: "[dictated]", before: "ls Güß 😀" });
    // The next one is judged on its own.
    c.beforeInput("insertFromComposition", "ls Güß 😀[dictated]");
    expect(c.end("😀")).toEqual({ text: "😀", before: "ls Güß 😀[dictated]" });
  });

  test("a composition that starts as usual stays with xterm", () => {
    const c = new ImeCommits();
    c.start();
    c.beforeInput("insertCompositionText", "");
    c.beforeInput("insertFromComposition", "");
    expect(c.end("日本")).toBeNull();
    // ...and does not leave the next lone commit unrecognised.
    c.beforeInput("insertFromComposition", "日本");
    expect(c.end("語")).toEqual({ text: "語", before: "日本" });
  });

  test("a compositionend with no commit before it is left alone", () => {
    const c = new ImeCommits();
    c.beforeInput("insertText", "abc");
    expect(c.end("x")).toBeNull();
  });
});
