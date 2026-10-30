import { describe, expect, test } from "bun:test";
import type { ApiError, MoveCheck, MoveIssue, MoveProbe, MoveStatus } from "@/core/gen";
import type { HostClient } from "./client";
import { apiError } from "./errors";
import {
  canMove,
  defaultChoice,
  type MoveEnv,
  type MoveOutcome,
  type MoveProgress,
  type MoveRecord,
  memoryRecordStore,
  preflightMove,
  reconcileMoves,
  type RunMoveParams,
  runMove,
} from "./move";

type Params = Record<string, unknown>;
type Side = "A" | "B";
interface Call {
  side: Side;
  method: string;
  params: Params;
}

const CHECK: MoveCheck = {
  agentId: "a1",
  name: "fix-login",
  title: "Fix login",
  cwd: "/home/me/app",
  git: { repoRoot: "/home/me/app", repoName: "app", top: "/home/me/app", subdir: "", branch: "fix-login", head: "abc", remote: "origin", remoteUrl: "git@x:app.git", dirty: 2, linked: false },
  sessionFile: "/s.jsonl",
  sessionBytes: 900_000,
  artifactFiles: 0,
  subagentTranscripts: 0,
  changesBytes: 10,
  parked: false,
  issues: [],
} as MoveCheck;

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) % 251;
  return b;
}
/** Content digest the fake hosts compare (FNV-1a 32 bit per lane; stands in for sha-256). */
const sha = (b: Uint8Array) => {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  b.forEach((x, i) => {
    const l = i % 4;
    lanes[l] = Math.imul((lanes[l] ?? 0) ^ x, 0x01000193) >>> 0;
  });
  return lanes.map((l) => l.toString(16).padStart(8, "0")).join("").repeat(2);
};
const b64 = (b: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};

interface Opts {
  /** Throw from a call before the host handles it. */
  before?(side: Side, method: string, p: Params, n: number): void;
  /** A's own failure while preparing. */
  prepareFails?: ApiError;
  /** B's receive job fails with this. */
  receiveFails?: ApiError;
  /** B answers `done` to the abort (it finished first). */
  doneOnAbort?: boolean;
  /** B takes this many status polls to finish. */
  receivePolls?: number;
  /** B's receive ends `confirming` (its launch cannot be confirmed), and then `confirmThen` after `confirmAfter` more polls (never when unset). */
  confirms?: boolean;
  confirmThen?: "done" | "failed";
  confirmAfter?: number;
}

