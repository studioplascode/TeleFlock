import type { AppEvent, DictationEvent, DictationMicrophone, DictationModel, DictationState } from "@/core/gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

/*
 * The demo's on-device dictation (`dictation.*`, docs/architecture.md §5.2 and §6.16), as the desktop
 * app core answers it: the real catalog (tf-dictation catalog.rs), downloads that take a few seconds
 * (progress, cancel, resume), delete, the chosen model, language and microphone, and live sessions
 * that "hear" a canned ramble in the chosen language (English unless it is German): words arrive as
 * partials, each utterance ends as a final, Stop finishes the one being spoken. Nothing is kept
 * across reloads. A phone (Android user agent) answers `unsupported`, as the Android app core does.
 */

export interface DemoDictationEnv {
  clock: DemoClock;
  emit(e: AppEvent): void;
  /** The page runs on a phone: no on-device engine there (the Android app uses its system recognizer). */
  phone: boolean;
}

type CatalogModel = Omit<DictationModel, "phase" | "downloaded" | "error" | "recommended"> & { desktop: boolean };

const EU25 = ["en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk", "sl", "hr", "bg", "ro", "hu", "da", "sv", "fi", "et", "lv", "lt", "el", "uk", "ru", "mt"];
const WHISPER = [...EU25, "tr", "ja", "zh", "ko"];

/** tf-dictation's catalog (sizes are the sums of each model's pinned files). */
const CATALOG: CatalogModel[] = [
  {
    id: "parakeet-tdt-0.6b-v3",
    name: "Parakeet TDT 0.6B v3",
    summary: "NVIDIA's multilingual dictation model: accurate and very fast on a computer. Can drift into English on German with many English words.",
    languages: "25 European languages, detected automatically",
    languageCodes: EU25,
    autoLanguage: true,
    takesLanguage: false,
    size: 670_478_772,
    ramMb: 1100,
    speed: 4,
    accuracy: 4,
    notes: "Fastest of the accurate ones: a sentence in 0.3–0.7 s on a desktop CPU. 2 % of words wrong in English and German dictation, 14 % in German full of English terms.",
    desktop: true,
  },
  {
    id: "canary-180m-flash",
    name: "Canary 180M Flash",
    summary: "NVIDIA's small model for four languages: accurate and light enough for a phone. Hears the language you set (or your device's).",
    languages: "English, German, French, Spanish",
    languageCodes: ["en", "de", "fr", "es"],
    autoLanguage: false,
    takesLanguage: true,
    size: 207_170_046,
    ramMb: 450,
    speed: 4,
    accuracy: 4,
    notes: "A sentence in 0.5–1 s on a desktop CPU. 5 % of words wrong in English read speech, 7 % in German; drops more in German mixed with English terms.",
    desktop: false,
  },
  {
    id: "whisper-turbo",
    name: "Whisper large-v3 turbo",
    summary: "OpenAI's most accurate fast Whisper: the best German here. Slower than Parakeet; for computers.",
    languages: "99 languages, detected automatically",
    languageCodes: WHISPER,
    autoLanguage: true,
    takesLanguage: true,
    size: 1_036_613_791,
    ramMb: 1800,
    speed: 2,
    accuracy: 5,
    notes: "The fewest mistakes in German read speech (4 %), but each utterance costs a full 30 s Whisper window: seconds per sentence on a CPU.",
    desktop: false,
  },
  {
    id: "whisper-small",
    name: "Whisper small",
    summary: "A mid-sized Whisper for many languages.",
    languages: "99 languages, detected automatically",
    languageCodes: WHISPER,
    autoLanguage: true,
    takesLanguage: true,
    size: 375_485_327,
    ramMb: 700,
    speed: 2,
    accuracy: 3,
    notes: "A sentence in 4–5 s on a desktop CPU. 5 % of words wrong in English read speech, 10 % in German.",
    desktop: false,
  },
  {
    id: "whisper-base",
    name: "Whisper base",
    summary: "A small Whisper for many languages: quick, but makes more mistakes.",
    languages: "99 languages, detected automatically",
    languageCodes: WHISPER,
    autoLanguage: true,
    takesLanguage: true,
    size: 160_609_290,
    ramMb: 350,
    speed: 4,
    accuracy: 2,
    notes: "A sentence in 1–1.5 s on a desktop CPU. 7 % of words wrong in English read speech, 27 % in German.",
    desktop: false,
  },
  {
    id: "moonshine-base-en",
    name: "Moonshine base (English)",
    summary: "Useful Sensors' English-only model: the fastest here, good for phones.",
    languages: "English",
    languageCodes: ["en"],
    autoLanguage: true,
    takesLanguage: false,
    size: 141_300_566,
    ramMb: 300,
    speed: 5,
    accuracy: 3,
    notes: "A sentence in about 0.3 s on a desktop CPU; 8 % of words wrong in English read speech. English only.",
    desktop: false,
  },
];

const LANGUAGE_NAMES: Record<string, string> = {
  auto: "Detect automatically",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  cs: "Czech",
  da: "Danish",
  sv: "Swedish",
  fi: "Finnish",
  uk: "Ukrainian",
  ru: "Russian",
  tr: "Turkish",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
};

