/**
 * Turns SVG text (an `svg` fence, an `.svg` file, mermaid's output) into something an `<img>` can
 * show at the right size. Figures are always displayed through `<img src="data:image/svg+xml,…">`:
 * an SVG loaded as an image runs no script, loads no external resource and can't reach the page's
 * DOM or styles, so untrusted markup needs no sanitiser, only this size and namespace fix-up.
 */

export interface PreparedSvg {
  /** The markup with an explicit size, `xmlns` and `viewBox`. */
  svg: string;
  /** Natural size in CSS px. */
  width: number;
  height: number;
}

/** Larger sources stay code: a data URL that size makes the image slow to decode and the DOM heavy. */
export const MAX_SVG_CHARS = 1_500_000;
/** What an SVG with neither size nor viewBox is drawn at (browsers' own default for replaced elements). */
const DEFAULT_SIZE = { width: 300, height: 150 };
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
/** Where the root tag starts; it ends at the first `>` after it. */
const ROOT_START = /<svg(?=[\s>/])/i;

/** `name="…"` / `name='…'` in a start tag. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** A length in px: bare numbers and `px`; percentages and font-relative units have no size of their own. */
function pixels(value: string | undefined): number | undefined {
  // Trimmed first: spaces on both sides of an optional unit, matched by one pattern, take quadratic time.
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?$/i.exec((value ?? "").trim());
  const n = m ? Number.parseFloat(m[1]!) : Number.NaN;
  return n > 0 && Number.isFinite(n) ? n : undefined;
}

function viewBoxOf(tag: string): [number, number, number, number] | undefined {
  const parts = (attr(tag, "viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number.parseFloat);
  const [x, y, w, h] = parts;
  return parts.length === 4 && parts.every(Number.isFinite) && w! > 0 && h! > 0 ? [x!, y!, w!, h!] : undefined;
}

function dropAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "ig"), "");
}

const fmt = (n: number) => String(+n.toFixed(2));

/**
 * `raw` as a self-sufficient image document, or null when it has no `<svg>` root (or is over
 * {@link MAX_SVG_CHARS}). `background` paints a rect under the drawing (a transparent figure shown
 * on the lightbox's dark backdrop); `scale` enlarges the drawn size (a vector figure fills the
 * lightbox instead of sitting at 1:1). Linear in the text's length: it runs on every svg fence of a
 * chat, whatever an agent wrote there.
 */
export function prepareSvg(raw: string, background?: string, scale = 1): PreparedSvg | null {
  const text = raw.trim();
  if (text.length > MAX_SVG_CHARS) return null;
  const start = ROOT_START.exec(text);
  const end = start ? text.indexOf(">", start.index) : -1;
  if (!start || end < 0) return null;
  let tag = text.slice(start.index, end + 1);
  const box = viewBoxOf(tag);
  const w = pixels(attr(tag, "width"));
  const h = pixels(attr(tag, "height"));
  let width: number;
  let height: number;
  if (w && h) [width, height] = [w, h];
  else if (box) {
    // One side given: the other follows the viewBox's aspect ratio. Neither: the viewBox's own size.
    [width, height] = w ? [w, (w * box[3]) / box[2]] : h ? [(h * box[2]) / box[3], h] : [box[2], box[3]];
  } else [width, height] = [w ?? DEFAULT_SIZE.width, h ?? DEFAULT_SIZE.height];
  width = Math.max(1, Math.round(width * scale * 100) / 100);
  height = Math.max(1, Math.round(height * scale * 100) / 100);

  tag = dropAttr(dropAttr(tag, "width"), "height");
  const selfClosed = tag.endsWith("/>");
  tag = tag.slice(0, selfClosed ? -2 : -1).trimEnd();
  if (!box) tag = dropAttr(tag, "viewBox") + ` viewBox="0 0 ${fmt(width / scale)} ${fmt(height / scale)}"`;
  if (!attr(tag, "xmlns")) tag += ` xmlns="${SVG_NS}"`;
  if (/\sxlink:/i.test(text) && !/\sxmlns:xlink\s*=/i.test(tag)) tag += ` xmlns:xlink="${XLINK_NS}"`;
  tag += ` width="${fmt(width)}" height="${fmt(height)}"`;

  const [bx, by, bw, bh] = box ?? [0, 0, width / scale, height / scale];
  const fill = background ? `<rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(bw)}" height="${fmt(bh)}" fill="${background.replace(/[^#\w(),.%\s-]/g, "")}"/>` : "";
  // Mermaid writes `<br>`: not well-formed XML, which an SVG image document must be.
  const rest = text.slice(end + 1).replace(/<br\s*>/gi, "<br/>");
  const head = text.slice(0, start.index);
  const svg = selfClosed ? `${head}${tag}>${fill}</svg>` : `${head}${tag}>${fill}${rest}`;
  return { svg, width, height };
}

/** `<img src>` for SVG text. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Whether a path names a file figures can preview, and as what. */
export function previewKind(path: string): "svg" | "mermaid" | "markdown" | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext === "svg" ? "svg" : ext === "mmd" || ext === "mermaid" ? "mermaid" : ext === "md" || ext === "markdown" || ext === "mdx" ? "markdown" : undefined;
}