/** tf-hostd's `move.*` and `upload.*` in memory: A holds the parts, B receives them. */
function scenario(o: Opts = {}) {
  const log: Call[] = [];
  const session = bytes(900_000, 7);
  const patch = bytes(300, 3);
  const parts = [
    { name: "session", size: session.length, sha256: sha(session) },
    { name: "changes", size: patch.length, sha256: sha(patch) },
  ];
  const files: Record<string, Uint8Array> = { session, changes: patch };
  let a: "running" | "ready" | "rollingBack" | "failed" | "done" = "running";
  let aPolls = 0;
  let b: "idle" | "running" | "done" | "failed" | "confirming" = "idle";
  let bPolls = 0;
  const uploads = new Map<string, { size: number; data: number[] }>();
  const finished: { uploadId: string; sha256: unknown }[] = [];
  let seq = 0;

  const status = (role: "source" | "target"): MoveStatus => {
    const phase = role === "source" ? a : b === "idle" ? "running" : b;
    const failed = role === "source" ? (o.prepareFails ?? { code: "aborted", message: "aborted", retryable: false }) : (o.receiveFails ?? { code: "aborted", message: "aborted", retryable: false });
    return {
      moveId: "m1",
      role,
      phase,
      steps:
        role === "source"
          ? [
              { id: "push", label: "Push the branch", state: "done" },
              { id: "finish", label: "Mark as moved", state: phase === "done" ? "done" : "pending" },
            ]
          : [{ id: "fetch", label: "Fetch the branch", state: phase === "done" ? "done" : "running" }],
      ...(role === "source" && phase === "ready" ? { parts, source: CHECK } : {}),
      ...(role === "target" && phase === "done" ? { agentId: "b1", cwd: "/work/app", sessionFile: "/t.jsonl" } : {}),
      ...(role === "source" && phase === "failed" ? { agentId: "a2" } : {}),
      ...(phase === "failed" ? { error: failed, notes: role === "source" && o.prepareFails ? [] : ["note"] } : {}),
      startedAt: 0,
      updatedAt: 0,
    } as MoveStatus;
  };

  const handleA = (method: string, p: Params): unknown => {
    switch (method) {
      case "move.start":
        a = "running";
        return status("source");
      case "move.status":
        aPolls++;
        if (a === "running" && aPolls >= 2) a = o.prepareFails ? "failed" : "ready";
        else if (a === "rollingBack") a = "failed";
        return status("source");
      case "move.read": {
        const f = files[String(p.part)] as Uint8Array;
        const off = Number(p.offset);
        return { data: b64(f.subarray(off, off + Number(p.length))), size: f.length };
      }
      case "move.abort":
        if (a !== "failed") a = "rollingBack";
        return status("source");
      case "move.finish":
        a = "done";
        return status("source");
      default:
        throw apiError("unknown_method", method);
    }
  };
  const handleB = (method: string, p: Params): unknown => {
    const id = String(p.uploadId ?? "");
    const u = uploads.get(id);
    switch (method) {
      case "upload.begin": {
        const uploadId = `up${seq++}`;
        uploads.set(uploadId, { size: Number(p.size), data: [] });
        return { uploadId, path: `/up/${String(p.name)}`, maxChunk: 1024 * 1024 };
      }
      case "upload.chunk": {
        if (!u) throw apiError("not_found", "gone");
        if (p.offset !== u.data.length) throw apiError("upload_offset", "offset");
        u.data.push(...Uint8Array.from(atob(String(p.data)), (c) => c.charCodeAt(0)));
        return { uploadId: id, received: u.data.length, size: u.size };
      }
      case "upload.status":
        if (!u) throw apiError("not_found", "gone");
        return { uploadId: id, received: u.data.length, size: u.size };
      case "upload.finish": {
        if (!u) throw apiError("not_found", "gone");
        finished.push({ uploadId: id, sha256: p.sha256 });
        if (sha(Uint8Array.from(u.data)) !== p.sha256) {
          uploads.delete(id);
          throw apiError("checksum_mismatch", "bad sha");
        }
        return { path: "/up/x", size: u.size, sha256: String(p.sha256) };
      }
      case "upload.cancel":
        uploads.delete(id);
        return {};
      case "move.receive":
        b = "running";
        return status("target");
      case "move.status":
        if (b === "idle") throw apiError("not_found", "unknown move");
        bPolls++;
        if (b === "running" && bPolls >= (o.receivePolls ?? 2)) b = o.receiveFails ? "failed" : o.confirms ? "confirming" : "done";
        else if (b === "confirming" && o.confirmThen && bPolls >= (o.receivePolls ?? 2) + (o.confirmAfter ?? 3)) b = o.confirmThen;
        return status("target");
      case "move.abort":
        if (b === "idle") throw apiError("not_found", "unknown move");
        if (b === "running") b = o.doneOnAbort ? "done" : "failed";
        return status("target");
      default:
        throw apiError("unknown_method", method);
    }
  };
  const client = (side: Side): HostClient => {
    const counts = new Map<string, number>();
    return {
      call: (async (method: string, params: Params) => {
        log.push({ side, method, params });
        const n = (counts.get(method) ?? 0) + 1;
        counts.set(method, n);
        o.before?.(side, method, params, n);
        return side === "A" ? handleA(method, params) : handleB(method, params);
      }) as HostClient["call"],
    };
  };
  return {
    A: client("A"),
    B: client("B"),
    log,
    parts,
    session,
    patch,
    uploads,
    finished,
    setA: (s: typeof a) => void (a = s),
    setB: (s: typeof b) => void (b = s),
    methods: (side?: Side) => log.filter((c) => !side || c.side === side).map((c) => `${c.side}:${c.method}`),
    calls: (side: Side, method: string) => log.filter((c) => c.side === side && c.method === method),
  };
}

