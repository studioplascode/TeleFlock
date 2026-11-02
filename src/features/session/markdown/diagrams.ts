import type katexModule from "katex";
import type mermaidModule from "mermaid";
import { parseColor, readThemeColor } from "@/design";
import { prepareSvg } from "./svg";

/*
 * Lazy engines behind the transcript's Mermaid diagrams and math. Both libraries are dynamic
 * imports: a transcript without a diagram or a formula never fetches them, and the main chunk
 * doesn't carry them.
 */

// ── Mermaid ──

type Mermaid = typeof mermaidModule;

let mermaidLoad: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import("mermaid").then(
    (m) => m.default,
    (e: unknown) => {
      mermaidLoad = undefined;
      throw e;
    },
  );
  return mermaidLoad;
}

export type Diagram = { ok: true; svg: string; width: number; height: number } | { ok: false; error: string };

/** Fonts an SVG image can use: it sees the system's fonts, not the page's web fonts. */
const DIAGRAM_FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const hex = (css: string, fallback: string): string => {
  const c = parseColor(readThemeColor(css, fallback));
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return c ? `#${h(c.r)}${h(c.g)}${h(c.b)}` : fallback;
};

/** The app's colours as mermaid's `base` theme variables, so a diagram follows Daylight, High contrast and custom themes. */
export function mermaidTheme(): { darkMode: boolean; variables: Record<string, string> } {
  const c = (name: string, fallback: string) => hex(`--color-${name}`, fallback);
  const bg = c("bg-deep", "#07070b");
  const ink = c("ink", "#f5f5f7");
  const ink2 = c("ink-2", "#dcdce4");
  const mute = c("mute", "#9a9aad");
  const card = c("tile-3", "#232330");
  const raised = c("tile-4", "#2c2c3b");
  const accent = c("accent", "#a35cf0");
  const border = c("line-3", mute);
  const rgb = parseColor(bg);
  const darkMode = rgb ? 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b < 128 : true;
  return {
    darkMode,
    variables: {
      fontFamily: DIAGRAM_FONT,
      fontSize: "14px",
      background: bg,
      mainBkg: card,
      primaryColor: card,
      primaryTextColor: ink,
      primaryBorderColor: accent,
      secondaryColor: raised,
      secondaryTextColor: ink,
      secondaryBorderColor: border,
      tertiaryColor: c("tile-2", card),
      tertiaryTextColor: ink,
      tertiaryBorderColor: border,
      textColor: ink2,
      titleColor: ink,
      lineColor: mute,
      nodeBorder: accent,
      nodeTextColor: ink,
      clusterBkg: c("tile-2", card),
      clusterBorder: border,
      edgeLabelBackground: bg,
      noteBkgColor: raised,
      noteTextColor: ink,
      noteBorderColor: border,
      actorBkg: card,
      actorBorder: accent,
      actorTextColor: ink,
      actorLineColor: mute,
      signalColor: ink2,
      signalTextColor: ink2,
      labelBoxBkgColor: card,
      labelBoxBorderColor: border,
      labelTextColor: ink,
      loopTextColor: ink2,
      activationBkgColor: raised,
      activationBorderColor: accent,
      sequenceNumberColor: bg,
    },
  };
}

/** The figure surface behind a diagram (opaque, for the expanded view's dark backdrop). */
export const figureBackground = () => hex("--color-bg-deep", "#07070b");

const RESULTS_MAX = 80;
const settled = new Map<string, Diagram>();
const pending = new Map<string, Promise<Diagram>>();
/** Mermaid renders into one scratch element: renders run one after another. */
let queue: Promise<unknown> = Promise.resolve();
let renders = 0;

const diagramKey = (code: string, theme: number) => `${theme}\u0000${code}`;

/** A finished diagram for this source in this theme, if one was drawn already (a row scrolled back into view). */
export function peekDiagram(code: string, theme: number): Diagram | undefined {
  return settled.get(diagramKey(code, theme));
}

