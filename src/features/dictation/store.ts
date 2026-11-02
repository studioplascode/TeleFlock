import { create } from "zustand";
import { core, navigate, onAppEvent, toApiError } from "@/core";
import type { DictationEvent, DictationModel, DictationState } from "@/core/gen";

/*
 * On-device dictation as this app core offers it (`dictation.*`; docs/architecture.md §6.16): the speech models,
 * the chosen one, language and microphone (`dictation.models`, then `AppEvent::Dictation` after every change),
 * and the events of live sessions (`AppEvent::DictationSession`), handed to whoever started each.
 */

interface DictationStore {
  /** null until known, and on a core without on-device dictation (see `missing`). */
  state: DictationState | null;
  /** Why this app core has no on-device dictation: `unsupported` (the Android app, a build without the engine) or `unknown_method` (an app core from before 0.9.0). */
  missing: { code: string; message: string } | null;
  /** Settings → Dictation was asked to come into view (a composer's "Open settings"); cleared once it did. */
  focus: boolean;
}

export const useDictationModels = create<DictationStore>(() => ({ state: null, missing: null, focus: false }));

const listeners = new Map<string, (e: DictationEvent) => void>();
let started = false;

/** Loads the state once and follows it, and routes session events (idempotent). */
export function startDictation(): void {
  if (started) return;
  started = true;
  onAppEvent((e) => {
    if (e.type === "dictation") useDictationModels.setState({ state: e.state, missing: null });
    else if (e.type === "dictationSession") listeners.get(e.session)?.(e.event);
  });
  core.app("dictation.models", {}).then(
    // An event that arrived meanwhile is newer than this answer.
    (state) => useDictationModels.setState((s) => (s.state ? s : { state, missing: null })),
    (e: unknown) => {
      const err = toApiError(e);
      if (err.code === "unsupported" || err.code === "unknown_method") useDictationModels.setState({ missing: { code: err.code, message: err.message } });
    },
  );
}

/** Applies the state a `dictation.*` call answered with. */
export function applyDictationState(state: DictationState): void {
  useDictationModels.setState({ state, missing: null });
}

/** Hands the events of `session` to `cb` until the returned function is called. */
export function onDictationSession(session: string, cb: (e: DictationEvent) => void): () => void {
  listeners.set(session, cb);
  return () => {
    if (listeners.get(session) === cb) listeners.delete(session);
  };
}

/** The model the composers' mic dictates with: on-device dictation is in this app core and a model is installed and chosen. */
export function chosenModel(state: DictationState | null): DictationModel | null {
  if (!state?.supported || !state.selected) return null;
  return state.models.find((m) => m.id === state.selected && m.phase === "installed") ?? null;
}

/** Opens Settings with the Dictation card in view. */
export function openDictationSettings(): void {
  useDictationModels.setState({ focus: true });
  navigate({ name: "settings" });
}

/** A new session id: random, so tabs sharing a devserver never collide. */
export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
