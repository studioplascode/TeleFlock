import { describe, expect, test } from "bun:test";
import type { HostClient } from "./client";
import { apiError } from "./errors";
import { formatBytes, MAX_CHUNK, MAX_UPLOAD_BYTES, MIN_CHUNK, nextChunkSize, type UploadEnv, uploadVia } from "./upload";

type Params = Record<string, unknown>;

/**
 * tf-hostd's `upload.*` in memory, checking offsets like `ops::upload`. `before` runs ahead of a
 * request (throw to fail it untouched), `after` once the host did it (throw: the answer got lost).
 */
function fakeHost(hooks: { maxChunk?: number; before?(method: string, p: Params, n: number): void; after?(method: string, p: Params, n: number): void } = {}) {
  const running = new Map<string, { size: number; bytes: number[]; path: string }>();
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const chunkSizes: number[] = [];
  let seq = 0;
  const handle = (method: string, p: Params): unknown => {
    const id = String(p.uploadId ?? "");
    const u = running.get(id);
    switch (method) {
      case "upload.begin": {
        const uploadId = `up_${seq++}`;
        const path = `/home/me/.teleflock/uploads/2026-10-27/${String(p.name) || "upload"}`;
        running.set(uploadId, { size: Number(p.size), bytes: [], path });
        return { uploadId, path, maxChunk: hooks.maxChunk ?? MAX_CHUNK };
      }
      case "upload.chunk": {
        if (!u) throw apiError("not_found", `upload ${id} is gone`);
        const bytes = Uint8Array.from(atob(String(p.data)), (c) => c.charCodeAt(0));
        if (p.offset !== u.bytes.length) throw apiError("upload_offset", `upload ${id} is at byte ${u.bytes.length}, not ${String(p.offset)}`);
        if (bytes.length > (hooks.maxChunk ?? MAX_CHUNK) || u.bytes.length + bytes.length > u.size) throw apiError("invalid_params", "bad chunk");
        chunkSizes.push(bytes.length);
        u.bytes.push(...bytes);
        return { uploadId: id, received: u.bytes.length, size: u.size };
      }
      case "upload.status":
        if (!u) throw apiError("not_found", `upload ${id} is gone`);
        return { uploadId: id, received: u.bytes.length, size: u.size };
      case "upload.finish": {
        if (!u) throw apiError("not_found", `upload ${id} is gone`);
        if (u.bytes.length !== u.size) throw apiError("invalid_params", "incomplete");
        running.delete(id);
        files.set(u.path, Uint8Array.from(u.bytes));
        return { path: u.path, size: u.size, sha256: "ab".repeat(32) };
      }
      case "upload.cancel":
        running.delete(id);
        return {};
      default:
        throw apiError("unknown_method", method);
    }
  };
  const host: HostClient = {
    call: (async (method: string, p: Params) => {
      calls.push(method);
      const n = calls.filter((c) => c === method).length;
      hooks.before?.(method, p, n);
      const result = handle(method, p);
      hooks.after?.(method, p, n);
      return result;
    }) as HostClient["call"],
  };
  return { host, calls, chunkSizes, running, files };
}

/** Time only moves when the uploader waits. */
function fakeEnv(): UploadEnv & { t: number } {
  const env = {
    t: 0,
    now: () => env.t,
    sleep: async (ms: number) => {
      env.t += ms;
    },
  };
  return env;
}

function video(size: number, name = "clip.mp4"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return new File([bytes], name, { type: "video/mp4" });
}

