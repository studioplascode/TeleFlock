import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { core, toApiError } from "@/core";
import { isAndroid, isTauri } from "@/design";
import { DeviceSession } from "@/features/dictation/deviceSession";
import { chosenModel, newSessionId, onDictationSession, openDictationSettings, startDictation, useDictationModels } from "@/features/dictation/store";
import { errorMessage } from "@/features/shell/errors";

export interface Dictation {
  /** Speech recognition is available; hide the mic otherwise. */
  supported: boolean;
  listening: boolean;
  /** Words recognised so far that may still change. */
  interim: string;
  error: string | null;
  /** Set while the error can be fixed in settings (Android blocks the microphone for good: the app's system settings; no speech model: Settings → Dictation): opens them. */
  openSettings: (() => void) | null;
  toggle(): void;
}

// ── Web Speech API (desktop, mobile browsers) ───────────────────────────────────────────────

interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: RecognitionResultLike };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** The page has the Web Speech API (the system speech recognition of browsers and some app windows). */
export function hasWebSpeech(): boolean {
  return typeof window !== "undefined" && recognitionCtor() !== undefined;
}

function useWebDictation(onFinal: (text: string) => void, onEnd?: () => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalRef = useRef(onFinal);
  const endRef = useRef(onEnd);
  const Ctor = typeof window === "undefined" ? undefined : recognitionCtor();
  useEffect(() => {
    finalRef.current = onFinal;
    endRef.current = onEnd;
  });
  useEffect(() => () => rec.current?.stop(), []);

  const toggle = () => {
    if (!Ctor) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) finalRef.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission denied" : e.error);
    r.onend = () => {
      setListening(false);
      setInterim("");
      rec.current = null;
      endRef.current?.();
    };
    rec.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return { supported: Ctor != null, listening, interim, error, openSettings: null, toggle };
}

// ── Android app: the system speech recognizer through the TeleFlock plugin ──────────────────

const PLUGIN = "plugin:teleflock-android|";

type MicPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

/** Events of one session (`Dictation.kt`); `end` always comes last. */
type SpeechEvent = { type: "partial" | "final"; text: string } | { type: "error"; code: string; message: string } | { type: "end" };

/**
 * What to tell the user after Android refused the microphone. `settings`: denied for good, only
 * the app's system settings can grant it now; otherwise the next tap asks again.
 */
export function micPermissionNotice(state: Exclude<MicPermission, "granted">): { message: string; settings: boolean } {
  if (state === "denied") return { message: "Microphone access is blocked.", settings: true };
  return { message: "Dictation needs the microphone. Tap the mic to allow it.", settings: false };
}

let recognizer: boolean | undefined;
let recognizerCheck: Promise<boolean> | undefined;

/** Whether the phone has a speech recognizer; asked once per app run. */
function checkRecognizer(): Promise<boolean> {
  recognizerCheck ??= invoke<{ available: boolean }>(`${PLUGIN}dictation_available`).then(
    (r) => (recognizer = r.available),
    () => (recognizer = false),
  );
  return recognizerCheck;
}

