import { AudioLines, BookOpen, Braces, Code2, Download, ExternalLink, FileImage, FileText, Film, Globe, Image as ImageIcon, NotebookText, Paperclip, PenTool, Sheet, Workflow } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import type { PresentKind } from "@/core/gen";
import { Button, cn, EmptyState, Lightbox, LightboxTrigger, Skeleton, Spinner } from "@/design";
import { AudioPane, VideoPane } from "@/features/review/diff/MediaPreview";
import { Highlighted } from "../markdown/CodeBlock";
import { MermaidFigure } from "../markdown/Figures";
import { Markdown } from "../markdown/Markdown";
import { languageFor } from "../lib/highlight";
import { formatBytes } from "./artifacts";
import { extOf, isMediaKind, type MediaPresentKind, parseCsv } from "./kinds";
import type { DocState, LoadedDoc, ReadProgress } from "./load";
import { TEXT_MAX } from "./load";
import { SandboxFrame } from "./SandboxFrame";
import { artifactDocument, assetKey } from "./sandbox";

// pdf.js and its worker load with the first PDF (Review's viewer).
const PdfView = lazy(() => import("@/features/review/diff/PdfView").then((m) => ({ default: m.PdfView })));

export const KIND_ICON: Record<PresentKind, typeof Globe> = {
  html: Globe,
  markdown: NotebookText,
  svg: PenTool,
  image: ImageIcon,
  code: Code2,
  csv: Sheet,
  json: Braces,
  text: FileText,
  pdf: BookOpen,
  audio: AudioLines,
  video: Film,
  mermaid: Workflow,
  file: Paperclip,
};

/** Per-kind tint of the icon tile (the tool cards' palette). */
export const KIND_TONE: Record<PresentKind, string> = {
  html: "bg-review/14 text-review",
  markdown: "bg-ink/8 text-ink-2",
  svg: "bg-omp-pink/15 text-omp-pink",
  image: "bg-omp-pink/15 text-omp-pink",
  code: "bg-accent/15 text-accent-hi",
  csv: "bg-done/12 text-done",
  json: "bg-warn/12 text-warn",
  text: "bg-ink/6 text-mute",
  pdf: "bg-sun-1/15 text-sun-1",
  audio: "bg-omp-blue/15 text-omp-blue",
  video: "bg-omp-pink/15 text-omp-pink",
  mermaid: "bg-add/12 text-add",
  file: "bg-ink/6 text-mute",
};

/** Save and Open of a document shown as a file (the pane's; its menu offers the same). */
export interface FileActions {
  /** The name Save writes: the agent's own for a file it handed over. */
  name: string;
  /** The path the agent presented it from. */
  source?: string;
  /** Absent: this device saves no files (the Android app), or the file can't be read (`blocked`). */
  save?: () => void;
  /** Absent: no Open in browser here, or not for this type (it would run, or open as text). */
  open?: () => void;
  /** Why the file can't be saved from here. */
  blocked?: string;
  /** Reading it for Save or Open: bytes so far, of its size (0 before the first range answers). */
  reading?: ReadProgress;
}

