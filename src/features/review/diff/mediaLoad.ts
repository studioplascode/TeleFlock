/**
 * The bytes behind Review's previews of binary files: the working tree's through `fs.read`, the
 * base's through `git.show`, read in ranges (`readMedia`) a few files at a time and kept as object
 * URLs while Review is open. One loader per Review; `close()` revokes every URL.
 */
import { type HostClient, toApiError } from "@/core";
import { decodeBase64 } from "@/features/terminal/frames";
import { type MediaType, type RangeReader, type ReadOutcome, readMedia, type Side, sameBytes } from "./media";

/** Where one version of a file comes from. */
export interface MediaSource {
  side: Side;
  /** The repository's top level on the host. */
  root: string;
  /** Repository-relative path of this version (a renamed file's base version has its old path). */
  path: string;
  /** Old side: the revision it is read from. */
  rev?: string;
  /**
   * What the bytes are: a blob id from the patch, else a value that changes whenever they may have
   * (the diff was read again). A version already shown under another stamp is read again.
   */
  stamp: string;
}

export type MediaEntry =
  | { state: "loading"; received: number; size?: number }
  | { state: "ready"; url: string; blob: Blob; size: number; type: MediaType }
  /** Not something the webview shows; `size` 0 is an empty file. */
  | { state: "binary"; size: number }
  | { state: "tooLarge"; size: number; verdict: "ask" | "never"; rangeless: boolean }
  /** The host can't read a revision's version of a file (tf-hostd before 0.9.1). */
  | { state: "unsupported" }
  | { state: "error"; message: string };

interface Slot {
  view: MediaEntry;
  /** The stamp `view` was read for. */
  stamp: string;
  /** The read under way, if any; a newer read (another stamp, Load anyway) replaces it. */
  pending?: { stamp: string; forced: boolean; gen: number };
  gen: number;
  usedAt: number;
}

/** Files read at the same time. */
const PARALLEL = 3;
/** Bytes kept for previews not on screen; the least recently used go first. */
const KEEP_BYTES = 192 << 20;

export function mediaKey(src: Pick<MediaSource, "side" | "root" | "path" | "rev">): string {
  return [src.side, src.root, src.rev ?? "", src.path].join("\u0000");
}

export class MediaLoader {
  private readonly slots = new Map<string, Slot>();
  private readonly users = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private queue: (() => Promise<void>)[] = [];
  private readonly inflight = new Set<Promise<void>>();
  /** `git.show` answered `unknown_method`: this host reads no revision's files. */
  private noShow = false;
  private open = true;

  constructor(private readonly host: HostClient) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get = (key: string): MediaEntry | undefined => this.slots.get(key)?.view;

  /** False once the host answered that it reads no revision's files (tf-hostd before 0.9.1). */
  readsOld = (): boolean => !this.noShow;

  /**
   * Reads `src` unless what the loader has (or is reading) is for its stamp. `forced`: past the
   * preview cap ("Load anyway"), and again after a failed read.
   */
  want(src: MediaSource, forced = false): void {
    if (!this.open) return;
    const key = mediaKey(src);
    const slot = this.slots.get(key);
    if (slot) slot.usedAt = Date.now();
    if (src.side === "old" && this.noShow) {
      if (slot?.view.state !== "unsupported") this.set(key, { state: "unsupported" }, src.stamp);
      return;
    }
    if (slot?.pending) {
      if (slot.pending.stamp === src.stamp && (slot.pending.forced || !forced)) return;
    } else if (slot && slot.stamp === src.stamp) {
      const again = forced && (slot.view.state === "error" || (slot.view.state === "tooLarge" && slot.view.verdict === "ask"));
      if (!again) return;
    }
    this.start(key, src, forced);
  }

  /** A preview of `key` is on screen: its bytes are not evicted until the returned release. */
  retain(key: string): () => void {
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    return () => {
      const n = (this.users.get(key) ?? 1) - 1;
      if (n > 0) this.users.set(key, n);
      else this.users.delete(key);
      const slot = this.slots.get(key);
      if (slot) slot.usedAt = Date.now();
      this.evict();
    };
  }

  /** Review is open (again, after `close`). */
  reopen(): void {
    this.open = true;
  }

  /** Review closed: reads under way are dropped, every URL revoked. */
  close(): void {
    this.open = false;
    for (const slot of this.slots.values()) if (slot.view.state === "ready") URL.revokeObjectURL(slot.view.url);
    this.slots.clear();
    this.queue = [];
    this.noShow = false;
    this.emit();
  }

