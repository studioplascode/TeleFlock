import { Braces, Code2, FileImage, FileText, Globe, Image as ImageIcon, NotebookText, PenTool, Sheet } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { PresentKind } from "@/core/gen";
import { cn, EmptyState, Lightbox, LightboxTrigger, Skeleton } from "@/design";
import { Highlighted } from "../markdown/CodeBlock";
import { Markdown } from "../markdown/Markdown";
import { languageFor } from "../lib/highlight";
import { formatBytes } from "./artifacts";
import { extOf, parseCsv } from "./kinds";
import type { DocState, LoadedDoc } from "./load";
import { TEXT_MAX } from "./load";
import { SandboxFrame } from "./SandboxFrame";
import { artifactDocument, assetKey } from "./sandbox";

export const KIND_ICON: Record<PresentKind, typeof Globe> = {
  html: Globe,
  markdown: NotebookText,
  svg: PenTool,
  image: ImageIcon,
  code: Code2,
  csv: Sheet,
  json: Braces,
  text: FileText,
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
};

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
 * (its images inlined), a drawing or image (zoom on click), code highlighted, a table, JSON
 * pretty-printed, text. Fills its parent (a bounded flex column) and scrolls inside.
 */
export function ArtifactBody({ title, kind, state, review }: { title: string; kind: PresentKind; state: DocState & { loading: boolean }; review?: string }) {
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
  if (!doc) return <Skeleton className="m-4 h-48 rounded-lg" />;
  const lines = notes(doc);
  const top = lines.length > 0 && <Note>{lines.join(" ")}</Note>;
  const text = doc.text;
  if (kind === "image" || (kind === "svg" && doc.imageUrl)) {
    if (!doc.imageUrl)
      return <EmptyState compact icon={<FileImage />} title="Update this host to see images" description="Its TeleFlock host daemon reads documents as text only (images need 0.9.0)." />;
    return (
      <>
        {top}
        <ImageBody src={doc.imageUrl} alt={title} checker={kind === "svg"} />
      </>
    );
  }
  if (text == null)
    return <EmptyState compact icon={<FileText />} title="Not a text file" description={`${formatBytes(doc.content.size)} · ${doc.content.path}`} />;
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
