import type { AppEvent, RecordingBundle, RecordingDetail, RecordingFrame, RecordingInfo, RecordingList, RecordingShot, TranscriptSegment } from "@/core/gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

/*
 * The demo's session recordings (`recording.*`, docs/architecture.md §6.15): what the browser panel
 * records is kept in memory (frames, screenshots, the event log), Stop "saves" it with a short
 * processing phase and a canned transcript, and one recording is there from the start ("Checkout
 * total stays at 0") so the review sheet and the send flow can be tried without recording. Its
 * pictures are drawn on first use (a canvas: only in a page).
 */

export interface DemoRecordingEnv {
  clock: DemoClock;
  emit(e: AppEvent): void;
}

const BUDGET = 2 * 1024 ** 3;
/** The demo keeps recordings this long at most (memory). */
const MAX_MS = 3 * 60_000;

interface Rec {
  info: RecordingInfo;
  events: unknown[];
  frames: { t: number; data: string }[];
  shots: Map<string, string>;
  pausedAt: number | null;
  paused: number;
  /** Draws the canned recording's pictures on first use. */
  draw?: () => void;
}

/** Decoded bytes of base64 `s` (its padding counted out). */
const b64len = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);

/**
 * What the app gets of a recording: a copy, as the JSON of a real app core is. The demo changes
 * its own infos in place (state, transcript); one the UI already holds must not change under it
 * (a store selector sees the same object and the review sheet would stay on "saving").
 */
const snapshot = (info: RecordingInfo): RecordingInfo => structuredClone(info);

/** What a live demo recording "said": spread over its length. */
const SAID = ["Okay, look, here is what happens.", "When I do this, it doesn't do what it should.", "Can you find out why and fix it?"];

export class DemoRecordings {
  private readonly recs = new Map<string, Rec>();
  private active: string | null = null;
  private seq = 0;

  constructor(private readonly env: DemoRecordingEnv) {}

  call(method: string, p: Record<string, unknown>): unknown {
    const id = typeof p.id === "string" ? p.id : "";
    switch (method) {
      case "recording.start":
        return this.start(p.voice !== false);
      case "recording.append":
        return this.append(this.get(id), p);
      case "recording.pause":
        return this.pause(this.get(id));
      case "recording.resume":
        return this.resume(this.get(id));
      case "recording.stop":
        return this.stop(this.get(id));
      case "recording.list":
        return this.list();
      case "recording.get":
        return this.detail(this.get(id));
      case "recording.frame": {
        const r = this.get(id);
        r.draw?.();
        const f = r.frames[Number(p.index)];
        if (!f) throw apiError("not_found", `frame ${String(p.index)} of ${id}`);
        return { data: f.data, size: b64len(f.data) };
      }
      case "recording.read":
        return this.read(this.get(id), String(p.file ?? ""), Number(p.offset ?? 0), Number(p.length ?? 0));
      case "recording.update": {
        const r = this.get(id);
        if (typeof p.title === "string" && p.title.trim()) r.info.title = p.title.trim();
        if (p.doc !== undefined) r.info.doc = p.doc;
        this.changed();
        return snapshot(r.info);
      }
      case "recording.render":
        return this.render(this.get(id), p);
      case "recording.transcribe": {
        const r = this.get(id);
        this.transcribe(r);
        return snapshot(r.info);
      }
      case "recording.delete":
        if (this.active === id) this.active = null;
        this.recs.delete(id);
        this.changed();
        return this.list();
      default:
        throw apiError("unknown_method", `Unknown app method ${method}`);
    }
  }

