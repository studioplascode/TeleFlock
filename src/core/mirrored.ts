import { onFlush } from "./draftFlush";
import { indexedDbSlots, type SlotBackend } from "./draftSlots";

/*
 * A string kept in localStorage and mirrored to IndexedDB (the text drafts, Quick capture's text).
 *
 * localStorage is read synchronously, so a page shows what it stored in its first render, but it is
 * not durable everywhere: Chromium (WebView2 on Windows, Chrome) writes it to disk 5 s after a
 * change at the earliest and, under its hourly rate limits, minutes later (Android WebView after
 * 1 s); WebKitGTK commits after 500 ms. Whatever is pending when the process is killed (an
 * installer, the system) is lost. A completed IndexedDB transaction is on disk. Every write stores
 * both copies under the next revision; at start the copy with the higher revision wins.
 */

/** What IndexedDB holds per item; `value: null` records a deletion (a stale localStorage copy must not come back). */
export interface MirrorRecord {
  rev: number;
  at: number;
  value: string | null;
}

export interface MirroredItem {
  /** What localStorage held when the page started (`null`: nothing). */
  readonly initial: string | null;
  /**
   * Reads the IndexedDB copy (once; at most `LOAD_WAIT_MS`) and resolves with its value when it is
   * newer than `initial` (localStorage lost its last writes) and nothing was set meanwhile;
   * otherwise with `undefined`. Writes wait for it: a value set before it resolved is written then
   * and wins (it was set after the start).
   */
  load(): Promise<string | null | undefined>;
  /**
   * Stores `value` (`null` deletes): localStorage at once, IndexedDB in the background. `smaller`
   * is what localStorage gets when it refuses `value` (quota); IndexedDB always gets `value`.
   */
  set(value: string | null, smaller?: () => string): void;
  /** Resolves once everything set so far is in IndexedDB (or failed to get there). */
  flushed(): Promise<void>;
}

/** How long `load` waits for IndexedDB before going on with localStorage's copy. */
export const LOAD_WAIT_MS = 2000;

const DAY_MS = 86_400_000;
let shared: SlotBackend<MirrorRecord> | undefined;

/** Where items without a `backend` of their own keep their copy: IndexedDB `tf.mirror`/`items`. */
function sharedBackend(): SlotBackend<MirrorRecord> {
  shared ??= indexedDbSlots<MirrorRecord>("tf.mirror", "items", { maxStored: 32, maxAgeMs: 30 * DAY_MS });
  return shared;
}

/** Swaps the shared IndexedDB copy (tests); returns the previous one. */
export function setMirrorBackend(next: SlotBackend<MirrorRecord>): SlotBackend<MirrorRecord> {
  const prev = sharedBackend();
  shared = next;
  return prev;
}

/**
 * The item `name` (localStorage key; its revision is stored under `<name>@rev`). `storage` and
 * `backend` are for tests; by default localStorage and the shared IndexedDB copy.
 */
export function mirroredItem(name: string, opts: { storage?: Storage | null; backend?: SlotBackend<MirrorRecord>; loadWaitMs?: number } = {}): MirroredItem {
  const storage = opts.storage !== undefined ? opts.storage : (globalThis.localStorage ?? null);
  const backend = () => opts.backend ?? sharedBackend();
  const revKey = `${name}@rev`;
  const local = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const initial = local(name);
  const initialRev = Number(local(revKey)) || 0;
  let rev = initialRev;
  let loading: Promise<string | null | undefined> | null = null;
  let loaded = false;
  let held: { value: string | null; smaller?: () => string } | null = null;
  let last: Promise<void> = Promise.resolve();
  let warned = false;

  const setLocal = (value: string | null, smaller?: () => string): boolean => {
    if (!storage) return false;
    try {
      if (value === null) storage.removeItem(name);
      else storage.setItem(name, value);
      return true;
    } catch {
      // quota: the smaller value, if there is one
    }
    if (value === null || !smaller) return false;
    try {
      storage.setItem(name, smaller());
      return true;
    } catch {
      return false;
    }
  };

  const write = (value: string | null, smaller?: () => string) => {
    // Past localStorage's revision too: another tab of the same page (a browser) may have written.
    rev = Math.max(rev, Number(local(revKey)) || 0) + 1;
    if (setLocal(value, smaller)) {
      try {
        storage?.setItem(revKey, String(rev));
      } catch {
        // the IndexedDB copy then counts as newer, with the same value
      }
    } else if (storage && !warned) {
      warned = true;
      console.warn(`${name}: localStorage refused it (full?); kept in IndexedDB`);
    }
    last = Promise.resolve(backend().write(name, { rev, at: Date.now(), value })).catch(() => undefined);
  };

  const load = (): Promise<string | null | undefined> => {
    loading ??= (async () => {
      let timer: number | undefined;
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, opts.loadWaitMs ?? LOAD_WAIT_MS);
      });
      const stored = await Promise.race([backend().read(name).catch(() => undefined), late]);
      clearTimeout(timer);
      loaded = true;
      // A malformed record (another format) is ignored like one no newer than localStorage's copy.
      const newer = typeof stored?.rev === "number" && (typeof stored.value === "string" || stored.value === null) && stored.rev > initialRev ? stored : undefined;
      if (newer) rev = newer.rev;
      const pending = held;
      held = null;
      if (pending) {
        write(pending.value, pending.smaller);
        return undefined;
      }
      return newer?.value;
    })();
    return loading;
  };

  const item: MirroredItem = {
    initial,
    load,
    set(value, smaller) {
      if (loaded) return write(value, smaller);
      held = { value, smaller };
      void load();
    },
    async flushed() {
      if (loading) await loading;
      await last;
    },
  };
  onFlush(() => item.flushed());
  return item;
}
