import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AiOutcome, RambleInput } from "./ai";
import { aiTesting, RAMBLE_MAX_CHARS, suggestRamble } from "./ai";
import { apiError } from "./errors";
import type { AiCompleteParams, AiCompleteResult } from "./gen";
import { createRambler } from "./rambler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  aiTesting.setComplete(null);
  aiTesting.reset();
});

/** A rewrite the test answers by hand: `calls` are the inputs seen, `answer(i, …)` resolves call i. */
function manual() {
  const calls: RambleInput[] = [];
  const answers: ((o: AiOutcome<string>) => void)[] = [];
  const rewrite = (input: RambleInput) => {
    calls.push(input);
    return new Promise<AiOutcome<string>>((resolve) => answers.push(resolve));
  };
  const ok = (value: string): AiOutcome<string> => ({ ok: true, value });
  return { calls, rewrite, answer: (i: number, o: AiOutcome<string>) => answers[i]?.(o), ok };
}

/** The rewrite the app uses (`suggestRamble`), down to the host's `ai.complete`: every call reaching the host is recorded. */
function host(reply: () => Promise<Omit<AiCompleteResult, "model">>) {
  const calls: AiCompleteParams[] = [];
  aiTesting.setComplete(async (_h, p) => {
    calls.push(p);
    return reply();
  });
  return { calls, rewrite: (input: RambleInput) => suggestRamble("h", input, { role: "tiny" }) };
}

describe("one call, once the dictation ends", () => {
  test("no ai.complete while dictating; exactly one after the stop, over the whole transcript", async () => {
    const h = host(async () => ({ text: "Fix the login bug in auth.ts and add a test.", ms: 5 }));
    const r = createRambler({ rewrite: h.rewrite, about: "Repository: teleflock" });
    r.push("fix the login");
    vi.advanceTimersByTime(60_000);
    r.push("bug in auth dot ts");
    r.push("and add a test");
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.calls).toHaveLength(0);
    expect(r.state()).toEqual({ raw: "fix the login bug in auth dot ts and add a test", thinking: false, error: null });

    const done = r.finish();
    expect(r.state().thinking).toBe(true);
    expect(await done).toEqual({ text: "Fix the login bug in auth.ts and add a test.", raw: "fix the login bug in auth dot ts and add a test", cleaned: true, error: null });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.prompt).toContain("<transcript>\nfix the login bug in auth dot ts and add a test\n</transcript>");
    expect(h.calls[0]?.prompt).toContain("<context>\nRepository: teleflock\n</context>");
    expect(r.state().thinking).toBe(false);
  });

  test("the call carries the transcript and the context, nothing else", () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, about: "repo teleflock" });
    r.push(" hello ");
    r.push("");
    r.push("world");
    void r.finish();
    expect(m.calls).toEqual([{ transcript: "hello world", about: "repo teleflock" }]);
    const bare = manual();
    const s = createRambler({ rewrite: bare.rewrite });
    s.push("hi");
    void s.finish();
    expect(bare.calls).toEqual([{ transcript: "hi" }]);
  });

  test("a second finish() is the same answer, not a second call; words after the stop are not added", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite });
    r.push("rename foo to bar");
    const first = r.finish();
    r.push("and baz");
    expect(r.finish()).toBe(first);
    m.answer(0, m.ok("Rename foo to bar."));
    expect(await first).toMatchObject({ text: "Rename foo to bar.", raw: "rename foo to bar" });
    expect(m.calls).toHaveLength(1);
  });

  test("nothing said: no call, an empty result", async () => {
    const h = host(async () => ({ text: "x", ms: 1 }));
    const r = createRambler({ rewrite: h.rewrite });
    expect(await r.finish()).toEqual({ text: "", raw: "", cleaned: false, error: null });
    expect(h.calls).toHaveLength(0);
  });
});