  /** The recording that is there from the start. */
  seed(): void {
    const id = "rec_demo0shop";
    const createdAt = this.env.clock.now() - 2 * 3600_000;
    const segments: TranscriptSegment[] = [
      { startMs: 1200, endMs: 3600, text: "Okay, so here's the problem with the cart." },
      { startMs: 5000, endMs: 7800, text: "I click Add to cart, and the total stays at zero." },
      { startMs: 10_200, endMs: 13_400, text: "Even the coupon does nothing, and there's an error in the console." },
    ];
    const shop = "http://shop.demo/";
    const events: unknown[] = [
      { t: 0, tab: "t1", kind: "tab", change: "activated", url: shop, title: "Demo Shop" },
      { t: 300, tab: "t1", kind: "shot", name: "001-00m00s-start.jpg", reason: "start" },
      { t: 3000, tab: "t1", kind: "click", x: 812, y: 418, button: "left", count: 1, element: { tag: "button", role: "button", label: "Add to cart", selector: "button.add-to-cart" } },
      { t: 3000, tab: "t1", kind: "shot", name: "002-00m03s-click.jpg", reason: "click" },
      { t: 3300, tab: "t1", kind: "request", method: "POST", url: `${shop}api/cart`, status: 500, statusText: "Internal Server Error", resourceType: "Fetch", body: '{"error":"price service unavailable"}' },
      { t: 3400, tab: "t1", kind: "exception", text: "Uncaught TypeError: Cannot read properties of undefined (reading 'total')", source: `${shop}assets/cart.js:88:17`, stack: ["updateTotal @ http://shop.demo/assets/cart.js:88:17", "onAdd @ http://shop.demo/assets/cart.js:41:5"] },
      { t: 3800, tab: "t1", kind: "shot", name: "003-00m03s-error.jpg", reason: "error" },
      { t: 7500, tab: "t1", kind: "navigate", url: `${shop}cart`, title: "Your cart · Demo Shop" },
      { t: 8300, tab: "t1", kind: "shot", name: "004-00m08s-page.jpg", reason: "page" },
      { t: 9400, tab: "t1", kind: "click", x: 520, y: 360, button: "left", count: 1, element: { tag: "input", role: "textbox", type: "text", label: "Coupon code", selector: "input#coupon" } },
      { t: 9600, tab: "t1", kind: "type", text: "SAVE10", submitted: true, element: { tag: "input", role: "textbox", type: "text", label: "Coupon code", selector: "input#coupon" } },
      { t: 10_100, tab: "t1", kind: "console", level: "error", text: "Coupon check failed: total is NaN", source: `${shop}assets/cart.js:131:9`, repeat: 2 },
      { t: 12_000, tab: "t1", kind: "scroll", dx: 0, dy: 600, x: 640, y: 400 },
      { t: 14_600, tab: "t1", kind: "shot", name: "005-00m14s-end.jpg", reason: "end" },
    ];
    const rec: Rec = {
      info: {
        id,
        title: "Checkout total stays at 0 · Demo Shop",
        createdAt,
        state: "ready",
        durationMs: 15_000,
        frames: 6,
        shots: 5,
        events: events.length,
        bytes: 1_480_000,
        width: 1280,
        height: 832,
        voice: { state: "on", offsetMs: 90, durationMs: 14_900 },
        transcript: { state: "done", segments },
        video: "recording.mov",
        videoBytes: 1_180_000,
      },
      events,
      frames: [],
      shots: new Map(),
      pausedAt: null,
      paused: 0,
    };
    rec.draw = () => {
      rec.draw = undefined;
      if (typeof document === "undefined") return;
      const scenes: { t: number; scene: Scene }[] = [
        { t: 0, scene: { page: "home" } },
        { t: 3000, scene: { page: "home", ring: [812, 418] } },
        { t: 3500, scene: { page: "home", error: true } },
        { t: 7600, scene: { page: "cart" } },
        { t: 9700, scene: { page: "cart", coupon: "SAVE10" } },
        { t: 12_100, scene: { page: "cart", coupon: "SAVE10", scrolled: true } },
      ];
      rec.frames = scenes.map(({ t, scene }) => ({ t, data: drawShop(scene) }));
      const shotScene: Record<string, Scene> = {
        "001-00m00s-start.jpg": { page: "home" },
        "002-00m03s-click.jpg": { page: "home", ring: [812, 418] },
        "003-00m03s-error.jpg": { page: "home", error: true },
        "004-00m08s-page.jpg": { page: "cart" },
        "005-00m14s-end.jpg": { page: "cart", coupon: "SAVE10", scrolled: true },
      };
      for (const [name, scene] of Object.entries(shotScene)) rec.shots.set(name, drawShop(scene));
    };
    this.recs.set(id, rec);
  }

  private get(id: string): Rec {
    const r = this.recs.get(id);
    if (!r) throw apiError("not_found", `no recording ${id}`);
    return r;
  }

  private list(): RecordingList {
    const recordings = [...this.recs.values()].map((r) => snapshot(r.info)).sort((a, b) => b.createdAt - a.createdAt);
    return { recordings, bytes: recordings.reduce((n, r) => n + r.bytes, 0), budget: BUDGET };
  }

  private changed(): void {
    this.env.emit({ type: "recordings", recordings: this.list() });
  }

  private now(r: Rec): number {
    const end = r.pausedAt ?? this.env.clock.now();
    return Math.max(0, end - r.info.createdAt - r.paused);
  }

  private start(voice: boolean): RecordingInfo {
    if (this.active) throw apiError("busy", "A recording is running");
    const id = `rec_demo${(this.seq++).toString(36).padStart(6, "0")}`;
    const info: RecordingInfo = {
      id,
      title: "Recording",
      createdAt: this.env.clock.now(),
      state: "recording",
      durationMs: 0,
      frames: 0,
      shots: 0,
      events: 0,
      bytes: 0,
      voice: voice ? { state: "on", offsetMs: 80 } : { state: "off" },
      transcript: { state: voice ? "waiting" : "none", segments: [] },
    };
    this.recs.set(id, { info, events: [], frames: [], shots: new Map(), pausedAt: null, paused: 0 });
    this.active = id;
    this.changed();
    return snapshot(info);
  }

