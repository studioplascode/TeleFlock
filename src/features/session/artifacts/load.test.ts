import { afterEach, describe, expect, test } from "bun:test";
import { agentKey, apiError, core } from "@/core";
import type { ArtifactContent, PresentKind } from "@/core/gen";
import { type DocRef, loadDoc, readFile, shownAsFile } from "./load";

/** How a host answers `session.artifact`: tf-hostd ≥ 0.9.4 reads ranges, 0.9.0–0.9.3 from the start only (8 MiB of bytes at most), older ones text only. */
type HostAge = "ranges" | "rangeless" | "textOnly";
type Read = { offset?: number; maxBytes?: number };

const MiB = 1 << 20;
const realHost = core.host;
afterEach(() => {
  core.host = realHost;
});

/** Serves `files` as a host of `age` does; answers the reads it got. */
function serve(files: Record<string, Uint8Array>, age: HostAge = "ranges"): Read[] {
  const reads: Read[] = [];
  core.host = (() => ({
    call: (method: string, params: unknown) => {
      const p = params as { name: string; maxBytes?: number; base64?: boolean; offset?: number };
      const bytes = files[p.name];
      if (method !== "session.artifact" || !bytes) return Promise.reject(apiError("not_found", `${p.name} does not exist`));
      reads.push({ offset: p.offset, maxBytes: p.maxBytes });
      const ranged = age === "ranges" && p.offset !== undefined;
      const asData = age !== "textOnly" && (ranged || p.base64 === true);
      const start = ranged ? Math.min(p.offset ?? 0, bytes.length) : 0;
      const part = bytes.subarray(start, start + Math.min(Math.max(p.maxBytes ?? MiB, 4 << 10), asData ? 8 * MiB : 4 * MiB));
      const answer: ArtifactContent = {
        kind: "local",
        name: p.name,
        url: `local://${p.name}`,
        path: `/s/local/${p.name}`,
        size: bytes.length,
        mtime: 1,
        truncated: start + part.length < bytes.length,
        binary: true,
        ...(asData && { data: base64(part) }),
        ...(ranged && { offset: start }),
      };
      return Promise.resolve(answer);
    },
  })) as unknown as typeof core.host;
  return reads;
}

