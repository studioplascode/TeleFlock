import { afterAll, describe, expect, test } from "bun:test";
import { flushAll } from "./draftFlush";
import {
  attachUploads,
  attachUploadSource,
  detachDraftUploads,
  type DraftUploadSource,
  getDraftUploads,
  hydrateDraftUploads,
  MAX_DRAFT_UPLOADS,
  registerUploadSource,
  releaseUploads,
  removeDraftUpload,
  retryUploads,
  setDraftUploadBackend,
  setUploadTransport,
  startUploads,
  type StoredUploads,
  type UploadTransport,
  uploadRefLine,
  whenUploaded,
  withUploadRefs,
} from "./draftUploads";
import { apiError } from "./errors";
import type { UploadedFile, UploadOptions } from "./upload";

const mp4 = (name = "clip.mp4", size = 16) => new File([new Uint8Array(size)], name, { type: "video/mp4" });
const pdf = (name = "spec.pdf", size = 16) => new File([new Uint8Array(size)], name, { type: "application/pdf" });

/** Uploads that finish (or fail) when the test says so; records what went where. */
function controlledTransport() {
  const started: { hostId: string; name: string; opts: UploadOptions; finish(): void; fail(code: string): void }[] = [];
  const cancelled: [string, string][] = [];
  const t: UploadTransport = {
    upload: (hostId: string, file: File, opts: UploadOptions) =>
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      new Promise<UploadedFile>((resolve, reject) => {
        started.push({
          hostId,
          name: file.name,
          opts,
          finish: () => resolve({ path: `/home/me/.teleflock/uploads/2026-10-27/${file.name}`, size: file.size, sha256: "", uploadId: `up_${file.name}` }),
          fail: (code) => reject(apiError(code, `${code} happened`)),
        });
      }),
    cancel: async (hostId, uploadId) => {
      cancelled.push([hostId, uploadId]);
    },
  };
  return { t, started, cancelled };
}

const ctl = controlledTransport();
const previous = setUploadTransport(ctl.t);
afterAll(() => {
  setUploadTransport(previous);
});
/** Lets queued uploads move on: they chain on promises, so a few microtask turns are enough. */
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("prompt lines", () => {
  const ref = { name: "screen recording.mov", size: 12.34 * 1024 ** 2, path: "/home/me/.teleflock/uploads/2026-10-27/screen-recording.mov" };
  const doc = { name: "Q3 report.pdf", size: 1.2 * 1024 ** 2, path: "/home/me/.teleflock/uploads/2026-10-27/Q3-report.pdf", kind: "file" as const };

  test("one line per upload after the text, with its host path", () => {
    expect(uploadRefLine(ref)).toBe('Attached video "screen recording.mov" (12.3 MB): /home/me/.teleflock/uploads/2026-10-27/screen-recording.mov (read it to see it)');
    expect(uploadRefLine(doc)).toBe('Attached file "Q3 report.pdf" (1.2 MB): /home/me/.teleflock/uploads/2026-10-27/Q3-report.pdf (read it to see its contents)');
    expect(withUploadRefs("Why does the button flicker?", [ref, { ...ref, name: "b.mp4", size: 2048, path: "/u/b.mp4" }, doc])).toBe(
      `Why does the button flicker?\n\n${uploadRefLine(ref)}\nAttached video "b.mp4" (2 KB): /u/b.mp4 (read it to see it)\n${uploadRefLine(doc)}`,
    );
    expect(withUploadRefs("  ", [doc])).toBe(uploadRefLine(doc));
    expect(withUploadRefs("no uploads", [])).toBe("no uploads");
  });
});

