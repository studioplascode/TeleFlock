import { describe, expect, test } from "bun:test";
import { dragHasFiles, imageFiles, shrinkImage } from "./clipboardImages";

const png = (name = "image.png", bytes = 8, lastModified = 1) => new File([new Uint8Array(bytes)], name, { type: "image/png", lastModified });
const item = (f: File | null, kind = "file", type = f?.type ?? "text/plain") => ({ kind, type, getAsFile: () => f });

describe("imageFiles", () => {
  test("items only (WebKitGTK pastes screenshots there, files stays empty)", () => {
    const shot = png();
    expect(imageFiles({ items: [item(shot)], files: [] })).toEqual([shot]);
  });

  test("files only (drops from a file manager)", () => {
    const a = png("a.png");
    expect(imageFiles({ files: [a] })).toEqual([a]);
  });

  test("the same image in items and files counts once", () => {
    const shot = png();
    // getAsFile() hands out a new File object for the same image.
    const copy = new File([new Uint8Array(8)], "image.png", { type: "image/png", lastModified: 1 });
    expect(imageFiles({ items: [item(copy)], files: [shot] })).toHaveLength(1);
  });

  test("text and non-image files are skipped; distinct images all kept", () => {
    const a = png("a.png", 8);
    const b = png("b.png", 9);
    const doc = new File(["x"], "notes.txt", { type: "text/plain" });
    expect(imageFiles({ items: [item(null, "string", "text/plain"), item(a), item(doc)], files: [b, doc] })).toEqual([a, b]);
    expect(imageFiles(null)).toEqual([]);
    expect(imageFiles({ items: [item(null, "file", "image/png")] })).toEqual([]);
  });

  test("drag-over sees files by kind only", () => {
    expect(dragHasFiles({ items: [item(null, "file", "image/png")] })).toBe(true);
    expect(dragHasFiles({ items: [item(null, "string", "text/plain")] })).toBe(false);
  });
});

describe("shrinkImage", () => {
  test("small images and GIFs are untouched", async () => {
    const small = png();
    expect(await shrinkImage(small)).toBe(small);
    const gif = new File([new Uint8Array(4 * 1024 * 1024)], "a.gif", { type: "image/gif" });
    expect(await shrinkImage(gif)).toBe(gif);
  });
});
