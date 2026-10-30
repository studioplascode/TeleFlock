import type { ApiError, MoveCheck, MoveIssue, MovePart, MoveProbe, MoveRepo, MoveStatus, MoveStepState, UploadBegun } from "@/core/gen";
import type { HostClient } from "./client";
import { apiError, toApiError } from "./errors";
import { BACKOFF_MS, FIRST_CHUNK, GIVE_UP_MS, halveChunk, isTransientError, MAX_CHUNK, MAX_RESTARTS, nextChunkSize } from "./upload";

/*
 * Moving an agent to another host (`move.*`, architecture §3.28). Hosts never talk to each other:
 * this module relays. Source host A (where the agent is) and target host B:
 *
 *   move.check (A) · move.probe (B)            preflight
 *   move.start (A) → poll move.status (A)      push, patch, close the pane, pack the session → `ready`
 *   move.read (A) → upload.chunk (B) …         copy each part, `upload.finish {sha256}` checks it
 *   move.receive (B) → poll move.status (B)    clone/fetch/checkout, patch, unpack, resume → `done`
 *   move.finish (A)                            marks the copy left on A as moved
 *
 * Anything failing before `move.finish` aborts A (`move.abort`: the agent resumes where it was); a
 * user cancel during the receive aborts B first. Every in-flight move is saved in a `MoveRecordStore`
 * so a move the app abandoned (closed, crashed) is settled by `reconcileMoves` on the next start.
 * `runMove` takes injected host clients and a time/sleep/record env, so it runs in tests unchanged.
 */

// ---------------------------------------------------------------- types

/** What the user chose on the target: the repository checkout, a fresh clone, or (no git) a folder. */
export interface MoveChoice {
  /** A `MoveProbe.repos[].path`, or a folder picked on the target. */
  repoPath?: string;
  /** `MoveProbe.clonePath`. */
  cloneTo?: string;
  /** Agents without git: the existing folder on the target. */
  cwd?: string;
}

export interface RunMoveParams {
  src: HostClient;
  dst: HostClient;
  srcHostId: string;
  agentId: string;
  /** Agent name (for the saved record and messages). */
  name?: string;
  /** The source host's name (`move.receive {from}`). */
  fromLabel: string;
  /** The target host: its name (`MoveTo.label`) and the app's id. */
  to: { label: string; hostId: string };
  choice: MoveChoice;
}

/** `copy` is synthetic (the relay); the other steps come from the hosts, in order. */
export type MoveStepSide = "source" | "copy" | "target" | "finish";

export interface MoveStepView {
  /** Unique in the list (`source:push`, `copy`, `target:fetch`, `finish`). */
  key: string;
  side: MoveStepSide;
  id: string;
  label: string;
  state: MoveStepState;
  detail?: string;
}

/** Where the move is. `cancelling` / `rollingBack` end in `failed`; `finishing` can't be cancelled; `confirming`: the target cannot tell yet whether the agent started (nothing is aborted). */
export type MoveStage = "preparing" | "copying" | "receiving" | "confirming" | "finishing" | "cancelling" | "rollingBack" | "done" | "failed";

export interface MoveProgress {
  moveId?: string;
  stage: MoveStage;
  /** A's steps (its `finish` last), the copy, then B's steps. */
  steps: MoveStepView[];
  /** Bytes of the parts B confirmed, of all parts (0 / 0 until A is `ready`). */
  sent: number;
  total: number;
}

export interface MoveFailure {
  error: ApiError;
  /** Whose step failed: a host's, or the app's own (relay, cancel). */
  side: "source" | "target" | "app";
  cancelled: boolean;
  /** The source confirmed its rollback: the agent is back where it was. */
  rolledBack: boolean;
  /** After a rollback: the agent's id on the source (a resumed agent has a new one). */
  agentId?: string;
  /** A host was unreachable: the move is settled by `reconcileMoves` once it is back. */
  unsettled: boolean;
  /** The target could not tell yet whether the agent started there: nothing was aborted, the source stays parked, the record stays. */
  confirming?: boolean;
  /** What a rollback could not undo, and other notes (hosts' and ours). */
  notes: string[];
}

export type MoveOutcome =
  | { ok: true; agentId?: string; cwd?: string; sessionFile?: string; notes: string[]; status: MoveStatus }
  | { ok: false; failure: MoveFailure };