function useAndroidDictation(onFinal: (text: string) => void, onEnd?: () => void): Dictation {
  const [supported, setSupported] = useState(recognizer === true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  /** The running session's channel; events of older sessions are ignored. */
  const session = useRef<Channel<SpeechEvent> | null>(null);
  const starting = useRef(false);
  const mounted = useRef(false);
  const finalRef = useRef(onFinal);
  const endRef = useRef(onEnd);
  useEffect(() => {
    finalRef.current = onFinal;
    endRef.current = onEnd;
  });
  useEffect(() => {
    mounted.current = true;
    void checkRecognizer().then((ok) => {
      if (mounted.current) setSupported(ok);
    });
    return () => {
      mounted.current = false;
      const s = session.current;
      session.current = null;
      if (s) invoke(`${PLUGIN}cancel_dictation`, { session: s.id }).catch(() => {});
    };
  }, []);

  const listen = async () => {
    const ch = new Channel<SpeechEvent>();
    ch.onmessage = (e) => {
      if (session.current !== ch) return;
      switch (e.type) {
        case "partial":
          setInterim(e.text);
          break;
        case "final":
          setInterim("");
          finalRef.current(e.text);
          break;
        case "error":
          setError(e.message);
          break;
        case "end":
          session.current = null;
          setListening(false);
          setInterim("");
          endRef.current?.();
      }
    };
    session.current = ch;
    setListening(true);
    try {
      await invoke(`${PLUGIN}start_dictation`, { channel: ch });
    } catch (e) {
      if (session.current === ch) {
        session.current = null;
        setListening(false);
      }
      throw e;
    }
  };

  const start = async () => {
    starting.current = true;
    setError(null);
    setBlocked(false);
    try {
      // Resolves at once when granted, otherwise after the user answered the system prompt.
      const { recordAudio } = await invoke<{ recordAudio: MicPermission }>(`${PLUGIN}request_microphone_permission`);
      if (!mounted.current) return;
      if (recordAudio === "granted") {
        await listen();
        return;
      }
      const notice = micPermissionNotice(recordAudio);
      setError(notice.message);
      setBlocked(notice.settings);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      starting.current = false;
    }
  };

  const toggle = () => {
    const s = session.current;
    if (s) {
      invoke(`${PLUGIN}stop_dictation`, { session: s.id }).catch((e: unknown) => setError(errorMessage(e)));
      return;
    }
    if (!starting.current) void start();
  };

  const openSettings = () => {
    setError(null);
    setBlocked(false);
    invoke(`${PLUGIN}open_app_settings`).catch((e: unknown) => setError(errorMessage(e)));
  };

  return { supported, listening, interim, error, openSettings: blocked ? openSettings : null, toggle };
}

// ── The app core's on-device engine (desktop app, lab devservers; Settings → Dictation) ───────

function useDeviceDictation(onFinal: (text: string) => void, onEnd?: () => void): Dictation & { active: boolean } {
  const active = useDictationModels((s) => chosenModel(s.state) !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<{ message: string; settings: boolean } | null>(null);
  /** The running session; events of older ones are ignored. */
  const session = useRef<DeviceSession | null>(null);
  const finalRef = useRef(onFinal);
  const endRef = useRef(onEnd);
  useEffect(() => {
    finalRef.current = onFinal;
    endRef.current = onEnd;
  });
  useEffect(() => {
    startDictation();
    return () => {
      session.current?.cancel();
      session.current = null;
    };
  }, []);

  const toggle = () => {
    if (session.current) {
      session.current.stop();
      return;
    }
    const locale = typeof navigator === "undefined" ? "" : navigator.language;
    const s: DeviceSession = new DeviceSession(
      { call: (method, params) => core.app(method, params), listen: onDictationSession, id: newSessionId(), ...(locale ? { locale } : {}) },
      {
        partial: (text) => {
          if (session.current === s) setInterim(text);
        },
        final: (text) => {
          if (session.current !== s) return;
          setInterim("");
          finalRef.current(text);
        },
        error: (message) => {
          if (session.current === s) setError({ message, settings: false });
        },
        end: () => {
          if (session.current !== s) return;
          session.current = null;
          setListening(false);
          setInterim("");
          endRef.current?.();
        },
      },
    );
    session.current = s;
    setError(null);
    setListening(true);
    s.start().catch((e: unknown) => {
      if (session.current !== s) return;
      session.current = null;
      setListening(false);
      const err = toApiError(e);
      setError({ message: [err.message, err.hint].filter(Boolean).join(". "), settings: err.code === "no_model" });
    });
  };

  const openSettings = () => {
    setError(null);
    openDictationSettings();
  };

  return { supported: active, listening, interim, error: error?.message ?? null, openSettings: error?.settings ? openSettings : null, toggle, active };
}

const usePlatformDictation: (onFinal: (text: string) => void, onEnd?: () => void) => Dictation = isTauri() && isAndroid ? useAndroidDictation : useWebDictation;

/**
 * The engine the mic uses now: the app core's when a speech model is chosen (`device.active`), else the platform's;
 * a session in progress keeps its engine until it ends, whatever changed in Settings meanwhile.
 */
export function engineInUse<D extends Dictation>(device: D & { active: boolean }, platform: D): D {
  if (device.listening || (device.active && !platform.listening)) return device;
  return platform;
}

/**
 * Voice dictation; final phrases are passed to `onFinal`, in order, once each. `onEnd` is called once per
 * listening session, after its last `onFinal`, whenever the session ends (stopped, error, engine gone):
 * Rambler (`@/features/dictation`) rewrites the whole utterance stream then. With a speech model installed and
 * chosen in Settings → Dictation, the app core's on-device engine listens (desktop app); otherwise the Android
 * app uses the system speech recognizer (its WebView has no working Web Speech API), everything else the Web
 * Speech API.
 */
export function useDictation(onFinal: (text: string) => void, onEnd?: () => void): Dictation {
  return engineInUse(useDeviceDictation(onFinal, onEnd), usePlatformDictation(onFinal, onEnd));
}