  private start(key: string, src: MediaSource, forced: boolean): void {
    const slot: Slot = this.slots.get(key) ?? { view: { state: "loading", received: 0 }, stamp: src.stamp, gen: 0, usedAt: Date.now() };
    const gen = ++slot.gen;
    slot.pending = { stamp: src.stamp, forced, gen };
    // A read for a new stamp keeps the shown bytes on screen until the new ones arrive.
    if (slot.view.state !== "ready") slot.view = { state: "loading", received: 0 };
    this.slots.set(key, slot);
    this.emit();
    const alive = () => this.open && this.slots.get(key) === slot && slot.gen === gen;
    this.enqueue(async () => {
      // Scrolled away while it waited: read once it is wanted again (bytes on screen stay).
      if (!alive()) return;
      if (!this.users.has(key)) {
        if (slot.view.state === "ready") slot.pending = undefined;
        else this.drop(key);
        return;
      }
      try {
        const out = await readMedia(this.reader(src), src.path, {
          forced,
          alive,
          onProgress: (received, size) => {
            if (alive() && slot.view.state === "loading") this.update(slot, { state: "loading", received, size });
          },
        });
        if (alive()) await this.settle(key, slot, src.stamp, out, alive);
      } catch (e) {
        if (!alive()) return;
        const err = toApiError(e);
        if (src.side === "old" && err.code === "unknown_method") {
          this.noShow = true;
          for (const [k, s] of this.slots) if (k.startsWith("old\u0000")) this.set(k, { state: "unsupported" }, s.stamp);
          return;
        }
        slot.pending = undefined;
        slot.stamp = src.stamp;
        // A failed read of a new stamp leaves the bytes it had on screen.
        if (slot.view.state !== "ready") this.update(slot, { state: "error", message: err.message });
        else this.emit();
      }
    });
  }

  private async settle(key: string, slot: Slot, stamp: string, out: ReadOutcome, alive: () => boolean): Promise<void> {
    const prev = slot.view;
    if (out.state === "ready" && prev.state === "ready" && prev.size === out.size) {
      // Read again (the diff reloaded) and unchanged: keep the URL, so a playing video goes on.
      const same = sameBytes(new Uint8Array(await prev.blob.arrayBuffer()), out.parts);
      if (!alive()) return;
      if (same) {
        slot.pending = undefined;
        slot.stamp = stamp;
        this.emit();
        return;
      }
    }
    slot.pending = undefined;
    slot.stamp = stamp;
    if (out.state !== "ready") {
      this.update(slot, out);
      return;
    }
    const blob = new Blob(out.parts, { type: out.type.mime });
    this.update(slot, { state: "ready", url: URL.createObjectURL(blob), blob, size: out.size, type: out.type });
    this.evict(key);
  }

  private reader(src: MediaSource): RangeReader {
    const host = this.host;
    if (src.side === "new") {
      const path = `${src.root.replace(/[\\/]$/, "")}/${src.path}`;
      return async (offset, maxBytes) => {
        const r = await host.call("fs.read", { path, maxBytes, offset });
        // An older host may answer a small text-like file as text (it reads it whole).
        const bytes = r.base64 !== undefined ? (decodeBase64(r.base64) as Uint8Array<ArrayBuffer>) : new TextEncoder().encode(r.text ?? "");
        return { size: r.size, offset: r.offset, bytes, truncated: r.truncated };
      };
    }
    const rev = src.rev ?? "HEAD";
    return async (offset, maxBytes) => {
      const r = await host.call("git.show", { cwd: src.root, rev, path: src.path, offset, maxBytes });
      return { size: r.size, offset: r.offset, bytes: decodeBase64(r.base64) as Uint8Array<ArrayBuffer>, truncated: r.truncated };
    };
  }

  private set(key: string, view: MediaEntry, stamp: string): void {
    const slot = this.slots.get(key);
    if (slot) {
      slot.pending = undefined;
      slot.stamp = stamp;
      slot.gen++;
      this.update(slot, view);
    } else {
      this.slots.set(key, { view, stamp, gen: 0, usedAt: Date.now() });
      this.emit();
    }
  }

  private update(slot: Slot, view: MediaEntry): void {
    const prev = slot.view;
    if (prev.state === "ready" && (view.state !== "ready" || view.url !== prev.url)) URL.revokeObjectURL(prev.url);
    slot.view = view;
    this.emit();
  }

  private drop(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.view.state === "ready") URL.revokeObjectURL(slot.view.url);
    this.slots.delete(key);
    this.emit();
  }

  /** Keeps the bytes of previews off screen under `KEEP_BYTES`, least recently used out first. */
  private evict(keep?: string): void {
    const ready = [...this.slots].filter(([, s]) => s.view.state === "ready");
    let total = ready.reduce((n, [, s]) => n + (s.view.state === "ready" ? s.view.size : 0), 0);
    if (total <= KEEP_BYTES) return;
    for (const [key, slot] of ready.sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (total <= KEEP_BYTES) break;
      if (key === keep || this.users.has(key) || slot.pending || slot.view.state !== "ready") continue;
      total -= slot.view.size;
      this.drop(key);
    }
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.inflight.size < PARALLEL && this.queue.length > 0) {
      const job = this.queue.shift() as () => Promise<void>;
      const run: Promise<void> = job().finally(() => {
        this.inflight.delete(run);
        this.pump();
      });
      this.inflight.add(run);
    }
  }

  /** Every read asked for so far has settled (tests; nothing in the app waits for it). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all(this.inflight);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