/** Mermaid's parse error condensed: where ("Parse error on line 3") and what it expected, capped. */
function errorNote(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const lines = raw.split("\n").map((l) => l.trim());
  const where = lines.find((l) => l) ?? "";
  const expected = lines.find((l) => /^(?:Expecting|Got)\b/.test(l));
  const note = [where.replace(/:$/, ""), expected].filter(Boolean).join(": ");
  return (note || "The diagram has a syntax error").slice(0, 200);
}

async function drawDiagram(code: string): Promise<Diagram> {
  const id = `tf-mmd-${++renders}`;
  try {
    const mermaid = await loadMermaid();
    const { darkMode, variables } = mermaidTheme();
    mermaid.initialize({
      startOnLoad: false,
      // Mermaid sanitises labels and refuses click handlers and scripts in this mode.
      securityLevel: "strict",
      theme: "base",
      themeVariables: { darkMode, ...variables },
      fontFamily: DIAGRAM_FONT,
      // Mermaid 12 defaults to ELK (a 1.4 MB engine, fetched with the first flowchart); dagre, the layout
      // diagrams were drawn with before, is 47 kB. A diagram can still ask for `layout: elk` in its front matter.
      layout: "dagre",
      // Labels in <foreignObject> don't draw reliably once the SVG is an <img> (WebKit); plain SVG text does.
      htmlLabels: false,
      suppressErrorRendering: true,
      logLevel: "fatal",
    });
    const { svg } = await mermaid.render(id, code);
    const prepared = prepareSvg(svg);
    return prepared ? { ok: true, ...prepared } : { ok: false, error: "Mermaid returned no drawing" };
  } catch (e) {
    return { ok: false, error: errorNote(e) };
  } finally {
    // A failed render can leave its scratch node in the body.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Draws `code` in the current theme (`theme` = the theme version, part of the cache key). */
export function renderDiagram(code: string, theme: number): Promise<Diagram> {
  const key = diagramKey(code, theme);
  const hit = settled.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = queue.then(() => drawDiagram(code));
    queue = p;
    pending.set(key, p);
    void p.then((d) => {
      pending.delete(key);
      // A failure is final for this source: the same text fails the same way.
      settled.set(key, d);
      if (settled.size > RESULTS_MAX) settled.delete(settled.keys().next().value as string);
    });
  }
  return p;
}

// ── KaTeX ──

export type Katex = typeof katexModule;

let katex: Katex | undefined;
let katexLoad: Promise<Katex> | undefined;

/** KaTeX once loaded (also synchronously, for rows that remount). */
export const loadedKatex = (): Katex | undefined => katex;

export function loadKatex(): Promise<Katex> {
  katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([m]) => (katex = m.default),
    (e: unknown) => {
      katexLoad = undefined;
      throw e;
    },
  );
  return katexLoad;
}

export type Typeset = { ok: true; html: string } | { ok: false; error: string };

const TYPESET_MAX = 300;
const typeset = new Map<string, Typeset>();

/**
 * `tex` as KaTeX HTML. `trust: false` keeps `\href`, `\url`, `\includegraphics` and `\htmlClass`
 * inert; `maxSize` and `maxExpand` stop a formula from drawing a page-sized box or expanding forever.
 * Needs KaTeX loaded (`loadKatex`).
 */
export function typesetTex(k: Katex, tex: string, display: boolean): Typeset {
  const key = `${display ? "d" : "i"}${tex}`;
  const hit = typeset.get(key);
  if (hit) return hit;
  let out: Typeset;
  try {
    out = { ok: true, html: k.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", output: "html", maxSize: 30, maxExpand: 1000 }) };
  } catch (e) {
    out = { ok: false, error: (e instanceof Error ? e.message : "Invalid formula").replace(/^KaTeX parse error: /, "").slice(0, 160) };
  }
  typeset.set(key, out);
  if (typeset.size > TYPESET_MAX) typeset.delete(typeset.keys().next().value as string);
  return out;
}