/** `size` bytes that start with `head` (a format's signature, one byte per character), then a counting pattern. */
function file(size: number, head = ""): Uint8Array {
  const out = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
  out.set(Uint8Array.from(head, (c) => c.charCodeAt(0)));
  return out;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const ref = (name: string, as: PresentKind): DocRef => ({ agentKey: agentKey("forge", "docs"), kind: "local", name, as });

async function same(blob: Blob | undefined, bytes: Uint8Array): Promise<boolean> {
  const got = new Uint8Array(await (blob as Blob).arrayBuffer());
  return got.length === bytes.length && got.every((b, i) => b === bytes[i]);
}

describe("presented media", () => {
  test("a video larger than a read arrives in ranges, 1 MiB and then 2 MiB at a time, typed by its extension", async () => {
    const clip = file(5.5 * MiB);
    const reads = serve({ "presented/demo-v1.mp4": clip });
    const progress: Array<[number, number]> = [];
    const doc = await loadDoc(ref("presented/demo-v1.mp4", "video"), { onProgress: (received, size) => progress.push([received, size]) });
    expect(reads).toEqual([
      { offset: 0, maxBytes: MiB },
      { offset: MiB, maxBytes: 2 * MiB },
      { offset: 3 * MiB, maxBytes: 2 * MiB },
      { offset: 5 * MiB, maxBytes: 2 * MiB },
    ]);
    expect(progress).toEqual([MiB, 3 * MiB, 5 * MiB].map((received) => [received, clip.length]));
    expect([doc.media?.type, doc.media?.size, doc.unshown]).toEqual(["video/mp4", clip.length, undefined]);
    expect(await same(doc.media, clip)).toBe(true);
    // what Copy path and Mention use; the bytes live in `media` only
    expect(doc.content).toMatchObject({ name: "presented/demo-v1.mp4", path: "/s/local/presented/demo-v1.mp4", size: clip.length });
    expect(doc.content.data).toBeUndefined();
    expect(shownAsFile(doc)).toBe(false);
  });

  test("a host that reads from the start only gets one read of the whole file, up to 8 MiB; a larger one needs an update", async () => {
    const small = file(3 * MiB, "\x89PNG\r\n\x1a\n");
    const reads = serve({ "presented/shot-v1.png": small, "presented/poster-v1.png": file(9 * MiB) }, "rangeless");
    const shot = await loadDoc(ref("presented/shot-v1.png", "image"));
    expect(reads).toEqual([
      { offset: 0, maxBytes: MiB },
      { offset: 0, maxBytes: 3 * MiB },
    ]);
    expect(shot.media?.type).toBe("image/png");
    expect(await same(shot.media, small)).toBe(true);
    const poster = await loadDoc(ref("presented/poster-v1.png", "image"));
    expect([poster.unshown, poster.media, reads.length]).toEqual(["rangeless", undefined, 3]);
    expect(shownAsFile(poster)).toBe(false);
  });

  test("a host that reads documents as text only: the viewer asks for an update", async () => {
    serve({ "presented/q3-v1.pdf": file(100_000, "%PDF-1.7") }, "textOnly");
    const doc = await loadDoc(ref("presented/q3-v1.pdf", "pdf"));
    expect([doc.unshown, doc.media, doc.content.size]).toEqual(["textOnly", undefined, 100_000]);
  });

  test("a name that says nothing: the first bytes tell, else it is a file to save", async () => {
    serve({ "presented/scan-v1.bin": file(20_000, "%PDF-1.7"), "presented/noise-v1.bin": file(20_000), "presented/empty-v1.wav": new Uint8Array() });
    expect((await loadDoc(ref("presented/scan-v1.bin", "pdf"))).media?.type).toBe("application/pdf");
    const noise = await loadDoc(ref("presented/noise-v1.bin", "video"));
    expect([noise.unshown, shownAsFile(noise)]).toEqual(["notMedia", true]);
    const empty = await loadDoc(ref("presented/empty-v1.wav", "audio"));
    expect([empty.unshown, empty.content.size]).toEqual(["notMedia", 0]);
  });

  test("a read no view wants any more stops at its next range, and is no document", async () => {
    const reads = serve({ "presented/demo-v1.webm": file(7 * MiB) });
    let asked = 0;
    const load = loadDoc(ref("presented/demo-v1.webm", "video"), { alive: () => asked++ < 1 });
    await expect(load).rejects.toMatchObject({ code: "cancelled" });
    expect(reads.length).toBe(2);
  });
});

describe("files handed over", () => {
  test("shown from a peek (size, place, whether the host reads ranges); read whole in ranges only for Save or Open", async () => {
    const pack = file(3.5 * MiB, "PK\x03\x04");
    const reads = serve({ "presented/pack-v1.zip": pack });
    const doc = await loadDoc(ref("presented/pack-v1.zip", "file"));
    expect(reads).toEqual([{ offset: 0, maxBytes: 4 << 10 }]);
    expect([doc.rangeless, doc.content.size, doc.content.data, shownAsFile(doc)]).toEqual([false, pack.length, undefined, true]);
    const progress: number[] = [];
    const blob = await readFile(ref("presented/pack-v1.zip", "file"), (received) => progress.push(received));
    expect(reads.slice(1).map((r) => r.offset)).toEqual([0, MiB, 3 * MiB]);
    expect(progress).toEqual([MiB, 3 * MiB]);
    expect(blob.type).toBe("application/zip");
    expect(await same(blob, pack)).toBe(true);
  });

  test("an older host: one read up to 8 MiB, a larger file refused with why; text only, nothing to save", async () => {
    serve({ "presented/a-v1.zip": file(2 * MiB), "presented/b-v1.zip": file(9 * MiB) }, "rangeless");
    expect((await loadDoc(ref("presented/b-v1.zip", "file"))).rangeless).toBe(true);
    expect((await readFile(ref("presented/a-v1.zip", "file"))).size).toBe(2 * MiB);
    await expect(readFile(ref("presented/b-v1.zip", "file"))).rejects.toMatchObject({ code: "unsupported", hint: "Update TeleFlock on the host" });
    serve({ "presented/a-v1.zip": file(2 * MiB) }, "textOnly");
    await expect(readFile(ref("presented/a-v1.zip", "file"))).rejects.toMatchObject({ code: "unsupported" });
  });

  test("a document that isn't text shows as a file to save", async () => {
    serve({ "notes/blob.dat": file(10_000) });
    const doc = await loadDoc({ agentKey: agentKey("forge", "docs"), kind: "local", name: "notes/blob.dat" });
    expect([doc.kind, doc.text, shownAsFile(doc)]).toEqual(["text", undefined, true]);
  });
});
