/**
 * Just enough colour math for theme checks: parse `#hex` and `rgb()` colours, composite a
 * translucent colour over its background, and the WCAG 2 contrast ratio.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (commas or spaces, `/ alpha`, % alpha); else undefined. */
export function parseColor(value: string): Rgba | undefined {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 5 || hex.length === 7) return undefined;
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(v)?.[1];
  if (!fn) return undefined;
  const [channels = "", alphaPart] = fn.includes("/") ? fn.split("/") : [fn, undefined];
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  const legacyAlpha = alphaPart === undefined && parts.length === 4 ? parts.pop() : undefined;
  if (parts.length !== 3) return undefined;
  const channel = (p: string) => (p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p));
  const [r, g, b] = parts.map(channel) as [number, number, number];
  const alphaText = (alphaPart ?? legacyAlpha)?.trim();
  const a = alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText);
  if ([r, g, b, a].some((x) => Number.isNaN(x))) return undefined;
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

/** `fg` painted over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two opaque colours (1–21). */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A CSS colour at `alpha` as `rgba(r, g, b, a)` (canvas and xterm parse it); unparseable colours come back as they are. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return c ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+(c.a * alpha).toFixed(3)})` : color;
}
