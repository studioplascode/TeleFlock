import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiError, type HostClient } from "@/core";
import type { FsReadParams, GitShowParams } from "@/core/gen";
import { type MediaEntry, MediaLoader, type MediaSource, mediaKey } from "./mediaLoad";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const png = (n: number, fill = 7) => {
  const b = new Uint8Array(n).fill(fill);
  b.set([0x89, 0x50, 0x4e, 0x47]);
  return b;
};

/** A host with working-tree files (by absolute path) and blobs (by `rev:path`); `oldHost`: tf-hostd before 0.9.1. */
function fakeHost(opts: { files?: Record<string, Uint8Array>; blobs?: Record<string, Uint8Array>; oldHost?: boolean } = {}) {
  const calls: string[] = [];
  const range = (b: Uint8Array, offset = 0, max = 512 * 1024) => {
    const start = Math.min(offset, b.length);
    const chunk = b.slice(start, start + max);
    return { size: b.length, base64: b64(chunk), offset: start, truncated: start + chunk.length < b.length };
  };
  const call = async (method: string, params: unknown) => {
    if (method === "fs.read") {
      const p = params as FsReadParams;
      calls.push(`fs.read ${p.path}@${p.offset}`);
      const b = opts.files?.[p.path];
      if (!b) throw apiError("not_found", `No such file: ${p.path}`);
      return { path: p.path, ...range(b, p.offset, p.maxBytes) };
    }
    if (method === "git.show") {
      const p = params as GitShowParams;
      calls.push(`git.show ${p.rev}:${p.path}@${p.offset}`);
      if (opts.oldHost) throw apiError("unknown_method", "unknown method `git.show`");
      const b = opts.blobs?.[`${p.rev}:${p.path}`];
      if (!b) throw apiError("not_found", `\`${p.path}\` is not in \`${p.rev}\``);
      return range(b, p.offset, p.maxBytes);
    }
    throw apiError("unknown_method", method);
  };
  return { host: { call } as HostClient, calls };
}

const NEW: MediaSource = { side: "new", root: "/r", path: "art/a.png", stamp: "epoch 1" };
const OLD: MediaSource = { side: "old", root: "/r", path: "art/a.png", rev: "base1", stamp: "base1" };

/** Asks for `src` and waits for every read to settle. */
async function load(loader: MediaLoader, src: MediaSource, forced = false): Promise<MediaEntry | undefined> {
  loader.want(src, forced);
  await loader.idle();
  return loader.get(mediaKey(src));
}

const url = (e: MediaEntry | undefined) => (e?.state === "ready" ? e.url : undefined);
const revoked: string[] = [];
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  revoked.length = 0;
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u);
    realRevoke(u);
  };
});
afterEach(() => {
  URL.revokeObjectURL = realRevoke;
});

describe("Review's media loader", () => {
  test("reads both versions, keeps them per stamp, and reads a new stamp again", async () => {
    const files = { "/r/art/a.png": png(2000) };
    const { host, calls } = fakeHost({ files, blobs: { "base1:art/a.png": png(1500, 3) } });
    const loader = new MediaLoader(host);
    loader.retain(mediaKey(NEW));
    loader.retain(mediaKey(OLD));
    const after = await load(loader, NEW);
    const before = await load(loader, OLD);
    expect([after?.state === "ready" && after.size, before?.state === "ready" && before.size]).toEqual([2000, 1500]);
    // Same stamps: nothing is read again.
    await load(loader, NEW);
    await load(loader, OLD);
    expect(calls).toEqual(["fs.read /r/art/a.png@0", "git.show base1:art/a.png@0"]);
    // The diff reloaded and the file is unchanged: read again, same entry and URL (a playing video goes on).
    expect(await load(loader, { ...NEW, stamp: "epoch 2" })).toBe(after);
    expect(calls).toHaveLength(3);
    // Changed: the new bytes get a new URL, the old one is revoked.
    files["/r/art/a.png"] = png(2100, 9);
    const changed = await load(loader, { ...NEW, stamp: "epoch 3" });
    expect(changed?.state === "ready" && changed.size).toBe(2100);
    expect(url(changed)).not.toBe(url(after));
    expect(revoked).toEqual([url(after)]);
  });

  test("a host before 0.9.1 reads no base version: old sides say so, new sides load", async () => {
    const { host, calls } = fakeHost({ files: { "/r/art/a.png": png(100) }, oldHost: true });
    const loader = new MediaLoader(host);
    loader.retain(mediaKey(NEW));
    loader.retain(mediaKey(OLD));
    expect(loader.readsOld()).toBe(true);
    expect(await load(loader, OLD)).toEqual({ state: "unsupported" });
    expect(loader.readsOld()).toBe(false);
    expect((await load(loader, NEW))?.state).toBe("ready");
    const other: MediaSource = { ...OLD, path: "b.png" };
    expect(await load(loader, other)).toEqual({ state: "unsupported" });
    expect(calls.filter((c) => c.startsWith("git.show"))).toHaveLength(1);
  });

  test("a failed read says why and is read again on Retry", async () => {
    const files: Record<string, Uint8Array> = {};
    const { host, calls } = fakeHost({ files });
    const loader = new MediaLoader(host);
    loader.retain(mediaKey(NEW));
    expect(await load(loader, NEW)).toEqual({ state: "error", message: "No such file: /r/art/a.png" });
    expect((await load(loader, NEW))?.state).toBe("error");
    expect(calls).toHaveLength(1);
    files["/r/art/a.png"] = png(10);
    expect((await load(loader, NEW, true))?.state).toBe("ready");
  });

  test("a preview scrolled away before its turn is not read; closing Review revokes every URL", async () => {
    const names = ["art/a.png", "c.png", "d.png", "b.png"];
    const { host, calls } = fakeHost({ files: Object.fromEntries(names.map((n) => [`/r/${n}`, png(10)])) });
    const loader = new MediaLoader(host);
    // Three reads run at once; the fourth waits its turn and is gone by then.
    const [shownSrc, ...rest] = names.map((path): MediaSource => ({ ...NEW, path }));
    const gone = rest[2] as MediaSource;
    const releases = names.map((n) => loader.retain(mediaKey({ ...NEW, path: n })));
    for (const src of [shownSrc as MediaSource, ...rest]) loader.want(src);
    releases[3]?.();
    await loader.idle();
    expect(calls).toEqual(["fs.read /r/art/a.png@0", "fs.read /r/c.png@0", "fs.read /r/d.png@0"]);
    expect(loader.get(mediaKey(gone))).toBeUndefined();
    const shown = loader.get(mediaKey(NEW));
    loader.close();
    expect(revoked).toHaveLength(3);
    expect(revoked).toContain(url(shown) as string);
    expect(await load(loader, NEW)).toBeUndefined();
    loader.reopen();
    expect((await load(loader, NEW))?.state).toBe("ready");
  });
});