export interface MoveRunOptions {
  onProgress?(p: MoveProgress): void;
  /** Cancel: the request in flight completes, then everything is rolled back (see `runMove`). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- records

/** An in-flight move, saved so a restart can settle it. */
export interface MoveRecord {
  moveId: string;
  srcHostId: string;
  dstHostId: string;
  agentId: string;
  name: string;
  fromLabel: string;
  toLabel: string;
  startedAt: number;
  stage: "source" | "copy" | "target" | "finish";
  /** B's new agent, once B reported `done` (then only `move.finish` is left). */
  targetAgentId?: string;
}

export interface MoveRecordStore {
  list(): MoveRecord[];
  put(r: MoveRecord): void;
  remove(moveId: string): void;
}

const RECORDS_KEY = "tf.moves";

export function memoryRecordStore(): MoveRecordStore {
  const map = new Map<string, MoveRecord>();
  return {
    list: () => [...map.values()],
    put: (r) => void map.set(r.moveId, r),
    remove: (id) => void map.delete(id),
  };
}

/** Records in `localStorage` (memory only where it is unavailable). */
export function localRecordStore(key: string = RECORDS_KEY): MoveRecordStore {
  const read = (): MoveRecord[] => {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? (list as MoveRecord[]).filter((r) => typeof r?.moveId === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (list: MoveRecord[]) => {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(list));
    } catch {
      /* storage unavailable: the move still runs, only a restart can't settle it */
    }
  };
  return {
    list: read,
    put: (r) => write([...read().filter((x) => x.moveId !== r.moveId), r]),
    remove: (id) => write(read().filter((x) => x.moveId !== id)),
  };
}

// ---------------------------------------------------------------- env

/** Test seams: time, waiting and the saved records. */
export interface MoveEnv {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  records: MoveRecordStore;
}

let realRecords: MoveRecordStore | null = null;

const realEnv: MoveEnv = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
  get records() {
    return (realRecords ??= localRecordStore());
  },
};

/** Poll interval of `move.status`. */
export const POLL_MS = 700;
/** A host that keeps failing transiently is given up on after this long. */
export const POLL_GIVE_UP_MS = 3 * 60_000;
const FINISH_TRIES = 3;
/** While the target confirms, the source's move is touched this often (it times out after 30 min without word). */
const KEEPALIVE_MS = 5 * 60_000;
const FILE_NAMES: Record<string, string> = { session: "session.tar", changes: "changes.patch" };

/** Moves this app is running right now (reconcile leaves them alone). */
const active = new Set<string>();

export function isMoveActive(moveId: string): boolean {
  return active.has(moveId);
}

// ---------------------------------------------------------------- errors

/** "This host's TeleFlock is too old to move agents" for `unknown_method`; anything else as is. */
export function moveError(e: unknown, hostName?: string): ApiError {
  const err = toApiError(e);
  if (err.code !== "unknown_method") return err;
  return apiError("unsupported", "This host's TeleFlock is too old to move agents", { hint: `Reconnect ${hostName ?? "the host"} with this app to update it` });
}

/** The user cancelled. */
class Cancelled extends Error {
  constructor() {
    super("Move cancelled");
  }
}

/** A step failed on a side; `unreachable`: the host kept failing transiently (outcome unknown). */
class StepError extends Error {
  constructor(
    readonly side: "source" | "target",
    readonly error: ApiError,
    readonly unreachable = false,
  ) {
    super(error.message);
  }
}

// ---------------------------------------------------------------- preflight

/** `move.check` on the agent's host. */
export async function checkMove(src: HostClient, agentId: string, hostName?: string): Promise<MoveCheck> {
  try {
    return await src.call("move.check", { agentId });
  } catch (e) {
    throw moveError(e, hostName);
  }
}

/** `move.probe` on a target; `repoPath` re-checks a folder the user picked. */
export async function probeMove(dst: HostClient, source: MoveCheck, repoPath?: string, hostName?: string): Promise<MoveProbe> {
  try {
    return await dst.call("move.probe", { source, ...(repoPath ? { repoPath } : {}) });
  } catch (e) {
    throw moveError(e, hostName);
  }
}

