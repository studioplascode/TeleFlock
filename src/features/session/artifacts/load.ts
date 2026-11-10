import { useEffect, useState } from "react";
import { create } from "zustand";
import { apiError, core, parseAgentKey, toApiError } from "@/core";
import type { ArtifactContent, ArtifactKind, ArtifactParams, PresentKind } from "@/core/gen";
import { FIRST_READ, LOAD_MAX, mediaByPath, RANGELESS_MAX, type RangeReader, readMedia, readRest } from "@/features/review/diff/media";
import { decodeBase64 } from "@/features/terminal/frames";
import { languageFor } from "../lib/highlight";
import { prepareSvg, svgDataUrl } from "../markdown/svg";
import { formatBytes } from "./artifacts";
import { extOf, isImageName, isMediaKind, kindForName, type MediaPresentKind, mimeFor, presentedAssetsDir, presentedName } from "./kinds";
import {
  ASSET_LIMITS,
  artifactDocument,
  assetKey,
  cssRefs,
  type InlineAsset,
  inlineAssets,
  keyDir,
  markdownRefs,
  markupRefs,
  standaloneDocument,
} from "./sandbox";

/** A document the viewer shows: a file in the session's artifacts, or the pending plan review. */
export interface DocRef {
  agentKey: string;
  /** `review`: the plan under review (its text comes with the session's state, not from a file). */
  kind: ArtifactKind | "review";
  /** Root-relative name (`presented/q3-report-v2.html`); empty for the review. */
  name: string;
  /** What the agent said it is (`present`'s kind); else from the name. */
  as?: PresentKind;
  /** The title the agent gave it, or the listing's. */
  title?: string;
  /** `code`: the language to highlight. */
  language?: string;
}

/**
 * Why a media file's bytes aren't shown: `notMedia`, no type the webview shows (its name and first
 * bytes say nothing, or it is empty: shown as a file to save); `rangeless`, larger than one read of
 * a host that reads from the start only (before 0.9.4); `textOnly`, a host that reads documents as
 * text only (before 0.9.0).
 */
export type Unshown = "notMedia" | "rangeless" | "textOnly";

export interface LoadedDoc {
  kind: PresentKind;
  /** The (first) read's answer; `data` dropped. */
  content: ArtifactContent;
  /** The document's text (text kinds). */
  text?: string;
  /** `html`: the page the sandbox shows (references inlined, resource hints dropped, policy and prelude first). */
  page?: string;
  /** `html`: the self-contained copy for Save and Open in browser (the policy and guard first). */
  standalone?: string;
  /** `svg`: what an `<img>` shows. */
  imageUrl?: string;
  /** `image`, `pdf`, `audio`, `video`: the file's bytes, typed by its extension (else its first bytes). */
  media?: Blob;
  unshown?: Unshown;
  /** `file`: the host reads from the start only (before 0.9.4): Save reads at most 8 MiB. */
  rangeless?: boolean;
  /** `markdown`: `data:` URLs of its images, by reference key. */
  images?: ReadonlyMap<string, string>;
  /** Referenced files that could not be inlined (not copied, too large, a host before 0.9.0). */
  missing: number;
  language?: string;
}

/** Text documents read whole (hostd's text cap). */
export const TEXT_MAX = 4 << 20;
/** A file shown as a file to save: its first read tells its size, where it is, and whether the host reads ranges. */
const PEEK = 4 << 10;
const PARALLEL = 4;

/** What `ref` shows as. */
export function docKind(ref: Pick<DocRef, "kind" | "name" | "as">): PresentKind {
  if (ref.as) return ref.as;
  return ref.kind === "local" ? kindForName(ref.name) : "markdown";
}

/** Another version (`presented/…` name) of `doc`: what the agent said `doc` is carries over only to
 *  a version with the same extension (v1 a page and v2 Markdown: v2 shows as Markdown). */
export function otherVersion(doc: DocRef, name: string): DocRef {
  const same = extOf(name) === extOf(doc.name);
  return { ...doc, name, as: same ? doc.as : undefined, language: same ? doc.language : undefined };
}

