import { describe, expect, test } from "bun:test";
import {
  baseRev,
  CHUNK,
  FIRST_READ,
  isBinaryLike,
  LOAD_MAX,
  mediaByPath,
  mediaSides,
  PREVIEW_MAX,
  RANGELESS_MAX,
  type RangeReader,
  readMedia,
  sameBytes,
  sizeVerdict,
  SNIFF_BYTES,
  sniffMedia,
  upscale,
} from "./media";
import { mergeFiles, parsePatch } from "./parse";

const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? Array.from(x, (c) => c.charCodeAt(0)) : [x])));

/** A host file of `size` bytes (byte i is i % 251), read in ranges; `rangeless`: as hosts before 0.9.1. */
function fakeFile(content: Uint8Array, rangeless = false) {
  const reads: [number, number][] = [];
  const read: RangeReader = async (offset, maxBytes) => {
    reads.push([offset, maxBytes]);
    const start = rangeless ? 0 : Math.min(offset, content.length);
    const out = content.slice(start, start + Math.min(maxBytes, rangeless ? RANGELESS_MAX : 8 << 20));
    return { size: content.length, offset: rangeless ? undefined : start, bytes: out, truncated: start + out.length < content.length };
  };
  return { read, reads };
}

const filled = (n: number, head?: Uint8Array) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  if (head) b.set(head);
  return b;
};