/** Rows a table shows at most (a larger file says how many more there are). */
const MAX_ROWS = 2000;
/** Columns a table shows at most: a line of nothing but commas would otherwise be millions of cells. */
const MAX_COLUMNS = 100;

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const { rows, truncated, columns } = useMemo(() => parseCsv(text, tsv ? "\t" : ",", MAX_ROWS, MAX_COLUMNS), [text, tsv]);
  if (!rows.length) return <EmptyState compact title="An empty table" />;
  const [head, ...body] = rows;
  const width = Math.min(columns, MAX_COLUMNS);
  return (
    <>
      {columns > MAX_COLUMNS && (
        <Note>
          Showing the first {MAX_COLUMNS} of {columns.toLocaleString()} columns.
        </Note>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-[12.5px] tabular">
          <thead className="sticky top-0 z-raised bg-chrome">
            <tr>
              {Array.from({ length: width }, (_, i) => (
                <th key={i} className="border-b border-line px-3 py-1.5 text-left font-bold whitespace-nowrap text-ink">
                  {head?.[i] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className="even:bg-ink/[0.025]">
                {Array.from({ length: width }, (_, j) => (
                  <td key={j} className="border-b border-line/60 px-3 py-1 align-top whitespace-pre-wrap text-ink-2">
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && <div className="px-3 py-2 text-2xs font-semibold text-mute-2">Showing the first {MAX_ROWS.toLocaleString()} rows.</div>}
      </div>
    </>
  );
}

function ImageBody({ src, alt, checker }: { src: string; alt: string; checker?: boolean }) {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <div className={cn("grid min-h-0 flex-1 place-items-center overflow-auto p-4", checker && "bg-[repeating-conic-gradient(color-mix(in_srgb,var(--color-ink)_6%,transparent)_0_25%,transparent_0_50%)] bg-[length:20px_20px]")}>
      <LightboxTrigger label={`Zoom: ${alt}`} onClick={() => setIndex(0)} className="max-w-full">
        <img src={src} alt={alt} draggable={false} className="mx-auto block h-auto max-h-[calc(100dvh-200px)] max-w-full object-contain" />
      </LightboxTrigger>
      <Lightbox images={[{ src, alt }]} index={index} onIndexChange={setIndex} />
    </div>
  );
}

/** An object URL of `blob` while the view shows it, revoked when it goes (or the bytes change). */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [made, setMade] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setMade({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return made && made.blob === blob ? made.url : undefined;
}

/** An image (zoom on click), a PDF page by page (pdf.js, as in Review), audio or video in the platform's player. */
function MediaBody({ kind, blob, title }: { kind: MediaPresentKind; blob: Blob; title: string }) {
  const url = useObjectUrl(kind === "pdf" ? undefined : blob);
  const caption = formatBytes(blob.size);
  if (kind === "pdf")
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3 max-md:p-2">
        <Suspense fallback={<div className="min-h-0 flex-1 animate-pulse rounded-md bg-well" />}>
          <PdfView blob={blob} caption={caption} label={title} fill />
        </Suspense>
      </div>
    );
  if (!url) return null;
  if (kind === "image") return <ImageBody src={url} alt={title} />;
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4 max-md:p-3">
      {kind === "video" ? (
        <VideoPane url={url} caption={caption} maxH="max-h-[calc(100dvh-220px)]" />
      ) : (
        <div className="w-full max-w-[560px]">
          <AudioPane url={url} caption={caption} />
        </div>
      )}
    </div>
  );
}

/** Bytes so far of a file read in ranges (Review's bar). */
function ReadBar({ progress }: { progress: ReadProgress }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-2xs text-mute">
      <span className="tabular">
        {formatBytes(progress.received)} of {formatBytes(progress.size)}
      </span>
      <span className="h-1 w-40 overflow-hidden rounded-full bg-ink/10">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round((progress.received / progress.size) * 100)}%` }} />
      </span>
    </div>
  );
}

/** A media file on its way: how much of it came, once its size is known. */
function Reading({ progress }: { progress?: ReadProgress }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6" aria-busy>
      <div className="flex flex-col items-center gap-2.5">
        <Spinner size={18} label="Reading" />
        {progress && progress.size > 0 && <ReadBar progress={progress} />}
      </div>
    </div>
  );
}

/**
 * A file to save rather than read: its name, type and size, where the agent had it, Save and Open
 * (the Android app has neither: its path on the host is in the menu).
 */
function FileCard({ doc, file, note }: { doc: LoadedDoc; file?: FileActions; note?: string }) {
  const name = file?.name ?? doc.content.name.slice(doc.content.name.lastIndexOf("/") + 1);
  const ext = extOf(name);
  const reading = file?.reading;
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6 max-md:p-4">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-4 rounded-[22px] bg-ink/[0.025] px-6 py-7 text-center shadow-[inset_0_0_0_1px_var(--color-line)] max-md:px-4">
        <span className={cn("grid size-14 place-items-center rounded-[16px]", KIND_TONE.file)} aria-hidden>
          <Paperclip className="size-6" />
        </span>
        <div className="flex max-w-full min-w-0 flex-col gap-0.5">
          <span className="truncate text-[15px] font-bold text-ink" title={name}>
            {name}
          </span>
          <span className="text-[12px] font-semibold text-mute-2 tabular">
            {ext ? `${ext.toUpperCase()} file` : "File"} · {formatBytes(doc.content.size)}
          </span>
          {file?.source && (
            <span className="truncate font-mono text-[11px] text-mute-2" title={file.source}>
              {file.source}
            </span>
          )}
        </div>
        {(note || file?.blocked) && <p className="text-xs text-mute">{[note, file?.blocked].filter(Boolean).join(" ")}</p>}
        {file?.save || file?.open ? (
          <div className="flex flex-wrap justify-center gap-2">
            {file.save && (
              <Button variant="primary" size="sm" icon={<Download />} loading={!!reading} onClick={file.save}>
                Save
              </Button>
            )}
            {file.open && (
              <Button size="sm" icon={<ExternalLink />} disabled={!!reading} onClick={file.open}>
                Open
              </Button>
            )}
          </div>
        ) : (
          !file?.blocked && <p className="text-xs text-mute">This device can't save files. Copy its path on the host from the menu, or save it from TeleFlock on a computer.</p>
        )}
        {reading && reading.size > 0 && <ReadBar progress={reading} />}
      </div>
    </div>
  );
}

function SourceBody({ code, lang }: { code: string; lang?: string }) {
  return (
    <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-ink-2 max-md:px-3 max-md:text-[11.5px]">
      <code>
        <Highlighted code={code} lang={lang} />
      </code>
    </pre>
  );
}

/** JSON pretty-printed (as written when it doesn't parse). */
function JsonBody({ text }: { text: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return undefined;
    }
  }, [text]);
  return (
    <>
      {pretty === undefined && <Note>Not valid JSON; shown as written.</Note>}
      <SourceBody code={pretty ?? text} lang="json" />
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="shrink-0 border-b border-line bg-warn/[0.06] px-4 py-1.5 text-2xs font-semibold text-warn">{children}</div>;
}

/** Why a document shows less than it has. */
function notes(doc: LoadedDoc): string[] {
  const out: string[] = [];
  if (doc.content.truncated) out.push(`Showing the first ${formatBytes(TEXT_MAX)} of ${formatBytes(doc.content.size)}.`);
  if (doc.missing > 0) out.push(`${doc.missing} referenced file${doc.missing === 1 ? "" : "s"} couldn't be shown.`);
  return out;
}

/**
 * One document in full, by kind: a page in its sandbox, Markdown with the transcript's renderer
 * (its images inlined), a drawing, diagram or image (zoom on click), a PDF, audio or video, code
 * highlighted, a table, JSON pretty-printed, text; a file to save (one handed over as it is, or
 * one that can't be shown: `file` its card's actions). Fills its parent (a bounded flex column)
 * and scrolls inside.
 */
export function ArtifactBody({
  title,
  kind,
  state,
  review,
  file,
}: {
  title: string;
  kind: PresentKind;
  state: DocState & { loading: boolean; progress?: ReadProgress };
  review?: string;
  file?: FileActions;
}) {
  if (review !== undefined) {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5 text-[14px] leading-relaxed max-md:px-4">
        <div className="mx-auto max-w-[780px]">
          <Markdown text={review} />
        </div>
      </div>
    );
  }
  if (state.error)
    return (
      <EmptyState
        compact
        icon={<FileText />}
        title={state.error.code === "not_found" ? "It's gone" : "Couldn't read it"}
        description={state.error.code === "not_found" ? "The file is no longer in the session's artifacts (deleted, or the session was moved)." : state.error.message}
      />
    );
  const doc = state.doc;
  if (!doc) return isMediaKind(kind) ? <Reading progress={state.progress} /> : <Skeleton className="m-4 h-48 rounded-lg" />;
  const empty = doc.content.size === 0 ? "It is empty." : undefined;
  if (isMediaKind(kind)) {
    if (doc.media) return <MediaBody kind={kind} blob={doc.media} title={title} />;
    if (doc.unshown === "textOnly")
      return <EmptyState compact icon={<FileImage />} title="Update this host to see this file" description="Its TeleFlock host daemon reads documents as text only (images, PDFs, audio and video need 0.9.0)." />;
    if (doc.unshown === "rangeless")
      return (
        <EmptyState
          compact
          icon={<FileImage />}
          title="Update this host to see this file"
          description={`Its TeleFlock host daemon reads files up to 8 MB at once, and this one is ${formatBytes(doc.content.size)} (larger ones need 0.9.4).`}
        />
      );
    return <FileCard doc={doc} file={file} note={empty ?? "TeleFlock can't show this type of file."} />;
  }
  const text = doc.text;
  if (kind === "file" || text == null) return <FileCard doc={doc} file={file} note={kind === "file" ? undefined : (empty ?? "It isn't text, so it can't be shown here.")} />;
  const lines = notes(doc);
  const top = lines.length > 0 && <Note>{lines.join(" ")}</Note>;
  if (kind === "svg" && doc.imageUrl)
    return (
      <>
        {top}
        <ImageBody src={doc.imageUrl} alt={title} checker />
      </>
    );
  switch (kind) {
    case "html":
      return (
        <>
          {top}
          <SandboxFrame page={doc.page ?? artifactDocument(text, new Map())} title={title} />
        </>
      );
    case "markdown":
      return (
        <>
          {top}
          <div className="min-h-0 flex-1 overflow-auto px-6 py-5 text-[14px] leading-relaxed max-md:px-4">
            <div className="mx-auto max-w-[780px]">
              <Markdown
                text={text}
                imageSrc={(src) => {
                  const key = assetKey(src);
                  return key !== undefined ? doc.images?.get(key) : src;
                }}
              />
            </div>
          </div>
        </>
      );
    case "mermaid":
      return (
        <>
          {top}
          <div className="min-h-0 flex-1 overflow-auto px-6 py-5 max-md:px-3 max-md:py-3">
            <div className="mx-auto max-w-[1100px]">
              <MermaidFigure code={text} />
            </div>
          </div>
        </>
      );
    case "csv":
      return (
        <>
          {top}
          <CsvTable text={text} tsv={extOf(doc.content.name) === "tsv"} />
        </>
      );
    case "json":
      return (
        <>
          {top}
          <JsonBody text={text} />
        </>
      );
    case "code":
    case "svg":
      return (
        <>
          {top}
          <SourceBody code={text} lang={languageFor(doc.language ?? doc.content.name) ?? (kind === "svg" ? "svg" : undefined)} />
        </>
      );
    default:
      return (
        <>
          {top}
          <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">{text}</pre>
        </>
      );
  }
}
