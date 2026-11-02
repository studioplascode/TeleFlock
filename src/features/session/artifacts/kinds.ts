import type { ArtifactFile, PresentKind } from "@/core/gen";
import { languageFor } from "../lib/highlight";

/**
 * What a document is shown as, from what the agent said (`present`'s kind) or else its name, and
 * the names the bridge gives presented snapshots (`presented/<slug>-v<n>.<ext>`, the same rule as
 * tf-collab `presented_name`).
 */

export const KIND_LABEL: Record<PresentKind, string> = {
  html: "HTML page",
  markdown: "Markdown",
  svg: "SVG",
  image: "Image",
  code: "Code",
  csv: "Table",
  json: "JSON",
  text: "Text",
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const OTHER_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  vtt: "text/vtt",
};

/** `presented/a.b/report.HTML` → `html`. */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function mimeFor(name: string): string {
  const ext = extOf(name);
  return IMAGE_MIME[ext] ?? OTHER_MIME[ext] ?? "application/octet-stream";
}

export const isImageName = (name: string): boolean => extOf(name) in IMAGE_MIME;

/** The kind a file shows as by its name (the bridge's `presentKindForExt`, code by what TeleFlock highlights). */
export function kindForName(name: string): PresentKind {
  const ext = extOf(name);
  switch (ext) {
    case "html":
    case "htm":
    case "xhtml":
      return "html";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "svg":
      return "svg";
    case "csv":
    case "tsv":
      return "csv";
    case "json":
      return "json";
    case "txt":
    case "text":
    case "log":
      return "text";
  }
  if (ext in IMAGE_MIME) return "image";
  return languageFor(name) ? "code" : "text";
}

export interface PresentedName {
  slug: string;
  version: number;
  ext: string;
}

/** `presented/<slug>-v<version>.<ext>` → its parts; undefined for any other name. */
export function presentedName(name: string): PresentedName | undefined {
  const m = /^presented\/([a-z0-9-]+)-v(\d+)\.([a-z0-9]{1,10})$/.exec(name);
  if (!m) return undefined;
  const version = Number(m[2]);
  return version >= 1 && Number.isSafeInteger(version) ? { slug: m[1]!, version, ext: m[3]! } : undefined;
}

/** The folder a presented snapshot's referenced files were copied to. */
export function presentedAssetsDir(name: string): string | undefined {
  const p = presentedName(name);
  return p ? `presented/${p.slug}-v${p.version}.files` : undefined;
}

/** Whether a listed file is one of the files a presented document references (not a document itself). */
export const isPresentedAsset = (name: string): boolean => /^presented\/[a-z0-9-]+-v\d+\.files\//.test(name);

/** Every version of a presented artifact in a listing, oldest first. */
export function presentedVersions(files: readonly ArtifactFile[], slug: string): Array<{ version: number; file: ArtifactFile }> {
  const out: Array<{ version: number; file: ArtifactFile }> = [];
  for (const file of files) {
    if (file.kind !== "local") continue;
    const p = presentedName(file.name);
    if (p?.slug === slug) out.push({ version: p.version, file });
  }
  return out.sort((a, b) => a.version - b.version);
}

/**
 * Rows (and whether more were cut) of a CSV/TSV text: quoted fields, doubled quotes, CRLF. A row
 * keeps its first `maxColumns` fields; `columns` counts the widest kept row's fields, cut ones too.
 */
export function parseCsv(
  text: string,
  delimiter: string,
  maxRows: number,
  maxColumns = Number.POSITIVE_INFINITY,
): { rows: string[][]; truncated: boolean; columns: number } {
  const rows: string[][] = [];
  const widths: number[] = [];
  let row: string[] = [];
  let width = 0;
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    if (width < maxColumns) row.push(field);
    width++;
    field = "";
  };
  const endRow = () => {
    endField();
    if (width > 1 || row[0] !== "") {
      rows.push(row);
      widths.push(width);
    }
    row = [];
    width = 0;
  };
  const done = (truncated: boolean) => {
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    return { rows: kept, truncated, columns: widths.slice(0, kept.length).reduce((a, b) => Math.max(a, b), 0) };
  };
  while (i < n) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length > maxRows) return done(true);
    } else field += c;
    i++;
  }
  if (field !== "" || width > 0) endRow();
  return done(rows.length > maxRows);
}