  private append(r: Rec, p: Record<string, unknown>): { bytes: number; durationMs: number; stop?: string } {
    if (r.info.state !== "recording" && r.info.state !== "paused") throw apiError("invalid_params", "the recording is not running");
    for (const f of (p.frames as RecordingFrame[] | undefined) ?? []) {
      r.frames.push({ t: Math.max(f.t, r.frames.at(-1)?.t ?? 0), data: f.data });
      r.info.width ??= f.width;
      r.info.height ??= f.height;
      r.info.bytes += b64len(f.data);
    }
    for (const s of (p.shots as RecordingShot[] | undefined) ?? []) {
      r.shots.set(s.name, s.data);
      r.info.bytes += b64len(s.data);
    }
    r.events.push(...(((p.events as unknown[] | undefined) ?? []) as unknown[]));
    r.info.frames = r.frames.length;
    r.info.shots = r.shots.size;
    r.info.events = r.events.length;
    r.info.durationMs = this.now(r);
    return { bytes: r.info.bytes, durationMs: r.info.durationMs, ...(r.info.durationMs > MAX_MS ? { stop: "The demo keeps recordings up to 3 minutes" } : {}) };
  }

  private pause(r: Rec): RecordingInfo {
    if (r.info.state === "recording") {
      r.pausedAt = this.env.clock.now();
      r.info.state = "paused";
      this.changed();
    }
    return snapshot(r.info);
  }

  private resume(r: Rec): RecordingInfo {
    if (r.info.state === "paused" && r.pausedAt !== null) {
      r.paused += this.env.clock.now() - r.pausedAt;
      r.pausedAt = null;
      r.info.state = "recording";
      this.changed();
    }
    return snapshot(r.info);
  }

  private stop(r: Rec): RecordingInfo {
    if (r.info.state !== "recording" && r.info.state !== "paused") return snapshot(r.info);
    r.info.durationMs = this.now(r);
    r.info.state = "processing";
    if (this.active === r.info.id) this.active = null;
    this.changed();
    this.env.clock.after(700, () => {
      if (!this.recs.has(r.info.id)) return;
      r.info.state = "ready";
      r.info.video = r.frames.length ? "recording.mov" : undefined;
      r.info.videoBytes = r.frames.length ? Math.round(r.frames.reduce((n, f) => n + b64len(f.data), 0) * 0.6) : undefined;
      if (r.info.voice.state === "on") r.info.voice = { ...r.info.voice, durationMs: Math.max(0, r.info.durationMs - (r.info.voice.offsetMs ?? 0)) };
      this.changed();
      this.transcribe(r);
    });
    return snapshot(r.info);
  }

  private transcribe(r: Rec): void {
    if (r.info.voice.state !== "on") return;
    r.info.transcript = { state: "running", progress: 0.2, segments: [] };
    this.changed();
    this.env.clock.after(600, () => {
      if (!this.recs.has(r.info.id)) return;
      r.info.transcript = { state: "running", progress: 0.7, segments: [] };
      this.changed();
    });
    this.env.clock.after(1300, () => {
      if (!this.recs.has(r.info.id)) return;
      const d = Math.max(1000, r.info.durationMs);
      const n = d < 4000 ? 1 : SAID.length;
      const segments = SAID.slice(0, n).map((text, i) => {
        const start = Math.round((d * (i + 0.15)) / n);
        return { startMs: start, endMs: Math.min(d, start + Math.round(d / n / 1.6)), text };
      });
      r.info.transcript = { state: "done", segments };
      this.changed();
    });
  }

  private detail(r: Rec): RecordingDetail {
    r.draw?.();
    return {
      info: snapshot(r.info),
      events: r.events,
      frames: r.frames.map((f) => ({ t: f.t, size: b64len(f.data) })),
      shots: [...r.shots].map(([name, data]) => ({ name, size: b64len(data) })),
    };
  }

  private read(r: Rec, file: string, offset: number, length: number): { data: string; size: number } {
    r.draw?.();
    if (file.startsWith("shots/")) {
      const data = r.shots.get(file.slice(6));
      if (data === undefined) throw apiError("not_found", file);
      const bin = atob(data);
      return { data: btoa(bin.slice(offset, offset + length)), size: bin.length };
    }
    if (file === "recording.mov" || file === "bundle/recording.mov") {
      const size = file === "recording.mov" ? (r.info.videoBytes ?? 0) : Math.round((r.info.videoBytes ?? 0) * 0.8);
      const n = Math.max(0, Math.min(length, size - offset));
      return { data: btoa("\0".repeat(n)), size };
    }
    // No microphone in the demo: no voice file to play.
    throw apiError("not_found", `${file} isn't kept by the demo`);
  }

