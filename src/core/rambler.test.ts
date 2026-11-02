import { describe, expect, test } from "bun:test";
import type { AiOutcome, RambleInput } from "./ai";
import { RAMBLE_MAX_CHARS } from "./ai";
import { createRambler } from "./rambler";

/** A rewrite the test answers by hand: `calls` are the inputs seen, `answer(i, …)` resolves call i. */
function manual() {
  const calls: RambleInput[] = [];
  const answers: ((o: AiOutcome<string>) => void)[] = [];
  let running = 0;
  let overlap = false;
  const rewrite = (input: RambleInput) => {
    calls.push(input);
    if (++running > 1) overlap = true;
    return new Promise<AiOutcome<string>>((resolve) =>
      answers.push((o) => {
        running--;
        resolve(o);
      }),
    );
  };
  const ok = (value: string): AiOutcome<string> => ({ ok: true, value });
  return { calls, rewrite, answer: (i: number, o: AiOutcome<string>) => answers[i]?.(o), ok, overlapped: () => overlap };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fail = (why: "unavailable" | "failed" | "timeout" | "junk", message = "no"): AiOutcome<string> => ({ ok: false, failure: { why, message } });

describe("coalescing", () => {
  test("never two calls at once: utterances during a call wait, then one call carries the newest transcript and the previous rewrite", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("fix the login");
    r.push("bug in auth dot ts");
    r.push("and add a test");
    expect(m.calls.map((c) => c.transcript)).toEqual(["fix the login"]);
    m.answer(0, m.ok("Fix the login."));
    await tick();
    expect(m.calls.map((c) => c.transcript)).toEqual(["fix the login", "fix the login bug in auth dot ts and add a test"]);
    expect(m.calls[1]?.previous).toBe("Fix the login.");
    m.answer(1, m.ok("Fix the login bug in auth.ts and add a test."));
    await tick();
    expect(m.calls).toHaveLength(2);
    expect(m.overlapped()).toBe(false);
    expect(r.state()).toMatchObject({ clean: "Fix the login bug in auth.ts and add a test.", upToDate: true, thinking: false });
  });

  test("the first call carries no previous rewrite and the context", () => {
    const m = manual();
    createRambler({ rewrite: m.rewrite, about: "repo teleflock" }).push("hello");
    expect(m.calls[0]).toEqual({ transcript: "hello", about: "repo teleflock" });
  });

  test("live calls are paced: a quick answer does not start the next call before the gap", async () => {
    const m = manual();
    let t = 1_000;
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 40, now: () => t });
    r.push("one");
    r.push("two");
    m.answer(0, m.ok("One."));
    await tick();
    expect(m.calls).toHaveLength(1);
    t += 40;
    await new Promise((res) => setTimeout(res, 60));
    expect(m.calls.map((c) => c.transcript)).toEqual(["one", "one two"]);
  });

  test("live calls are capped; the final call after finish() still happens", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0, maxLiveCalls: 2 });
    for (let i = 0; i < 4; i++) {
      r.push(`part${i}`);
      m.answer(i, m.ok(`clean${i}`));
      await tick();
    }
    expect(m.calls).toHaveLength(2);
    const done = r.finish();
    await tick();
    expect(m.calls).toHaveLength(3);
    m.answer(2, m.ok("final"));
    expect((await done).text).toBe("final");
  });
});

describe("finish", () => {
  test("waits for the call in flight, then makes one final call for what was said meanwhile", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("add a cache");
    r.push("keyed by user id");
    const done = r.finish();
    m.answer(0, m.ok("Add a cache."));
    await tick();
    expect(m.calls.map((c) => c.transcript)).toEqual(["add a cache", "add a cache keyed by user id"]);
    m.answer(1, m.ok("Add a cache keyed by user id."));
    expect(await done).toEqual({ text: "Add a cache keyed by user id.", raw: "add a cache keyed by user id", cleaned: true, error: null });
  });

  test("a rewrite that already covers everything resolves at once, without another call", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("rename foo to bar");
    m.answer(0, m.ok("Rename foo to bar."));
    await tick();
    expect((await r.finish()).text).toBe("Rename foo to bar.");
    expect(m.calls).toHaveLength(1);
  });

  test("nothing said: empty result, no call", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite });
    expect(await r.finish()).toEqual({ text: "", raw: "", cleaned: false, error: null });
    expect(m.calls).toHaveLength(0);
  });

  test("the final call is not paced", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 60_000 });
    r.push("one");
    m.answer(0, m.ok("One."));
    await tick();
    r.push("two");
    const done = r.finish();
    expect(m.calls).toHaveLength(2);
    m.answer(1, m.ok("One. Two."));
    expect((await done).text).toBe("One. Two.");
  });

  test("a model that is too slow falls back to the raw transcript", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, finalTimeoutMs: 20 });
    r.push("slow one");
    const res = await r.finish();
    expect(res).toMatchObject({ text: "slow one", cleaned: false, error: "The model took too long" });
    m.answer(0, m.ok("late"));
    await tick();
    expect(r.state().clean).toBe("");
  });
});

