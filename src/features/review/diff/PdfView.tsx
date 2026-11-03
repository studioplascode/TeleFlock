/**
 * A PDF in Review, drawn with pdf.js on every platform (WebView2, WebKitGTK, WKWebView and Android's
 * WebView, which has no PDF viewer of its own). This module and pdf.js's worker load with the first
 * PDF preview. Pages sit in a scrolling frame; each is drawn while near the frame's view and dropped
 * when far, so a long document costs a few canvases. A page opens full size in the lightbox.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn, Lightbox, type LightboxImage } from "@/design";

// The legacy build carries what older WebKit (macOS 11–13, WebKitGTK of older distributions) lacks.
GlobalWorkerOptions.workerSrc = workerSrc;

/** pdf.js reads CMaps, standard fonts, ICC profiles and image decoders by file name from here (`vite.config.ts` `pdfjsAssets`). */
const ASSETS = new URL("/pdfjs/", location.href).href;
/** Until a page says otherwise: US Letter's height to width. */
const LETTER = 11 / 8.5;
/** Canvas pixels per page at most (a poster-sized page would otherwise need hundreds of MB). */
const MAX_PIXELS = 16e6;
/** The lightbox's copy of a page: this many pixels on its longer side at most. */
const FULL_SIDE = 4096;

function pdfError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "PasswordException") return "This PDF is protected with a password.";
  if (name === "InvalidPDFException") return "This file isn't a readable PDF.";
  return e instanceof Error ? e.message : String(e);
}

/** The document from `blob`; mount it again (a `key`) for other bytes. */
export function PdfView({ blob, caption, label }: { blob: Blob; caption: string; label: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    let task: PDFDocumentLoadingTask | undefined;
    blob
      .arrayBuffer()
      .then((buf) => {
        if (gone) return;
        task = getDocument({
          data: new Uint8Array(buf),
          cMapUrl: `${ASSETS}cmaps/`,
          standardFontDataUrl: `${ASSETS}standard_fonts/`,
          wasmUrl: `${ASSETS}wasm/`,
          iccUrl: `${ASSETS}iccs/`,
          verbosity: VerbosityLevel.ERRORS,
        });
        return task.promise.then((d) => {
          if (!gone) setDoc(d);
        });
      })
      .catch((e: unknown) => {
        if (!gone) setError(pdfError(e));
      });
    return () => {
      gone = true;
      void task?.destroy();
    };
  }, [blob]);
  if (error) return <p className="rounded-md bg-well px-3 py-6 text-center text-xs text-mute">{error}</p>;
  return (
    <figure className="flex flex-col gap-1.5">
      {doc ? <Pages doc={doc} label={label} /> : <div className="h-[min(70vh,760px)] animate-pulse rounded-md bg-well max-md:h-[62vh]" aria-busy aria-label="Opening the PDF" />}
      <figcaption className="px-0.5 text-2xs text-mute tabular">
        {doc ? `${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"} · ` : ""}
        {caption}
      </figcaption>
    </figure>
  );
}

function Pages({ doc, label }: { doc: PDFDocumentProxy; label: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState(LETTER);
  const [full, setFull] = useState<LightboxImage | null>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // Pages fill the frame's width less its padding (24 px).
    const fit = () => setWidth(Math.max(0, Math.floor(el.clientWidth - 24)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let gone = false;
    void doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      if (!gone) setAspect(v.height / v.width);
    });
    return () => {
      gone = true;
    };
  }, [doc]);

  // The lightbox's copy of the last opened page lives until another opens or the view goes.
  useEffect(() => () => void (full && URL.revokeObjectURL(full.src)), [full]);

  const openPage = async (n: number) => {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(FULL_SIDE / Math.max(base.width, base.height), Math.max(2, (2 * window.innerWidth) / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return;
    setFull({ src: URL.createObjectURL(png), alt: `${label}, page ${n}`, width: canvas.width, height: canvas.height });
    setOpen(true);
  };

  return (
    <>
      <div ref={frameRef} className="h-[min(70vh,760px)] overflow-auto overscroll-contain rounded-md bg-well p-3 max-md:h-[62vh]" tabIndex={0} aria-label={`${label}: ${doc.numPages} pages`}>
        <div className="flex flex-col items-center gap-3">
          {width > 0 && Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} n={i + 1} width={width} fallback={aspect} root={frameRef} onOpen={(n) => void openPage(n)} />)}
        </div>
      </div>
      <Lightbox images={full ? [full] : []} index={open && full ? 0 : null} onIndexChange={(i) => setOpen(i !== null)} />
    </>
  );
}

function Page({ doc, n, width, fallback, root, onOpen }: { doc: PDFDocumentProxy; n: number; width: number; fallback: number; root: RefObject<HTMLDivElement | null>; onOpen: (n: number) => void }) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1]?.isIntersecting ?? false), { root: root.current, rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let gone = false;
    let task: RenderTask | undefined;
    void doc
      .getPage(n)
      .then((page) => {
        const base = page.getViewport({ scale: 1 });
        if (gone) return;
        setAspect(base.height / base.width);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const scale = Math.min((width / base.width) * dpr, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        return task.promise;
      })
      .catch((e: unknown) => {
        if (!gone && !(e instanceof Error && e.name === "RenderingCancelledException")) setFailed(true);
      });
    return () => {
      gone = true;
      task?.cancel();
      // Far from view: give the canvas's memory back.
      const c = canvasRef.current;
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, [near, width, doc, n]);

  return (
    <button
      ref={boxRef}
      type="button"
      onClick={() => onOpen(n)}
      aria-label={`Open page ${n} full size`}
      className={cn("relative block shrink-0 cursor-zoom-in overflow-hidden rounded-[3px] bg-white shadow-[var(--shadow-d1)] focus-ring", failed && "bg-well")}
      style={{ width, height: Math.round(width * (aspect ?? fallback)) }}
    >
      <canvas ref={canvasRef} className="block size-full" />
      {failed && <span className="absolute inset-0 grid place-items-center text-xs text-mute">Couldn't draw page {n}</span>}
      <span className="absolute right-1.5 bottom-1 rounded-sm bg-black/45 px-1 font-sans text-[10px] font-semibold text-white tabular">{n}</span>
    </button>
  );
}
