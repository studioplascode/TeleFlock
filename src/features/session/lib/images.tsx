import { ImageIcon } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { CoreError, core } from "@/core";
import type { ImageParams, ImageRef } from "@/core/gen";
import { cn, Shimmer } from "@/design";
import { SessionCtx } from "../context";

/** What a transcript image can be shown from. */
export type ImageSource =
  | { state: "ready"; src: string }
  /** Fetching the full image from the host, or waiting for the journal to supply a payload collab cut. */
  | { state: "loading" }
  | { state: "unavailable" };

/** Fetched images as data URLs by `${hostId}:${blob or original}`, most recently used last, bounded by size. */
const CACHE_CHARS = 96 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheChars = 0;
const inflight = new Map<string, Promise<string>>();

function cached(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function remember(key: string, src: string): void {
  cache.set(key, src);
  cacheChars += src.length;
  while (cacheChars > CACHE_CHARS && cache.size > 1) {
    const [k, v] = cache.entries().next().value as [string, string];
    cache.delete(k);
    cacheChars -= v.length;
  }
}

function fetchImage(hostId: string, key: string, params: ImageParams, mime: string): Promise<string> {
  let p = inflight.get(key);
  if (!p) {
    p = core
      .host(hostId)
      .call("session.image", params)
      .then((r) => {
        const src = `data:${r.mime ?? mime};base64,${r.data}`;
        remember(key, src);
        return src;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/**
 * Display sources for a row's images, in order. Inline payloads show at once; omp blobs (history
 * read from the journal, and payloads too big for a collab frame once the journal has them) are the
 * full original, fetched from the row's host and cached.
 */
export function useImageSources(images: readonly ImageRef[]): ImageSource[] {
  const hostId = useContext(SessionCtx)?.hostId;
  // Blobs this row fetched (or found cached) and the ones the host could not supply, by hash.
  const [fetched, setFetched] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!hostId) return;
    let alive = true;
    for (const img of images) {
      const blob = img.blob;
      if (img.data || img.url || !blob) continue;
      const key = `${hostId}:${blob}`;
      const hit = cached(key);
      const done = (src: string) => alive && setFetched((m) => (m.get(blob) === src ? m : new Map(m).set(blob, src)));
      if (hit !== undefined) done(hit);
      else fetchImage(hostId, key, { blob }, img.mime).then(done, () => alive && setFailed((s) => new Set(s).add(blob)));
    }
    return () => {
      alive = false;
    };
  }, [hostId, images]);

  // Inline payloads can be megabytes: their data URLs are built once per row version.
  const inline = useMemo(() => images.map((img) => (img.data ? `data:${img.mime};base64,${img.data}` : img.url)), [images]);
  return images.map((img, i): ImageSource => {
    const src = inline[i];
    if (src) return { state: "ready", src };
    if (!img.blob) return { state: "loading" };
    // A remounted row (virtualised list) shows a cached blob at once, before its effect runs.
    const hit = fetched.get(img.blob) ?? (hostId ? cache.get(`${hostId}:${img.blob}`) : undefined);
    if (hit) return { state: "ready", src: hit };
    return !hostId || failed.has(img.blob) ? { state: "unavailable" } : { state: "loading" };
  });
}

/** Originals the host no longer has (pruned from its store, file deleted), by cache key: not asked for again. */
const missingOriginals = new Set<string>();

/**
 * The full-resolution original behind a downscaled image (`ImageRef.original`: omp keeps only a
 * small copy of images it queues, and of TUI pastes), for the viewer: fetched from the host only
 * when asked for (pass the image the lightbox shows, `undefined` while closed) and cached like
 * blobs. Undefined while loading, when there is none, or when the host can't supply it (no toast,
 * no retry): the viewer keeps showing the copy it has.
 */
export function useOriginal(img: ImageRef | undefined): string | undefined {
  const session = useContext(SessionCtx);
  const hostId = session?.hostId;
  const agentId = session?.agentId;
  const original = img?.original;
  const mime = img?.mime ?? "image/png";
  const key = hostId && original ? `${hostId}:${original}` : undefined;
  const [loaded, setLoaded] = useState<{ key: string; src: string }>();

  useEffect(() => {
    if (!hostId || !original || !key || missingOriginals.has(key) || cached(key) !== undefined) return;
    let alive = true;
    fetchImage(hostId, key, { original, agentId }, mime).then(
      (src) => alive && setLoaded({ key, src }),
      (e: unknown) => e instanceof CoreError && !e.retryable && missingOriginals.add(key),
    );
    return () => {
      alive = false;
    };
  }, [hostId, agentId, original, key, mime]);

  if (!key) return undefined;
  return loaded?.key === key ? loaded.src : cache.get(key);
}

/** Stand-in tile for an image that is loading or can't be shown. */
export function ImagePlaceholder({ state, className }: { state: "loading" | "unavailable"; className?: string }) {
  return (
    <div className={cn("flex h-28 w-44 items-center justify-center gap-2 rounded-md bg-bg-deep text-xs text-mute-2 shadow-hairline", className)}>
      <ImageIcon className="size-4 shrink-0" aria-hidden />
      {state === "loading" ? <Shimmer>Loading image…</Shimmer> : "Image not available"}
    </div>
  );
}