const MICROPHONES: DictationMicrophone[] = [
  { id: "demo:default", name: "Built-in microphone", default: true },
  { id: "demo:usb", name: "USB headset", default: false },
];

/** Download speed of the demo (bytes per second): Parakeet takes about 8 s. */
const BYTES_PER_SECOND = 80_000_000;
const PROGRESS_EVERY = 250;
/** Time per spoken word, and the pause that ends an utterance. */
const WORD_MS = 260;
const PAUSE_MS = 700;
/** The decode after an utterance ends, and after Stop. */
const DECODE_MS = 300;
/** Without speech this long, a session ends by itself (as the engine's). */
const IDLE_END_MS = 60_000;

/** What a demo microphone "hears": a ramble, as utterances. */
export const DEMO_SPEECH: Record<"en" | "de", string[]> = {
  en: [
    "So um the session composer should keep the draft when I switch agents",
    "and uh also write a test for the draft slots",
    "no wait I mean the dispatch composer not the session one",
  ],
  de: [
    "Also der Composer soll den Entwurf behalten wenn ich den Agenten wechsle",
    "und äh schreib bitte auch einen Test für die Entwürfe",
    "nein warte ich meine den Dispatch Composer nicht den in der Sitzung",
  ],
};

interface Download {
  done: number;
  cancel: () => void;
}

interface Live {
  id: string;
  words: string[][];
  utterance: number;
  word: number;
  timer: (() => void) | null;
  /** The last time words came (idle end). */
  spokeAt: number;
  ending: boolean;
}

export class DemoDictation {
  private readonly installed = new Set<string>();
  /** Bytes of an interrupted download, kept for the resume. */
  private readonly partial = new Map<string, number>();
  private readonly downloads = new Map<string, Download>();
  private readonly errors = new Map<string, string>();
  private selected: string | null = null;
  private language = "auto";
  private microphone: DictationMicrophone | null = null;
  private readonly sessions = new Map<string, Live>();

  constructor(private readonly env: DemoDictationEnv) {}

  call(method: string, p: Record<string, unknown>): unknown {
    if (this.env.phone) throw apiError("unsupported", `${method}: this TeleFlock has no on-device speech engine (the desktop app has it; Android uses its own speech recognizer)`);
    const modelId = typeof p.modelId === "string" ? p.modelId : "";
    switch (method) {
      case "dictation.models":
        return this.state();
      case "dictation.install":
        this.install(this.model(modelId));
        return this.state();
      case "dictation.cancelInstall":
        this.downloads.get(this.model(modelId).id)?.cancel();
        return this.state();
      case "dictation.remove":
        this.remove(this.model(modelId));
        return this.state();
      case "dictation.select": {
        const id = typeof p.modelId === "string" ? p.modelId : null;
        if (id !== null && !this.installed.has(this.model(id).id)) throw apiError("invalid_params", "Download the model first");
        this.selected = id;
        this.changed();
        return this.state();
      }
      case "dictation.setLanguage": {
        const language = String(p.language ?? "");
        if (!(language in LANGUAGE_NAMES)) throw apiError("invalid_params", `unknown language \`${language}\``);
        this.language = language;
        this.changed();
        return this.state();
      }
      case "dictation.microphones":
        return { microphones: MICROPHONES };
      case "dictation.setMicrophone": {
        const id = typeof p.id === "string" ? p.id : null;
        const mic = id === null ? null : MICROPHONES.find((m) => m.id === id);
        if (mic === undefined) throw apiError("invalid_params", "That microphone isn't connected");
        this.microphone = mic && { ...mic, default: false };
        this.changed();
        return this.state();
      }
      case "dictation.start":
        this.start(String(p.session ?? ""));
        return {};
      case "dictation.stop":
        this.stop(String(p.session ?? ""), false);
        return {};
      case "dictation.cancel":
        this.stop(String(p.session ?? ""), true);
        return {};
      default:
        throw apiError("unknown_method", `Unknown app method ${method}`);
    }
  }