/** Both preflight calls. */
export async function preflightMove(
  src: HostClient,
  dst: HostClient,
  agentId: string,
  opts: { repoPath?: string; srcLabel?: string; dstLabel?: string } = {},
): Promise<{ source: MoveCheck; target: MoveProbe }> {
  const source = await checkMove(src, agentId, opts.srcLabel);
  return { source, target: await probeMove(dst, source, opts.repoPath, opts.dstLabel) };
}

export function blockersOf(issues: readonly MoveIssue[]): MoveIssue[] {
  return issues.filter((i) => i.level === "blocker");
}

/** The repository a choice names (`repoPath`), when the probe knows it. */
export function chosenRepo(probe: MoveProbe, choice: MoveChoice): MoveRepo | undefined {
  return choice.repoPath ? probe.repos.find((r) => r.path === choice.repoPath) : undefined;
}

/** The best default: the first clone without blockers, else a fresh clone, else nothing (pick a folder). */
export function defaultChoice(source: MoveCheck, probe: MoveProbe): MoveChoice {
  if (!source.git) return {};
  const repo = probe.repos.find((r) => blockersOf(r.issues).length === 0);
  if (repo) return { repoPath: repo.path };
  if (probe.clonePath) return { cloneTo: probe.clonePath };
  return {};
}

/** Every issue that applies: the source's, the target's and the chosen repository's. */
export function issuesFor(source: MoveCheck, probe: MoveProbe, choice: MoveChoice): MoveIssue[] {
  return [...source.issues, ...probe.issues, ...(chosenRepo(probe, choice)?.issues ?? [])];
}

/** Whether the choice is complete and nothing blocks the move. */
export function canMove(source: MoveCheck, probe: MoveProbe, choice: MoveChoice): boolean {
  if (blockersOf(issuesFor(source, probe, choice)).length > 0) return false;
  return source.git ? !!(choice.repoPath || choice.cloneTo) : !!choice.cwd;
}

// ---------------------------------------------------------------- the move

/**
 * Run a move end to end. Never rejects: `{ ok: true }` once the agent runs on the target (the
 * source's copy marked moved, or a note saying it could not be), else `{ ok: false, failure }` after
 * the rollback: the source is aborted (the agent resumes there), begun uploads dropped. On cancel
 * during the receive the target is aborted first; a target that finished before the abort landed
 * makes the move succeed. A host that stays unreachable leaves the move `unsettled` and its record
 * saved for `reconcileMoves`.
 */
