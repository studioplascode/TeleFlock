import { useEffect, useRef, useState } from "react";

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

export interface Dictation {
  /** Web Speech API present; hide the mic otherwise. */
  supported: boolean;
  listening: boolean;
  /** Words recognised so far that may still change. */
  interim: string;
  error: string | null;
  toggle(): void;
}

/** Voice dictation through the Web Speech API. Final phrases are passed to `onFinal`. */
export function useDictation(onFinal: (text: string) => void): Dictation {
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

  return { supported: Ctor != null, listening, interim, error, toggle };
}