  state(): DictationState {
    const models: DictationModel[] = CATALOG.map(({ desktop, ...m }) => {
      const dl = this.downloads.get(m.id);
      const partial = this.partial.get(m.id);
      const error = this.errors.get(m.id);
      return {
        ...m,
        recommended: desktop,
        phase: dl ? "downloading" : this.installed.has(m.id) ? "installed" : "available",
        ...(dl ? { downloaded: dl.done } : partial ? { downloaded: partial } : {}),
        ...(error ? { error } : {}),
      };
    });
    const languages = Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }));
    return {
      supported: true,
      device: "desktop",
      models,
      ...(this.selected && this.installed.has(this.selected) ? { selected: this.selected } : {}),
      language: this.language,
      languages,
      engine: "sherpa-onnx 2.0.1 (demo)",
      ...(this.microphone ? { microphone: this.microphone } : {}),
    };
  }

  /** Ends every session (the page went away). */
  dispose(): void {
    for (const s of [...this.sessions.values()]) this.end(s, null);
    for (const d of this.downloads.values()) d.cancel();
  }

  private model(id: string): CatalogModel {
    const m = CATALOG.find((x) => x.id === id);
    if (!m) throw apiError("not_found", `no speech model \`${id}\``);
    return m;
  }

  private changed(): void {
    this.env.emit({ type: "dictation", state: this.state() });
  }

  private install(m: CatalogModel): void {
    if (this.installed.has(m.id) || this.downloads.has(m.id)) return;
    this.errors.delete(m.id);
    const dl: Download = { done: this.partial.get(m.id) ?? 0, cancel: () => {} };
    const step = (BYTES_PER_SECOND * PROGRESS_EVERY) / 1000;
    const stopTicks = this.env.clock.every(PROGRESS_EVERY, () => {
      dl.done = Math.min(m.size, dl.done + step);
      if (dl.done >= m.size) {
        stopTicks();
        this.downloads.delete(m.id);
        this.partial.delete(m.id);
        this.installed.add(m.id);
        // The first model installed becomes the chosen one.
        if (!this.selected || !this.installed.has(this.selected)) this.selected = m.id;
      }
      this.changed();
    });
    dl.cancel = () => {
      stopTicks();
      this.downloads.delete(m.id);
      this.partial.set(m.id, dl.done);
      this.changed();
    };
    this.downloads.set(m.id, dl);
    this.changed();
  }

  private remove(m: CatalogModel): void {
    if (this.downloads.has(m.id)) throw apiError("busy", "Cancel the download first");
    const chosen = this.selected === m.id;
    if (chosen) for (const s of [...this.sessions.values()]) this.end(s, null);
    this.installed.delete(m.id);
    this.partial.delete(m.id);
    this.errors.delete(m.id);
    if (chosen) {
      const rest = CATALOG.filter((c) => this.installed.has(c.id));
      this.selected = (rest.find((c) => c.desktop) ?? rest[0])?.id ?? null;
    }
    this.changed();
  }

  // ── sessions ──────────────────────────────────────────────────────────────────────────────

  private start(id: string): void {
    if (!id || id.length > 64) throw apiError("invalid_params", "a dictation session needs an id of 1–64 characters");
    if (this.sessions.has(id)) throw apiError("invalid_params", `dictation session \`${id}\` is running`);
    if (!this.selected || !this.installed.has(this.selected)) {
      throw apiError("no_model", "No speech model is installed: download one in Settings → Dictation", { hint: "Download a speech model in Settings → Dictation." });
    }
    for (const other of [...this.sessions.values()]) this.stop(other.id, false);
    const lang = this.language === "de" ? "de" : "en";
    const s: Live = { id, words: DEMO_SPEECH[lang].map((u) => u.split(" ")), utterance: 0, word: 0, timer: null, spokeAt: this.env.clock.now(), ending: false };
    this.sessions.set(id, s);
    this.send(id, { type: "listening" });
    this.schedule(s, 500);
  }

  private send(session: string, event: DictationEvent): void {
    this.env.emit({ type: "dictationSession", session, event });
  }

  private schedule(s: Live, ms: number): void {
    s.timer = this.env.clock.after(ms, () => this.tick(s));
  }

  /** The next word of the ramble (a partial), or the end of an utterance (its final, then a pause). */
  private tick(s: Live): void {
    s.timer = null;
    const words = s.words[s.utterance];
    if (!words) {
      // Everything was said: silence until Stop, or the idle end.
      if (this.env.clock.now() - s.spokeAt >= IDLE_END_MS) this.end(s, null);
      else this.schedule(s, 1000);
      return;
    }
    s.spokeAt = this.env.clock.now();
    if (s.word < words.length) {
      s.word += 1;
      this.send(s.id, { type: "partial", text: words.slice(0, s.word).join(" ") });
      this.schedule(s, WORD_MS);
      return;
    }
    s.timer = this.env.clock.after(DECODE_MS, () => {
      this.send(s.id, { type: "final", text: sentence(words) });
      s.utterance += 1;
      s.word = 0;
      this.schedule(s, PAUSE_MS);
    });
  }

  /** Stop: what is being said still arrives as a final, then the end. Cancel: the end now. */
  private stop(id: string, cancel: boolean): void {
    const s = this.sessions.get(id);
    if (!s || s.ending) return;
    s.ending = true;
    s.timer?.();
    s.timer = null;
    const words = s.words[s.utterance]?.slice(0, s.word) ?? [];
    if (cancel || words.length === 0) {
      this.end(s, null);
      return;
    }
    this.env.clock.after(DECODE_MS, () => this.end(s, sentence(words)));
  }

  private end(s: Live, last: string | null): void {
    if (this.sessions.get(s.id) !== s) return;
    s.timer?.();
    this.sessions.delete(s.id);
    if (last) this.send(s.id, { type: "final", text: last });
    this.send(s.id, { type: "end" });
  }
}

/** An utterance as the engine writes it: capitalised, with a full stop. */
function sentence(words: string[]): string {
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
