import { describe, expect, test } from "bun:test";
import type { RecordingDetail, RecordingInfo, RecordingReadParams, RecordingReleaseParams, RecordingRenderParams } from "@/core/gen";
import type { UploadedFile, UploadOptions, UploadSource } from "@/core/upload";
import type { RecEvent } from "./model";
import { type RecordingIo, uploadRecording } from "./send";

const events: RecEvent[] = [
  { t: 0, tab: "t1", kind: "tab", change: "activated", url: "http://shop.test/", title: "Shop" },
  { t: 500, tab: "t1", kind: "shot", name: "001-00m00s-start.jpg", reason: "start" },
  { t: 4000, tab: "t1", kind: "click", x: 10, y: 20, button: "left", count: 1, element: { tag: "button", label: "Add", selector: "button.add" } },
  { t: 4000, tab: "t1", kind: "shot", name: "002-00m04s-click.jpg", reason: "click" },
  { t: 4200, tab: "t1", kind: "request", method: "POST", url: "http://shop.test/api/cart", status: 500 },
  { t: 4600, tab: "t1", kind: "shot", name: "003-00m04s-error.jpg", reason: "error" },
  { t: 8000, tab: "t1", kind: "type", text: "", hidden: true },
  { t: 8100, tab: "t1", kind: "shot", name: "004-00m08s-click.jpg", reason: "click" },
];

function info(over: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id: "rec_ab12cd34ef",
    title: "Shop · 14:03",
    createdAt: Date.UTC(2026, 10, 1, 13, 3),
    state: "ready",
    durationMs: 12_000,
    frames: 40,
    shots: 4,
    events: events.length,
    bytes: 2_000_000,
    width: 1280,
    height: 832,
    voice: { state: "on", offsetMs: 120, durationMs: 11_800 },
    transcript: { state: "done", segments: [{ startMs: 1000, endMs: 3500, text: "I add the shoes and it fails." }, { startMs: 7900, endMs: 9000, text: "Here is my password." }] },
    video: "recording.mov",
    videoBytes: 1_500_000,
    // The part with the password is cut; the transcript's second line goes with it.
    doc: { v: 1, cuts: [{ start: 7500, end: 9500 }], useCleaned: false },
    ...over,
  };
}

/** The app core and a host's uploads, faked: what was called, in order. `changed`: a file the core replaced meanwhile (its size differs). */
function fakeIo(rec: RecordingInfo, failAt?: number, changed?: string) {
  const calls: string[] = [];
  const renders: RecordingRenderParams[] = [];
  const released: string[] = [];
  const uploads: { name: string; size: number; type?: string; text?: string }[] = [];
  const cancelled: string[] = [];
  const detail: RecordingDetail = { info: rec, events, frames: [{ t: 0, size: 1000 }], shots: ["001-00m00s-start.jpg", "002-00m04s-click.jpg", "003-00m04s-error.jpg", "004-00m08s-click.jpg"].map((name) => ({ name, size: 10 })) };
  const sizes = new Map([["bundle/r1/recording.mov", 30], ...detail.shots.map((s) => [`shots/${s.name}`, s.size] as const)]);
  const io: RecordingIo = {
    app: (async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "recording.get") return detail;
      if (method === "recording.render") {
        renders.push(params as RecordingRenderParams);
        return { dir: "bundle/r1", video: { file: "bundle/r1/recording.mov", size: 30, path: "/data/recordings/rec_ab12cd34ef/bundle/r1/recording.mov" }, files: [], durationMs: 10_000 };
      }
      // The method name fixes its params' type (the fake takes them untyped).
      if (method === "recording.read") {
        const p = params as RecordingReadParams;
        return { data: btoa("x".repeat(p.length)), size: (sizes.get(p.file) ?? 0) + (p.file === changed ? 1 : 0) };
      }
      if (method === "recording.release") {
        const p = params as RecordingReleaseParams;
        released.push(p.dir);
        return {};
      }
      throw new Error(`unexpected ${method}`);
    }) as RecordingIo["app"],
    upload: async (_hostId: string, file: UploadSource | File, opts: UploadOptions): Promise<UploadedFile> => {
      if (failAt !== undefined && uploads.length === failAt) throw new Error("connection lost");
      const text = file instanceof File ? await file.text() : undefined;
      if (!(file instanceof File)) await file.readBase64(0, file.size);
      uploads.push({ name: file.name ?? "", size: file.size, ...(file.type ? { type: file.type } : {}), ...(text !== undefined ? { text } : {}) });
      opts.onProgress?.(file.size, file.size);
      return { path: `/h/up/${file.name}`, size: file.size, sha256: "", uploadId: `up_${uploads.length}` };
    },
    cancel: async (_hostId, uploadId) => {
      cancelled.push(uploadId);
    },
  };
  return { io, calls, renders, released, uploads, cancelled };
}

