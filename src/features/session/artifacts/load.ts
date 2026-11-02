import { useEffect, useState } from "react";
import { core, parseAgentKey, toApiError } from "@/core";
import type { ArtifactContent, ArtifactKind, PresentKind } from "@/core/gen";
import { languageFor } from "../lib/highlight";
import { prepareSvg, svgDataUrl } from "../markdown/svg";
import { extOf, isImageName, kindForName, mimeFor, presentedAssetsDir, presentedName } from "./kinds";
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

export interface LoadedDoc {
  kind: PresentKind;
  content: ArtifactContent;
  /** The document's text (all but images). */
  text?: string;
  /** `html`: the page the sandbox shows (references inlined, resource hints dropped, policy and prelude first). */
  page?: string;
  /** `html`: the self-contained copy for Save and Open in browser (the policy and guard first). */
  standalone?: string;
  /** `image`, `svg`: what an `<img>` shows. */
  imageUrl?: string;
  /** `markdown`: `data:` URLs of its images, by reference key. */
  images?: ReadonlyMap<string, string>;
  /** Referenced files that could not be inlined (not copied, too large, a host before 0.9.0). */
  missing: number;
  language?: string;
}

/** Text documents read whole (hostd's text cap). */
export const TEXT_MAX = 4 << 20;
/** Images read whole (hostd's base64 cap). */
export const IMAGE_MAX = 8 << 20;
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

/** Source extensions a code file keeps when written: ones whose default app shows text. */
const SOURCE_EXT: Record<string, true> = Object.fromEntries(
  "rs go c h cc cpp cxx hpp cs java kt swift zig ts tsx mts cts css scss less sql yaml yml toml ini diff patch proto graphql".split(" ").map((e) => [e, true]),
);

/**
 * The file name Save (`save`) and Open in browser (`open`) write a document as: its own name's stem
 * with an extension for what it is shown as, never one a default app would run or render outside
 * the sandbox. A page is `.html` (the copy with the policy first, `LoadedDoc.standalone`); a
 * drawing `.svg`, or for Open `.html` (a page that shows it as an image); Markdown, JSON and text
 * `.md`, `.json`, `.txt`; an image its own type; code its source extension when a default app shows
 * it as text, else `.txt` appended (`x.html` shown as code is `x.html.txt`); a table `.csv`/`.tsv`,
 * for Open with `.txt` appended (a spreadsheet app would evaluate its formulas).
 */
export function docFileName(ref: Pick<DocRef, "name" | "title">, kind: PresentKind, purpose: "save" | "open"): string {
  const base = ref.name.slice(ref.name.lastIndexOf("/") + 1);
  const ext = extOf(base);
  const dot = base.lastIndexOf(".");
  const stem = base ? (dot > 0 ? base.slice(0, dot) : base) : (ref.title ?? "plan").replace(/[^\w .-]+/g, "_").trim() || "document";
  const table = ext === "tsv" ? "tsv" : "csv";
  const out: Record<PresentKind, string> = {
    html: "html",
    markdown: "md",
    json: "json",
    text: "txt",
    svg: purpose === "open" ? "html" : "svg",
    image: isImageName(base) ? ext : "txt",
    code: SOURCE_EXT[ext] ? ext : ext ? `${ext}.txt` : "txt",
    csv: purpose === "open" ? `${table}.txt` : table,
  };
  return `${stem}.${out[kind]}`;
}

function read(ref: DocRef, name: string, base64: boolean, maxBytes: number): Promise<ArtifactContent> {
  if (ref.kind === "review") return Promise.reject(new Error("the plan under review is not a file"));
  const { hostId, agentId } = parseAgentKey(ref.agentKey);
  return core.host(hostId).call("session.artifact", { agentId, kind: ref.kind, name, maxBytes, ...(base64 ? { base64: true } : {}) });
}

function decodeUtf8(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
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
    const results = await Promise.allSettled(batch.map((q) => read(ref, dir ? `${dir}/${q.key}` : q.key, true, ASSET_LIMITS.each)));
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

/** Reads a document and, for pages, drawings and Markdown, the files it references. */
export async function loadDoc(ref: DocRef): Promise<LoadedDoc> {
  const kind = docKind(ref);
  const language = kind === "code" ? (ref.language ?? languageFor(ref.name) ?? extOf(ref.name)) : undefined;
  if (kind === "image") {
    const content = await read(ref, ref.name, true, IMAGE_MAX);
    return { kind, content, imageUrl: content.data ? `data:${mimeFor(ref.name)};base64,${content.data}` : undefined, missing: 0 };
  }
  const content = await read(ref, ref.name, false, TEXT_MAX);
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

// ── cache ──

/** Loaded documents kept (a page with its files inlined can be several MB). */
const MAX_CACHED = 6;
const cache = new Map<string, Promise<LoadedDoc>>();

/** Presented snapshots never change; other files are read again when their modification time moves. */
function cacheKey(ref: DocRef, mtime: number | undefined): string {
  const stable = ref.kind === "local" && presentedName(ref.name) !== undefined;
  return `${ref.agentKey}|${ref.kind}|${ref.name}|${ref.as ?? ""}|${stable ? "" : (mtime ?? "")}`;
}

function cachedLoad(ref: DocRef, mtime: number | undefined): Promise<LoadedDoc> {
  const id = cacheKey(ref, mtime);
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const p = loadDoc(ref);
  cache.set(id, p);
  p.catch(() => cache.get(id) === p && cache.delete(id));
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return p;
}

export interface DocState {
  doc?: LoadedDoc;
  error?: { code: string; message: string };
}

/**
 * The document `ref` names, loaded (from the cache when it is there). `mtime`: the listing's
 * modification time of a file that can change, so an edited plan is read again.
 */
export function useLoadedDoc(ref: DocRef | null, mtime?: number): DocState & { loading: boolean } {
  const id = ref ? cacheKey(ref, mtime) : "";
  const [state, setState] = useState<{ id: string } & DocState>({ id: "" });
  useEffect(() => {
    if (!ref || ref.kind === "review") return;
    let live = true;
    cachedLoad(ref, mtime).then(
      (doc) => live && setState({ id, doc }),
      (e: unknown) => {
        const err = toApiError(e);
        if (live) setState({ id, error: { code: err.code, message: err.message } });
      },
    );
    return () => {
      live = false;
    };
    // `id` covers everything in `ref` (and `mtime`) that changes what is read.
  }, [id]);
  const current: DocState = state.id === id ? state : {};
  return { ...current, loading: !!ref && ref.kind !== "review" && !current.doc && !current.error };
}