export async function runMove(p: RunMoveParams, opts: MoveRunOptions = {}, env: MoveEnv = realEnv): Promise<MoveOutcome> {
  const { signal } = opts;
  let stage: "start" | "source" | "copy" | "target" | "finish" = "start";
  let moveId: string | undefined;
  let srcStatus: MoveStatus | undefined;
  let dstStatus: MoveStatus | undefined;
  /** B may be running the receive job (the call went out, B has not reported a final state). */
  let dstMayRun = false;
  let lastKeepAlive = Number.NEGATIVE_INFINITY;
  let view: MoveStage = "preparing";
  let copy: MoveStepState = "pending";
  let sent = 0;
  let total = 0;
  const uploads = new Set<string>();
  const extraNotes: string[] = [];
  const startedAt = env.now();

  const emit = () => {
    const src = (srcStatus?.steps ?? []).map((s) => ({ ...s, key: `source:${s.id}`, side: s.id === "finish" ? ("finish" as const) : ("source" as const) }));
    const fin = src.find((s) => s.id === "finish");
    const dst = dstStatus?.steps.map((s) => ({ ...s, key: `target:${s.id}`, side: "target" as const }));
    const steps: MoveStepView[] = [
      ...src.filter((s) => s.id !== "finish"),
      { key: "copy", side: "copy", id: "copy", label: `Copy to ${p.to.label}`, state: copy },
      ...(dst ?? [{ key: "target:receive", side: "target" as const, id: "receive", label: `Set up on ${p.to.label}`, state: "pending" as const }]),
      fin ?? { key: "finish", side: "finish", id: "finish", label: `Mark the copy on ${p.fromLabel} as moved`, state: "pending" },
    ];
    opts.onProgress?.({ moveId, stage: view, steps, sent, total });
  };
  const setView = (v: MoveStage) => {
    view = v;
    emit();
  };
  const save = (patch: Partial<MoveRecord> = {}) => {
    if (!moveId) return;
    env.records.put({
      moveId,
      srcHostId: p.srcHostId,
      dstHostId: p.to.hostId,
      agentId: p.agentId,
      name: p.name ?? p.agentId,
      fromLabel: p.fromLabel,
      toLabel: p.to.label,
      startedAt,
      stage: stage === "start" ? "source" : stage,
      ...(dstStatus?.agentId && stage === "finish" ? { targetAgentId: dstStatus.agentId } : {}),
      ...patch,
    });
  };
  const forget = () => moveId && env.records.remove(moveId);
  const guard = () => {
    if (signal?.aborted) throw new Cancelled();
  };
  const on = async <T>(side: "source" | "target", fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Cancelled || e instanceof StepError) throw e;
      throw new StepError(side, moveError(e, side === "source" ? p.fromLabel : p.to.label));
    }
  };
  const poll = (side: "source" | "target", cancellable: boolean, done: (s: MoveStatus) => boolean): Promise<MoveStatus> =>
    pollStatus(side === "source" ? p.src : p.dst, moveId as string, done, {
      env,
      signal: cancellable ? signal : undefined,
      name: side === "source" ? p.fromLabel : p.to.label,
      side,
      onStatus: (s) => {
        // A confirming target can take long: keeps the source's move from timing out meanwhile.
        if (side === "target" && s.phase === "confirming" && env.now() - lastKeepAlive >= KEEPALIVE_MS) {
          lastKeepAlive = env.now();
          void p.src.call("move.status", { moveId: moveId as string }).catch(() => undefined);
        }
        if (side === "source") srcStatus = s;
        else {
          dstStatus = s;
          if (s.phase === "confirming") view = "confirming";
          else if (view === "confirming") view = "receiving";
        }
        emit();
      },
    });

  /** `move.finish` on A: a success either way; a failure becomes a note. */
  const finishSource = async (targetAgentId: string | undefined): Promise<void> => {
    stage = "finish";
    setView("finishing");
    save({ stage: "finish", ...(targetAgentId ? { targetAgentId } : {}) });
    let last: ApiError | undefined;
    for (let i = 0; i < FINISH_TRIES; i++) {
      try {
        const st = await p.src.call("move.finish", { moveId: moveId as string, ...(targetAgentId ? { agentId: targetAgentId } : {}) });
        srcStatus = st;
        forget();
        extraNotes.push(...(st.notes ?? []));
        return;
      } catch (e) {
        last = toApiError(e);
        if (!isTransientError(last)) break;
        if (i < FINISH_TRIES - 1) await env.sleep(BACKOFF_MS[i] ?? 1_000);
      }
    }
    // transient failures keep the record: `reconcileMoves` retries the finish later; so does any
    // refusal but "no such move": the target runs the agent, the record must survive
    if (last?.code === "not_found") forget();
    extraNotes.push(`${p.fromLabel} couldn't mark its copy as moved (${moveError(last).message}); resuming it there would continue an older copy as a fork.`);
  };

  const success = (): MoveOutcome => {
    copy = "done";
    setView("done");
    const status = dstStatus as MoveStatus;
    const notes = dedupe([...(dstStatus?.notes ?? []), ...extraNotes]);
    return { ok: true, agentId: status.agentId, cwd: status.cwd, sessionFile: status.sessionFile, notes, status };
  };

  const relayAll = async (parts: MovePart[]): Promise<{ session: string; changes?: string }> => {
    total = parts.reduce((n, x) => n + x.size, 0);
    let base = 0;
    const ids: Record<string, string> = {};
    for (const part of parts) {
      ids[part.name] = await relayPart(part, base);
      base += part.size;
    }
    if (!ids.session) throw new StepError("source", apiError("internal", `${p.fromLabel} did not offer the session to copy`));
    return { session: ids.session, ...(ids.changes ? { changes: ids.changes } : {}) };
  };

  /** One part from A to B (see `uploadVia`'s retry rules); the upload id on B once finished. */
  const relayPart = async (part: MovePart, base: number): Promise<string> => {
    const name = FILE_NAMES[part.name] ?? part.name;
    let begun: UploadBegun | null = null;
    let step: "begin" | "status" | "chunk" | "finish" = "begin";
    let at = 0;
    let chunk = FIRST_CHUNK;
    let failingSince: number | null = null;
    let failures = 0;
    let restarts = 0;
    let resyncs = 0;
    let side: "source" | "target" = "target";
    const report = (n: number) => {
      at = n;
      sent = base + n;
      emit();
    };
    for (;;) {
      guard();
      try {
        if (step === "begin") {
          side = "target";
          begun = await p.dst.call("upload.begin", { name, size: part.size });
          uploads.add(begun.uploadId);
          step = "chunk";
          report(0);
        } else if (!begun) {
          step = "begin";
          continue;
        } else if (step === "status") {
          side = "target";
          const got = (await p.dst.call("upload.status", { uploadId: begun.uploadId })).received;
          step = got >= part.size ? "finish" : "chunk";
          report(got);
        } else if (step === "chunk") {
          const length = Math.min(chunk, begun.maxChunk, MAX_CHUNK, part.size - at);
          side = "source";
          const read = await p.src.call("move.read", { moveId: moveId as string, part: part.name, offset: at, length });
          if (!read.data) throw apiError("internal", `${p.fromLabel} returned no data at byte ${at} of ${part.size}`);
          if (signal?.aborted) continue;
          side = "target";
          const t0 = env.now();
          const got = (await p.dst.call("upload.chunk", { uploadId: begun.uploadId, offset: at, data: read.data })).received;
          chunk = nextChunkSize(length, env.now() - t0, begun.maxChunk);
          resyncs = 0;
          if (got >= part.size) step = "finish";
          report(got);
        } else {
          side = "target";
          await p.dst.call("upload.finish", { uploadId: begun.uploadId, sha256: part.sha256 });
          return begun.uploadId;
        }
        failingSince = null;
        failures = 0;
      } catch (e) {
        const err = moveError(e, side === "source" ? p.fromLabel : p.to.label);
        if (side === "target" && err.code === "checksum_mismatch" && begun) {
          // the host dropped the upload itself
          uploads.delete(begun.uploadId);
          throw new StepError(side, err);
        }
        if (err.code === "not_found" && side === "target" && begun && step !== "begin") {
          uploads.delete(begun.uploadId);
          if (++restarts > MAX_RESTARTS) throw new StepError(side, err);
          begun = null;
          step = "begin";
          continue;
        }
        if (err.code === "upload_offset" && side === "target" && ++resyncs <= 3) {
          step = "status";
          continue;
        }
        if (!isTransientError(err)) throw new StepError(side, err);
        failingSince ??= env.now();
        if (env.now() - failingSince > GIVE_UP_MS) throw new StepError(side, err);
        if (err.code === "timeout" && step === "chunk") chunk = halveChunk(chunk);
        await env.sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 1_000, signal);
        failures++;
        if (begun && step === "chunk") step = "status";
      }
    }
  };

  const dropUploads = async () => {
    const ids = [...uploads];
    uploads.clear();
    await Promise.allSettled(ids.map((uploadId) => p.dst.call("upload.cancel", { uploadId })));
  };

  /** `move.abort` on `host`, then poll until its job ended. `null`: the host never knew the move. */
  const abortAndSettle = async (side: "source" | "target"): Promise<MoveStatus | null> => {
    const host = side === "source" ? p.src : p.dst;
    const current = side === "source" ? srcStatus : dstStatus;
    const name = side === "source" ? p.fromLabel : p.to.label;
    try {
      if (current?.phase === "failed") return current;
      await retryCall(env, () => host.call("move.abort", { moveId: moveId as string }));
      return await poll(side, false, (s) => s.phase === "failed" || s.phase === "done" || s.phase === "confirming");
    } catch (e) {
      if (e instanceof StepError && e.error.code === "not_found") return null;
      if (e instanceof StepError) throw e;
      const err = toApiError(e);
      if (err.code === "not_found") return null;
      throw new StepError(side, moveError(err, name), isTransientError(err));
    }
  };

  const fail = async (e: unknown): Promise<MoveOutcome> => {
    const cancelled = e instanceof Cancelled;
    let error: ApiError = cancelled ? apiError("cancelled", "Move cancelled") : toApiError(e);
    let side: MoveFailure["side"] = "app";
    let unsettled = false;
    let confirming = false;
    if (e instanceof StepError) {
      error = e.error;
      side = e.side;
      unsettled = e.unreachable;
    }
    if (copy === "running") copy = "failed";
    const notes: string[] = [];
    const finalize = (rolledBack: boolean): MoveOutcome => {
      setView("failed");
      notes.push(...(srcStatus?.notes ?? []), ...(dstStatus?.notes ?? []), ...extraNotes);
      return { ok: false, failure: { error, side, cancelled, rolledBack, ...(rolledBack && srcStatus?.agentId ? { agentId: srcStatus.agentId } : {}), unsettled, ...(confirming ? { confirming } : {}), notes: dedupe(notes) } };
    };
    setView(cancelled ? "cancelling" : "rollingBack");
    // The receive owns the uploads while the target may run it (it deletes them when it ends; a
    // confirming one keeps its patch for a rollback): nothing is cancelled under it.
    if (!dstMayRun) void dropUploads();
    /** The target may run the agent and does not know yet: nothing is aborted, the record stays. */
    const stillConfirming = (st: MoveStatus | undefined): MoveOutcome => {
      if (st) dstStatus = st;
      unsettled = true;
      confirming = true;
      notes.push(`${p.to.label} is still confirming whether ${p.name ?? "the agent"} started there. It stays parked on ${p.fromLabel} until ${p.to.label} knows; TeleFlock settles the move then.`);
      return finalize(false);
    };
    if (moveId && dstStatus?.phase === "confirming") return stillConfirming(dstStatus);
    if (!moveId) return finalize(false); // move.start never answered: nothing to settle from here

    // Unreachable host: its outcome is unknown, so nothing is rolled back; reconcile settles it later.
    if (unsettled) {
      notes.push(`Lost contact with ${side === "source" ? p.fromLabel : p.to.label}. TeleFlock settles the move when it is back.`);
      return finalize(false);
    }

    // The target may be running the receive: stop it first (it may even have finished).
    if (stage === "target" && dstMayRun && dstStatus?.phase !== "failed") {
      try {
        const st = await abortAndSettle("target");
        dstMayRun = false;
        if (st?.phase === "confirming") return stillConfirming(st);
        if (st?.phase === "done") {
          extraNotes.push("The move finished before it could be cancelled.");
          await finishSource(st.agentId);
          return success();
        }
        if (st) dstStatus = st;
      } catch (err) {
        unsettled = err instanceof StepError && err.unreachable;
        if (unsettled) {
          notes.push(`Couldn't stop the move on ${p.to.label}. TeleFlock settles it when ${p.to.label} is back.`);
          return finalize(false);
        }
        notes.push(`${p.to.label} didn't confirm that the move stopped: ${toApiError(err).message}`);
      }
    }
    // The target is settled (it never ran the receive, or it ended): its uploads are surely not needed.
    void dropUploads();

    // Roll the source back (a source that failed itself already did).
    try {
      const st = await abortAndSettle("source");
      if (!st) {
        notes.push(`${p.fromLabel} no longer knows this move (its TeleFlock restarted); check whether the agent runs there.`);
        forget();
        return finalize(false);
      }
      srcStatus = st;
      forget();
      if (st.phase === "done") {
        notes.push(`${p.fromLabel} had already marked the agent as moved.`);
        return finalize(false);
      }
      return finalize(true);
    } catch (err) {
      const e2 = err instanceof StepError ? err : new StepError("source", toApiError(err));
      if (e2.unreachable) {
        unsettled = true;
        notes.push(`Couldn't reach ${p.fromLabel} to roll the move back. TeleFlock finishes the rollback when it is back.`);
      } else {
        notes.push(`${p.fromLabel} couldn't roll the move back: ${e2.error.message}`);
      }
      return finalize(false);
    }
  };

  /* main flow */
  try {
    emit();
    // 1. start on A
    srcStatus = await on("source", () => p.src.call("move.start", { agentId: p.agentId, to: { label: p.to.label, hostId: p.to.hostId } }));
    moveId = srcStatus.moveId;
    active.add(moveId);
    stage = "source";
    save();
    emit();
    guard();
    srcStatus = await poll("source", true, (s) => s.phase === "ready" || s.phase === "failed" || s.phase === "done");
    // A failed on its own: it rolled itself back (`fail` only reads that state, no abort)
    if (srcStatus.phase === "failed") throw new StepError("source", srcStatus.error ?? apiError("internal", `${p.fromLabel} could not prepare the move`));
    const parts = srcStatus.parts ?? [];
    const source = srcStatus.source;
    if (!source) throw new StepError("source", apiError("internal", `${p.fromLabel} did not describe the agent`));

    // 2. copy
    stage = "copy";
    copy = "running";
    save();
    setView("copying");
    const files = await relayAll(parts);
    copy = "done";
    guard();

    // 3. receive on B
    stage = "target";
    save();
    setView("receiving");
    dstMayRun = true;
    try {
      dstStatus = await p.dst.call("move.receive", {
        moveId,
        source,
        from: p.fromLabel,
        sessionUpload: files.session,
        ...(files.changes ? { changesUpload: files.changes } : {}),
        ...(p.choice.repoPath ? { repoPath: p.choice.repoPath } : {}),
        ...(p.choice.cloneTo ? { cloneTo: p.choice.cloneTo } : {}),
        ...(p.choice.cwd ? { cwd: p.choice.cwd } : {}),
      });
    } catch (e) {
      const err = moveError(e, p.to.label);
      // a definitive answer means the job never started; a lost answer means it may have
      if (!isTransientError(err)) dstMayRun = false;
      throw new StepError("target", err);
    }
    emit();
    dstStatus = await poll("target", true, (s) => s.phase === "done" || s.phase === "failed");
    if (dstStatus.phase === "failed") {
      dstMayRun = false;
      throw new StepError("target", dstStatus.error ?? apiError("internal", `${p.to.label} could not take the agent`));
    }
    dstMayRun = false;
    uploads.clear(); // consumed by the receive: a later failure must not cancel them

    // 4. finish on A
    await finishSource(dstStatus.agentId);
    return success();
  } catch (e) {
    return await fail(e);
  } finally {
    if (moveId) active.delete(moveId);
  }
}

