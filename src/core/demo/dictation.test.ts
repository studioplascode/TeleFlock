import { describe, expect, test } from "bun:test";
import type { AppEvent, DictationEvent, DictationModel, DictationState } from "@/core/gen";
import { ManualClock } from "./clock";
import { DEMO_SPEECH, DemoDictation } from "./dictation";

function demo(phone = false) {
  const clock = new ManualClock();
  const events: AppEvent[] = [];
  const dictation = new DemoDictation({ clock, emit: (e) => events.push(e), phone });
  const state = () => dictation.call("dictation.models", {}) as DictationState;
  const model = (id: string): DictationModel | undefined => state().models.find((m) => m.id === id);
  /** What session `id` reported, in order. */
  const heard = (id: string): DictationEvent[] => events.flatMap((e) => (e.type === "dictationSession" && e.session === id ? [e.event] : []));
  /** Installs `id` and lets its download finish. */
  const install = (id: string) => {
    dictation.call("dictation.install", { modelId: id });
    clock.advance(20_000);
  };
  return { clock, events, dictation, state, model, heard, install };
}

/** The error `call` threw; null when it returned. */
function refusal(call: () => unknown): unknown {
  try {
    call();
  } catch (e) {
    return e;
  }
  return null;
}

/** An utterance as the engine writes it: capitalised, with a full stop. */
function written(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

const [FIRST_EN = ""] = DEMO_SPEECH.en;
const FIRST_EN_WORDS = FIRST_EN.split(" ");

describe("demo on-device dictation: models", () => {
  test("a download reports progress, cancels keeping what it got, resumes from there; the first model installed is the chosen one", () => {
    const { clock, events, dictation, state, model } = demo();
    expect(state().selected).toBeUndefined();
    dictation.call("dictation.install", { modelId: "parakeet-tdt-0.6b-v3" });
    clock.advance(1000);
    expect(model("parakeet-tdt-0.6b-v3")).toMatchObject({ phase: "downloading", downloaded: 80_000_000 });
    expect(events.filter((e) => e.type === "dictation").length).toBeGreaterThanOrEqual(4);

    dictation.call("dictation.cancelInstall", { modelId: "parakeet-tdt-0.6b-v3" });
    clock.advance(5000);
    // Interrupted, not lost: Settings offers to resume at 80 MB.
    expect(model("parakeet-tdt-0.6b-v3")).toMatchObject({ phase: "available", downloaded: 80_000_000 });

    dictation.call("dictation.install", { modelId: "parakeet-tdt-0.6b-v3" });
    clock.advance(250);
    expect(model("parakeet-tdt-0.6b-v3")?.downloaded).toBe(100_000_000);
    clock.advance(10_000);
    expect(model("parakeet-tdt-0.6b-v3")).toMatchObject({ phase: "installed" });
    expect(model("parakeet-tdt-0.6b-v3")?.downloaded).toBeUndefined();
    expect(state().selected).toBe("parakeet-tdt-0.6b-v3");
    // A page that only follows the events ends up with the same state.
    expect(events.at(-1)).toEqual({ type: "dictation", state: state() });
  });

  test("deleting the chosen model hands over to an installed one, the recommended first (as the app core decides), else to none", () => {
    const { dictation, state, install } = demo();
    install("canary-180m-flash");
    install("whisper-base");
    install("parakeet-tdt-0.6b-v3");
    // The first one installed stays chosen until the user picks another.
    expect(state().selected).toBe("canary-180m-flash");
    dictation.call("dictation.select", { modelId: "whisper-base" });

    dictation.call("dictation.remove", { modelId: "whisper-base" });
    expect(state().selected).toBe("parakeet-tdt-0.6b-v3");
    dictation.call("dictation.remove", { modelId: "parakeet-tdt-0.6b-v3" });
    expect(state().selected).toBe("canary-180m-flash");
    dictation.call("dictation.remove", { modelId: "canary-180m-flash" });
    expect(state().selected).toBeUndefined();
    expect(state().models.every((m) => m.phase === "available")).toBe(true);
  });

  test("refusals: a download in progress can't be deleted, a model not downloaded can't be chosen", () => {
    const { clock, dictation, state } = demo();
    dictation.call("dictation.install", { modelId: "moonshine-base-en" });
    clock.advance(500);
    expect(refusal(() => dictation.call("dictation.remove", { modelId: "moonshine-base-en" }))).toMatchObject({ code: "busy" });
    expect(refusal(() => dictation.call("dictation.select", { modelId: "whisper-small" }))).toMatchObject({ code: "invalid_params" });
    expect(refusal(() => dictation.call("dictation.select", { modelId: "nope" }))).toMatchObject({ code: "not_found" });
    clock.advance(20_000);
    expect(state().selected).toBe("moonshine-base-en");
    // Choosing none hands the mic back to the system's recognition.
    dictation.call("dictation.select", {});
    expect(state().selected).toBeUndefined();
  });

  test("a phone has no on-device engine: every method answers unsupported, as the Android app core does", () => {
    const { dictation } = demo(true);
    for (const method of ["dictation.models", "dictation.install", "dictation.start"]) {
      expect(refusal(() => dictation.call(method, { modelId: "canary-180m-flash", session: "a" }))).toMatchObject({ code: "unsupported" });
    }
  });
});

describe("demo on-device dictation: sessions", () => {
  test("without a model nothing starts, and the error says where to get one", () => {
    const { dictation, heard } = demo();
    expect(refusal(() => dictation.call("dictation.start", { session: "a" }))).toMatchObject({ code: "no_model", hint: "Download a speech model in Settings → Dictation." });
    expect(heard("a")).toEqual([]);
  });

  test("words arrive as partials, each utterance ends as a final; Stop finishes the one being spoken, then the end", () => {
    const { clock, dictation, heard, install } = demo();
    install("parakeet-tdt-0.6b-v3");
    dictation.call("dictation.start", { session: "a" });
    expect(heard("a")).toEqual([{ type: "listening" }]);
    clock.advance(500 + 2 * 260);
    expect(heard("a").slice(1)).toEqual([1, 2, 3].map((n) => ({ type: "partial", text: FIRST_EN_WORDS.slice(0, n).join(" ") })));
    clock.advance(10_000);
    const finals = heard("a").filter((e) => e.type === "final");
    expect(finals.length).toBe(2);
    expect(finals[0]).toEqual({ type: "final", text: written(FIRST_EN) });

    // Mid-sentence: what was said so far is still decoded and arrives before the end.
    const last = heard("a").at(-1);
    if (last?.type !== "partial") throw new Error(`expected a partial, got ${JSON.stringify(last)}`);
    dictation.call("dictation.stop", { session: "a" });
    expect(heard("a").at(-1)).toEqual(last);
    clock.advance(300);
    expect(heard("a").slice(-2)).toEqual([{ type: "final", text: written(last.text) }, { type: "end" }]);
    clock.advance(60_000);
    expect(heard("a").filter((e) => e.type === "end").length).toBe(1);
    expect(heard("a").at(-1)).toEqual({ type: "end" });
  });

  test("cancel ends at once without the utterance; a new session finishes the running one; an id in use is refused", () => {
    const { clock, dictation, heard, install } = demo();
    install("parakeet-tdt-0.6b-v3");
    dictation.call("dictation.start", { session: "a" });
    clock.advance(1000);
    expect(refusal(() => dictation.call("dictation.start", { session: "a" }))).toMatchObject({ code: "invalid_params" });

    // One microphone, one dictation: "a" finishes what it heard, "b" listens.
    dictation.call("dictation.start", { session: "b" });
    clock.advance(300);
    expect(heard("a").slice(-2)).toEqual([{ type: "final", text: written(FIRST_EN_WORDS.slice(0, 2).join(" ")) }, { type: "end" }]);
    expect(heard("b")[0]).toEqual({ type: "listening" });

    clock.advance(1500);
    expect(heard("b").at(-1)?.type).toBe("partial");
    dictation.call("dictation.cancel", { session: "b" });
    expect(heard("b").at(-1)).toEqual({ type: "end" });
    expect(heard("b").some((e) => e.type === "final")).toBe(false);
    // An ended session frees its id.
    dictation.call("dictation.start", { session: "a" });
    expect(heard("a").at(-1)).toEqual({ type: "listening" });
  });

  test("German is heard when the language is German; a minute without speech ends the session by itself", () => {
    const { clock, dictation, heard, install } = demo();
    install("canary-180m-flash");
    dictation.call("dictation.setLanguage", { language: "de" });
    dictation.call("dictation.start", { session: "de" });
    clock.advance(30_000);
    expect(heard("de").flatMap((e) => (e.type === "final" ? [e.text] : []))).toEqual(DEMO_SPEECH.de.map(written));
    expect(heard("de").at(-1)?.type).not.toBe("end");
    clock.advance(60_000);
    expect(heard("de").at(-1)).toEqual({ type: "end" });
  });

  test("deleting the chosen model ends its session; the page going away ends every session", () => {
    const { clock, dictation, heard, install } = demo();
    install("parakeet-tdt-0.6b-v3");
    dictation.call("dictation.start", { session: "a" });
    clock.advance(1000);
    dictation.call("dictation.remove", { modelId: "parakeet-tdt-0.6b-v3" });
    expect(heard("a").at(-1)).toEqual({ type: "end" });

    install("canary-180m-flash");
    dictation.call("dictation.start", { session: "b" });
    clock.advance(1000);
    dictation.dispose();
    expect(heard("b").at(-1)).toEqual({ type: "end" });
    clock.advance(5000);
    expect(heard("b").filter((e) => e.type !== "partial")).toEqual([{ type: "listening" }, { type: "end" }]);
  });
});