describe("sending a recording", () => {
  test("renders the cut video, uploads it and the chosen screenshots, then the timeline naming their host paths", async () => {
    const f = fakeIo(info());
    const progress: number[] = [];
    const out = await uploadRecording("rec_ab12cd34ef", "forge", { onProgress: (sent) => progress.push(sent) }, f.io);

    expect(f.renders).toHaveLength(1);
    expect(f.renders[0]?.cuts).toEqual([{ startMs: 7500, endMs: 9500 }]);
    // The render's own timeline names files relative to the recording's folder.
    expect(f.renders[0]?.files.map((x) => x.name)).toEqual(["timeline.md", "timeline.json"]);
    expect(f.renders[0]?.files[0]?.text).toContain("Video: recording.mov");
    expect(f.renders[0]?.files[0]?.text).toContain("screenshot: shots/002-00m04s-click.jpg");

    // The screenshot taken in the cut part is not sent.
    expect(f.uploads.map((u) => u.name)).toEqual(["shop-ab12.mov", "shop-ab12-001-00m00s-start.jpg", "shop-ab12-002-00m04s-click.jpg", "shop-ab12-003-00m04s-error.jpg", "shop-ab12-timeline.json", "shop-ab12-timeline.md"]);
    expect(f.uploads[0]?.type).toBe("video/quicktime");
    const md = f.uploads[5]?.text ?? "";
    expect(md).toContain("Video: /h/up/shop-ab12.mov (1280×832, 10 fps)");
    expect(md).toContain("- `00:04.0` screenshot: /h/up/shop-ab12-002-00m04s-click.jpg");
    expect(md).toContain('said: "I add the shoes and it fails."');
    expect(md).not.toContain("Here is my password");
    expect(md).toContain("The same as data: /h/up/shop-ab12-timeline.json.");

    expect(out.path).toBe("/h/up/shop-ab12-timeline.md");
    expect(out.extra).toEqual(["up_1", "up_2", "up_3", "up_4", "up_5"]);
    expect(out.ref).toContain('Attached recording "Shop · 14:03" (0:10, made in the TeleFlock Browser)');
    expect(out.ref).toContain("- Timeline: /h/up/shop-ab12-timeline.md (read it first; the same as data: /h/up/shop-ab12-timeline.json)");
    expect(out.ref).toContain("- Video: /h/up/shop-ab12.mov (30 B, 10 fps; read it to see it, or read /h/up/shop-ab12.mov:00:14.0 for the frame at a time in the timeline)");
    expect(out.ref).toContain("- Screenshots: 3 files, named in the timeline at the moment each was taken; all attached as images too");
    // Short: the timeline is in the prompt too.
    expect(out.ref).toContain("\nTimeline:\n00:00.0 switched to the tab http://shop.test/");
    expect(progress.at(-1)).toBe(out.size);
    // The render was this upload's: it goes once the upload ended.
    expect(f.released).toEqual(["bundle/r1"]);
  });

  test("a failed upload drops what went up before it", async () => {
    const f = fakeIo(info(), 2);
    await expect(uploadRecording("rec_ab12cd34ef", "forge", {}, f.io)).rejects.toThrow("connection lost");
    expect(f.cancelled).toEqual(["up_1", "up_2"]);
    expect(f.released).toEqual(["bundle/r1"]);
  });

  test("a file that changed while it was sent fails the upload rather than sending parts of two files", async () => {
    const f = fakeIo(info(), undefined, "bundle/r1/recording.mov");
    await expect(uploadRecording("rec_ab12cd34ef", "forge", {}, f.io)).rejects.toThrow("The recording changed while it was sent");
    expect(f.uploads).toEqual([]);
    expect(f.released).toEqual(["bundle/r1"]);
  });

  test("a recording still being saved is not sent", async () => {
    const f = fakeIo(info({ state: "processing" }));
    await expect(uploadRecording("rec_ab12cd34ef", "forge", {}, f.io)).rejects.toThrow("The recording is still being saved");
    expect(f.uploads).toEqual([]);
  });
});