function dedupe(notes: string[]): string[] {
  return [...new Set(notes.filter(Boolean))];
}

// ---------------------------------------------------------------- polling

interface PollOptions {
  env: MoveEnv;
  signal?: AbortSignal;
  name: string;
  side: "source" | "target";
  onStatus(s: MoveStatus): void;
  giveUpMs?: number;
}

/**
 * `move.status` every `POLL_MS` until `done(status)`. Transient failures (timeouts, a lost
 * connection) are tolerated for `POLL_GIVE_UP_MS`, then `StepError(unreachable)`; anything else
 * (`not_found`: the host forgot the move) fails at once. A signal that fires throws `Cancelled`.
 */
async function pollStatus(host: HostClient, moveId: string, done: (s: MoveStatus) => boolean, o: PollOptions): Promise<MoveStatus> {
  let failingSince: number | null = null;
  let failures = 0;
  for (;;) {
    if (o.signal?.aborted) throw new Cancelled();
    let failed = false;
    try {
      const st = await host.call("move.status", { moveId });
      failingSince = null;
      failures = 0;
      o.onStatus(st);
      if (done(st)) return st;
    } catch (e) {
      const err = moveError(e, o.name);
      if (!isTransientError(err)) throw new StepError(o.side, err);
      failingSince ??= o.env.now();
      if (o.env.now() - failingSince > (o.giveUpMs ?? POLL_GIVE_UP_MS)) throw new StepError(o.side, err, true);
      failed = true;
    }
    await o.env.sleep(failed ? (BACKOFF_MS[Math.min(failures++, 2)] ?? 4_000) : POLL_MS, o.signal);
  }
}