describe("what a binary file shows as", () => {
  test("by extension, whatever its case", () => {
    expect(mediaByPath("art/previews/sack_flour.png")).toEqual({ kind: "image", mime: "image/png" });
    expect(mediaByPath("PHOTO.JPG")?.kind).toBe("image");
    expect(mediaByPath("icons/app.svg")).toEqual({ kind: "image", mime: "image/svg+xml" });
    expect(mediaByPath("clips/demo.MOV")).toEqual({ kind: "video", mime: "video/quicktime" });
    expect(mediaByPath("a/b.m4a")).toEqual({ kind: "audio", mime: "audio/mp4" });
    expect(mediaByPath("docs/spec.pdf")?.kind).toBe("pdf");
    for (const p of ["Makefile", ".gitignore", "data.sqlite", "archive.zip", "png", "dir.png/file", "font.woff2"]) expect(mediaByPath(p)).toBeUndefined();
  });

  test("by its first bytes, for names that say nothing", () => {
    expect(sniffMedia(bytes(0x89, "PNG\r\n", 0x1a, "\n", 0, 0))?.mime).toBe("image/png");
    expect(sniffMedia(bytes(0xff, 0xd8, 0xff, 0xe0))?.mime).toBe("image/jpeg");
    expect(sniffMedia(bytes("GIF89a"))?.mime).toBe("image/gif");
    expect(sniffMedia(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))?.mime).toBe("image/webp");
    expect(sniffMedia(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "))?.mime).toBe("audio/wav");
    expect(sniffMedia(bytes("%PDF-1.7\n"))?.kind).toBe("pdf");
    expect(sniffMedia(bytes(0, 0, 0, 0x20, "ftypisom"))?.mime).toBe("video/mp4");
    expect(sniffMedia(bytes(0, 0, 0, 0x14, "ftypqt  "))?.mime).toBe("video/quicktime");
    expect(sniffMedia(bytes(0, 0, 0, 0x1c, "ftypavif"))?.mime).toBe("image/avif");
    expect(sniffMedia(bytes(0, 0, 0, 0x1c, "ftypM4A "))?.mime).toBe("audio/mp4");
    expect(sniffMedia(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f))?.mime).toBe("video/webm");
    expect(sniffMedia(bytes("OggS", 0))?.kind).toBe("audio");
    expect(sniffMedia(bytes("fLaC"))?.mime).toBe("audio/flac");
    expect(sniffMedia(bytes("ID3", 4, 0))?.mime).toBe("audio/mpeg");
    // Not media: an archive, a database, an executable, too few bytes.
    for (const b of [bytes("PK", 3, 4), bytes("SQLite format 3", 0), bytes(0x7f, "ELF"), bytes(0x89, "PN"), new Uint8Array()]) expect(sniffMedia(b)).toBeUndefined();
  });

  test("binary files and media files get a preview row; an SVG with lines stays a diff", () => {
    const patch = [
      "diff --git a/art/a.png b/art/a.png\nnew file mode 100644\nBinary files /dev/null and b/art/a.png differ",
      "diff --git a/data.db b/data.db\nindex 1111111..2222222 100644\nBinary files a/data.db and b/data.db differ",
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b",
      "diff --git a/logo.svg b/logo.svg\n--- a/logo.svg\n+++ b/logo.svg\n@@ -1 +1 @@\n-<svg/>\n+<svg></svg>",
      // A PDF of uncompressed streams is text to git.
      "diff --git a/docs/guide.pdf b/docs/guide.pdf\nnew file mode 100644\n--- /dev/null\n+++ b/docs/guide.pdf\n@@ -0,0 +1,2 @@\n+%PDF-1.4\n+1 0 obj",
    ].join("\n");
    // `art/z.png` is past the patch's untracked files: listed, no lines.
    const files = mergeFiles(parsePatch(patch), [
      { path: "art/a.png", added: 0, removed: 0, status: "untracked" },
      { path: "art/z.png", added: 0, removed: 0, status: "untracked" },
      { path: "data.db", added: 0, removed: 0, status: "modified" },
      { path: "docs/guide.pdf", added: 2, removed: 0, status: "added" },
      { path: "logo.svg", added: 1, removed: 1, status: "modified" },
      { path: "src/x.ts", added: 1, removed: 1, status: "modified" },
    ]);
    expect(files.filter(isBinaryLike).map((f) => f.path)).toEqual(["art/a.png", "art/z.png", "data.db", "docs/guide.pdf"]);
  });

  test("blob ids come from the patch's index line; an untracked file has none", () => {
    const [mod, untracked] = parsePatch("diff --git a/a.png b/a.png\nindex b269f1d..055fbc1 100644\nBinary files a/a.png and b/a.png differ\ndiff --git a/b.png b/b.png\nnew file mode 100644\nBinary files /dev/null and b/b.png differ\n");
    expect(mod?.oids).toEqual({ old: "b269f1d", new: "055fbc1" });
    expect(untracked?.oids).toBeUndefined();
  });

  test("which versions a preview shows", () => {
    expect(mediaSides("modified")).toEqual(["old", "new"]);
    expect(mediaSides("deleted")).toEqual(["old"]);
    for (const s of ["added", "untracked", "renamed"] as const) expect(mediaSides(s)).toEqual(["new"]);
  });

  test("the old side is read at the base's sha", () => {
    expect(baseRev("4f1c2d9e0b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d")).toBe("4f1c2d9e0b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d");
    expect(baseRev("origin/main (50fc366)")).toBe("50fc366");
  });
});