describe("failures fall back to the raw words", () => {
  test("a failed final call: raw transcript, the reason, no retry", async () => {
    const m = manual();
    // no live call: the one after finish() is the final call
    const r = createRambler({ rewrite: m.rewrite, maxLiveCalls: 0 });
    r.push("do the thing");
    const done = r.finish();
    m.answer(0, fail("timeout", "omp's tiny model didn't answer in time"));
    expect(await done).toEqual({ text: "do the thing", raw: "do the thing", cleaned: false, error: "omp's tiny model didn't answer in time" });
    expect(m.calls).toHaveLength(1);
  });

  test("a live call that fails after the user stopped is no final failure: the final call still runs", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("add a cache");
    r.push("keyed by user id");
    const done = r.finish();
    // the call on the earlier part, started before finish(), times out
    m.answer(0, fail("timeout", "slow"));
    await tick();
    expect(m.calls.map((c) => c.transcript)).toEqual(["add a cache", "add a cache keyed by user id"]);
    m.answer(1, m.ok("Add a cache keyed by user id."));
    expect(await done).toEqual({ text: "Add a cache keyed by user id.", raw: "add a cache keyed by user id", cleaned: true, error: null });
  });

  test("an unavailable host stops the session's calls at once", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("a");
    m.answer(0, fail("unavailable", "omp has no tiny role"));
    await tick();
    r.push("b");
    await tick();
    expect(m.calls).toHaveLength(1);
    expect(r.state()).toMatchObject({ raw: "a b", thinking: false, error: "omp has no tiny role" });
    expect((await r.finish()).text).toBe("a b");
  });

  test("one transient failure is retried with the newest transcript; a second in a row stops asking", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("a");
    m.answer(0, fail("junk"));
    await tick();
    expect(m.calls.map((c) => c.transcript)).toEqual(["a", "a"]);
    m.answer(1, fail("failed"));
    await tick();
    r.push("b");
    await tick();
    expect(m.calls).toHaveLength(2);
    expect(r.state().thinking).toBe(false);
  });

  test("a rewrite after a failure clears the error", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite, minGapMs: 0 });
    r.push("a");
    m.answer(0, fail("junk", "odd answer"));
    await tick();
    expect(r.state().error).toBe("odd answer");
    m.answer(1, m.ok("A."));
    await tick();
    expect(r.state()).toMatchObject({ error: null, clean: "A." });
  });

  test("a rejected call is a failure, not an unhandled error", async () => {
    const r = createRambler({ rewrite: () => Promise.reject(new Error("link down")), minGapMs: 0 });
    r.push("x");
    const res = await r.finish();
    expect(res).toMatchObject({ text: "x", cleaned: false, error: "link down" });
  });

  test("a transcript beyond the limit is never sent and stays as dictated", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite });
    r.push("x".repeat(RAMBLE_MAX_CHARS + 1));
    expect(m.calls).toHaveLength(0);
    const res = await r.finish();
    expect(res.cleaned).toBe(false);
    expect(res.error).toContain("Too long");
  });
});

describe("cancel", () => {
  test("drops late answers and releases a pending finish with the raw words", async () => {
    const m = manual();
    const r = createRambler({ rewrite: m.rewrite });
    r.push("hello");
    const done = r.finish();
    r.cancel();
    expect((await done).text).toBe("hello");
    m.answer(0, m.ok("Hello."));
    await tick();
    expect(r.state().clean).toBe("");
  });

  test("subscribers hear every change until they unsubscribe", async () => {
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
});