  private render(r: Rec, p: Record<string, unknown>): RecordingBundle {
    if (r.info.state !== "ready") throw apiError("invalid_params", "the recording is still being saved");
    const cuts = (p.cuts as { startMs: number; endMs: number }[] | undefined) ?? [];
    const files = ((p.files as { name: string; text: string }[] | undefined) ?? []).map((f) => ({ file: `bundle/${f.name}`, size: new TextEncoder().encode(f.text).length, path: `/demo/recordings/${r.info.id}/bundle/${f.name}` }));
    const cut = cuts.reduce((n, c) => n + Math.max(0, c.endMs - c.startMs), 0);
    const video = r.info.video ? (cuts.length ? { file: "bundle/recording.mov", size: Math.round((r.info.videoBytes ?? 0) * 0.8), path: `/demo/recordings/${r.info.id}/bundle/recording.mov` } : { file: "recording.mov", size: r.info.videoBytes ?? 0, path: `/demo/recordings/${r.info.id}/recording.mov` }) : undefined;
    return { ...(video ? { video } : {}), files, durationMs: Math.max(0, r.info.durationMs - cut) };
  }
}

interface Scene {
  page: "home" | "cart";
  ring?: [number, number];
  error?: boolean;
  coupon?: string;
  scrolled?: boolean;
}

/** One picture of the demo shop, as the recorder's frames look (address strip on top), JPEG base64. */
function drawShop(s: Scene): string {
  const w = 1280;
  const h = 832;
  const strip = 32;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#f6f4ef";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1d2027";
  g.fillRect(0, 0, w, strip);
  g.fillStyle = "#c7ccd6";
  g.font = "15px system-ui, sans-serif";
  g.textBaseline = "middle";
  g.fillText(s.page === "home" ? "http://shop.demo/  —  Demo Shop" : "http://shop.demo/cart  —  Your cart · Demo Shop", 13, strip / 2 + 1);
  const y0 = strip - (s.scrolled ? 160 : 0);
  g.fillStyle = "#2d3a2f";
  g.fillRect(0, y0, w, 64);
  g.fillStyle = "#f6f4ef";
  g.font = "bold 24px system-ui, sans-serif";
  g.fillText("Demo Shop", 32, y0 + 32);
  g.font = "16px system-ui, sans-serif";
  g.fillText(`Cart (${s.page === "cart" ? 1 : 0})  ·  Total $0.00`, w - 280, y0 + 32);
  g.fillStyle = "#222";
  if (s.page === "home") {
    g.fillStyle = "#e3ddd0";
    g.fillRect(96, y0 + 120, 520, 420);
    g.fillStyle = "#222";
    g.font = "bold 30px system-ui, sans-serif";
    g.fillText("Trail running shoes", 680, y0 + 170);
    g.font = "22px system-ui, sans-serif";
    g.fillText("$89.00", 680, y0 + 220);
    g.fillStyle = "#2d6a4f";
    g.fillRect(680, y0 + 360, 264, 56);
    g.fillStyle = "#fff";
    g.font = "bold 20px system-ui, sans-serif";
    g.fillText("Add to cart", 752, y0 + 388);
  } else {
    g.font = "bold 30px system-ui, sans-serif";
    g.fillText("Your cart", 96, y0 + 140);
    g.font = "20px system-ui, sans-serif";
    g.fillText("Trail running shoes  ×1", 96, y0 + 210);
    g.fillText("$89.00", 760, y0 + 210);
    g.fillText("Total", 96, y0 + 270);
    g.fillText("$0.00", 760, y0 + 270);
    g.strokeStyle = "#999";
    g.lineWidth = 2;
    g.strokeRect(96, y0 + 330, 520, 52);
    g.fillStyle = s.coupon ? "#222" : "#999";
    g.fillText(s.coupon ?? "Coupon code", 112, y0 + 357);
  }
  if (s.error) {
    g.fillStyle = "#b42318";
    g.fillRect(w - 460, h - 120, 420, 72);
    g.fillStyle = "#fff";
    g.font = "17px system-ui, sans-serif";
    g.fillText("Something went wrong. Try again.", w - 436, h - 84);
  }
  if (s.ring) {
    g.beginPath();
    g.arc(s.ring[0], s.ring[1] + strip, 16, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,92,92,0.95)";
    g.lineWidth = 3;
    g.stroke();
  }
  return c.toDataURL("image/jpeg", 0.75).replace(/^data:[^,]*,/, "");
}
