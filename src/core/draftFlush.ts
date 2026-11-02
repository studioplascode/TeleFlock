import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "./transport/tauri";

/*
 * Writing out every unsent draft now, for the moments a page ends without warning: the desktop
 * app's update restart, the Windows installer and Quit, the Android installer, which kill the page
 * without `pagehide`. Each draft store registers how to write out what it holds (`onFlush`):
 * `flushAll` runs them and resolves once IndexedDB has everything. Work that adds to a draft
 * asynchronously (an image being read, a paste waiting for its stored list) is tracked
 * (`trackDraftWork`) so a flush also waits for it, within a bound.
 */

type Flusher = () => Promise<void> | void;

const flushers = new Set<Flusher>();
const work = new Set<Promise<unknown>>();

/** How long `flushAll` waits for draft work in flight (the shell gives a page 3 s in all). */
export const WORK_WAIT_MS = 1500;

/** Registers how a draft store writes out what it holds now (resolving once it is on disk). */
export function onFlush(flush: Flusher): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/** Tracks work that adds to a draft when it settles, so `flushAll` waits for it. Returns `p`. */
export function trackDraftWork<T>(p: Promise<T>): Promise<T> {
  work.add(p);
  const done = () => work.delete(p);
  p.then(done, done);
  return p;
}

async function runFlushers(): Promise<void> {
  await Promise.allSettled([...flushers].map(async (f) => f()));
}

/**
 * Writes out every draft store and resolves once they are stored. Draft work in flight is waited
 * for up to `workWaitMs`; the stores are written before that wait and again after it, so work that
 * never ends doesn't hold back what is already there.
 */
export async function flushAll(workWaitMs = WORK_WAIT_MS): Promise<void> {
  await runFlushers();
  if (work.size === 0) return;
  let timer: number | undefined;
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, workWaitMs);
  });
  await Promise.race([Promise.allSettled([...work]), bound]);
  clearTimeout(timer);
  await runFlushers();
}

let answering = false;

/**
 * Desktop and Android app: the shell asks every page to write out its drafts before it ends the
 * process itself (an update's restart or installer, Quit) and waits for each page's answer
 * (`src-tauri/src/drafts.rs`). Once per page; nothing outside Tauri.
 */
export function answerFlushRequests(): void {
  if (answering || !inTauri()) return;
  answering = true;
  listen<number>("tf-drafts://flush", (e) => {
    void flushAll().finally(() => invoke("drafts_flushed", { id: e.payload }).catch(() => undefined));
  })
    .then(() => invoke("drafts_listen"))
    .catch((err: unknown) => console.warn("[drafts] can't answer the shell's flush requests", err));
}

const busy = new Set<string>();
let reportedBusy = false;

/**
 * Work a restart would lose started or ended (`what`: e.g. `"videos"`, an upload in flight).
 * Desktop app: while any goes on, the shell's updater doesn't restart the app by itself
 * (`drafts_busy`, `src-tauri/src/drafts.rs`).
 */
export function setDraftWorkBusy(what: string, on: boolean): void {
  if (on) busy.add(what);
  else busy.delete(what);
  const now = busy.size > 0;
  if (now === reportedBusy || !inTauri()) return;
  reportedBusy = now;
  invoke("drafts_busy", { busy: now }).catch(() => undefined);
}
