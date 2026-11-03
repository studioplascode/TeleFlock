import { FileWarning, RefreshCw } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { formatBytes } from "@/core/upload";
import { Button, cn, Lightbox, LightboxTrigger, Spinner } from "@/design";
import { baseRev, formatDuration, mediaByPath, mediaSides, RANGELESS_MAX, type Side, upscale } from "./media";
import { type MediaEntry, type MediaLoader, type MediaSource, mediaKey } from "./mediaLoad";
import type { DiffFile } from "./parse";

// pdf.js and its worker load with the first PDF preview.
const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));

/** What Review's binary-file previews need (see `MediaRow`). */
export interface MediaView {
  loader: MediaLoader;
  /** The repository's top level on the host (`GitStatusResult.root`); nothing is read before it is known. */
  root: string | undefined;
  /** The diff's base (`GitDiffResult.base`): old versions are read from it. */
  base?: string;
  /** Counts the diff's reloads: a working-tree file the patch names no blob id for is read again after one. */
  epoch: number;
}

/** The transparency checkerboard (as the document viewer's). */
const CHECKER = "bg-[repeating-conic-gradient(color-mix(in_srgb,var(--color-ink)_6%,transparent)_0_25%,transparent_0_50%)] bg-[length:20px_20px]";
/** Tall media stay within the view. */
const MEDIA_MAX_H = "max-h-[min(60vh,560px)]";

function sourceOf(file: DiffFile, side: Side, media: MediaView): MediaSource {
  const root = media.root ?? "";
  if (side === "old") {
    const rev = baseRev(media.base ?? "HEAD");
    return { side, root, path: file.oldPath ?? file.path, rev, stamp: rev };
  }
  const oid = file.oids?.new;
  // A blob id names the bytes; without one (untracked files) any reload may have changed them.
  return { side, root, path: file.path, stamp: oid && /[1-9a-f]/.test(oid) ? oid : `epoch ${media.epoch}` };
}

/**
 * A binary file's row: images, video, audio and PDFs shown (both versions of a modified file side by
 * side, stacked on phones), anything else as a "Binary file" line with its size. Bytes are read
 * while the row is `near` the view.
 */