describe("draft uploads", () => {
  test("caps: no empty, duplicate or oversized files, at most eight", () => {
    const key = "caps";
    const huge = { name: "huge.mp4", type: "video/mp4", size: 3 * 1024 ** 3, lastModified: 1 } as File;
    const r = attachUploads(key, null, [mp4("a.mp4"), pdf("notes.pdf"), mp4("a.mp4"), new File([], "empty.pdf", { type: "application/pdf" }), huge]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe("huge.mp4 is 3 GB; uploads go up to 2 GB.");
    const more = attachUploads(key, null, ["b", "c", "d", "e", "f", "g", "h"].map((n) => pdf(`${n}.pdf`)));
    expect(more).toEqual({ added: MAX_DRAFT_UPLOADS - 2, skipped: `A prompt takes at most ${MAX_DRAFT_UPLOADS} files.` });
    // A video stays a video; any other file is a file (its chip and prompt line say so).
    expect(getDraftUploads(key).map((u) => [u.name, u.kind ?? "video"]).slice(0, 3)).toEqual([
      ["a.mp4", "video"],
      ["notes.pdf", "file"],
      ["b.pdf", "file"],
    ]);
    // Without a host (Dispatch Auto) nothing uploads yet.
    expect(new Set(getDraftUploads(key).map((u) => u.phase))).toEqual(new Set(["pending"]));
    expect(ctl.started).toHaveLength(0);
    releaseUploads(getDraftUploads(key).map((u) => u.id));
    expect(getDraftUploads(key)).toEqual([]);
  });

  test("one upload at a time per host; sending waits for all of them", async () => {
    const key = "send";
    attachUploads(key, "studio", [mp4("one.mp4"), pdf("two.pdf")]);
    const ids = getDraftUploads(key).map((u) => u.id);
    await tick();
    expect(ctl.started.map((s) => s.name)).toEqual(["one.mp4"]);
    expect(getDraftUploads(key).map((u) => u.phase)).toEqual(["uploading", "queued"]);
    let refs: { path: string }[] | null = null;
    void whenUploaded(ids).then((r) => {
      refs = r;
    });
    ctl.started[0]?.opts.onProgress?.(8, 16);
    expect(getDraftUploads(key)[0]?.sent).toBe(8);
    ctl.started[0]?.finish();
    await tick();
    expect(ctl.started.map((s) => s.name)).toEqual(["one.mp4", "two.pdf"]);
    expect(ctl.started[1]?.opts.mime).toBe("application/pdf");
    expect(refs).toBeNull();
    ctl.started[1]?.finish();
    await tick();
    expect(refs).toEqual([
      { name: "one.mp4", size: 16, path: "/home/me/.teleflock/uploads/2026-10-27/one.mp4" },
      { name: "two.pdf", size: 16, path: "/home/me/.teleflock/uploads/2026-10-27/two.pdf", kind: "file" },
    ]);
    // Sent: off the draft, nothing dropped on the host.
    detachDraftUploads(key, ids);
    releaseUploads(ids);
    expect(getDraftUploads(key)).toEqual([]);
    expect(ctl.cancelled).toEqual([]);
    ctl.started.length = 0;
  });

  test("a failed upload fails the send until it is retried; removing a chip drops it on the host", async () => {
    const key = "fail";
    attachUploads(key, "forge", [pdf("bad.pdf")]);
    const [id] = getDraftUploads(key).map((u) => u.id);
    await tick();
    ctl.started[0]?.fail("io_error");
    await tick();
    expect(getDraftUploads(key)[0]).toMatchObject({ phase: "failed", error: "io_error happened" });
    await expect(whenUploaded([id ?? ""])).rejects.toMatchObject({ code: "upload_failed", message: "bad.pdf didn't upload: io_error happened" });
    retryUploads([id ?? ""]);
    await tick();
    expect(ctl.started).toHaveLength(2);
    ctl.started[1]?.finish();
    await tick();
    // Uploaded but never sent: its chip's × deletes the file on the host.
    removeDraftUpload(key, id ?? "");
    expect(ctl.cancelled).toEqual([["forge", "up_bad.pdf"]]);
    // One still uploading is aborted instead (uploadFile then drops it on the host).
    attachUploads(key, "forge", [mp4("slow.mp4")]);
    await tick();
    const slow = ctl.started[2];
    removeDraftUpload(key, getDraftUploads(key)[0]?.id ?? "");
    expect(slow?.opts.signal?.aborted).toBe(true);
    expect(getDraftUploads(key)).toEqual([]);
    ctl.started.length = 0;
    ctl.cancelled.length = 0;
  });

  test("uploads waiting for a host start on the one a task goes to", async () => {
    const key = "auto";
    attachUploads(key, null, [pdf("auto.pdf")]);
    const ids = getDraftUploads(key).map((u) => u.id);
    startUploads(ids, "picked");
    await tick();
    expect(ctl.started.map((s) => [s.hostId, s.name])).toEqual([["picked", "auto.pdf"]]);
    ctl.started[0]?.finish();
    await expect(whenUploaded(ids)).resolves.toEqual([{ name: "auto.pdf", size: 16, path: "/home/me/.teleflock/uploads/2026-10-27/auto.pdf", kind: "file" }]);
    releaseUploads(ids);
    ctl.started.length = 0;
  });
});

describe("draft uploads across a restart", () => {
  /** Stored uploads per draft key; records every write. */
  function store(seed: Record<string, StoredUploads> = {}) {
    const records = new Map(Object.entries(seed));
    const prev = setDraftUploadBackend({
      read: async (key) => records.get(key),
      write: (key, value) => void (value ? records.set(key, value) : records.delete(key)),
    });
    return { records, restore: () => setDraftUploadBackend(prev) };
  }

  test("an uploaded file is stored with its host path and kind, so its chip comes back", async () => {
    const s = store();
    try {
      const key = "kept";
      attachUploads(key, "restart-host", [pdf("talk.pdf")]);
      await tick();
      ctl.started.find((u) => u.name === "talk.pdf")?.finish();
      await tick();
      await flushAll();
      expect(s.records.get(key)?.videos.map((u) => [u.name, u.kind, u.path])).toEqual([["talk.pdf", "file", "/home/me/.teleflock/uploads/2026-10-27/talk.pdf"]]);
      // Sent: off the draft, and off the stored draft.
      const ids = getDraftUploads(key).map((u) => u.id);
      detachDraftUploads(key, ids);
      releaseUploads(ids);
      await flushAll();
      expect(s.records.has(key)).toBe(false);
    } finally {
      s.restore();
      ctl.started.length = 0;
    }
  });

  test("after a restart an uploaded file is back as it was, one cut off mid-upload as failed", async () => {
    const path = "/home/me/.teleflock/uploads/2026-11-01/demo.mp4";
    const docPath = "/home/me/.teleflock/uploads/2026-11-01/spec.pdf";
    const s = store({
      restarted: {
        videos: [
          { id: "v-up", name: "demo.mp4", size: 16, mime: "video/mp4", hostId: "forge", path, uploadId: "up_demo" },
          { id: "f-up", name: "spec.pdf", size: 16, mime: "application/pdf", hostId: "forge", path: docPath, uploadId: "up_spec", kind: "file" },
          { id: "v-cut", name: "cut.mp4", size: 16, mime: "video/mp4", hostId: "forge" },
        ],
        at: Date.now(),
      },
    });
    try {
      await hydrateDraftUploads("restarted");
      expect(getDraftUploads("restarted").map((u) => [u.name, u.phase, u.path ?? null])).toEqual([
        ["demo.mp4", "done", path],
        ["spec.pdf", "done", docPath],
        ["cut.mp4", "failed", null],
      ]);
      expect(await whenUploaded(["v-up", "f-up"])).toEqual([
        { name: "demo.mp4", size: 16, path },
        { name: "spec.pdf", size: 16, path: docPath, kind: "file" },
      ]);
      // Its file is gone with the old page: a retry asks for it again instead of uploading.
      retryUploads(["v-cut"]);
      expect(getDraftUploads("restarted")[2]).toMatchObject({ phase: "failed", error: "The file can't be read any more; attach it again" });
      // Never sent: removing the uploaded one drops its file on the host.
      removeDraftUpload("restarted", "v-up");
      expect(ctl.cancelled).toEqual([["forge", "up_demo"]]);
    } finally {
      s.restore();
      for (const u of getDraftUploads("restarted")) removeDraftUpload("restarted", u.id);
      ctl.cancelled.length = 0;
    }
  });
});

describe("uploads from a source (browser recordings)", () => {
  /** A source whose upload the test finishes; records the hosts it was asked for. */
  function source(ref: string) {
    const calls: { hostId: string; opts: UploadOptions; finish(): void }[] = [];
    const src: DraftUploadSource = {
      upload: (hostId, opts) =>
        // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
        new Promise((resolve) => {
          calls.push({ hostId, opts, finish: () => resolve({ path: "/h/up/rec-timeline.md", size: 900, sha256: "", uploadId: "up_md", ref, extra: ["up_mov", "up_shot"] }) });
        }),
    };
    return { src, calls };
  }
  const entry = { name: "Cart breaks", size: 800, mime: "video/quicktime", kind: "recording" as const, source: "recording:rec_1" };

  test("waits for the send, uploads itself to the host the prompt goes to, and the prompt carries its own block", async () => {
    const { src, calls } = source('Attached recording "Cart breaks" (1:42, made in the TeleFlock Browser): …\n- Timeline: /h/up/rec-timeline.md');
    expect(attachUploadSource("src-draft", null, entry, src)).toEqual({ added: 1 });
    expect(attachUploadSource("src-draft", null, entry, src)).toEqual({ added: 0 });
    const [u] = getDraftUploads("src-draft");
    if (!u) throw new Error("not attached");
    await tick();
    expect(u.phase).toBe("pending");
    expect(calls).toHaveLength(0);
    startUploads([u.id], "rec-host");
    await tick();
    expect(calls.map((c) => c.hostId)).toEqual(["rec-host"]);
    calls[0]?.finish();
    const refs = await whenUploaded([u.id]);
    expect(getDraftUploads("src-draft")[0]).toMatchObject({ phase: "done", size: 900, kind: "recording" });
    expect(withUploadRefs("Fix the cart.", [{ name: "a.mp4", size: 1, path: "/a.mp4" }, ...refs])).toBe('Fix the cart.\n\nAttached video "a.mp4" (1 B): /a.mp4 (read it to see it)\n\nAttached recording "Cart breaks" (1:42, made in the TeleFlock Browser): …\n- Timeline: /h/up/rec-timeline.md');
    // Never sent: removing it drops every file it uploaded.
    removeDraftUpload("src-draft", u.id);
    expect(ctl.cancelled).toEqual([
      ["rec-host", "up_md"],
      ["rec-host", "up_mov"],
      ["rec-host", "up_shot"],
    ]);
    ctl.cancelled.length = 0;
  });

  test("after a restart a stored source comes back waiting for its host while its kind can read it again; otherwise failed", async () => {
    const records = new Map<string, StoredUploads>([["src-restart", { videos: [{ id: "v-rec", name: "Cart breaks", size: 800, mime: "video/quicktime", hostId: null, kind: "recording", source: "recording:rec_9" }, { id: "v-other", name: "x", size: 1, mime: "", hostId: null, source: "gone:1" }], at: Date.now() }]]);
    const prev = setDraftUploadBackend({ read: async (key) => records.get(key), write: (key, value) => void (value ? records.set(key, value) : records.delete(key)) });
    const asked: string[] = [];
    const off = registerUploadSource("recording", (id) => {
      asked.push(id);
      return source("block").src;
    });
    try {
      await hydrateDraftUploads("src-restart");
      expect(asked).toEqual(["rec_9"]);
      expect(getDraftUploads("src-restart").map((u) => [u.id, u.phase])).toEqual([
        ["v-rec", "pending"],
        ["v-other", "failed"],
      ]);
    } finally {
      off();
      setDraftUploadBackend(prev);
      for (const u of getDraftUploads("src-restart")) removeDraftUpload("src-restart", u.id);
      ctl.cancelled.length = 0;
    }
  });
});