describe("how much is read", () => {
  test("up to the preview cap at once, then on request, never past the hard cap", () => {
    expect(sizeVerdict(PREVIEW_MAX, false, false)).toBe("read");
    expect(sizeVerdict(PREVIEW_MAX + 1, false, false)).toBe("ask");
    expect(sizeVerdict(PREVIEW_MAX + 1, true, false)).toBe("read");
    expect(sizeVerdict(LOAD_MAX + 1, true, false)).toBe("never");
    // A host that reads from the start only: one read of its most.
    expect(sizeVerdict(RANGELESS_MAX, false, true)).toBe("read");
    expect(sizeVerdict(RANGELESS_MAX + 1, true, true)).toBe("never");
  });

  test("a small image is one read", async () => {
    const png = filled(300_000, bytes(0x89, "PNG"));
    const f = fakeFile(png);
    const out = await readMedia(f.read, "a.png", { forced: false });
    expect(out.state).toBe("ready");
    if (out.state === "ready") expect(sameBytes(png, out.parts)).toBe(true);
    expect(f.reads).toEqual([[0, FIRST_READ]]);
  });

  test("a large file arrives in ranges that join into it", async () => {
    const video = filled(FIRST_READ + 2 * CHUNK + 123);
    const f = fakeFile(video);
    const progress: number[] = [];
    const out = await readMedia(f.read, "clip.mp4", { forced: false, onProgress: (received) => progress.push(received) });
    expect(f.reads).toEqual([
      [0, FIRST_READ],
      [FIRST_READ, CHUNK],
      [FIRST_READ + CHUNK, CHUNK],
      [FIRST_READ + 2 * CHUNK, CHUNK],
    ]);
    expect(progress).toEqual([FIRST_READ, FIRST_READ + CHUNK, FIRST_READ + 2 * CHUNK]);
    expect(out.state === "ready" && out.size === video.length && sameBytes(video, out.parts)).toBe(true);
  });

  test("past the preview cap nothing more is read until asked", async () => {
    const big = filled(PREVIEW_MAX + 10);
    const f = fakeFile(big);
    expect(await readMedia(f.read, "big.mov", { forced: false })).toEqual({ state: "tooLarge", size: big.length, verdict: "ask", rangeless: false });
    expect(f.reads).toHaveLength(1);
    const forced = await readMedia(fakeFile(big).read, "big.mov", { forced: true });
    expect(forced.state === "ready" && forced.size === big.length).toBe(true);
  });

  test("a binary file whose name says nothing: a few bytes tell it apart", async () => {
    const db = fakeFile(filled(40_000, bytes("SQLite format 3", 0)));
    expect(await readMedia(db.read, "fixtures/columns", { forced: false })).toEqual({ state: "binary", size: 40_000 });
    expect(db.reads).toEqual([[0, SNIFF_BYTES]]);
    const shot = filled(70_000, bytes(0x89, "PNG\r\n", 0x1a, "\n"));
    const unnamed = fakeFile(shot);
    const out = await readMedia(unnamed.read, "screenshot", { forced: false });
    expect(out.state === "ready" && out.type.mime === "image/png" && sameBytes(shot, out.parts)).toBe(true);
    expect(await readMedia(fakeFile(new Uint8Array()).read, "empty.png", { forced: false })).toEqual({ state: "binary", size: 0 });
  });

  test("a host without ranges reads the whole file once, up to its 8 MB", async () => {
    const pdf = filled(3 * FIRST_READ, bytes("%PDF-1.7"));
    const f = fakeFile(pdf, true);
    const out = await readMedia(f.read, "doc.pdf", { forced: false });
    expect(f.reads).toEqual([
      [0, FIRST_READ],
      [0, pdf.length],
    ]);
    expect(out.state === "ready" && sameBytes(pdf, out.parts)).toBe(true);
    expect(await readMedia(fakeFile(filled(RANGELESS_MAX + 1), true).read, "big.mp4", { forced: true })).toEqual({ state: "tooLarge", size: RANGELESS_MAX + 1, verdict: "never", rangeless: true });
  });

  test("comparing a re-read with what is shown", () => {
    const a = filled(10);
    expect(sameBytes(a, [a.slice(0, 4), a.slice(4)])).toBe(true);
    expect(sameBytes(a, [a.slice(0, 9)])).toBe(false);
    expect(sameBytes(a, [a, bytes(1)])).toBe(false);
    const b = a.slice();
    b[7] = 99;
    expect(sameBytes(a, [b])).toBe(false);
  });

  test("small images are enlarged by a whole factor, large ones never", () => {
    expect(upscale(16, 16)).toBe(6);
    expect(upscale(32, 8)).toBe(3);
    expect(upscale(96, 10)).toBe(1);
    expect(upscale(1920, 1080)).toBe(1);
    expect(upscale(0, 0)).toBe(1);
  });
});
