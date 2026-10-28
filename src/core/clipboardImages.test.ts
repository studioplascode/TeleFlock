import { describe, expect, test } from "bun:test";
import { attachImages, dragHasFiles, fitImages, imageChars, imageFiles, MAX_PROMPT_IMAGE_CHARS, shrinkImage } from "./clipboardImages";
import { getDraftImages, MAX_DRAFT_IMAGES } from "./draftImages";

const png = (name = "image.png", bytes = 8, lastModified = 1) => new File([new Uint8Array(bytes)], name, { type: "image/png", lastModified });
const item = (f: File | null, kind = "file", type = f?.type ?? "text/plain") => ({ kind, type, getAsFile: () => f });

describe("imageFiles", () => {
  test("items only (WebKitGTK pastes screenshots there, files stays empty)", () => {
    const shot = png();
    expect(imageFiles({ items: [item(shot)], files: [] })).toEqual([shot]);
  });

  test("files only (drops from a file manager), also when items holds only strings", () => {
    const a = png("a.png");
    expect(imageFiles({ files: [a] })).toEqual([a]);
    expect(imageFiles({ items: [item(null, "string", "text/uri-list")], files: [a] })).toEqual([a]);
  });

  test("a pasted image counts once although Chromium lists it in items and files", () => {
    // Two File objects, one per list, whose lastModified differ (Chromium 150: 1 ms apart for a
    // small image, 22 ms for a screenshot).
    const fromFiles = png("image.png", 8, 1_000);
    const fromItems = png("image.png", 8, 1_022);
    expect(imageFiles({ items: [item(fromItems)], files: [fromFiles] })).toHaveLength(1);
  });

  test("text and non-image files are skipped; distinct images all kept", () => {
    const a = png("a.png", 8);
    const b = png("b.png", 9);
    const doc = new File(["x"], "notes.txt", { type: "text/plain" });
    expect(imageFiles({ items: [item(null, "string", "text/plain"), item(a), item(doc), item(b)], files: [a, doc, b] })).toEqual([a, b]);
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

describe("prompt image caps", () => {
  const img = (chars: number) => ({ mime: "image/png", data: "A".repeat(chars), preview: "" });

  test("count and total size", () => {
    const nine = Array.from({ length: MAX_DRAFT_IMAGES + 1 }, () => img(4));
    const counted = fitImages([], nine);
    expect(counted.images).toHaveLength(MAX_DRAFT_IMAGES);
    expect(counted.skipped).toContain(`${MAX_DRAFT_IMAGES} images`);
    const half = img(MAX_PROMPT_IMAGE_CHARS / 2 + 1);
    const sized = fitImages([half], [half, img(10)]);
    // The big one is left out, a small one after it still fits.
    expect(sized.images.map((i) => i.data.length)).toEqual([half.data.length, 10]);
    expect(sized.skipped).toContain("MB in total");
    expect(fitImages([img(1)], [img(2)])).toEqual({ images: [img(1), img(2)] });
  });

  test("overlapping pastes are capped against each other, not against what each saw at the start", async () => {
    // 5 MiB each: ~6.7 MiB of base64, so only one of two fits under the 12 MiB cap.
    const big = (name: string) => new File([new Uint8Array(5 * 1024 * 1024)], name, { type: "image/png", lastModified: 1 });
    const [a, b] = await Promise.all([attachImages("test.overlap", [big("a.png")]), attachImages("test.overlap", [big("b.png")])]);
    expect([a.added, b.added].sort()).toEqual([0, 1]);
    expect(a.skipped ?? b.skipped).toContain("MB in total");
    const kept = getDraftImages("test.overlap");
    expect(kept).toHaveLength(1);
    expect(imageChars(kept)).toBeLessThanOrEqual(MAX_PROMPT_IMAGE_CHARS);
  });
});
