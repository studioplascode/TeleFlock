import type { CardStat, StatKey, WrappedCard } from "./model";

/*
 * The card as a 1080×1350 poster (4:5, what feeds and chats show whole), drawn on a canvas: the
 * page shows this same canvas, so the PNG is exactly what is on screen. Fonts, colors and the
 * mark are the app's own (src/design/styles/tokens.css, src/assets/logo/teleflock-mark.svg).
 */

export const POSTER_W = 1080;
export const POSTER_H = 1350;

const DISPLAY = '"Sora Variable", "Segoe UI", system-ui, sans-serif';
const BODY = '"Manrope Variable", "Segoe UI", system-ui, sans-serif';
const PAD = 72;
const GAP = 24;
const INK = "#f5f5f7";
const INK_2 = "#dcdce4";
const MUTE = "#9a9aad";
const MUTE_2 = "#6e6e82";
const OMP = ["#f053d0", "#a15eef", "#7fa2e7"] as const;
const ACCENT: Record<StatKey, string> = {
  agents: "#4f8bff",
  lines: "#a3e635",
  prs: "#22d3ee",
  overnight: "#a15eef",
  fastest: "#ff7a18",
  crew: "#f053d0",
};

/** The faces the poster uses: canvas text never waits for a web font, so load them first. */
export async function loadPosterFonts(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return;
  await Promise.allSettled([`800 100px ${DISPLAY}`, `700 100px ${DISPLAY}`, `500 20px ${BODY}`, `600 20px ${BODY}`, `700 20px ${BODY}`].map((f) => fonts.load(f)));
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgb(${rgb} / ${alpha})`);
  g.addColorStop(1, `rgb(${rgb} / 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);
}