function fakeEnv(): MoveEnv & { t: number } {
  const env = {
    t: 0,
    now: () => env.t,
    sleep: async (ms: number) => {
      env.t += ms;
    },
    records: memoryRecordStore(),
  };
  return env;
}

function params(s: ReturnType<typeof scenario>, extra: Partial<RunMoveParams> = {}): RunMoveParams {
  return { src: s.A, dst: s.B, srcHostId: "ha", agentId: "a1", name: "fix-login", fromLabel: "laptop", to: { label: "build", hostId: "hb" }, choice: { repoPath: "/srv/app" }, ...extra };
}

function failureOf(o: MoveOutcome) {
  if (o.ok) throw new Error("expected a failed move");
  return o.failure;
}

describe("runMove", () => {
  test("happy path: copies both parts through the relay, then receives and finishes", async () => {
    const s = scenario();
    const env = fakeEnv();
    const progress: MoveProgress[] = [];
    const out = await runMove(params(s), { onProgress: (p) => progress.push(p) }, env);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agentId).toBe("b1");
    expect(out.cwd).toBe("/work/app");

    // order: start → status… → (begin → read/chunk… → finish) per part → receive → status… → finish
    const m = s.methods();
    const first = (x: string) => m.indexOf(x);
    expect(m[0]).toBe("A:move.start");
    expect(first("A:move.status")).toBeLessThan(first("B:upload.begin"));
    expect(first("B:upload.finish")).toBeLessThan(first("B:move.receive"));
    expect(first("B:move.receive")).toBeLessThan(first("B:move.status"));
    expect(m.at(-1)).toBe("A:move.finish");
    expect(m).not.toContain("A:move.abort");

    // the relay: each part's chunks in order, then finish with the part's sha
    const begins = s.calls("B", "upload.begin").map((c) => c.params);
    expect(begins).toEqual([
      { name: "session.tar", size: s.session.length },
      { name: "changes.patch", size: s.patch.length },
    ]);
    const reads = s.calls("A", "move.read").map((c) => c.params);
    expect(reads.every((r) => Number(r.length) <= 1024 * 1024 && Number(r.length) > 0)).toBe(true);
    const sessionReads = reads.filter((r) => r.part === "session").map((r) => Number(r.offset));
    expect(sessionReads[0]).toBe(0);
    expect(sessionReads).toEqual([...sessionReads].sort((x, y) => x - y));
    expect(reads.every((r) => r.moveId === "m1")).toBe(true);
    // chunks pass through unchanged and in order
    const chunks = s.calls("B", "upload.chunk").map((c) => c.params);
    expect(chunks.filter((c) => c.uploadId === "up0").map((c) => Number(c.offset))).toEqual(sessionReads);
    expect(s.finished).toEqual([
      { uploadId: "up0", sha256: s.parts[0]?.sha256 },
      { uploadId: "up1", sha256: s.parts[1]?.sha256 },
    ]);

    expect(s.calls("B", "move.receive")[0]?.params).toMatchObject({ moveId: "m1", from: "laptop", sessionUpload: "up0", changesUpload: "up1", repoPath: "/srv/app", source: CHECK });
    expect(s.calls("A", "move.start")[0]?.params).toEqual({ agentId: "a1", to: { label: "build", hostId: "hb" } });
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b1" });
    expect(env.records.list()).toEqual([]);

    // progress: A's steps (finish last), the copy, B's steps, with bytes
    const last = progress.at(-1) as MoveProgress;
    expect(last.stage).toBe("done");
    expect(last.steps.map((x) => x.key)).toEqual(["source:push", "copy", "target:fetch", "source:finish"]);
    expect(last.steps.map((x) => x.side)).toEqual(["source", "copy", "target", "finish"]);
    expect(last.sent).toBe(last.total);
    expect(last.total).toBe(s.session.length + s.patch.length);
    expect(progress.some((p) => p.stage === "copying" && p.sent > 0 && p.sent < p.total)).toBe(true);
  });

  test("A fails while preparing: no copy, its error surfaces, nothing to abort", async () => {
    const s = scenario({ prepareFails: { code: "pushRejected", message: "push rejected", hint: "pull first", retryable: false } });
    const env = fakeEnv();
    const f = failureOf(await runMove(params(s), {}, env));
    expect(f.error.code).toBe("pushRejected");
    expect(f.error.hint).toBe("pull first");
    expect(f.side).toBe("source");
    expect(f.rolledBack).toBe(true);
    expect(s.methods("B")).toEqual([]);
    expect(s.methods()).not.toContain("A:move.abort");
    expect(env.records.list()).toEqual([]);
  });

  test("relay failure: the begun upload is cancelled and A is aborted", async () => {
    const s = scenario({
      before: (side, method, _p, n) => {
        if (side === "B" && method === "upload.chunk" && n === 2) throw apiError("invalid_params", "disk full");
      },
    });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.error.message).toBe("disk full");
    expect(f.side).toBe("target");
    expect(f.rolledBack).toBe(true);
    expect(s.calls("B", "upload.cancel").map((c) => c.params.uploadId)).toEqual(["up0"]);
    expect(s.calls("A", "move.abort")).toHaveLength(1);
    expect(s.methods()).not.toContain("B:move.receive");
    expect(f.agentId).toBe("a2"); // the agent A's rollback resumed has a new id: Try again targets it
  });

  test("source read failure is the source's", async () => {
    const s = scenario({
      before: (side, method) => {
        if (side === "A" && method === "move.read") throw apiError("not_found", "unknown move");
      },
    });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.side).toBe("source");
    expect(f.error.code).toBe("not_found");
    expect(s.calls("A", "move.abort")).toHaveLength(1);
  });

  test("a transient failure mid-copy is retried after a resync", async () => {
    const s = scenario({
      before: (side, method, _p, n) => {
        if (side === "A" && method === "move.read" && n === 2) throw apiError("timeout", "timed out", { retryable: true });
      },
    });
    const out = await runMove(params(s), {}, fakeEnv());
    expect(out.ok).toBe(true);
    expect(s.calls("B", "upload.status").length).toBeGreaterThan(0);
  });

  test("checksum mismatch fails the move (the host dropped the upload) and rolls back", async () => {
    const s = scenario();
    s.parts[0]!.sha256 = "00".repeat(32);
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.error.code).toBe("checksum_mismatch");
    expect(f.rolledBack).toBe(true);
    expect(s.calls("B", "upload.cancel").map((c) => c.params.uploadId)).not.toContain("up0");
  });

  test("B fails: its error is reported and A is aborted (B is not)", async () => {
    const s = scenario({ receiveFails: { code: "fetchFailed", message: "can't fetch the branch", hint: "check access", retryable: false } });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.error.code).toBe("fetchFailed");
    expect(f.side).toBe("target");
    expect(f.rolledBack).toBe(true);
    expect(f.notes).toContain("note");
    expect(s.calls("B", "move.abort")).toHaveLength(0);
    expect(s.calls("A", "move.abort")).toHaveLength(1);
    expect(s.methods().indexOf("A:move.abort")).toBeGreaterThan(s.methods().indexOf("B:move.receive"));
    expect(s.methods()).not.toContain("A:move.finish");
  });

  test("a move.receive the host refuses never ran: only A is aborted", async () => {
    const s = scenario({
      before: (side, method) => {
        if (side === "B" && method === "move.receive") throw apiError("invalid_params", "pick a folder");
      },
    });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.error.message).toBe("pick a folder");
    expect(s.calls("B", "move.abort")).toHaveLength(0);
    expect(s.calls("A", "move.abort")).toHaveLength(1);
  });

  test("user abort during the relay: uploads cancelled, A aborted, B never involved further", async () => {
    const ctl = new AbortController();
    const s = scenario({
      before: (side, method, _p, n) => {
        if (side === "A" && method === "move.read" && n === 2) ctl.abort();
      },
    });
    const f = failureOf(await runMove(params(s), { signal: ctl.signal }, fakeEnv()));
    expect(f.cancelled).toBe(true);
    expect(f.rolledBack).toBe(true);
    expect(s.calls("B", "upload.cancel").length).toBeGreaterThan(0);
    expect(s.methods()).not.toContain("B:move.receive");
    expect(s.methods()).not.toContain("B:move.abort");
    expect(s.calls("A", "move.abort")).toHaveLength(1);
  });

  test("user abort during the receive: B is aborted and settled before A", async () => {
    const ctl = new AbortController();
    const s = scenario({
      receivePolls: 5,
      before: (side, method) => {
        if (side === "B" && method === "move.status") ctl.abort();
      },
    });
    const f = failureOf(await runMove(params(s), { signal: ctl.signal }, fakeEnv()));
    expect(f.cancelled).toBe(true);
    expect(f.rolledBack).toBe(true);
    const m = s.methods();
    expect(m.indexOf("B:move.abort")).toBeGreaterThan(m.indexOf("B:move.receive"));
    expect(m.indexOf("A:move.abort")).toBeGreaterThan(m.lastIndexOf("B:move.status"));
    expect(m).not.toContain("A:move.finish");
  });

  test("user abort that B outran: the move succeeds and A is finished", async () => {
    const ctl = new AbortController();
    const s = scenario({
      receivePolls: 5,
      doneOnAbort: true,
      before: (side, method) => {
        if (side === "B" && method === "move.status") ctl.abort();
      },
    });
    const out = await runMove(params(s), { signal: ctl.signal }, fakeEnv());
    expect(out.ok).toBe(true);
    expect(s.methods()).not.toContain("A:move.abort");
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b1" });
  });

  test("B confirming, then done: the source stays parked meanwhile and is finished, never aborted", async () => {
    const s = scenario({ confirms: true, confirmThen: "done" });
    const stages: string[] = [];
    const out = await runMove(params(s), { onProgress: (p) => stages.push(p.stage) }, fakeEnv());
    expect(out.ok).toBe(true);
    expect(stages).toContain("confirming");
    expect(s.methods()).not.toContain("A:move.abort");
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b1" });
  });

  test("B confirming, then surely absent (failed): the source is rolled back", async () => {
    const s = scenario({ confirms: true, confirmThen: "failed" });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.rolledBack).toBe(true);
    expect(f.confirming).toBeUndefined();
    expect(s.calls("A", "move.abort")).toHaveLength(1);
  });

  test("a cancel while B is confirming aborts nothing: unsettled, record kept, no rollback claimed", async () => {
    const ctl = new AbortController();
    const s = scenario({
      confirms: true,
      before: (side, method, _p, n) => {
        if (side === "B" && method === "move.status" && n >= 4) ctl.abort();
      },
    });
    const env = fakeEnv();
    const f = failureOf(await runMove(params(s), { signal: ctl.signal }, env));
    expect(f.confirming).toBe(true);
    expect(f.unsettled).toBe(true);
    expect(f.rolledBack).toBe(false);
    expect(f.notes.join(" ")).toContain("still confirming");
    expect(s.methods()).not.toContain("A:move.abort");
    expect(s.methods()).not.toContain("B:move.abort");
    // the receive owns its uploads (its patch is what a rollback reverses): none is cancelled under it
    expect(s.calls("B", "upload.cancel")).toHaveLength(0);
    expect(s.uploads.size).toBeGreaterThan(0);
    expect(env.records.list().map((r) => r.moveId)).toEqual(["m1"]);
  });

  test("move.finish failing keeps the move a success, with a note", async () => {
    const s = scenario({
      before: (side, method) => {
        if (side === "A" && method === "move.finish") throw apiError("internal", "boom");
      },
    });
    const env = fakeEnv();
    const out = await runMove(params(s), {}, env);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agentId).toBe("b1");
    expect(out.notes.join(" ")).toContain("couldn't mark its copy as moved");
    // the target runs the agent: the record stays, reconcile retries the finish
    expect(env.records.list().map((r) => r.moveId)).toEqual(["m1"]);
  });

  test("move.finish refused for any reason but 'no such move' keeps the record; 'no such move' ends it", async () => {
    for (const [code, kept] of [["invalid_params", 1], ["not_found", 0]] as const) {
      const s = scenario({
        before: (side, method) => {
          if (side === "A" && method === "move.finish") throw apiError(code, "refused");
        },
      });
      const env = fakeEnv();
      const out = await runMove(params(s), {}, env);
      expect(out.ok).toBe(true);
      expect(env.records.list()).toHaveLength(kept);
    }
  });

  test("a target that takes long to confirm keeps the source's move alive with status polls", async () => {
    const s = scenario({ confirms: true, confirmThen: "done", confirmAfter: 600 });
    const out = await runMove(params(s), {}, fakeEnv());
    expect(out.ok).toBe(true);
    const from = s.log.findIndex((c) => c.side === "B" && c.method === "move.receive");
    const keepalives = s.log.slice(from).filter((c) => c.side === "A" && c.method === "move.status");
    expect(keepalives.length).toBeGreaterThanOrEqual(1);
    // not one per poll
    expect(keepalives.length).toBeLessThan(10);
  });

  test("move.finish with a lost connection is retried, then left for reconcile", async () => {
    const s = scenario({
      before: (side, method) => {
        if (side === "A" && method === "move.finish") throw apiError("not_connected", "offline", { retryable: true });
      },
    });
    const env = fakeEnv();
    const out = await runMove(params(s), {}, env);
    expect(out.ok).toBe(true);
    expect(s.calls("A", "move.finish")).toHaveLength(3);
    expect(env.records.list()).toHaveLength(1);
    expect(env.records.list()[0]?.targetAgentId).toBe("b1");
  });

  test("a host without move.* is too old", async () => {
    const s = scenario({
      before: (side, method) => {
        if (side === "A" && method === "move.start") throw apiError("unknown_method", "move.start");
      },
    });
    const f = failureOf(await runMove(params(s), {}, fakeEnv()));
    expect(f.error.message).toBe("This host's TeleFlock is too old to move agents");
    expect(f.error.hint).toContain("laptop");
    expect(f.rolledBack).toBe(false);
  });

  test("status polls tolerate transient failures", async () => {
    const s = scenario({
      before: (side, method, _p, n) => {
        if (side === "A" && method === "move.status" && n <= 3) throw apiError("timeout", "timed out", { retryable: true });
      },
    });
    expect((await runMove(params(s), {}, fakeEnv())).ok).toBe(true);
  });

  test("a source that stays unreachable leaves the move unsettled, record kept, nothing aborted", async () => {
    const s = scenario({
      before: (side, method, _p, n) => {
        if (side === "A" && method === "move.status" && n >= 2) throw apiError("not_connected", "offline", { retryable: true });
      },
    });
    const env = fakeEnv();
    const f = failureOf(await runMove(params(s), {}, env));
    expect(f.unsettled).toBe(true);
    expect(f.rolledBack).toBe(false);
    expect(env.t).toBeGreaterThanOrEqual(3 * 60_000);
    expect(env.records.list().map((r) => r.moveId)).toEqual(["m1"]);
    expect(s.methods()).not.toContain("A:move.abort");
  });

  test("a record is saved while the move runs", async () => {
    const s = scenario();
    const env = fakeEnv();
    const stages: string[] = [];
    await runMove(params(s), { onProgress: () => stages.push(env.records.list()[0]?.stage ?? "-") }, env);
    expect(stages).toContain("source");
    expect(stages).toContain("copy");
    expect(stages).toContain("target");
    expect(env.records.list()).toEqual([]);
  });
});

