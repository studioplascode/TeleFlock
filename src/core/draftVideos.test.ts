import { afterAll, describe, expect, test } from "bun:test";
import { isVideoFile, mediaFiles, videoFiles } from "./clipboardImages";
import { flushAll } from "./draftFlush";
import {
  attachVideos,
  attachVideoSource,
  detachDraftVideos,
  getDraftVideos,
  hydrateDraftVideos,
  MAX_DRAFT_VIDEOS,
  registerVideoSource,
  releaseVideos,
  removeDraftVideo,
  retryVideos,
  setDraftVideoBackend,
  setVideoTransport,
  type StoredVideos,
  uploadDraftVideos,
  type VideoSource,
  type VideoTransport,
  videoRefLine,
  whenUploaded,
  withVideoRefs,
} from "./draftVideos";
import { apiError } from "./errors";
import type { UploadedFile, UploadOptions } from "./upload";

const mp4 = (name = "clip.mp4", size = 16) => new File([new Uint8Array(size)], name, { type: "video/mp4" });

/** Uploads that finish (or fail) when the test says so; records what went where. */
function controlledTransport() {
  const started: { hostId: string; name: string; opts: UploadOptions; finish(): void; fail(code: string): void }[] = [];
  const cancelled: [string, string][] = [];
  const t: VideoTransport = {
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
const previous = setVideoTransport(ctl.t);
afterAll(() => {
  setVideoTransport(previous);
});
/** Lets queued uploads move on: they chain on promises, so a few microtask turns are enough. */
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("video files", () => {
  test("by type, or by extension when the platform gives none", () => {
    expect(isVideoFile({ name: "clip.mov", type: "video/quicktime" })).toBe(true);
    expect(isVideoFile({ name: "VID_2026.MP4", type: "" })).toBe(true);
    expect(isVideoFile({ name: "clip.webm", type: "application/octet-stream" })).toBe(true);
    expect(isVideoFile({ name: "notes.txt", type: "" })).toBe(false);
    expect(isVideoFile({ name: "shot.png", type: "image/png" })).toBe(false);
    const png = new File([new Uint8Array(4)], "shot.png", { type: "image/png" });
    const clip = mp4();
    const item = (f: File) => ({ kind: "file", type: f.type, getAsFile: () => f });
    expect(videoFiles({ items: [item(png), item(clip)], files: [clip] })).toEqual([clip]);
    expect(mediaFiles({ items: [item(png), item(clip)], files: [png, clip] })).toEqual([png, clip]);
  });
});

describe("prompt lines", () => {
  const ref = { name: "screen recording.mov", size: 12.34 * 1024 ** 2, path: "/home/me/.teleflock/uploads/2026-10-27/screen-recording.mov" };

  test("one line per video after the text, with its host path", () => {
    expect(videoRefLine(ref)).toBe('Attached video "screen recording.mov" (12.3 MB): /home/me/.teleflock/uploads/2026-10-27/screen-recording.mov (read it to see it)');
    expect(withVideoRefs("Why does the button flicker?", [ref, { ...ref, name: "b.mp4", size: 2048, path: "/u/b.mp4" }])).toBe(
      `Why does the button flicker?\n\n${videoRefLine(ref)}\nAttached video "b.mp4" (2 KB): /u/b.mp4 (read it to see it)`,
    );
    expect(withVideoRefs("  ", [ref])).toBe(videoRefLine(ref));
    expect(withVideoRefs("no videos", [])).toBe("no videos");
  });
});

describe("draft videos", () => {
  test("caps: videos only, no empty or duplicate files, at most four", () => {
    const key = "caps";
    const huge = { name: "huge.mp4", type: "video/mp4", size: 3 * 1024 ** 3, lastModified: 1 } as File;
    const r = attachVideos(key, null, [mp4("a.mp4"), new File(["x"], "notes.txt", { type: "text/plain" }), mp4("a.mp4"), new File([], "empty.mp4", { type: "video/mp4" }), huge]);
    expect(r.added).toBe(1);
    expect(r.skipped).toContain("huge.mp4 is 3 GB");
    const more = attachVideos(key, null, ["b", "c", "d", "e"].map((n) => mp4(`${n}.mp4`)));
    expect(more).toEqual({ added: MAX_DRAFT_VIDEOS - 1, skipped: `A prompt takes at most ${MAX_DRAFT_VIDEOS} videos.` });
    // Without a host (Dispatch Auto) nothing uploads yet.
    expect(getDraftVideos(key).map((v) => v.phase)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(ctl.started).toHaveLength(0);
    releaseVideos(getDraftVideos(key).map((v) => v.id));
    expect(getDraftVideos(key)).toEqual([]);
  });

  test("one upload at a time per host; sending waits for all of them", async () => {
    const key = "send";
    attachVideos(key, "studio", [mp4("one.mp4"), mp4("two.mp4")]);
    const ids = getDraftVideos(key).map((v) => v.id);
    await tick();
    expect(ctl.started.map((s) => s.name)).toEqual(["one.mp4"]);
    expect(getDraftVideos(key).map((v) => v.phase)).toEqual(["uploading", "queued"]);
    let refs: { path: string }[] | null = null;
    void whenUploaded(ids).then((r) => {
      refs = r;
    });
    ctl.started[0]?.opts.onProgress?.(8, 16);
    expect(getDraftVideos(key)[0]?.sent).toBe(8);
    ctl.started[0]?.finish();
    await tick();
    expect(ctl.started.map((s) => s.name)).toEqual(["one.mp4", "two.mp4"]);
    expect(refs).toBeNull();
    ctl.started[1]?.finish();
    await tick();
    expect(refs).toEqual([
      { name: "one.mp4", size: 16, path: "/home/me/.teleflock/uploads/2026-10-27/one.mp4" },
      { name: "two.mp4", size: 16, path: "/home/me/.teleflock/uploads/2026-10-27/two.mp4" },
    ]);
    // Sent: off the draft, nothing dropped on the host.
    detachDraftVideos(key, ids);
    releaseVideos(ids);
    expect(getDraftVideos(key)).toEqual([]);
    expect(ctl.cancelled).toEqual([]);
    ctl.started.length = 0;
  });

  test("a failed upload fails the send until it is retried; removing a chip drops it on the host", async () => {
    const key = "fail";
    attachVideos(key, "forge", [mp4("bad.mp4")]);
    const [id] = getDraftVideos(key).map((v) => v.id);
    await tick();
    ctl.started[0]?.fail("io_error");
    await tick();
    expect(getDraftVideos(key)[0]).toMatchObject({ phase: "failed", error: "io_error happened" });
    await expect(whenUploaded([id ?? ""])).rejects.toMatchObject({ code: "upload_failed", message: "bad.mp4 didn't upload: io_error happened" });
    retryVideos([id ?? ""]);
    await tick();
    expect(ctl.started).toHaveLength(2);
    ctl.started[1]?.finish();
    await tick();
    // Uploaded but never sent: its chip's × deletes the file on the host.
    removeDraftVideo(key, id ?? "");
    expect(ctl.cancelled).toEqual([["forge", "up_bad.mp4"]]);
    // One still uploading is aborted instead (uploadFile then drops it on the host).
    attachVideos(key, "forge", [mp4("slow.mp4")]);
    await tick();
    const slow = ctl.started[2];
    removeDraftVideo(key, getDraftVideos(key)[0]?.id ?? "");
    expect(slow?.opts.signal?.aborted).toBe(true);
    expect(getDraftVideos(key)).toEqual([]);
    ctl.started.length = 0;
    ctl.cancelled.length = 0;
  });

  test("videos waiting for a host start on the one a task goes to", async () => {
    const key = "auto";
    attachVideos(key, null, [mp4("auto.mp4")]);
    const ids = getDraftVideos(key).map((v) => v.id);
    uploadDraftVideos(ids, "picked");
    await tick();
    expect(ctl.started.map((s) => [s.hostId, s.name])).toEqual([["picked", "auto.mp4"]]);
    ctl.started[0]?.finish();
    await expect(whenUploaded(ids)).resolves.toHaveLength(1);
    releaseVideos(ids);
    ctl.started.length = 0;
  });
});

describe("draft videos across a restart", () => {
  /** Stored videos per draft key; records every write. */
  function store(seed: Record<string, StoredVideos> = {}) {
    const records = new Map(Object.entries(seed));
    const prev = setDraftVideoBackend({
      read: async (key) => records.get(key),
      write: (key, value) => void (value ? records.set(key, value) : records.delete(key)),
    });
    return { records, restore: () => setDraftVideoBackend(prev) };
  }

  test("an uploaded video is stored with its host path, so its chip comes back", async () => {
    const s = store();
    try {
      const key = "kept";
      attachVideos(key, "restart-host", [mp4("talk.mp4")]);
      await tick();
      ctl.started.find((u) => u.name === "talk.mp4")?.finish();
      await tick();
      await flushAll();
      expect(s.records.get(key)?.videos.map((v) => [v.name, v.path])).toEqual([["talk.mp4", "/home/me/.teleflock/uploads/2026-10-27/talk.mp4"]]);
      // Sent: off the draft, and off the stored draft.
      const ids = getDraftVideos(key).map((v) => v.id);
      detachDraftVideos(key, ids);
      releaseVideos(ids);
      await flushAll();
      expect(s.records.has(key)).toBe(false);
    } finally {
      s.restore();
      ctl.started.length = 0;
    }
  });

  test("after a restart an uploaded video is back as it was, one cut off mid-upload as failed", async () => {
    const path = "/home/me/.teleflock/uploads/2026-11-01/demo.mp4";
    const s = store({
      restarted: {
        videos: [
          { id: "v-up", name: "demo.mp4", size: 16, mime: "video/mp4", hostId: "forge", path, uploadId: "up_demo" },
          { id: "v-cut", name: "cut.mp4", size: 16, mime: "video/mp4", hostId: "forge" },
        ],
        at: Date.now(),
      },
    });
    try {
      await hydrateDraftVideos("restarted");
      expect(getDraftVideos("restarted").map((v) => [v.name, v.phase, v.path ?? null])).toEqual([
        ["demo.mp4", "done", path],
        ["cut.mp4", "failed", null],
      ]);
      expect(await whenUploaded(["v-up"])).toEqual([{ name: "demo.mp4", size: 16, path }]);
      // Its file is gone with the old page: a retry asks for it again instead of uploading.
      retryVideos(["v-cut"]);
      expect(getDraftVideos("restarted")[1]).toMatchObject({ phase: "failed", error: "The file can't be read any more; attach it again" });
      // Never sent: removing the uploaded one drops its file on the host.
      removeDraftVideo("restarted", "v-up");
      expect(ctl.cancelled).toEqual([["forge", "up_demo"]]);
    } finally {
      s.restore();
      for (const v of getDraftVideos("restarted")) removeDraftVideo("restarted", v.id);
      ctl.cancelled.length = 0;
    }
  });
});

describe("videos from a source (browser recordings)", () => {
  /** A source whose upload the test finishes; records the hosts it was asked for. */
  function source(ref: string) {
    const calls: { hostId: string; opts: UploadOptions; finish(): void }[] = [];
    const src: VideoSource = {
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
    expect(attachVideoSource("src-draft", null, entry, src)).toEqual({ added: 1 });
    expect(attachVideoSource("src-draft", null, entry, src)).toEqual({ added: 0 });
    const [v] = getDraftVideos("src-draft");
    if (!v) throw new Error("not attached");
    await tick();
    expect(v.phase).toBe("pending");
    expect(calls).toHaveLength(0);
    uploadDraftVideos([v.id], "rec-host");
    await tick();
    expect(calls.map((c) => c.hostId)).toEqual(["rec-host"]);
    calls[0]?.finish();
    const refs = await whenUploaded([v.id]);
    expect(getDraftVideos("src-draft")[0]).toMatchObject({ phase: "done", size: 900, kind: "recording" });
    expect(withVideoRefs("Fix the cart.", [{ name: "a.mp4", size: 1, path: "/a.mp4" }, ...refs])).toBe('Fix the cart.\n\nAttached video "a.mp4" (1 B): /a.mp4 (read it to see it)\n\nAttached recording "Cart breaks" (1:42, made in the TeleFlock Browser): …\n- Timeline: /h/up/rec-timeline.md');
    // Never sent: removing it drops every file it uploaded.
    removeDraftVideo("src-draft", v.id);
    expect(ctl.cancelled).toEqual([
      ["rec-host", "up_md"],
      ["rec-host", "up_mov"],
      ["rec-host", "up_shot"],
    ]);
    ctl.cancelled.length = 0;
  });

  test("after a restart a stored source comes back waiting for its host while its kind can read it again; otherwise failed", async () => {
    const records = new Map<string, StoredVideos>([["src-restart", { videos: [{ id: "v-rec", name: "Cart breaks", size: 800, mime: "video/quicktime", hostId: null, kind: "recording", source: "recording:rec_9" }, { id: "v-other", name: "x", size: 1, mime: "", hostId: null, source: "gone:1" }], at: Date.now() }]]);
    const prev = setDraftVideoBackend({ read: async (key) => records.get(key), write: (key, value) => void (value ? records.set(key, value) : records.delete(key)) });
    const asked: string[] = [];
    const off = registerVideoSource("recording", (id) => {
      asked.push(id);
      return source("block").src;
    });
    try {
      await hydrateDraftVideos("src-restart");
      expect(asked).toEqual(["rec_9"]);
      expect(getDraftVideos("src-restart").map((v) => [v.id, v.phase])).toEqual([
        ["v-rec", "pending"],
        ["v-other", "failed"],
      ]);
    } finally {
      off();
      setDraftVideoBackend(prev);
      for (const v of getDraftVideos("src-restart")) removeDraftVideo("src-restart", v.id);
      ctl.cancelled.length = 0;
    }
  });
});
