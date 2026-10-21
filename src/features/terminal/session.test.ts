import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import type { TermEvent } from "@/core/gen";

/* A fake core: records host calls, lets tests push termBus events. */
const calls: { method: string; params: Record<string, unknown> }[] = [];
const listeners = new Map<string, (ev: TermEvent) => void>();
let nextTerm = 0;

mock.module("@/core", () => ({
  core: {
    host: () => ({
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "term.open") return { termId: `t${++nextTerm}`, paneId: "w1:p1" };
        return {};
      },
    }),
    termInput: () => {},
  },
  termBus: {
    subscribe: (_host: string, termId: string, cb: (ev: TermEvent) => void) => {
      listeners.set(termId, cb);
      return () => listeners.delete(termId);
    },
  },
  toApiError: (e: unknown) => ({ code: "internal", message: String(e), retryable: true }),
}));

// Browser globals the session touches.
globalThis.window ??= globalThis as unknown as Window & typeof globalThis;

// Dynamic: the module must load after `mock.module` replaced "@/core".
const { FIRST_FRAME_NUDGE_MS, TermSession } = await import("./session");

interface FakeTerm {
  cols: number;
  rows: number;
  writes: number;
  disposed: boolean;
}

function fakeTerm(): FakeTerm & Record<string, unknown> {
  const t = {
    cols: 100,
    rows: 30,
    writes: 0,
    disposed: false,
    buffer: { active: { viewportY: 0, baseY: 0 } },
    write(_data: Uint8Array, cb?: () => void) {
      if (t.disposed) throw new Error("write after dispose");
      t.writes++;
      cb?.();
    },
    scrollToBottom() {},
  };
  return t;
}

function session(term: ReturnType<typeof fakeTerm>) {
  const phases: string[] = [];
  const s = new TermSession({
    hostId: "lab",
    target: { kind: "pane", paneId: "w1:p1" },
    mode: "control",
    term: term as never,
    onPhase: (p) => phases.push(p.k),
    onFrame: () => {},
  });
  return { s, phases };
}

const frame = (seq: number): TermEvent => ({ k: "frame", seq, full: seq === 0, cols: 100, rows: 30, data: btoa("x") });

beforeEach(() => {
  calls.length = 0;
  listeners.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("TermSession", () => {
  test("an idle pane that sends no frame gets a resize nudge quickly", async () => {
    const { s } = session(fakeTerm());
    await s.open(false);
    expect(calls.map((c) => c.method)).toEqual(["term.open"]);
    vi.advanceTimersByTime(FIRST_FRAME_NUDGE_MS + 1);
    expect(calls.map((c) => c.method)).toEqual(["term.open", "term.resize"]);
    expect(FIRST_FRAME_NUDGE_MS).toBeLessThan(1000);
    s.dispose();
  });

  test("no nudge once a frame arrived", async () => {
    const term = fakeTerm();
    const { s } = session(term);
    await s.open(false);
    listeners.get(s.currentTermId!)?.(frame(0));
    vi.advanceTimersByTime(FIRST_FRAME_NUDGE_MS + 1);
    expect(calls.map((c) => c.method)).toEqual(["term.open"]);
    expect(term.writes).toBe(1);
    s.dispose();
  });

  test("dispose releases the lease, unsubscribes and is idempotent", async () => {
    const term = fakeTerm();
    const { s } = session(term);
    await s.open(false);
    const termId = s.currentTermId!;
    s.dispose();
    s.dispose();
    expect(calls.filter((c) => c.method === "term.close").map((c) => c.params.termId)).toEqual([termId]);
    expect(listeners.has(termId)).toBe(false);
    // A disposed terminal never receives late frames.
    term.disposed = true;
    expect(() => listeners.get(termId)?.(frame(1))).not.toThrow();
  });

  test("reopen moves to a new termId and ignores the old stream", async () => {
    const term = fakeTerm();
    const { s, phases } = session(term);
    await s.open(false);
    const first = s.currentTermId!;
    const oldCb = listeners.get(first);
    await s.open(true);
    const second = s.currentTermId!;
    expect(second).not.toBe(first);
    oldCb?.(frame(5));
    expect(term.writes).toBe(0);
    listeners.get(second)?.(frame(0));
    expect(term.writes).toBe(1);
    expect(phases.filter((p) => p === "live").length).toBe(2);
    s.dispose();
  });
});