describe("reconcileMoves", () => {
  const record = (extra: Partial<MoveRecord> = {}): MoveRecord => ({
    moveId: "m1",
    srcHostId: "ha",
    dstHostId: "hb",
    agentId: "a1",
    name: "fix-login",
    fromLabel: "laptop",
    toLabel: "build",
    startedAt: 0,
    stage: "target",
    ...extra,
  });
  const hosts = (s: ReturnType<typeof scenario>, online: Record<string, boolean> = { ha: true, hb: true }) => ({
    client: (id: string) => (id === "ha" ? s.A : id === "hb" ? s.B : null),
    online: (id: string) => online[id] ?? false,
  });

  test("B done → finish A", async () => {
    const s = scenario();
    s.setA("ready");
    s.setB("done");
    const env = fakeEnv();
    env.records.put(record());
    const out = await reconcileMoves(hosts(s), env);
    expect(out.map((r) => r.action)).toEqual(["finished"]);
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b1" });
    expect(env.records.list()).toEqual([]);
  });

  test("B failed → abort A", async () => {
    const s = scenario({ receiveFails: { code: "x", message: "x", retryable: false } });
    s.setA("ready");
    s.setB("failed");
    const env = fakeEnv();
    env.records.put(record());
    const out = await reconcileMoves(hosts(s), env);
    expect(out.map((r) => r.action)).toEqual(["rolledBack"]);
    expect(s.calls("A", "move.abort")).toHaveLength(1);
    expect(s.methods()).not.toContain("A:move.finish");
    expect(env.records.list()).toEqual([]);
  });

  test("B unaware of the move → abort A", async () => {
    const s = scenario();
    s.setA("ready");
    const env = fakeEnv();
    env.records.put(record({ stage: "copy" }));
    expect((await reconcileMoves(hosts(s), env)).map((r) => r.action)).toEqual(["rolledBack"]);
    expect(s.calls("A", "move.abort")).toHaveLength(1);
  });

  test("A already done or failed → just drop the record", async () => {
    const s = scenario();
    s.setA("done");
    const env = fakeEnv();
    env.records.put(record());
    expect((await reconcileMoves(hosts(s), env)).map((r) => r.action)).toEqual(["dropped"]);
    expect(s.methods()).not.toContain("A:move.abort");
    expect(env.records.list()).toEqual([]);
  });

  test("an offline host leaves the record for later", async () => {
    const s = scenario();
    const env = fakeEnv();
    env.records.put(record());
    expect((await reconcileMoves(hosts(s, { ha: true, hb: false }), env)).map((r) => r.action)).toEqual(["unsettled"]);
    expect(s.log).toEqual([]);
    expect(env.records.list()).toHaveLength(1);
  });

  test("a finish the source refuses keeps the record for the next pass; 'no such move' drops it", async () => {
    for (const [code, action, kept] of [["invalid_params", "unsettled", 1], ["not_found", "dropped", 0]] as const) {
      const s = scenario({
        before: (side, method) => {
          if (side === "A" && method === "move.finish") throw apiError(code, "refused");
        },
      });
      s.setA("ready");
      s.setB("done");
      const env = fakeEnv();
      env.records.put(record());
      expect((await reconcileMoves(hosts(s), env)).map((r) => r.action)).toEqual([action]);
      expect(env.records.list()).toHaveLength(kept);
    }
  });

  test("B confirming → nothing is aborted or finished, the record stays; B done later → finish A", async () => {
    const s = scenario({ confirms: true, confirmThen: "done", confirmAfter: 1_000 });
    s.setA("ready");
    s.setB("confirming");
    const env = fakeEnv();
    env.records.put(record());
    const out = await reconcileMoves(hosts(s), env);
    expect(out.map((r) => r.action)).toEqual(["unsettled"]);
    expect(out[0]?.notes.join(" ")).toContain("still confirming");
    expect(s.methods()).not.toContain("A:move.abort");
    expect(s.methods()).not.toContain("A:move.finish");
    expect(env.records.list()).toHaveLength(1);
    // the target knows now: the agent runs
    s.setB("done");
    expect((await reconcileMoves(hosts(s), env)).map((r) => r.action)).toEqual(["finished"]);
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b1" });
    expect(env.records.list()).toEqual([]);
  });

  test("a record that knows B's agent only needs the finish", async () => {
    const s = scenario();
    s.setA("ready");
    const env = fakeEnv();
    env.records.put(record({ stage: "finish", targetAgentId: "b9" }));
    await reconcileMoves(hosts(s, { ha: true, hb: false }), env);
    expect(s.calls("A", "move.finish")[0]?.params).toEqual({ moveId: "m1", agentId: "b9" });
    expect(s.methods("B")).toEqual([]);
  });
});