/** Whether the viewer shows `doc` as a file to save rather than its content: one handed over as it is, a media file the webview can't show, a document that isn't text. */
export function shownAsFile(doc: LoadedDoc): boolean {
  if (doc.kind === "file") return true;
  if (isMediaKind(doc.kind)) return doc.unshown === "notMedia";
  return doc.text == null;
}

/** Source extensions a code file keeps when written: ones whose default app shows text. */
const SOURCE_EXT: ReadonlySet<string> = new Set("rs go c h cc cpp cxx hpp cs java kt swift zig ts tsx mts cts css scss less sql yaml yml toml ini diff patch proto graphql".split(" "));

/**
 * Extensions a file handed over as it is (`file`) opens with: what the desktop app's Open in
 * browser keeps (src-tauri `docs.rs` `OPENABLE`), pages aside (a page opens only as its copy with
 * the policy first). Any other would open as text there, or run.
 */
const OPENS_AS_IS: ReadonlySet<string> = new Set([
  ..."md markdown png apng jpg jpeg gif webp bmp ico avif pdf mp3 wav ogg oga opus m4a flac aac mp4 m4v webm mov ogv json txt log".split(" "),
  ...SOURCE_EXT,
]);

export const opensAsIs = (name: string): boolean => OPENS_AS_IS.has(extOf(name));

