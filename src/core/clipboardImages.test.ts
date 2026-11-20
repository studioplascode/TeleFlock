import { describe, expect, test } from "bun:test";
import { attachImages, dragHasFiles, fitImages, imageChars, imageFiles, isVideoFile, MAX_PROMPT_IMAGE_CHARS, shrinkImage, splitAttachments, transferFiles } from "./clipboardImages";
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

describe("what a file attaches as", () => {
  const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type, lastModified: 7 });

  test("a mixed selection: images inline, a video and a PDF to the host, in the order picked", () => {
    const shot = png("shot.png");
    const clip = file("clip.mp4", "video/mp4");
    const spec = file("spec.pdf", "application/pdf");
    const split = splitAttachments([spec, shot, clip]);
    expect(split.images).toEqual([shot]);
    expect(split.uploads).toEqual([spec, clip]);
    expect(split.uploads.map(isVideoFile)).toEqual([false, true]);
  });

  test("a file handed over without a type is told by its extension; such an image gets the type it is sent as", () => {
    const { images, uploads } = splitAttachments([file("IMG_2041.JPG", ""), file("scan.webp", "application/octet-stream"), file("VID_1.MP4", ""), file("report.pdf", ""), file("notes", "")]);
    expect(images.map((f) => [f.name, f.type])).toEqual([
      ["IMG_2041.JPG", "image/jpeg"],
      ["scan.webp", "image/webp"],
    ]);
    expect(uploads.map((f) => [f.name, isVideoFile(f)])).toEqual([
      ["VID_1.MP4", true],
      ["report.pdf", false],
      ["notes", false],
    ]);
  });

  test("only the image formats models read go inline; any other image uploads like a file", () => {
    const { images, uploads } = splitAttachments([file("logo.svg", "image/svg+xml"), file("IMG_0042.HEIC", "image/heic"), file("photo.jpg", "image/jpg"), png("shot.png")]);
    expect(images.map((f) => [f.name, f.type])).toEqual([
      ["photo.jpg", "image/jpeg"],
      ["shot.png", "image/png"],
    ]);
    expect(uploads.map((f) => f.name)).toEqual(["logo.svg", "IMG_0042.HEIC"]);
  });

  test("a TypeScript source the platform calls an MPEG transport stream is no video", () => {
    expect(isVideoFile(file("index.ts", "video/mp2t"))).toBe(false);
    expect(isVideoFile(file("worker.mts", "video/mp2t"))).toBe(false);
    expect(isVideoFile(file("concert.m2ts", "video/mp2t"))).toBe(true);
    expect(isVideoFile(file("clip.mov", "video/quicktime"))).toBe(true);
  });

  test("every file of a paste or a drop, dropped folders left out", () => {
    const spec = file("spec.pdf", "application/pdf");
    const folder = file("src", "");
    const dir = { kind: "file", type: "", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) };
    expect(transferFiles({ items: [item(spec), dir, item(null, "string", "text/uri-list")], files: [spec, folder] })).toEqual([spec]);
    // Only a folder in `items`: `files` would hand it over again.
    expect(transferFiles({ items: [dir], files: [folder] })).toEqual([]);
    expect(transferFiles({ files: [spec] })).toEqual([spec]);
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