describe("preflight helpers", () => {
  const issue = (level: MoveIssue["level"], code: string): MoveIssue => ({ level, code, message: code });
  const probe = (p: Partial<MoveProbe>): MoveProbe => ({ hostname: "build", repos: [], issues: [], ...p }) as MoveProbe;
  const repo = (path: string, issues: MoveIssue[] = []) => ({ path, remote: "origin", remoteUrl: "u", checkout: "newWorktree", branchExists: false, issues }) as MoveProbe["repos"][number];

  test("defaultChoice prefers a clone without blockers, then the clone path", () => {
    const pr = probe({ repos: [repo("/a", [issue("blocker", "dirty")]), repo("/b")], clonePath: "/c" });
    expect(defaultChoice(CHECK, pr)).toEqual({ repoPath: "/b" });
    expect(defaultChoice(CHECK, probe({ repos: [repo("/a", [issue("blocker", "x")])], clonePath: "/c" }))).toEqual({ cloneTo: "/c" });
    expect(defaultChoice(CHECK, probe({}))).toEqual({});
    expect(defaultChoice({ ...CHECK, git: undefined }, probe({}))).toEqual({});
  });

  test("canMove needs a choice and no blockers anywhere", () => {
    const pr = probe({ repos: [repo("/a", [issue("blocker", "dirty")]), repo("/b")] });
    expect(canMove(CHECK, pr, { repoPath: "/b" })).toBe(true);
    expect(canMove(CHECK, pr, { repoPath: "/a" })).toBe(false);
    expect(canMove(CHECK, pr, {})).toBe(false);
    expect(canMove({ ...CHECK, issues: [issue("warning", "w")] }, pr, { repoPath: "/b" })).toBe(true);
    expect(canMove({ ...CHECK, issues: [issue("blocker", "notIdle")] }, pr, { repoPath: "/b" })).toBe(false);
    expect(canMove({ ...CHECK, git: undefined }, probe({}), {})).toBe(false);
    expect(canMove({ ...CHECK, git: undefined }, probe({}), { cwd: "/x" })).toBe(true);
  });

  test("preflightMove checks the source, then probes the target with it", async () => {
    const log: string[] = [];
    const src = { call: async (m: string) => (log.push(`A:${m}`), CHECK) } as unknown as HostClient;
    const dst = { call: async (m: string, p: Params) => (log.push(`B:${m}`), expect(p).toEqual({ source: CHECK, repoPath: "/r" }), probe({})) } as unknown as HostClient;
    const r = await preflightMove(src, dst, "a1", { repoPath: "/r" });
    expect(log).toEqual(["A:move.check", "B:move.probe"]);
    expect(r.source).toBe(CHECK);
  });

  test("an old host is reported as too old", async () => {
    const src = {
      call: async () => {
        throw apiError("unknown_method", "move.check");
      },
    } as unknown as HostClient;
    await expect(preflightMove(src, src, "a1", { srcLabel: "laptop" })).rejects.toMatchObject({ code: "unsupported", message: "This host's TeleFlock is too old to move agents" });
  });
});