/** The TeleFlock mark (64-unit viewBox) at `x, y`, `size` px. */
function mark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 64, size / 64);
  const g = ctx.createLinearGradient(6, 6, 58, 58);
  g.addColorStop(0, OMP[0]);
  g.addColorStop(0.5, OMP[1]);
  g.addColorStop(1, OMP[2]);
  ctx.strokeStyle = g;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const strokes: [string, number, number][] = [
    ["M7 28 C13 20.5 19.5 19.5 25 23 L32 27.5 L39 23 C44.5 19.5 51 20.5 57 28", 6.2, 1],
    ["M24.5 25.5 V48", 6.2, 1],
    ["M39.5 25.5 V49 C39.5 53.5 42 56 47 55.5", 6.2, 1],
    ["M33 13.2 C35.5 9.6 38 9.4 40.5 13.4 C43 9.4 45.5 9.6 48 13.2", 3.4, 0.9],
    ["M47.5 6.4 C49.2 4 50.8 3.9 52.4 6.6 C54 3.9 55.6 4 57.2 6.4", 2.6, 0.65],
  ];
  for (const [d, width, alpha] of strokes) {
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

/** `text` cut with an ellipsis to fit `max` px in the current font. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Sets the largest font from `max` down to `min` px in which `text` fits `width`; returns the text to draw. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, family: string, max: number, min: number, width: number): string {
  let size = max;
  ctx.font = `${weight} ${size}px ${family}`;
  while (size > min && ctx.measureText(text).width > width) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return ellipsize(ctx, text, width);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tile(ctx: CanvasRenderingContext2D, s: CardStat, x: number, y: number, w: number, h: number): void {
  const bg = ctx.createLinearGradient(0, y, 0, y + h);
  bg.addColorStop(0, "rgb(27 27 37 / 0.9)");
  bg.addColorStop(1, "rgb(21 21 29 / 0.9)");
  roundRect(ctx, x, y, w, h, 34);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgb(255 255 255 / 0.08)";
  ctx.stroke();

  const inner = w - 64;
  ctx.fillStyle = ACCENT[s.key];
  ctx.beginPath();
  ctx.arc(x + 38, y + 44, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `700 20px ${BODY}`;
  ctx.letterSpacing = "2px";
  ctx.fillStyle = MUTE;
  ctx.fillText(ellipsize(ctx, s.label.toUpperCase(), inner - 22), x + 54, y + 51);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = s.empty ? MUTE_2 : INK;
  ctx.fillText(fit(ctx, s.value, 700, DISPLAY, 62, 30, inner), x + 32, y + 122);

  ctx.font = `600 22px ${BODY}`;
  ctx.fillStyle = s.empty ? MUTE_2 : INK_2;
  ctx.fillText(ellipsize(ctx, s.detail, inner), x + 32, y + 160);
}

/** Draws the poster onto a `POSTER_W × POSTER_H` context. */
export function paintPoster(ctx: CanvasRenderingContext2D, card: WrappedCard): void {
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);
  glow(ctx, 1000, 40, 820, "240 83 208", 0.42);
  glow(ctx, 40, 560, 720, "161 94 239", 0.3);
  glow(ctx, 860, 1380, 780, "127 162 231", 0.24);

  // Header: mark, kicker and week; the period as a pill on the right.
  mark(ctx, PAD, PAD - 6, 64);
  ctx.font = `700 24px ${DISPLAY}`;
  ctx.letterSpacing = "5px";
  ctx.fillStyle = "#e9dcff";
  ctx.fillText("FLOCK WRAPPED", PAD + 86, PAD + 18);
  ctx.letterSpacing = "0px";
  ctx.font = `600 30px ${BODY}`;
  ctx.fillStyle = INK;
  ctx.fillText(card.range, PAD + 86, PAD + 58);
  ctx.font = `700 22px ${BODY}`;
  const pill = ctx.measureText(card.period).width + 44;
  roundRect(ctx, POSTER_W - PAD - pill, PAD - 2, pill, 50, 25);
  ctx.fillStyle = "rgb(255 255 255 / 0.08)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgb(255 255 255 / 0.16)";
  ctx.stroke();
  ctx.fillStyle = INK_2;
  ctx.fillText(card.period, POSTER_W - PAD - pill + 22, PAD + 31);

  // Hero: the week's unattended work, in the omp gradient.
  const width = POSTER_W - 2 * PAD;
  const value = fit(ctx, card.hero.value, 800, DISPLAY, 250, 120, width);
  const grad = ctx.createLinearGradient(PAD, 0, PAD + Math.min(width, ctx.measureText(value).width), 0);
  grad.addColorStop(0, OMP[0]);
  grad.addColorStop(0.5, OMP[1]);
  grad.addColorStop(1, OMP[2]);
  ctx.fillStyle = card.hero.empty ? MUTE_2 : grad;
  ctx.fillText(value, PAD - 6, 418);
  ctx.font = `700 52px ${DISPLAY}`;
  ctx.fillStyle = INK;
  ctx.fillText(ellipsize(ctx, card.hero.caption, width), PAD, 494);
  ctx.font = `500 26px ${BODY}`;
  ctx.fillStyle = MUTE;
  ctx.fillText(ellipsize(ctx, card.hero.detail, width), PAD, 540);

  // Six tiles, two columns.
  const top = 596;
  const colW = (width - GAP) / 2;
  const rowH = 186;
  card.stats.forEach((s, i) => tile(ctx, s, PAD + (i % 2) * (colW + GAP), top + Math.floor(i / 2) * (rowH + GAP), colW, rowH));

  // Footer: the wordmark and who counted.
  const base = POSTER_H - PAD + 4;
  ctx.fillStyle = "rgb(255 255 255 / 0.1)";
  ctx.fillRect(PAD, base - 64, width, 2);
  mark(ctx, PAD, base - 40, 46);
  ctx.font = `600 30px ${DISPLAY}`;
  ctx.fillStyle = INK;
  ctx.fillText("TeleFlock", PAD + 60, base);
  ctx.font = `600 24px ${BODY}`;
  ctx.fillStyle = MUTE;
  ctx.textAlign = "right";
  ctx.fillText(ellipsize(ctx, card.footer, width - 260), POSTER_W - PAD, base - 2);
  ctx.restore();
}

/** The poster as a PNG. */
export async function posterPng(card: WrappedCard): Promise<Blob> {
  await loadPosterFonts();
  const canvas = document.createElement("canvas");
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device cannot draw images");
  paintPoster(ctx, card);
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be made"))), "image/png"));
}