/** A quick call retried on transient failures (a few tries). */
async function retryCall<T>(env: MoveEnv, fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = toApiError(e);
      if (i >= tries - 1 || !isTransientError(err)) throw err;
      await env.sleep(BACKOFF_MS[i] ?? 1_000);
    }
  }
}

// ---------------------------------------------------------------- reconcile

export type ReconcileAction = "finished" | "rolledBack" | "dropped" | "unsettled";

export interface ReconcileResult {
  record: MoveRecord;
  action: ReconcileAction;
  notes: string[];
}

export interface ReconcileHosts {
  /** A client for the host (null: no such host any more). */
  client(hostId: string): HostClient | null;
  /** The host is connected right now. */
  online(hostId: string): boolean;
}

/**
 * Settle moves a previous run left behind (app closed or crashed mid-move; also one whose host was
 * unreachable). Per record: B `done` (or already known `done`) → `move.finish` on A; B failed or
 * unaware → `move.abort` on A unless A is done or has forgotten it; a host that is offline leaves
 * the record for a later pass. Moves this app is still running are skipped.
 */
export async function reconcileMoves(hosts: ReconcileHosts, env: MoveEnv = realEnv, only?: (r: MoveRecord) => boolean): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  for (const record of env.records.list()) {
    if (active.has(record.moveId) || (only && !only(record))) continue;
    out.push(await reconcileOne(record, hosts, env));
  }
  return out;
}

