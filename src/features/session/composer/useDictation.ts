import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isAndroid, isTauri } from "@/design";
import { errorMessage } from "@/features/shell/errors";

export interface Dictation {
  /** Speech recognition is available; hide the mic otherwise. */
  supported: boolean;
  listening: boolean;
  /** Words recognised so far that may still change. */
  interim: string;
  error: string | null;
  /** Set while Android blocks the microphone for good: opens the app's system settings. */
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

function useWebDictation(onFinal: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalRef = useRef(onFinal);
  const Ctor = typeof window === "undefined" ? undefined : recognitionCtor();
  useEffect(() => {
    finalRef.current = onFinal;
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

function useAndroidDictation(onFinal: (text: string) => void): Dictation {
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
  useEffect(() => {
    finalRef.current = onFinal;
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

/**
 * Voice dictation; final phrases are passed to `onFinal`. The Android app uses the system speech
 * recognizer (its WebView has no working Web Speech API); everything else the Web Speech API.
 */
export const useDictation: (onFinal: (text: string) => void) => Dictation = isTauri() && isAndroid ? useAndroidDictation : useWebDictation;
