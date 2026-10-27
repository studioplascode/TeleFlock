import { describe, expect, test } from "bun:test";
import { type ClipItem, pastePathsInput, pastedMedia, pasteTextInput, pathsText, quotePath, readClipItems, readClipboard } from "./mediaPaste";

describe("quotePath", () => {
  test("leaves plain paths bare", () => {
    expect(quotePath("/home/u/.teleflock/uploads/2026-10-27/image-2.png")).toBe("/home/u/.teleflock/uploads/2026-10-27/image-2.png");
    expect(quotePath("/tmp/日本語/写真.jpeg")).toBe("/tmp/日本語/写真.jpeg");
  });

  test("single-quotes spaces, shell characters and Windows separators", () => {
    expect(quotePath("/home/john doe/a.png")).toBe("'/home/john doe/a.png'");
    expect(quotePath("/srv/a(1)&b;$x/[y]*.png")).toBe("'/srv/a(1)&b;$x/[y]*.png'");
    expect(quotePath("C:\\Users\\me\\a.png")).toBe("'C:\\Users\\me\\a.png'");
  });

  test("double-quotes a path with a single quote, escaping what double quotes expand", () => {
    expect(quotePath("/home/o'brien/a.png")).toBe(`"/home/o'brien/a.png"`);
    expect(quotePath("/x/o'b $H/`c`/\"q\"/d\\e.png")).toBe('"/x/o\'b \\$H/\\`c\\`/\\"q\\"/d\\\\e.png"');
  });
});

test("paths go in as one bracketed paste, space-separated, with a trailing space", () => {
  expect(pathsText(["/a/x.png", "/b c/y.mp4"])).toBe("/a/x.png '/b c/y.mp4'");
  expect(pastePathsInput(["/a/x.png", "/b c/y.mp4"])).toBe("\x1b[200~/a/x.png '/b c/y.mp4' \x1b[201~");
});

describe("pasteTextInput", () => {
  test("multi-line text is one bracketed paste with xterm's line breaks", () => {
    expect(pasteTextInput("first line\nsecond\r\nthird")).toBe("\x1b[200~first line\rsecond\rthird\x1b[201~");
  });

  test("text can never close the paste early, even from pieces of the end marker", () => {
    expect(pasteTextInput("a\x1b[201~rm -rf ~\n")).toBe("\x1b[200~a[201~rm -rf ~\r\x1b[201~");
    const out = pasteTextInput("x\x1b[20\x1b[201~1~y");
    expect(out.startsWith("\x1b[200~")).toBe(true);
    expect(out.indexOf("\x1b[201~")).toBe(out.length - "\x1b[201~".length);
  });
});

describe("pastedMedia", () => {
  const png = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const mp4 = new File([new Uint8Array([4])], "clip.mp4", { type: "video/mp4" });
  const pdf = new File([new Uint8Array([5])], "doc.pdf", { type: "application/pdf" });
  const clipboard = (text: string, files: File[]) => ({
    getData: (format: string) => (format === "text/plain" ? text : ""),
    files,
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  });

  test("images and videos when the clipboard has no text", () => {
    expect(pastedMedia(clipboard("", [png, mp4, pdf])).map((f) => f.name)).toEqual(["shot.png", "clip.mp4"]);
    expect(pastedMedia(clipboard(" \n", [png])).map((f) => f.name)).toEqual(["shot.png"]);
  });

  test("text on the clipboard keeps the text paste", () => {
    expect(pastedMedia(clipboard("ls -la", [png]))).toEqual([]);
    expect(pastedMedia(clipboard("", [pdf]))).toEqual([]);
    expect(pastedMedia(null)).toEqual([]);
  });
});

/** A clipboard item holding `parts` (type → content), in order. */
function item(parts: Record<string, Blob | string>): ClipItem {
  return {
    types: Object.keys(parts),
    getType: async (type) => {
      const part = parts[type];
      if (part === undefined) throw new Error(`no ${type}`);
      return typeof part === "string" ? new Blob([part], { type }) : part;
    },
  };
}

describe("readClipItems", () => {
  const png = new Blob([new Uint8Array([1])], { type: "image/png" });
  const mp4 = new Blob([new Uint8Array([2])], { type: "video/mp4" });

  test("text wins over images", async () => {
    expect(await readClipItems([item({ "text/plain": "ls -la", "image/png": png })])).toEqual({ text: "ls -la", media: [] });
  });

  test("one image or video per item when there is no text", async () => {
    const got = await readClipItems([item({ "text/html": "<img>", "image/png": png, "image/svg+xml": "<svg/>" }), item({ "video/mp4": mp4 })]);
    expect(got).toEqual({ text: "", media: [png, mp4] });
  });
});

describe("readClipboard", () => {
  test("reads images through read()", async () => {
    const png = new Blob([new Uint8Array([1])], { type: "image/png" });
    expect(await readClipboard({ read: async () => [item({ "image/png": png })], readText: async () => "" })).toEqual({ text: "", media: [png] });
  });

  test("falls back to readText() when read() is missing or refused", async () => {
    expect(await readClipboard({ readText: async () => "a" })).toEqual({ text: "a", media: [] });
    const refused = async (): Promise<ClipItem[]> => {
      throw new Error("NotAllowedError");
    };
    expect(await readClipboard({ read: refused, readText: async () => "b" })).toEqual({ text: "b", media: [] });
  });

  test("rejects when clipboard access is denied", async () => {
    const denied = async (): Promise<string> => {
      throw new Error("denied");
    };
    await expect(readClipboard({ readText: denied })).rejects.toThrow("denied");
  });
});
