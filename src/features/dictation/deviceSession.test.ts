import { describe, expect, test } from "bun:test";
import type { DictationEvent } from "@/core/gen";
import { DeviceSession } from "./deviceSession";

type Method = "dictation.start" | "dictation.stop" | "dictation.cancel";

/**
 * The app core as a session sees it: `dictation.start` answers when the test says so, and the core knows the
 * session only from then on (a stop or cancel for a session it doesn't know does nothing, as tf-client's).
 */
function rig(locale?: string) {
  const sent: { method: Method; params: { session: string; locale?: string } }[] = [];
  const waiters: { method: Method; resolve: () => void }[] = [];
  /** Sessions the core runs. */
  const running = new Set<string>();
  let answer: { ok(): void; fail(e: unknown): void } | null = null;
  let route: ((e: DictationEvent) => void) | null = null;
  const seen: string[] = [];
  const session = new DeviceSession(
    {
      call(method, params) {
        sent.push({ method, params });
        for (const w of waiters) if (w.method === method) w.resolve();
        if (method !== "dictation.start") {
          running.delete(params.session);
          return Promise.resolve({});
        }
        // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
        return new Promise((resolve, reject) => {
          answer = {
            ok: () => {
              running.add(params.session);
              resolve({});
            },
            fail: reject,
          };
        });
      },
      listen(_session, cb) {
        route = cb;
        return () => {
          route = null;
        };
      },
      id: "s1",
      ...(locale ? { locale } : {}),
    },
    {
      partial: (text) => seen.push(`partial ${text}`),
      final: (text) => seen.push(`final ${text}`),
      error: (message) => seen.push(`error ${message}`),
      end: () => seen.push("end"),
    },
  );
  return {
    session,
    sent,
    running,
    seen,
    /** What the core says about the session, through the page's routing. */
    say: (e: DictationEvent) => route?.(e),
    listening: () => route !== null,
    answer: () => answer?.ok(),
    refuse: (e: unknown) => answer?.fail(e),
    /** Resolves once the page has sent `method`. */
    sentOnce(method: Method): Promise<void> {
      // Executor form, as above.
      return new Promise((resolve) => {
        if (sent.some((s) => s.method === method)) resolve();
        else waiters.push({ method, resolve });
      });
    },
  };
}

describe("on-device dictation session (the page's side)", () => {
  test("events that come before the start answers are kept; the end is last, once, and nothing after it counts", async () => {
    const r = rig("de-DE");
    const started = r.session.start();
    expect(r.sent).toEqual([{ method: "dictation.start", params: { session: "s1", locale: "de-DE" } }]);
    r.say({ type: "listening" });
    r.say({ type: "partial", text: "Hallo" });
    r.say({ type: "final", text: "Hallo Welt." });
    r.answer();
    await started;
    r.say({ type: "error", code: "no_device", message: "The microphone went away" });
    r.say({ type: "end" });
    expect(r.seen).toEqual(["partial Hallo", "final Hallo Welt.", "error The microphone went away", "end"]);
    expect(r.listening()).toBe(false);
    // Ended: there is nothing left to stop.
    r.session.stop();
    r.session.cancel();
    expect(r.sent.map((s) => s.method)).toEqual(["dictation.start"]);
  });

  test("Stop asks the core to finish: the utterance being spoken still arrives, then the end", async () => {
    const r = rig();
    const started = r.session.start();
    expect(r.sent[0]?.params).toEqual({ session: "s1" });
    r.answer();
    await started;
    r.session.stop();
    await r.sentOnce("dictation.stop");
    expect(r.sent.at(-1)).toEqual({ method: "dictation.stop", params: { session: "s1" } });
    r.say({ type: "final", text: "The rest." });
    r.say({ type: "end" });
    expect(r.seen).toEqual(["final The rest.", "end"]);
  });

  test("a start that fails rejects, reports nothing and needs no stop", async () => {
    const r = rig();
    const started = r.session.start();
    r.refuse({ code: "no_model", message: "No speech model is installed" });
    let error: unknown = null;
    await started.catch((e: unknown) => {
      error = e;
    });
    expect(error).toMatchObject({ code: "no_model" });
    expect(r.listening()).toBe(false);
    r.session.stop();
    r.session.cancel();
    expect(r.sent.map((s) => s.method)).toEqual(["dictation.start"]);
    expect(r.seen).toEqual([]);
  });

  test("a cancel while the start is on its way reaches the core once it started: the microphone doesn't stay open", async () => {
    const r = rig();
    const started = r.session.start();
    // The text box goes away while the core opens the microphone.
    r.session.cancel();
    expect(r.listening()).toBe(false);
    r.answer();
    await started;
    await r.sentOnce("dictation.cancel");
    expect(r.running.size).toBe(0);
    expect(r.sent.map((s) => s.method)).toEqual(["dictation.start", "dictation.cancel"]);
    // Nothing is reported to a box that went away.
    r.say({ type: "end" });
    expect(r.seen).toEqual([]);
  });

  test("a stop while the start is on its way (a quick second tap) stops the session once it started", async () => {
    const r = rig();
    const started = r.session.start();
    r.session.stop();
    expect(r.sent.map((s) => s.method)).toEqual(["dictation.start"]);
    r.answer();
    await started;
    await r.sentOnce("dictation.stop");
    expect(r.running.size).toBe(0);
  });
});
