/*
 * The frames of a recording's video: each screencast frame of the user's tab drawn into one
 * fixed-size picture (the video can't change size when the panel does: the page is fitted in,
 * letterboxed) under a strip with the page's address and title, with a ring where the user just
 * clicked and covers over sensitive fields (the focused one, and every one typed into on the page:
 * `EventLog.covers`). An agent's tab shows as a card saying it is not recorded.
 */

/** Video width at most (frames from a HiDPI panel are scaled down). */
export const MAX_VIDEO_WIDTH = 1280;
/** A click's ring shows this long. */
export const CLICK_RING_MS = 800;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Something on the page where the tab's viewport showed it (CSS px), at the page's scroll offset then. */
export interface Mask {
  rect: Rect;
  scroll?: Point;
}

/** A frame as drawn: its pixel size, the viewport it shows (CSS px) and the page's scroll offset in it. */
export interface Picture {
  width: number;
  height: number;
  viewport: { width: number; height: number } | null;
  scroll?: Point;
}

export interface Overlay {
  url?: string;
  title?: string;
  /** Recent clicks, viewport CSS px, with their age (ms). */
  clicks: { x: number; y: number; age: number }[];
  /** Fields to cover. */
  masks: Mask[];
  /** An element to outline (the clicked one, in screenshots). */
  outline?: Mask;
}

/**
 * Where to cover a mask in a picture of the page scrolled to `scroll`: where it was measured and,
 * when the page scrolled in between, where that scroll moved it too (a field in the page's flow
 * moves with it, one in a fixed box stays).
 */