async function bytesOf(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

describe("uploadVia", () => {
  test("sends the file in order, in chunks the host takes, reporting progress", async () => {
    const host = fakeHost({ maxChunk: 200 * 1024 });
    const file = video(700 * 1024);
    const progress: number[] = [];
    const done = await uploadVia(host.host, file, { onProgress: (sent, total) => progress.push(sent / total) }, fakeEnv());
    expect(done).toEqual({ path: "/home/me/.teleflock/uploads/2026-10-27/clip.mp4", size: file.size, sha256: "ab".repeat(32), uploadId: "up_0" });
    expect(host.files.get(done.path)).toEqual(await bytesOf(file));
    expect(Math.max(...host.chunkSizes)).toBeLessThanOrEqual(200 * 1024);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(host.calls[0]).toBe("upload.begin");
    expect(host.calls.at(-1)).toBe("upload.finish");
  });

  test("a chunk whose answer was lost is not sent twice: the host is asked where it stands", async () => {
    const host = fakeHost({
      after: (method, _p, n) => {
        if (method === "upload.chunk" && n === 2) throw apiError("timeout", "upload.chunk: no response from tf-hostd within 30s", { retryable: true });
      },
    });
    const file = video(900 * 1024);
    const done = await uploadVia(host.host, file, {}, fakeEnv());
    expect(host.files.get(done.path)).toEqual(await bytesOf(file));
    expect(host.calls).toContain("upload.status");
  });

  test("a host that lost the upload (its daemon restarted) gets it again from the start", async () => {
    const host = fakeHost({
      before: (method, p, n) => {
        if (method === "upload.chunk" && n === 2) {
          host.running.delete(String(p.uploadId));
          throw apiError("not_found", "upload is gone");
        }
      },
    });
    const file = video(600 * 1024);
    const done = await uploadVia(host.host, file, {}, fakeEnv());
    expect(host.calls.filter((c) => c === "upload.begin")).toHaveLength(2);
    expect(done.uploadId).toBe("up_1");
    expect(host.files.get(done.path)).toEqual(await bytesOf(file));
  });

  test("abort drops the upload on the host", async () => {
    const host = fakeHost();
    const ctrl = new AbortController();
    const run = uploadVia(host.host, video(900 * 1024), { signal: ctrl.signal, onProgress: (sent) => sent > 0 && ctrl.abort() }, fakeEnv());
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    // The cancel is not awaited by the uploader.
    await Promise.resolve();
    expect(host.calls).toContain("upload.cancel");
    expect(host.running.size).toBe(0);
  });

  test("a host daemon without uploads, and hard failures, end the upload", async () => {
    const old = fakeHost({ before: () => {
      throw apiError("unknown_method", "unknown method `upload.begin`");
    } });
    await expect(uploadVia(old.host, video(10), {}, fakeEnv())).rejects.toMatchObject({ code: "unsupported" });
    const full = fakeHost({ before: (method) => {
      if (method === "upload.chunk") throw apiError("io_error", "No space left on device");
    } });
    await expect(uploadVia(full.host, video(10), {}, fakeEnv())).rejects.toMatchObject({ code: "io_error" });
    await Promise.resolve();
    expect(full.calls).toContain("upload.cancel");
  });

  test("a lost connection is retried for 10 minutes, then the upload gives up", async () => {
    let calls = 0;
    const host = fakeHost({ before: (method) => {
      if (method === "upload.chunk" || method === "upload.status") {
        calls++;
        throw apiError("not_connected", "studio-pc is offline", { retryable: true });
      }
    } });
    const env = fakeEnv();
    await expect(uploadVia(host.host, video(10), {}, env)).rejects.toMatchObject({ code: "not_connected" });
    expect(env.t).toBeGreaterThan(10 * 60_000);
    expect(calls).toBeGreaterThan(10);
  });

  test("empty and oversized files fail before any request", async () => {
    const host = fakeHost();
    await expect(uploadVia(host.host, new File([], "empty.mp4"), {}, fakeEnv())).rejects.toMatchObject({ code: "invalid_params" });
    const huge = { name: "huge.mp4", type: "video/mp4", size: MAX_UPLOAD_BYTES + 1 } as File;
    await expect(uploadVia(host.host, huge, {}, fakeEnv())).rejects.toMatchObject({ code: "invalid_params", message: "huge.mp4 is 2.0 GB; uploads go up to 2 GB" });
    expect(host.calls).toEqual([]);
  });
});

describe("nextChunkSize", () => {
  test("about 3 s of data, at most double, 64 KiB to the host's limit in 64 KiB steps", () => {
    // A fast link grows the chunk, but only twofold per step.
    expect(nextChunkSize(256 * 1024, 100)).toBe(512 * 1024);
    expect(nextChunkSize(MAX_CHUNK, 100)).toBe(MAX_CHUNK);
    expect(nextChunkSize(MAX_CHUNK, 100, 300 * 1024)).toBe(256 * 1024);
    // A slow phone link (~20 KB/s) gets small chunks, never below 64 KiB.
    expect(nextChunkSize(256 * 1024, 12_000)).toBe(MIN_CHUNK);
    expect(nextChunkSize(MIN_CHUNK, 60_000)).toBe(MIN_CHUNK);
    expect(nextChunkSize(1024 * 1024, 4_000) % MIN_CHUNK).toBe(0);
  });
});

test("formatBytes", () => {
  expect([512, 1536, 12.34 * 1024 ** 2, 640 * 1024, 2 * 1024 ** 3].map(formatBytes)).toEqual(["512 B", "1.5 KB", "12.3 MB", "640 KB", "2 GB"]);
});