describe("cancel", () => {
  test("cancelled before the stop: no call, ever", async () => {
    const h = host(async () => ({ text: "Hello.", ms: 1 }));
    const r = createRambler({ rewrite: h.rewrite });
    r.push("hello");
    r.cancel();
    r.push("more");
    expect(await r.finish()).toEqual({ text: "hello", raw: "hello", cleaned: false, error: null });
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toHaveLength(0);
  });

  test("cancelled while tidying: the pending finish gets the raw words and the late answer is dropped", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite });
    r.push("hello");
    const done = r.finish();
    r.cancel();
    expect(await done).toEqual({ text: "hello", raw: "hello", cleaned: false, error: null });
    m.answer(0, m.ok("Hello."));
    expect(await r.finish()).toMatchObject({ text: "hello", cleaned: false });
    expect(r.state().thinking).toBe(false);
  });
});

describe("failures fall back to the raw words", () => {
  test("a failed call: the raw transcript and the host's reason, no retry", async () => {
    const h = host(async () => {
      throw apiError("ai_failed", "omp exited with status 1");
    });
    const r = createRambler({ rewrite: h.rewrite });
    r.push("do the thing");
    expect(await r.finish()).toEqual({ text: "do the thing", raw: "do the thing", cleaned: false, error: "omp exited with status 1" });
    expect(h.calls).toHaveLength(1);
  });

  test("an unusable answer: the raw transcript and why", async () => {
    const h = host(async () => ({ text: "Let me look at the repository structure first.", ms: 1 }));
    const r = createRambler({ rewrite: h.rewrite });
    r.push("um add a retry to the uploader");
    expect(await r.finish()).toEqual({ text: "um add a retry to the uploader", raw: "um add a retry to the uploader", cleaned: false, error: "The model's answer wasn't a usable rewrite" });
  });

  test("a rejected call is a failure, not an unhandled error", async () => {
    const r = createRambler({ rewrite: () => Promise.reject(new Error("link down")) });
    r.push("x");
    expect(await r.finish()).toMatchObject({ text: "x", cleaned: false, error: "link down" });
  });

  test("a model that is too slow: the raw transcript; its late answer changes nothing", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, timeoutMs: 20 });
    r.push("slow one");
    const done = r.finish();
    vi.advanceTimersByTime(20);
    expect(await done).toEqual({ text: "slow one", raw: "slow one", cleaned: false, error: "The model took too long" });
    expect(r.state().thinking).toBe(false);
    m.answer(0, m.ok("late"));
    expect(await r.finish()).toMatchObject({ text: "slow one", cleaned: false });
  });

  test("a transcript beyond the limit says so while dictating and is never sent", async () => {
    const h = host(async () => ({ text: "x", ms: 1 }));
    const r = createRambler({ rewrite: h.rewrite });
    r.push("x".repeat(RAMBLE_MAX_CHARS + 1));
    expect(r.state().error).toContain("Too long");
    const res = await r.finish();
    expect(res).toMatchObject({ cleaned: false, error: expect.stringContaining("Too long") });
    expect(res.text).toHaveLength(RAMBLE_MAX_CHARS + 1);
    expect(h.calls).toHaveLength(0);
  });
});

test("the host's worker is warmed when the session starts and while it lasts; never after the stop or a cancel", () => {
  const m = manual();
  let warmed = 0;
  const r = createRambler({ rewrite: m.rewrite, warm: () => warmed++, warmEveryMs: 10 });
  expect(warmed).toBe(1);
  r.push("a");
  vi.advanceTimersByTime(35);
  expect(warmed).toBe(4);
  expect(m.calls).toHaveLength(0);
  void r.finish();
  vi.advanceTimersByTime(100);
  expect(warmed).toBe(4);

  let again = 0;
  const s = createRambler({ rewrite: m.rewrite, warm: () => again++, warmEveryMs: 10 });
  s.cancel();
  vi.advanceTimersByTime(100);
  expect(again).toBe(1);
});

test("subscribers hear every change until they unsubscribe", () => {
  const m = manual();
  const r = createRambler({ rewrite: m.rewrite });
  let n = 0;
  const off = r.subscribe(() => n++);
  r.push("a");
  const seen = n;
  expect(seen).toBeGreaterThan(0);
  off();
  r.push("b");
  expect(n).toBe(seen);
});