function coverAt(m: Mask, scroll: Point | undefined): Rect {
  const r = m.rect;
  if (!m.scroll || !scroll) return r;
  const dx = m.scroll.x - scroll.x;
  const dy = m.scroll.y - scroll.y;
  return { x: r.x + Math.min(0, dx), y: r.y + Math.min(0, dy), width: r.width + Math.abs(dx), height: r.height + Math.abs(dy) };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The video's size for a first frame of `w`×`h` pixels: at most `MAX_VIDEO_WIDTH` wide, even sides, plus the address strip. */
export function videoSize(w: number, h: number): { width: number; height: number; strip: number } {
  const scale = Math.min(1, MAX_VIDEO_WIDTH / Math.max(1, w));
  const width = even(w * scale);
  const strip = even(Math.max(24, width / 40));
  return { width, height: even(h * scale) + strip, strip };
}

export class Compositor {
  readonly width: number;
  readonly height: number;
  readonly strip: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(frameWidth: number, frameHeight: number) {
    const size = videoSize(frameWidth, frameHeight);
    this.width = size.width;
    this.height = size.height;
    this.strip = size.strip;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    this.ctx = ctx;
  }

  /** A page frame fitted under the strip, then the overlay. */
  draw(img: CanvasImageSource, f: Picture, o: Overlay): void {
    const { ctx, width, height, strip } = this;
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, 0, width, height);
    const areaH = height - strip;
    const scale = Math.min(width / f.width, areaH / f.height);
    const w = f.width * scale;
    const h = f.height * scale;
    const dx = (width - w) / 2;
    const dy = strip + (areaH - h) / 2;
    ctx.drawImage(img, dx, dy, w, h);
    const vw = f.viewport?.width || f.width;
    const vh = f.viewport?.height || f.height;
    const px = (r: Rect): Rect => ({ x: dx + (r.x / vw) * w, y: dy + (r.y / vh) * h, width: (r.width / vw) * w, height: (r.height / vh) * h });
    for (const m of o.masks) {
      // Inside the page's area only: a field partly scrolled out of view is cut at its edge.
      const r = px(coverAt(m, f.scroll));
      const x = Math.max(r.x, dx);
      const y = Math.max(r.y, dy);
      const cut = { x, y, width: Math.min(r.x + r.width, dx + w) - x, height: Math.min(r.y + r.height, dy + h) - y };
      if (cut.width > 0 && cut.height > 0) this.cover(cut);
    }
    if (o.outline) {
      const { rect, scroll } = o.outline;
      const r = px(scroll && f.scroll ? { ...rect, x: rect.x + scroll.x - f.scroll.x, y: rect.y + scroll.y - f.scroll.y } : rect);
      ctx.strokeStyle = "#ffcc33";
      ctx.lineWidth = Math.max(2, width / 640);
      ctx.strokeRect(r.x - 2, r.y - 2, r.width + 4, r.height + 4);
    }
    for (const c of o.clicks) {
      if (c.age > CLICK_RING_MS) continue;
      const p = px({ x: c.x, y: c.y, width: 0, height: 0 });
      this.ring(p.x, p.y, c.age / CLICK_RING_MS);
    }
    this.addressStrip(o.url, o.title);
  }

  /** The shown tab isn't recorded (an agent's): a card instead of the page. */
  drawPlaceholder(title: string, detail: string, o: Pick<Overlay, "url" | "title">): void {
    const { ctx, width, height, strip } = this;
    ctx.fillStyle = "#14161b";
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e6e8ee";
    ctx.font = `600 ${Math.round(width / 40)}px system-ui, sans-serif`;
    ctx.fillText(title, width / 2, strip + (height - strip) / 2 - width / 60);
    ctx.fillStyle = "#9aa1ae";
    ctx.font = `${Math.round(width / 64)}px system-ui, sans-serif`;
    ctx.fillText(detail, width / 2, strip + (height - strip) / 2 + width / 50);
    ctx.textAlign = "start";
    this.addressStrip(o.url, o.title);
  }

  /** The picture as JPEG, base64 without the `data:` prefix. */
  jpeg(quality: number): Promise<string> {
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("the frame could not be encoded"));
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
          reader.onerror = () => reject(reader.error ?? new Error("the frame could not be read"));
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        quality,
      );
    });
  }

  private addressStrip(url: string | undefined, title: string | undefined): void {
    const { ctx, width, strip } = this;
    ctx.fillStyle = "#1d2027";
    ctx.fillRect(0, 0, width, strip);
    ctx.fillStyle = "#2c3039";
    ctx.fillRect(0, strip - 1, width, 1);
    const size = Math.round(strip * 0.46);
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const pad = Math.round(strip * 0.4);
    let text = url || "about:blank";
    if (title) text += `  —  ${title}`;
    ctx.fillStyle = "#c7ccd6";
    const max = width - 2 * pad;
    if (ctx.measureText(text).width > max) {
      while (text.length > 4 && ctx.measureText(`${text}…`).width > max) text = text.slice(0, -1);
      text += "…";
    }
    ctx.fillText(text, pad, strip / 2 + 1);
  }

  private ring(x: number, y: number, progress: number): void {
    const { ctx, width } = this;
    const unit = Math.max(1, width / 1280);
    const alpha = 1 - progress * 0.7;
    ctx.beginPath();
    ctx.arc(x, y, (10 + 14 * progress) * unit, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 92, 92, ${alpha})`;
    ctx.lineWidth = 3 * unit;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4 * unit, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 92, 92, ${alpha})`;
    ctx.fill();
  }

  private cover(r: Rect): void {
    const { ctx } = this;
    ctx.fillStyle = "#2a2e37";
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.strokeStyle = "#3b404b";
    ctx.lineWidth = 2;
    for (let i = -r.height; i < r.width; i += 8) {
      ctx.beginPath();
      ctx.moveTo(r.x + i, r.y + r.height);
      ctx.lineTo(r.x + i + r.height, r.y);
      ctx.stroke();
    }
    if (r.height >= 14 && r.width >= 50) {
      ctx.fillStyle = "#c7ccd6";
      ctx.font = `${Math.min(13, Math.round(r.height * 0.6))}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText("hidden", r.x + 6, r.y + r.height / 2);
    }
    ctx.restore();
  }
}

/** A base64 JPEG as something a canvas draws. */
export async function decodeJpeg(data: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${data}`;
  await img.decode();
  return img;
}