export function MediaRow({ file, media, compact, near }: { file: DiffFile; media: MediaView; compact: boolean; near: boolean }) {
  const readsOld = useSyncExternalStore(media.loader.subscribe, media.loader.readsOld);
  const all = mediaSides(file.status);
  // A host that can't read the base shows the working tree's version only.
  const sides = readsOld ? all : all.filter((s) => s === "new");
  const two = sides.length === 2;
  return (
    <div className={cn("sticky left-0 flex flex-col gap-2 pt-1 pb-3 font-sans", compact ? "px-2" : "px-3")} style={{ width: "var(--vw)" }}>
      {sides.length < all.length && (
        <Note>{sides.length === 0 ? "Deleted. " : ""}This host's TeleFlock can't read the base version: update TeleFlock on the host to see it.</Note>
      )}
      {sides.length > 0 && (
        <div className={cn("grid gap-3", two && !compact && "grid-cols-2")}>
          {sides.map((side) => (
            <SidePanel key={side} src={sourceOf(file, side, media)} loader={media.loader} near={near} label={two || side === "old" ? side : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

const LABEL: Record<Side, { text: string; tint: string }> = {
  old: { text: "Before", tint: "text-del" },
  new: { text: "After", tint: "text-add" },
};

function SidePanel({ src, loader, near, label }: { src: MediaSource; loader: MediaLoader; near: boolean; label?: Side }) {
  const key = mediaKey(src);
  const entry = useSyncExternalStore(loader.subscribe, () => loader.get(key));
  useEffect(() => loader.retain(key), [loader, key]);
  // `want` reads only what it doesn't have for this stamp.
  useEffect(() => {
    if (near && src.root) loader.want(src);
  }, [near, loader, src]);
  const name = src.path.slice(src.path.lastIndexOf("/") + 1);
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label={label ? `${LABEL[label].text}: ${name}` : name}>
      {label && <span className={cn("kicker px-0.5 text-[10px]", LABEL[label].tint)}>{LABEL[label].text}</span>}
      <SideBody entry={entry} name={name} named={mediaByPath(src.path) !== undefined} retry={(forced) => loader.want(src, forced)} />
    </section>
  );
}

function SideBody({ entry, name, named, retry }: { entry: MediaEntry | undefined; name: string; named: boolean; retry: (forced: boolean) => void }) {
  if (!entry || entry.state === "loading") {
    const progress = entry?.state === "loading" && entry.size ? entry : undefined;
    if (!named) return <Note icon={<Spinner size={14} label="Reading" />}>Binary file</Note>;
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md bg-well/60 text-2xs text-mute" aria-busy>
        <Spinner size={18} label="Reading" />
        {progress?.size !== undefined && (
          <>
            <span className="tabular">
              {formatBytes(progress.received)} of {formatBytes(progress.size)}
            </span>
            <span className="h-1 w-40 overflow-hidden rounded-full bg-ink/10">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round((progress.received / progress.size) * 100)}%` }} />
            </span>
          </>
        )}
      </div>
    );
  }
  switch (entry.state) {
    case "binary":
      return <Note>{entry.size === 0 ? "Empty file" : `Binary file · ${formatBytes(entry.size)}`}</Note>;
    case "tooLarge":
      return (
        <Note>
          <span>Too large to preview ({formatBytes(entry.size)})</span>
          {entry.verdict === "ask" ? (
            <Button size="sm" variant="secondary" onClick={() => retry(true)}>
              Load anyway
            </Button>
          ) : (
            entry.rangeless && <span>This host's TeleFlock reads files up to {formatBytes(RANGELESS_MAX)}: update TeleFlock on the host.</span>
          )}
        </Note>
      );
    case "unsupported":
      return <Note>This host's TeleFlock can't read the base version: update TeleFlock on the host to see it.</Note>;
    case "error":
      return (
        <Note>
          <span className="min-w-0 break-words">Couldn't read the file: {entry.message}</span>
          <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => retry(true)}>
            Retry
          </Button>
        </Note>
      );
    case "ready": {
      const caption = formatBytes(entry.size);
      if (entry.type.kind === "image") return <ImagePane url={entry.url} name={name} caption={caption} />;
      if (entry.type.kind === "video") return <VideoPane url={entry.url} caption={caption} />;
      if (entry.type.kind === "audio") return <AudioPane url={entry.url} caption={caption} />;
      return (
        <Suspense fallback={<div className="h-[min(70vh,760px)] animate-pulse rounded-md bg-well max-md:h-[62vh]" />}>
          <PdfView key={entry.url} blob={entry.blob} caption={caption} label={name} />
        </Suspense>
      );
    }
  }
}

/** One line of text in the row: a binary file, a size, why there is nothing to show. */
function Note({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md bg-well/60 px-3 py-2 text-xs text-mute">
      {icon ?? <FileWarning className="size-4 shrink-0 text-mute-2" aria-hidden />}
      {children}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <figcaption className="px-0.5 text-2xs text-mute tabular">{children}</figcaption>;
}

/** On the checkerboard, fit to the width, small images enlarged crisply; a click opens it full size. */
function ImagePane({ url, name, caption }: { url: string; name: string; caption: string }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const zoom = size ? upscale(size.w, size.h) : 1;
  if (failed) return <Note>Can't show this image here · {caption}</Note>;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <div className={cn("grid min-h-24 place-items-center overflow-hidden rounded-md p-3 shadow-[inset_0_0_0_1px_var(--color-line)]", CHECKER)}>
        <LightboxTrigger label={`Open ${name} full size`} onClick={() => setOpen(0)} className="max-w-full">
          <img
            src={url}
            alt={name}
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            className={cn("block h-auto max-w-full object-contain", MEDIA_MAX_H, zoom > 1 && "[image-rendering:pixelated]")}
            style={size && zoom > 1 ? { width: size.w * zoom } : undefined}
          />
        </LightboxTrigger>
      </div>
      <Caption>
        {size && size.w > 0 ? `${size.w} × ${size.h} px${zoom > 1 ? ` · shown ${zoom}×` : ""} · ` : ""}
        {caption}
      </Caption>
      <Lightbox images={[{ src: url, alt: name, width: size?.w || undefined, height: size?.h || undefined }]} index={open} onIndexChange={setOpen} />
    </figure>
  );
}

/** Native controls, never autoplaying. */
function VideoPane({ url, caption }: { url: string; caption: string }) {
  const [meta, setMeta] = useState<{ w: number; h: number; d: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <Note>This video doesn't play here: its format isn't supported on this device · {caption}</Note>;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setMeta({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, d: e.currentTarget.duration })}
        onError={() => setFailed(true)}
        className={cn("block w-auto max-w-full self-start rounded-md bg-black", MEDIA_MAX_H)}
      />
      <Caption>
        {meta ? [meta.w > 0 ? `${meta.w} × ${meta.h}` : "", formatDuration(meta.d)].filter(Boolean).join(" · ") + " · " : ""}
        {caption}
      </Caption>
    </figure>
  );
}

function AudioPane({ url, caption }: { url: string; caption: string }) {
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <Note>This audio doesn't play here: its format isn't supported on this device · {caption}</Note>;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <audio src={url} controls preload="metadata" onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onError={() => setFailed(true)} className="w-full max-w-[520px]" />
      <Caption>
        {duration !== null && formatDuration(duration) ? `${formatDuration(duration)} · ` : ""}
        {caption}
      </Caption>
    </figure>
  );
}
