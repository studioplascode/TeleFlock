import { describe, expect, test } from "bun:test";
import { apiError } from "@/core/errors";
import { MAX_UPLOAD_BYTES, type UploadOptions, type UploadedFile } from "@/core/upload";
import { TermUploads } from "./termUploads";

interface Call {
  name?: string;
  opts: UploadOptions;
  finish(): void;
  fail(e: unknown): void;
}

/** Uploads the test finishes by hand; an abort rejects one with `cancelled`, as `uploadFile` does. */
function fakeUploads() {
  const calls: Call[] = [];
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const upload = (_hostId: string, file: Blob & { name?: string }, opts: UploadOptions) =>
    new Promise<UploadedFile>((resolve, reject) => {
      calls.push({ name: file.name, opts, finish: () => resolve({ path: `/h/up/${file.name}`, size: file.size, sha256: "", uploadId: "u" }), fail: reject });
      opts.signal?.addEventListener("abort", () => reject(apiError("cancelled", "Upload cancelled")));
    });
  /** The `i`th upload once the batch has started it (the previous one's continuation ran). */
  const call = async (i: number): Promise<Call> => {
    for (let c = calls[i]; ; c = calls[i]) {
      if (c) return c;
      await Promise.resolve();
    }
  };
  return { calls, call, uploads: new TermUploads(upload) };
}

const file = (name: string, size = 100) => new File([new Uint8Array(size)], name, { type: name.endsWith(".mp4") ? "video/mp4" : "image/png" });

describe("TermUploads", () => {
  test("uploads a batch one file at a time, sums its progress, answers the paths in order", async () => {
    const { calls, call, uploads } = fakeUploads();
    const run = uploads.run("lab", [file("a.png", 100), file("b.mp4", 300)]);
    expect(calls.map((c) => c.name)).toEqual(["a.png"]);
    expect(uploads.progress()).toEqual({ label: "2 files", sent: 0, total: 400 });
    const a = await call(0);
    a.opts.onProgress?.(50, 100);
    expect(uploads.progress()?.sent).toBe(50);
    a.finish();
    const b = await call(1);
    b.opts.onProgress?.(150, 300);
    expect(uploads.progress()?.sent).toBe(250);
    b.finish();
    expect(await run).toEqual({ paths: ["/h/up/a.png", "/h/up/b.mp4"], cancelled: false, skipped: [] });
    expect(uploads.progress()).toBeNull();
  });

  test("leaves out empty files and files over the host's limit", async () => {
    const { calls, call, uploads } = fakeUploads();
    const huge = { name: "huge.mov", size: MAX_UPLOAD_BYTES + 1, type: "video/quicktime" } as unknown as File;
    const run = uploads.run("lab", [file("empty.png", 0), huge, file("ok.png")]);
    expect(uploads.progress()?.label).toBe("ok.png");
    (await call(0)).finish();
    const res = await run;
    expect(res.paths).toEqual(["/h/up/ok.png"]);
    expect(res.skipped.map((s) => s.name)).toEqual(["empty.png", "huge.mov"]);
    expect(calls).toHaveLength(1);
  });

  test("a failure ends the batch and keeps the paths that arrived", async () => {
    const { calls, call, uploads } = fakeUploads();
    const run = uploads.run("lab", [file("a.png"), file("b.png"), file("c.png")]);
    (await call(0)).finish();
    (await call(1)).fail(apiError("unsupported", "upload.* is unknown", { hint: "Update the host" }));
    const res = await run;
    expect(res.paths).toEqual(["/h/up/a.png"]);
    expect(res.cancelled).toBe(false);
    expect(res.failed?.name).toBe("b.png");
    expect(res.failed?.error).toMatchObject({ code: "unsupported", hint: "Update the host" });
    expect(calls).toHaveLength(2);
  });

  test("cancel stops every batch and pastes nothing, even files that arrived", async () => {
    const { call, uploads } = fakeUploads();
    const one = uploads.run("lab", [file("a.png")]);
    const two = uploads.run("lab", [file("b.png"), file("c.png")]);
    expect(uploads.progress()?.label).toBe("3 files");
    (await call(0)).finish();
    expect(await one).toMatchObject({ paths: ["/h/up/a.png"], cancelled: false });
    expect(uploads.progress()?.label).toBe("2 files");
    (await call(1)).finish();
    await call(2);
    uploads.cancel();
    expect(await two).toEqual({ paths: [], cancelled: true, skipped: [] });
    expect(uploads.progress()).toBeNull();
  });

  test("a cancel that lands while the last file finishes still pastes nothing", async () => {
    const { call, uploads } = fakeUploads();
    const run = uploads.run("lab", [file("a.png")]);
    (await call(0)).finish();
    uploads.cancel();
    expect(await run).toMatchObject({ paths: [], cancelled: true });
  });

  test("notifies subscribers on every change", async () => {
    const { call, uploads } = fakeUploads();
    let n = 0;
    const off = uploads.subscribe(() => n++);
    const run = uploads.run("lab", [file("a.png")]);
    const a = await call(0);
    a.opts.onProgress?.(10, 100);
    a.finish();
    await run;
    off();
    expect(n).toBe(3); // start, progress, done
  });
});
