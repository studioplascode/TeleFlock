import { Check, Copy, Download, Maximize2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn, isAndroid, isTauri, Lightbox, LightboxTrigger, saveBlob, Shimmer, useThemeVersion } from "@/design";
import { CodeBlock, HEADER_BUTTON, useCopy } from "./CodeBlock";
import { type Diagram, figureBackground, type Katex, loadedKatex, loadKatex, peekDiagram, renderDiagram, typesetTex } from "./diagrams";
import { type PreparedSvg, prepareSvg, svgDataUrl } from "./svg";

/** The Android app's WebView has no downloads. */
const canDownload = !(isTauri() && isAndroid);

interface FigureProps {
  /** Header label (`mermaid`, `svg`). */
  label: string;
  /** What Copy puts on the clipboard: the source the author wrote. */
  source: string;
  image: PreparedSvg;
  /** File name for Download. */
  file: string;
  alt: string;
}

/**
 * A rendered diagram or SVG: the image, with Copy source, Expand (the lightbox: zoom, pan) and
 * Download. Always an `<img>` of the SVG, so nothing in the markup can run or reach the page.
 */
function Figure({ label, source, image, file, alt }: FigureProps) {
  const { copied, copy } = useCopy(source);
  const [expanded, setExpanded] = useState(false);
  const src = useMemo(() => svgDataUrl(image.svg), [image.svg]);
  // The viewer is dark in every theme: a transparent drawing gets the figure's own surface behind it.
  const viewer = useMemo(() => {
    if (!expanded) return [];
    // Vector art fills the viewer (up to 4x) instead of sitting at its small natural size.
    const scale = Math.max(1, Math.min(4, 1200 / image.width, 700 / image.height));
    const big = prepareSvg(image.svg, figureBackground(), scale);
    return [{ src: big ? svgDataUrl(big.svg) : src, alt, width: big?.width ?? image.width, height: big?.height ?? image.height }];
  }, [expanded, image, src, alt]);
  return (
    <div className="group/code relative my-2.5 overflow-hidden rounded-md bg-bg-deep/80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]">
      <div data-find-skip className="flex h-7 items-center gap-1 border-b border-line px-3 text-2xs text-mute-2 max-md:h-6 max-md:px-2.5">
        <span className="font-mono font-semibold tracking-wide">{label}</span>
        <button type="button" onClick={copy} className={cn(HEADER_BUTTON, "ml-auto")} aria-label={`Copy ${label} source`}>
          {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={() => setExpanded(true)} className={HEADER_BUTTON} aria-label={`Expand ${label}`}>
          <Maximize2 className="size-3" />
          Expand
        </button>
        {canDownload && (
          <button type="button" onClick={() => saveBlob(new Blob([image.svg], { type: "image/svg+xml" }), file)} className={HEADER_BUTTON} aria-label={`Download ${label} as SVG`}>
            <Download className="size-3" />
            SVG
          </button>
        )}
      </div>
      <button type="button" onClick={() => setExpanded(true)} aria-label={`Expand ${label}`} className="focus-ring block w-full cursor-zoom-in p-3 max-md:p-2">
        <img src={src} alt={alt} width={image.width} height={image.height} draggable={false} className="mx-auto block h-auto max-h-[520px] w-auto max-w-full" />
      </button>
      <Lightbox images={viewer} index={expanded ? 0 : null} onIndexChange={(i) => setExpanded(i != null)} />
    </div>
  );
}

/** Space held while the diagram engine loads and draws, so the row doesn't jump twice. */
function Drawing({ label }: { label: string }) {
  return (
    <div className="group/code my-2.5 grid h-28 place-items-center overflow-hidden rounded-md bg-bg-deep/80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]">
      <Shimmer className="text-2xs font-semibold">{label}</Shimmer>
    </div>
  );
}

/**
 * A closed ```mermaid fence. The engine is loaded on first use and draws in the current theme
 * (again when the theme changes); a diagram that doesn't parse shows its source with the reason.
 */
export function MermaidFigure({ code }: { code: string }) {
  const theme = useThemeVersion();
  const [drawn, setDrawn] = useState<{ code: string; diagram: Diagram }>();
  useEffect(() => {
    let live = true;
    void renderDiagram(code, theme).then((diagram) => live && setDrawn({ code, diagram }));
    return () => {
      live = false;
    };
  }, [code, theme]);
  // The previous theme's drawing stays up until the new one is ready; a row scrolling back in finds its own at once.
  const diagram = peekDiagram(code, theme) ?? (drawn?.code === code ? drawn.diagram : undefined);
  if (!diagram) return <Drawing label="Drawing diagram…" />;
  if (!diagram.ok) return <CodeBlock code={code} lang="mermaid" note={`Couldn't draw this diagram: ${diagram.error}`} />;
  return <Figure label="mermaid" source={code} image={diagram} file="diagram.svg" alt="Mermaid diagram" />;
}

/** A closed ```svg fence (or an `.svg` file's content): shown as an image. */
export function SvgFigure({ code }: { code: string }) {
  const image = useMemo(() => prepareSvg(code), [code]);
  if (!image) return <CodeBlock code={code} lang="svg" note="Couldn't preview this SVG: it has no <svg> element, or it is too large." />;
  return <Figure label="svg" source={code} image={image} file="image.svg" alt="SVG image" />;
}

// ── math ──

/** KaTeX, once its chunk has loaded (right away when an earlier formula loaded it). */
function useKatex(): Katex | undefined {
  const [katex, setKatex] = useState<Katex | undefined>(() => loadedKatex());
  useEffect(() => {
    if (katex) return;
    let live = true;
    loadKatex().then(
      (k) => live && setKatex(k),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [katex]);
  return katex;
}

const MATH_SOURCE = "rounded-[6px] bg-ink/[0.07] px-[5px] py-[1px] font-mono text-[0.88em] text-accent-ink shadow-[inset_0_0_0_1px_var(--color-line)]";

/** `$x$` / `\(x\)`: the formula in the line; its TeX until KaTeX is ready (and when it won't parse). */
export function InlineMath({ tex }: { tex: string }) {
  const katex = useKatex();
  const set = katex ? typesetTex(katex, tex, false) : undefined;
  if (!set?.ok)
    return (
      <code className={MATH_SOURCE} title={set?.error}>
        {tex}
      </code>
    );
  return <span data-find-skip role="math" aria-label={tex} className="tf-math" dangerouslySetInnerHTML={{ __html: set.html }} />;
}

/** `$$…$$` / `\[…\]`: a centred formula that scrolls sideways when it is wider than the column. */
export function DisplayMath({ tex }: { tex: string }) {
  const katex = useKatex();
  const { copied, copy } = useCopy(tex);
  const set = katex ? typesetTex(katex, tex, true) : undefined;
  let body: ReactNode;
  if (set?.ok) body = <span data-find-skip role="math" aria-label={tex} className="tf-math block" dangerouslySetInnerHTML={{ __html: set.html }} />;
  else
    body = (
      <>
        <span className="block whitespace-pre-wrap font-mono text-[12px] text-mute">{tex}</span>
        {set && <span className="mt-0.5 block text-2xs text-warn">Couldn't typeset this formula: {set.error}</span>}
      </>
    );
  return (
    <span className="group/code relative my-2.5 block max-md:my-2">
      <span className="block min-h-[2.4em] overflow-x-auto overflow-y-hidden py-1 text-center">{body}</span>
      <button type="button" onClick={copy} data-find-skip className={cn(HEADER_BUTTON, "absolute top-0 right-0")} aria-label="Copy formula source">
        {copied ? <Check className="size-3 text-done" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** `![alt](data:image/…)`: a picture in the text, opening the lightbox on click. */
export function InlineImage({ src, alt }: { src: string; alt: string }) {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <>
      <LightboxTrigger label={alt ? `Open image: ${alt}` : "Open image"} onClick={() => setIndex(0)} className="my-1 inline-block max-w-full align-middle">
        <img src={src} alt={alt} loading="lazy" draggable={false} className="max-h-[360px] max-w-full rounded-md object-contain" />
      </LightboxTrigger>
      <Lightbox images={[{ src, alt }]} index={index} onIndexChange={setIndex} />
    </>
  );
}