/** The name a file handed over is saved as: the last segment of the path the agent named, without what a file system refuses. */
function handedName(source: string | undefined): string | undefined {
  const last = source?.split(/[\\/]/).pop() ?? "";
  return last.replace(/[<>:"|?*\u0000-\u001f]+/g, "_").replace(/^[. ]+|[. ]+$/g, "") || undefined;
}

/**
 * The file name Save (`save`) and Open in browser (`open`) write a document as: its own name's stem
 * with an extension for what it is shown as, never one a default app would run or render outside
 * the sandbox. A page is `.html` (the copy with the policy first, `LoadedDoc.standalone`); a
 * drawing or diagram `.svg` / `.mmd`, or for Open `.html` (a page that shows it as an image);
 * Markdown, JSON and text `.md`, `.json`, `.txt`; an image, a PDF, audio and video their own type;
 * code its source extension when a default app shows it as text, else `.txt` appended (`x.html`
 * shown as code is `x.html.txt`); a table `.csv`/`.tsv`, for Open with `.txt` appended (a
 * spreadsheet app would evaluate its formulas). A file handed over as it is (`file`) keeps its name,
 * the one the agent gave it (`source`) when known: it opens only as a type `opensAsIs` names.
 */
export function docFileName(ref: Pick<DocRef, "name" | "title">, kind: PresentKind, purpose: "save" | "open", source?: string): string {
  const base = ref.name.slice(ref.name.lastIndexOf("/") + 1);
  if (kind === "file") return handedName(source) ?? (base || "file");
  const ext = extOf(base);
  const dot = base.lastIndexOf(".");
  const stem = base ? (dot > 0 ? base.slice(0, dot) : base) : (ref.title ?? "plan").replace(/[^\w .-]+/g, "_").trim() || "document";
  const table = ext === "tsv" ? "tsv" : "csv";
  const media = mediaByPath(base)?.kind;
  const out: Record<Exclude<PresentKind, "file">, string> = {
    html: "html",
    markdown: "md",
    json: "json",
    text: "txt",
    svg: purpose === "open" ? "html" : "svg",
    mermaid: purpose === "open" ? "html" : "mmd",
    image: isImageName(base) ? ext : "txt",
    pdf: "pdf",
    audio: media === "audio" ? ext : "bin",
    video: media === "video" ? ext : "bin",
    code: SOURCE_EXT.has(ext) ? ext : ext ? `${ext}.txt` : "txt",
    csv: purpose === "open" ? `${table}.txt` : table,
  };
  return `${stem}.${out[kind]}`;
}

function read(ref: DocRef, name: string, how: Pick<ArtifactParams, "maxBytes" | "base64" | "offset">): Promise<ArtifactContent> {
  if (ref.kind === "review") return Promise.reject(new Error("the plan under review is not a file"));
  const { hostId, agentId } = parseAgentKey(ref.agentKey);
  return core.host(hostId).call("session.artifact", { agentId, kind: ref.kind, name, ...how });
}

function decodeUtf8(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

/** The answer without its bytes. */
function withoutData({ data: _, ...content }: ArtifactContent): ArtifactContent {
  return content;
}

/** A host before 0.9.0 answered a read for bytes as text (it ignores `base64`). */
class TextOnlyHost extends Error {
  constructor(readonly content: ArtifactContent) {
    super("This host's TeleFlock reads documents as text only");
  }
}

/**
 * `ref`'s file as Review reads media (`RangeReader`): ranges as base64 from `offset` (hosts ≥
 * 0.9.4; an older one reads from the start and names no offset). `seen` gets each answer.
 */
function rangeReader(ref: DocRef, seen?: (content: ArtifactContent) => void): RangeReader {
  return async (offset, maxBytes) => {
    const c = await read(ref, ref.name, { base64: true, offset, maxBytes });
    if (c.data == null) throw new TextOnlyHost(c);
    seen?.(c);
    return { size: c.size, offset: c.offset, bytes: decodeBase64(c.data) as Uint8Array<ArrayBuffer>, truncated: c.truncated };
  };
}

/**
 * The files `refs` point at, read from `dir` (in the session's `local://` root) as base64, within
 * {@link ASSET_LIMITS}: stylesheets' own references too (two `@import` levels), four reads at a time.
 */
async function readAssets(ref: DocRef, dir: string, refs: readonly string[]): Promise<{ assets: Map<string, InlineAsset>; missing: number }> {
  const assets = new Map<string, InlineAsset>();
  let missing = 0;
  let total = 0;
  const queue: Array<{ key: string; depth: number }> = [];
  const seen = new Set<string>();
  const add = (list: readonly string[], base: string, depth: number) => {
    for (const r of list) {
      const key = assetKey(r, base);
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      queue.push({ key, depth });
    }
  };
  add(refs, "", 0);
  for (let i = 0; i < queue.length; ) {
    const batch = queue.slice(i, i + PARALLEL);
    i += batch.length;
    const results = await Promise.allSettled(batch.map((q) => read(ref, dir ? `${dir}/${q.key}` : q.key, { base64: true, maxBytes: ASSET_LIMITS.each })));
    batch.forEach((q, j) => {
      const r = results[j];
      const content = r?.status === "fulfilled" ? r.value : undefined;
      if (!content?.data || content.truncated || assets.size >= ASSET_LIMITS.count || total + content.size > ASSET_LIMITS.total) {
        missing++;
        return;
      }
      total += content.size;
      const mime = mimeFor(q.key);
      const asset: InlineAsset = { mime, base64: content.data };
      if (mime === "text/css") {
        asset.text = decodeUtf8(content.data);
        if (q.depth < ASSET_LIMITS.cssDepth) add(cssRefs(asset.text), keyDir(q.key), q.depth + 1);
      }
      assets.set(q.key, asset);
    });
  }
  return { assets, missing };
}

export interface LoadOptions {
  /** A file read in ranges: bytes so far, of its size, before each further range. */
  onProgress?: (received: number, size: number) => void;
  /** False once no view wants the document any more: a read in ranges stops at its next range. */
  alive?: () => boolean;
}

/**
 * An image, PDF, audio or video: the whole file in ranges (Review's `readMedia`: 1 MiB, then
 * 2 MiB at a time), typed by its extension, else its first bytes. A host before 0.9.4 reads it in
 * one go up to 8 MiB; one before 0.9.0 not at all.
 */
async function loadMedia(ref: DocRef, kind: MediaPresentKind, opts: LoadOptions): Promise<LoadedDoc> {
  let first: ArtifactContent | undefined;
  try {
    const out = await readMedia(
      rangeReader(ref, (c) => void (first ??= withoutData(c))),
      ref.name,
      { forced: true, ...opts },
    );
    if (opts.alive?.() === false) throw apiError("cancelled", "no view shows this document any more");
    // readMedia read at least once, and the reader saw that answer.
    const content = first as ArtifactContent;
    if (out.state === "ready") return { kind, content, media: new Blob(out.parts, { type: out.type.mime }), missing: 0 };
    return { kind, content, unshown: out.state === "tooLarge" && out.rangeless ? "rangeless" : "notMedia", missing: 0 };
  } catch (e) {
    if (e instanceof TextOnlyHost) return { kind, content: withoutData(e.content), unshown: "textOnly", missing: 0 };
    throw e;
  }
}

/** Reads a document and, for pages, drawings and Markdown, the files it references; media whole, in ranges. */
export async function loadDoc(ref: DocRef, opts: LoadOptions = {}): Promise<LoadedDoc> {
  const kind = docKind(ref);
  if (isMediaKind(kind)) return loadMedia(ref, kind, opts);
  if (kind === "file") {
    // Its bytes are read when Save or Open asks (`readFile`).
    const content = await read(ref, ref.name, { base64: true, offset: 0, maxBytes: PEEK });
    return { kind, content: withoutData(content), rangeless: content.offset === undefined, missing: 0 };
  }
  const language = kind === "code" ? (ref.language ?? languageFor(ref.name) ?? extOf(ref.name)) : undefined;
  const content = await read(ref, ref.name, { maxBytes: TEXT_MAX });
  const text = content.text ?? undefined;
  if (text == null || (kind !== "html" && kind !== "markdown" && kind !== "svg")) return { kind, content, text, missing: 0, language };
  // Only the session's `local://` files have a folder of referenced files to inline.
  const dir = ref.kind === "local" ? (presentedAssetsDir(ref.name) ?? keyDir(ref.name)) : undefined;
  const refs = dir === undefined ? [] : kind === "markdown" ? markdownRefs(text) : markupRefs(text);
  const { assets, missing } = dir !== undefined && refs.length ? await readAssets(ref, dir, refs) : { assets: new Map<string, InlineAsset>(), missing: 0 };
  if (kind === "html") return { kind, content, text, page: artifactDocument(text, assets), standalone: standaloneDocument(text, assets), missing };
  if (kind === "svg") {
    const prepared = prepareSvg(inlineAssets(text, assets));
    return { kind, content, text, imageUrl: prepared ? svgDataUrl(prepared.svg) : undefined, missing };
  }
  const images = new Map<string, string>();
  for (const [key, a] of assets) if (a.mime.startsWith("image/")) images.set(key, `data:${a.mime};base64,${a.base64}`);
  return { kind, content, text, images, missing };
}

/**
 * Every byte of `ref`'s file, for Save and Open of one the viewer shows as a file: in ranges as
 * media are read (`onProgress` before each further range), on a host before 0.9.4 in one read of
 * at most 8 MiB, on one before 0.9.0 not at all; 256 MiB at most (the webview holds all of it).
 */
export async function readFile(ref: DocRef, onProgress?: (received: number, size: number) => void): Promise<Blob> {
  const reader = rangeReader(ref);
  try {
    const first = await reader(0, FIRST_READ);
    if (first.size > LOAD_MAX) throw apiError("too_large", `It is ${formatBytes(first.size)}; TeleFlock saves files up to ${formatBytes(LOAD_MAX)}.`, { hint: "Copy its path on the host instead" });
    if (first.offset === undefined && first.size > RANGELESS_MAX) {
      throw apiError("unsupported", `This host's TeleFlock reads files up to ${formatBytes(RANGELESS_MAX)}; this one is ${formatBytes(first.size)}.`, { hint: "Update TeleFlock on the host" });
    }
    return new Blob(await readRest(reader, first, { onProgress }), { type: mimeFor(ref.name) });
  } catch (e) {
    if (e instanceof TextOnlyHost) throw apiError("unsupported", "This host's TeleFlock reads documents as text only.", { hint: "Update TeleFlock on the host" });
    throw e;
  }
}

// ── cache ──

interface Cached {
  promise: Promise<LoadedDoc>;
  /** Views showing it now. */
  users: number;
  settled: boolean;
  /** Bytes of a loaded file it holds (media). */
  bytes: number;
  /** No view wanted it before it finished: its read stops, and it leaves the cache. */
  dropped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Loaded documents kept (a page with its files inlined can be several MB) … */
const MAX_CACHED = 6;
/** … and the bytes of loaded media among them (a video can be 64 MiB); the ones on screen always stay. */
const MAX_CACHED_BYTES = 128 << 20;
/** A document no view shows stops loading after this (a remount, a switch to full screen and back, keeps it going). */
const DROP_AFTER_MS = 2000;
const cache = new Map<string, Cached>();

export interface ReadProgress {
  received: number;
  size: number;
}

/** Media read in ranges: bytes so far of their size, by cache id. */
const useReads = create<{ reads: Record<string, ReadProgress> }>()(() => ({ reads: {} }));

function setProgress(id: string, p: ReadProgress | undefined): void {
  useReads.setState((s) => {
    const reads = { ...s.reads };
    if (p) reads[id] = p;
    else delete reads[id];
    return { reads };
  });
}

/** Presented snapshots never change; other files are read again when their modification time moves. */
function cacheKey(ref: DocRef, mtime: number | undefined): string {
  const stable = ref.kind === "local" && presentedName(ref.name) !== undefined;
  return `${ref.agentKey}|${ref.kind}|${ref.name}|${ref.as ?? ""}|${stable ? "" : (mtime ?? "")}`;
}

/** Keeps the cache within its limits, least recently used out first, never a document on screen. */
function trim(): void {
  let bytes = 0;
  for (const c of cache.values()) bytes += c.bytes;
  for (const [id, c] of cache) {
    if (cache.size <= MAX_CACHED && bytes <= MAX_CACHED_BYTES) break;
    if (c.users > 0) continue;
    cache.delete(id);
    bytes -= c.bytes;
    c.dropped = !c.settled;
  }
}

/** The document `ref` names, loading or loaded, for one view: `release` when the view goes. */
function acquire(ref: DocRef, mtime: number | undefined): { promise: Promise<LoadedDoc>; release: () => void } {
  const id = cacheKey(ref, mtime);
  let entry = cache.get(id);
  if (entry) {
    // Most recently used last.
    cache.delete(id);
    cache.set(id, entry);
  } else {
    const c: Cached = { promise: Promise.resolve(undefined as never), users: 0, settled: false, bytes: 0, dropped: false };
    c.promise = loadDoc(ref, { alive: () => !c.dropped, onProgress: (received, size) => setProgress(id, { received, size }) }).then(
      (doc) => {
        setProgress(id, undefined);
        c.settled = true;
        c.bytes = doc.media?.size ?? 0;
        trim();
        return doc;
      },
      (e: unknown) => {
        setProgress(id, undefined);
        if (cache.get(id) === c) cache.delete(id);
        throw e;
      },
    );
    // Every view handles a failure; a dropped read fails with nobody left to.
    c.promise.catch(() => undefined);
    cache.set(id, c);
    entry = c;
  }
  const c = entry;
  c.users++;
  clearTimeout(c.timer);
  trim();
  let released = false;
  return {
    promise: c.promise,
    release: () => {
      if (released) return;
      released = true;
      c.users--;
      if (c.users > 0 || c.settled) return;
      c.timer = setTimeout(() => {
        if (c.users > 0 || c.settled) return;
        c.dropped = true;
        if (cache.get(id) === c) cache.delete(id);
      }, DROP_AFTER_MS);
    },
  };
}

export interface DocState {
  doc?: LoadedDoc;
  error?: { code: string; message: string };
}

/**
 * The document `ref` names, loaded (from the cache when it is there); `progress` while media are
 * read in ranges. `mtime`: the listing's modification time of a file that can change, so an edited
 * plan is read again.
 */
export function useLoadedDoc(ref: DocRef | null, mtime?: number): DocState & { loading: boolean; progress?: ReadProgress } {
  const id = ref ? cacheKey(ref, mtime) : "";
  const [state, setState] = useState<{ id: string } & DocState>({ id: "" });
  const progress = useReads((s) => s.reads[id]);
  useEffect(() => {
    if (!ref || ref.kind === "review") return;
    let live = true;
    const lease = acquire(ref, mtime);
    lease.promise.then(
      (doc) => live && setState({ id, doc }),
      (e: unknown) => {
        const err = toApiError(e);
        if (live) setState({ id, error: { code: err.code, message: err.message } });
      },
    );
    return () => {
      live = false;
      lease.release();
    };
    // `id` covers everything in `ref` (and `mtime`) that changes what is read.
  }, [id]);
  const current: DocState = state.id === id ? state : {};
  return { ...current, loading: !!ref && ref.kind !== "review" && !current.doc && !current.error, progress };
}