async function reconcileOne(r: MoveRecord, hosts: ReconcileHosts, env: MoveEnv): Promise<ReconcileResult> {
  const result = (action: ReconcileAction, notes: string[] = []): ReconcileResult => ({ record: r, action, notes });
  const drop = (action: ReconcileAction, notes?: string[]) => {
    env.records.remove(r.moveId);
    return result(action, notes);
  };
  const src = hosts.client(r.srcHostId);
  if (!src) return drop("dropped");
  if (!hosts.online(r.srcHostId)) return result("unsettled");
  const dst = hosts.client(r.dstHostId);
  const o = (side: "source" | "target", name: string): PollOptions => ({ env, name, side, onStatus: () => undefined });

  const finish = async (agentId: string | undefined): Promise<ReconcileResult> => {
    try {
      await retryCall(env, () => src.call("move.finish", { moveId: r.moveId, ...(agentId ? { agentId } : {}) }));
      return drop("finished");
    } catch (e) {
      const err = toApiError(e);
      if (isTransientError(err)) return result("unsettled");
      // Only "nothing here is moving with this id" ends the record; any other refusal keeps it, so
      // a source that is not ready to finish yet is asked again, never forgotten while the target runs the agent.
      if (err.code === "not_found") return drop("dropped", [`${r.fromLabel} no longer has ${r.name} marked as moving: ${err.message}`]);
      return result("unsettled", [`${r.fromLabel} couldn't mark its copy of ${r.name} as moved yet: ${err.message}`]);
    }
  };
  const abort = async (): Promise<ReconcileResult> => {
    try {
      const st = await src.call("move.status", { moveId: r.moveId });
      if (st.phase === "done" || st.phase === "failed") return drop("dropped");
      if (st.phase !== "rollingBack") await retryCall(env, () => src.call("move.abort", { moveId: r.moveId }));
      const end = await pollStatus(src, r.moveId, (s) => s.phase === "failed" || s.phase === "done", o("source", r.fromLabel));
      return drop(end.phase === "failed" ? "rolledBack" : "dropped", end.notes ?? []);
    } catch (e) {
      const err = e instanceof StepError ? e.error : toApiError(e);
      if (err.code === "not_found") return drop("dropped");
      if (e instanceof StepError ? e.unreachable : isTransientError(err)) return result("unsettled");
      return drop("dropped", [`${r.fromLabel} couldn't roll back the move of ${r.name}: ${err.message}`]);
    }
  };

  if (r.targetAgentId) return finish(r.targetAgentId);
  if (!dst) return abort();
  if (!hosts.online(r.dstHostId)) return result("unsettled");
  try {
    const st = await pollStatus(dst, r.moveId, (s) => s.phase === "done" || s.phase === "failed" || s.phase === "confirming", o("target", r.toLabel));
    // The target cannot tell yet whether the agent runs there: the source stays parked, the record
    // stays, and the next pass asks again (aborting the source now could run the session twice).
    if (st.phase === "confirming") return result("unsettled", [`${r.toLabel} is still confirming whether ${r.name} started there. It stays parked on ${r.fromLabel} until then.`]);
    return st.phase === "done" ? await finish(st.agentId) : await abort();
  } catch (e) {
    const err = e instanceof StepError ? e.error : toApiError(e);
    if (err.code === "not_found") return abort();
    if (e instanceof StepError ? e.unreachable : isTransientError(err)) return result("unsettled");
    return abort();
  }
}

